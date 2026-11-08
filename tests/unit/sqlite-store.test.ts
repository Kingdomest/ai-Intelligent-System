import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import type { CapabilityRecord, CreateAgentInput, SendAgentMessageInput } from '../../src/domain/contracts.js';

const temporaryDirectories: string[] = [];

function createTestStore(filename?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-store-'));
  temporaryDirectories.push(directory);
  return new SqliteStore(filename ?? join(directory, 'jarvis.sqlite'));
}

function capability(overrides: Partial<CapabilityRecord> = {}): CapabilityRecord {
  return {
    id: 'count_lines',
    version: '1.0.0',
    status: 'active',
    normalizedIntent: 'count lines uploaded content',
    manifest: {
      id: 'count_lines',
      version: '1.0.0',
      kind: 'tool',
      name: 'count_lines',
      description: 'Counts lines in provided content.',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      entrypoint: 'tool.mjs',
      runtime: 'node-sandbox-v1',
      permissions: [],
      riskLevel: 'low',
      tests: ['counts lines'],
      provenance: { sourceTaskId: 'task-1', generatedAt: new Date().toISOString() },
    },
    code: 'export async function run(input) { return { count: input.content.split(/\\r?\\n/).length }; }',
    evaluation: {
      targetId: 'count_lines',
      targetVersion: '1.0.0',
      verdict: 'pass',
      score: 1,
      failures: [],
      recommendations: [],
      evaluatorRunId: randomUUID(),
    },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SqliteStore', () => {
  it('persists agent sessions and idempotent A2A messages across reopen', () => {
    const first = createTestStore();
    try {
      const rootTask = first.createTask({ message: '协作任务', attachments: [] });
      const mainInput: CreateAgentInput = {
        id: 'agent-main', rootTaskId: rootTask.id, name: '主 Agent', role: '负责总体决策', goal: '完成任务', capabilities: [],
      };
      const childInput: CreateAgentInput = {
        id: 'agent-research', parentAgentId: 'agent-main', rootTaskId: rootTask.id,
        name: '研究 Agent', role: '收集资料', goal: '提交研究结果', capabilities: ['filesystem.read'],
      };
      expect(first.createAgent(mainInput)).toMatchObject({ id: 'agent-main', status: 'queued', rootTaskId: rootTask.id });
      expect(first.createAgent(childInput)).toMatchObject({ parentAgentId: 'agent-main', capabilities: ['filesystem.read'] });
      const message: SendAgentMessageInput = {
        messageId: 'message-1', rootTaskId: rootTask.id, senderAgentId: 'agent-main', recipientAgentId: 'agent-research',
        type: 'request', correlationId: 'research-1', payload: { question: '请收集资料' },
      };
      const saved = first.sendAgentMessage(message);
      expect(saved).toMatchObject({ id: 'message-1', status: 'queued', payload: { question: '请收集资料' } });
      expect(first.sendAgentMessage(message)).toEqual(saved);
      expect(first.listAgentMessages('agent-research', { status: 'queued' })).toHaveLength(1);
      expect(first.ackAgentMessage('agent-research', 'message-1', 'read')).toMatchObject({ status: 'read', readAt: expect.any(String) });
      const filename = first.filename;
      first.close();

      const second = new SqliteStore(filename);
      try {
        expect(second.getAgent('agent-main')).toMatchObject({ id: 'agent-main', rootTaskId: rootTask.id });
        expect(second.listAgents(rootTask.id)).toHaveLength(2);
        expect(second.getAgentMessage('message-1')).toMatchObject({ status: 'read', payload: { question: '请收集资料' } });
      } finally {
        second.close();
      }
    } finally {
      try { first.close(); } catch { /* already closed after the reopen check */ }
    }
  });

  it('persists full Agent payload references and limits reads to the recipient', () => {
    const first = createTestStore();
    const filename = first.filename;
    first.saveAgentPayloadRef('assignment-1', 'task-1', 'worker-1', {
      input: { text: 'large input'.repeat(1_000) },
    });
    first.close();
    const second = new SqliteStore(filename);
    try {
      expect(second.getAgentPayloadRef('assignment-1', 'worker-1')).toMatchObject({
        input: { text: 'large input'.repeat(1_000) },
      });
      expect(second.getAgentPayloadRef('assignment-1', 'worker-2')).toBeNull();
    } finally {
      second.close();
    }
  });

  it('rejects a duplicate message id with a different envelope', () => {
    const store = createTestStore();
    try {
      store.createAgent({ id: 'agent-a', rootTaskId: 'task-a', name: 'A', role: 'a', goal: 'a' });
      store.createAgent({ id: 'agent-b', rootTaskId: 'task-a', name: 'B', role: 'b', goal: 'b' });
      store.sendAgentMessage({ messageId: 'message-duplicate', rootTaskId: 'task-a', senderAgentId: 'agent-a',
        recipientAgentId: 'agent-b', type: 'event', payload: { value: 1 } });
      expect(() => store.sendAgentMessage({ messageId: 'message-duplicate', rootTaskId: 'task-a', senderAgentId: 'agent-a',
        recipientAgentId: 'agent-b', type: 'event', payload: { value: 2 } })).toThrow(/different envelope/i);
    } finally {
      store.close();
    }
  });

  it('rolls back a failed batch of agent inserts', () => {
    const store = createTestStore();
    try {
      expect(() => store.createAgents([
        { id: 'batch-agent', rootTaskId: 'task-batch', name: 'one', role: 'worker', goal: 'work' },
        { id: 'batch-agent', rootTaskId: 'task-batch', name: 'two', role: 'worker', goal: 'work' },
      ])).toThrow(/constraint|already|unique/i);
      expect(store.listAgents('task-batch')).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('builds bounded diagnostic evidence from the latest failed task in a session', () => {
    const store = createTestStore();
    const session = store.createSession('诊断');
    const failed = store.createTask({ message: '创建 app.ts', attachments: [], sessionId: session.id });
    failed.status = 'FAILED';
    failed.result = '任务未完成：路径不存在';
    store.saveTask(failed);
    store.appendEvent(failed.id, { type: 'step.failed', payload: { stepId: 'write', failureCode: 'BAD_PATH', secret: 'do-not-copy' } });
    const traceId = store.startModelTrace({ taskId: failed.id, role: 'planner', system: 'system', user: 'request' });
    store.finishModelTrace(traceId, { error: '模型输出格式错误' });
    const context = (store as any).getLatestDiagnosticContext(session.id, 'new-task');
    expect(context).toMatchObject({ taskId: failed.id, status: 'FAILED', request: '创建 app.ts', result: '任务未完成：路径不存在' });
    expect(context.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'event', type: 'step.failed', details: expect.objectContaining({ failureCode: 'BAD_PATH' }) }),
      expect.objectContaining({ kind: 'model', type: 'planner', details: expect.objectContaining({ error: '模型输出格式错误' }) }),
    ]));
    expect(JSON.stringify(context)).not.toContain('do-not-copy');
    store.close();
  });

  it('adds the pin column to an existing sessions table without losing sessions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-session-pin-migration-'));
    temporaryDirectories.push(directory);
    const filename = join(directory, 'state.sqlite');
    const initial = new SqliteStore(filename);
    const session = initial.createSession('旧会话');
    initial.close();
    const legacy = new DatabaseSync(filename);
    legacy.exec('ALTER TABLE sessions DROP COLUMN pinned_at');
    legacy.close();

    const upgraded = new SqliteStore(filename);
    expect(upgraded.getSession(session.id)).toMatchObject({ title: '旧会话', pinnedAt: null });
    expect(upgraded.updateSession(session.id, { pinned: true }).pinnedAt).toBeTruthy();
    upgraded.close();
  });

  it('keeps Windows file targets readable in the operation timeline', () => {
    const store = createTestStore();
    const task = store.createTask({ message: 'write', attachments: [] });
    const now = new Date().toISOString();
    store.createOperation({ taskId: task.id, operationId: 'write-1', state: 'completed',
      operation: { operationId: 'write-1', permission: 'filesystem.write', action: 'writeText',
        target: 'D:\\demo\\file.txt', reason: 'write', arguments: { content: 'secret' } },
      result: { ok: true, value: 'secret' }, createdAt: now, updatedAt: now });
    const entry = store.listTrajectory({ taskId: task.id }).entries[0];
    expect(entry?.operation?.target).toBe('D:\\demo\\file.txt');
    expect(JSON.stringify(entry)).not.toContain('secret');
    store.close();
  });

  it('marks model calls interrupted after a restart instead of leaving them running forever', () => {
    const store = createTestStore();
    const task = store.createTask({ message: 'trace', attachments: [] });
    store.startModelTrace({ taskId: task.id, role: 'planner', system: 's', user: 'u' });
    expect(store.recoverInterruptedModelCalls()).toBe(1);
    expect(store.recoverInterruptedModelCalls()).toBe(0);
    const trace = store.listTrajectory({ taskId: task.id });
    expect(trace.summary.failedModels).toBe(1);
    expect(trace.entries[0]?.model).toMatchObject({ status: 'interrupted',
      error: '服务在模型调用完成前停止，结果未知。' });
    expect(trace.entries[0]?.model?.finishedAt).toBeTruthy();
    store.close();
  });

  it('upgrades task-only model traces so session compaction calls can be recorded', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-model-trace-'));
    temporaryDirectories.push(directory);
    const filename = join(directory, 'state.sqlite');
    const first = new SqliteStore(filename);
    const session = first.createSession();
    const task = first.createTask({ message: 'Original task', attachments: [], sessionId: session.id });
    first.close();
    const legacy = new DatabaseSync(filename);
    legacy.exec(`DROP TABLE model_calls; CREATE TABLE model_calls (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), role TEXT NOT NULL,
      model_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, system_prompt TEXT NOT NULL,
      user_prompt TEXT NOT NULL, response_json TEXT, error TEXT, request_id TEXT,
      input_tokens INTEGER, output_tokens INTEGER, duration_ms INTEGER,
      created_at TEXT NOT NULL, finished_at TEXT
    ); CREATE INDEX idx_model_calls_task_time ON model_calls(task_id, created_at);`);
    legacy.prepare(`INSERT INTO model_calls (id, task_id, role, status, system_prompt, user_prompt, created_at)
      VALUES (?, ?, 'planner', 'completed', 'system', 'user', ?)`)
      .run('legacy-call', task.id, new Date().toISOString());
    legacy.close();

    const upgraded = new SqliteStore(filename);
    const compactionId = upgraded.startModelTrace({ sessionId: session.id, role: 'session.compaction',
      system: 'summarize', user: 'history' });
    upgraded.finishModelTrace(compactionId, { completion: {
      data: { summary: 'short' }, usage: { inputTokens: 2, outputTokens: 1 },
    } });
    expect(upgraded.listTrajectory({ sessionId: session.id }).entries.map(entry => entry.type).sort())
      .toEqual(['planner', 'session.compaction']);
    upgraded.close();
  });

  it('persists a pending correction round and finishes it idempotently across reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-round-'));
    temporaryDirectories.push(directory);
    const filename = join(directory, 'state.sqlite');
    const first = new SqliteStore(filename);
    const task = first.createTask({ message: 'Summarize guide', attachments: [] });
    expect(task.correctionState).toEqual({ roundsUsed: 0, finishedRoundIds: [], failures: [] });
    task.correctionState.currentRound = { id: 'round-1', ordinal: 1, target: 'answer', phase: 'test' };
    first.saveTask(task);
    first.close();

    const second = new SqliteStore(filename);
    expect(second.getTask(task.id)?.correctionState.currentRound?.phase).toBe('test');
    const done = second.finishCorrectionRound(task.id, 'round-1');
    expect(done.correctionState.roundsUsed).toBe(1);
    expect(second.finishCorrectionRound(task.id, 'round-1').correctionState.roundsUsed).toBe(1);
    expect(second.listEvents(task.id).filter(event => event.type === 'correction.round_finished')).toHaveLength(1);
    second.close();
  });

  it('migrates a legacy database without losing tasks, events, or active capabilities', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-legacy-'));
    temporaryDirectories.push(directory);
    const filename = join(directory, 'legacy.sqlite');
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, message TEXT NOT NULL, attachments_json TEXT NOT NULL,
        status TEXT NOT NULL, acceptance_criteria_json TEXT NOT NULL, result TEXT,
        current_step_id TEXT, metrics_json TEXT NOT NULL, retry_counts_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, type TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE capabilities (
        id TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL,
        normalized_intent TEXT NOT NULL, manifest_json TEXT NOT NULL, code TEXT NOT NULL,
        evaluation_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (id, version)
      );
    `);
    const now = new Date().toISOString();
    legacy.prepare(`INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'legacy-task', 'old task', '[]', 'COMPLETED', '[]', 'done', null,
      JSON.stringify({ generatedCapabilityCount: 0, reusedCapabilityCount: 0, retryCount: 0 }),
      '{}', now, now,
    );
    legacy.prepare(`INSERT INTO task_events (task_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)`).run(
      'legacy-task', 'task.created', JSON.stringify({ retained: true }), now,
    );
    const activeCapability = capability();
    legacy.prepare(`INSERT INTO capabilities VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      activeCapability.id,
      activeCapability.version,
      activeCapability.status,
      'count lines uploaded content',
      JSON.stringify(activeCapability.manifest),
      activeCapability.code,
      JSON.stringify(activeCapability.evaluation),
      activeCapability.createdAt,
    );
    legacy.close();

    const migrated = new SqliteStore(filename);
    try {
      expect(migrated.getTask('legacy-task')).toMatchObject({
        message: 'old task',
        status: 'COMPLETED',
        permissionMode: 'request',
        pendingPermission: undefined,
      });
      expect(migrated.listEvents('legacy-task')).toHaveLength(1);
      expect(migrated.getActive('count_lines')?.status).toBe('active');
    } finally {
      migrated.close();
    }
  });

  it('persists a task and events across store instances', () => {
    const first = createTestStore();
    const task = first.createTask({ message: 'count lines', attachments: [] });
    first.appendEvent(task.id, { type: 'task.created', payload: { message: 'count lines' } });

    const second = createTestStore(first.filename);
    expect(second.getTask(task.id)?.status).toBe('INTAKE');
    expect(second.listEvents(task.id)).toHaveLength(1);

    first.close();
    second.close();
  });

  it('persists permission mode, pending approval, checkpoint, and one-shot operation state', () => {
    const store = createTestStore();
    const task = store.createTask({ message: 'create folder', attachments: [], permissionMode: 'auto' });
    task.pendingPermission = {
      requestId: 'approval-1',
      taskId: task.id,
      operation: {
        operationId: 'op-1', permission: 'filesystem.write', action: 'mkdir', target: 'hm',
        reason: 'Create the requested folder.', arguments: { path: 'hm' },
      },
      risk: 'low',
      createdAt: new Date().toISOString(),
    };
    task.executionCheckpoint = {
      planner: { steps: ['create folder'] }, capabilityName: 'create_folder', capabilityVersion: '1.0.0',
      completedStepIds: [], currentStepId: 'step-1', operationSequence: 1,
    };
    task.status = 'WAITING_FOR_APPROVAL';
    store.saveTask(task);
    const now = new Date().toISOString();
    store.createOperation({
      taskId: task.id,
      operationId: 'op-1',
      requestId: 'approval-1',
      state: 'pending',
      operation: task.pendingPermission.operation,
      createdAt: now,
      updatedAt: now,
    });

    const reopened = new SqliteStore(store.filename);
    expect(reopened.getTask(task.id)).toMatchObject({
      permissionMode: 'auto',
      status: 'WAITING_FOR_APPROVAL',
      pendingPermission: { requestId: 'approval-1' },
      executionCheckpoint: { currentStepId: 'step-1', operationSequence: 1 },
    });
    expect(reopened.getOperation(task.id, 'op-1')?.state).toBe('pending');
    expect(reopened.transitionOperation(task.id, 'op-1', ['pending'], 'approved')).toBe(true);
    expect(reopened.transitionOperation(task.id, 'op-1', ['pending'], 'approved')).toBe(false);
    expect(reopened.getOperation(task.id, 'op-1')?.state).toBe('approved');
    store.close();
    reopened.close();
  });

  it('marks an interrupted executing operation unknown and never replays it', () => {
    const store = createTestStore();
    const task = store.createTask({ message: 'write file', attachments: [], permissionMode: 'full' });
    task.status = 'EXECUTING';
    store.saveTask(task);
    const now = new Date().toISOString();
    store.createOperation({
      taskId: task.id,
      operationId: 'uncertain-op',
      state: 'executing',
      operation: { operationId: 'uncertain-op', permission: 'filesystem.write', action: 'writeText', target: 'a.txt', reason: 'write', arguments: { path: 'a.txt' } },
      createdAt: now,
      updatedAt: now,
    });

    expect(store.recoverInterruptedOperations()).toBe(1);
    expect(store.getOperation(task.id, 'uncertain-op')?.state).toBe('unknown');
    expect(store.getTask(task.id)).toMatchObject({ status: 'BLOCKED', result: expect.stringContaining('没有重放') });
    expect(store.recoverInterruptedOperations()).toBe(0);
    store.close();
  });

  it('finds a task stranded while building a capability without a host operation', () => {
    const store = createTestStore();
    const task = store.createTask({ message: 'create a folder', attachments: [] });
    task.status = 'CAPABILITY_BUILDING';
    store.saveTask(task);
    expect(store.listInterruptedTaskIds()).toContain(task.id);
    store.close();
  });

  it('finds checkpointed tasks whose host operation completed before a crash', () => {
    const store = createTestStore();
    const task = store.createTask({ message: 'create a folder', attachments: [], permissionMode: 'auto' });
    task.status = 'EXECUTING';
    task.executionCheckpoint = {
      planner: { steps: [{ id: 'step-1' }] }, capabilityName: 'create_folder', capabilityVersion: '1.0.0',
      completedStepIds: [], currentStepId: 'step-1', operationSequence: 0,
    };
    store.saveTask(task);
    const operation = {
      operationId: 'completed-op', permission: 'filesystem.write' as const, action: 'mkdir', target: 'hm',
      reason: 'Create a folder.', arguments: { path: 'hm' },
    };
    const now = new Date().toISOString();
    store.createOperation({ taskId: task.id, operationId: operation.operationId, state: 'executing', operation, createdAt: now, updatedAt: now });
    store.completeOperation(task.id, operation.operationId, { callId: 'operation:completed-op', ok: true, value: { path: 'hm', created: true } });

    try {
      expect(store.listRecoverableTaskIds()).toEqual([task.id]);
    } finally {
      store.close();
    }
  });

  it('redacts query payloads from permission audit events', () => {
    const store = createTestStore();
    const task = store.createTask({ message: 'fetch data', attachments: [] });
    const operation = {
      operationId: 'network-op', permission: 'network' as const, action: 'request',
      target: 'https://api.example.test/path?token=secret-value', reason: 'Fetch the requested data.',
      arguments: { url: 'https://api.example.test/path?token=secret-value', method: 'GET', headers: { authorization: 'secret-value' } },
    };
    task.status = 'WAITING_FOR_APPROVAL';
    task.pendingPermission = {
      requestId: 'network-approval', taskId: task.id, operation, risk: 'high', createdAt: new Date().toISOString(),
    };
    const now = new Date().toISOString();
    store.recordPendingPermission(task, {
      taskId: task.id, operationId: operation.operationId, requestId: 'network-approval', state: 'pending', operation,
      createdAt: now, updatedAt: now,
    });
    const event = store.listEvents(task.id).find((item) => item.type === 'task.permission_requested');
    expect(event?.payload.target).toBe('https://api.example.test/path?[query redacted]');
    expect(JSON.stringify(event)).not.toContain('secret-value');
    store.close();
  });

  it('returns the newest active capability and ignores inactive versions', () => {
    const store = createTestStore();
    store.saveCapability(capability({ version: '1.0.0', status: 'deprecated' }));
    store.saveCapability(capability({ version: '1.1.0', status: 'active' }));

    expect(store.findByIntent('Count   Lines Uploaded Content')?.version).toBe('1.1.0');
    expect(store.getActive('count_lines')?.version).toBe('1.1.0');

    store.close();
  });
});
