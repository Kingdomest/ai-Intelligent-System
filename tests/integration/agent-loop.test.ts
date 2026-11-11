import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRunner, type EvaluatorDecision, type PlannerDecision, type ToolCandidate } from '../../src/agents/agent-runner.js';
import { A2AProtocol } from '../../src/agents/a2a-protocol.js';
import { TestAgent } from '../../src/agents/test-agent.js';
import { CapabilityRegistry } from '../../src/capabilities/registry.js';
import { SandboxRunner } from '../../src/capabilities/sandbox-runner.js';
import { ToolFactory } from '../../src/capabilities/tool-factory.js';
import type { Attachment, CapabilityRecord, EvaluationRecord } from '../../src/domain/contracts.js';
import { DefaultHostOperationExecutor } from '../../src/permissions/host-operations.js';
import { PermissionBroker } from '../../src/permissions/permission-broker.js';
import type { HostCall, HostExecutionContext, HostOperationExecutor } from '../../src/permissions/operation-protocol.js';
import { ModelGateway } from '../../src/model/gateway.js';
import { MockModelProvider } from '../../src/model/mock-provider.js';
import { AgentLoop, type AgentServices } from '../../src/runtime/agent-loop.js';
import { TestExecutor } from '../../src/runtime/test-executor.js';
import { WindowsDesktopObserver } from '../../src/runtime/windows-desktop-observer.js';
import type { ApplicationResolution } from '../../src/runtime/windows-app-resolver.js';
import { BudgetManager } from '../../src/runtime/budget-manager.js';
import { AdaptiveScheduler } from '../../src/runtime/scheduler.js';
import { TaskService } from '../../src/runtime/task-service.js';
import { TaskCollaborationRuntime } from '../../src/runtime/task-collaboration.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

const temporaryDirectories: string[] = [];
const testStores: SqliteStore[] = [];

function createService(agents: AgentServices = new AgentRunner(new ModelGateway(new MockModelProvider())),
  withCollaboration = false) {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-loop-'));
  temporaryDirectories.push(directory);
  const store = new SqliteStore(join(directory, 'jarvis.sqlite'));
  testStores.push(store);
  const sandbox = new SandboxRunner();
  const registry = new CapabilityRegistry(store, sandbox);
  const executor = new DefaultHostOperationExecutor();
  const permissionBroker = new PermissionBroker(store, executor, directory);
  const factory = new ToolFactory(agents);
  const protocol = withCollaboration ? new A2AProtocol(store) : undefined;
  const loop = new AgentLoop({
    store,
    agents,
    tester: new TestAgent(new ModelGateway(new MockModelProvider())),
    testExecutor: new TestExecutor(sandbox),
    desktopObserver: new WindowsDesktopObserver(),
    factory,
    registry,
    sandbox,
    budget: new BudgetManager({ maxContextTokens: 32_000, outputReserveTokens: 4_000 }),
    scheduler: new AdaptiveScheduler({ maxConcurrency: 3 }),
    collaboration: protocol ? new TaskCollaborationRuntime(protocol) : undefined,
    maxRetries: 5,
    maxSteps: 50,
    permissionBroker,
    workspaceRoot: directory,
    desktopDirectory: join(directory, 'Desktop'),
  });
  return { service: new TaskService(store, loop, permissionBroker), store, directory, protocol };
}

afterEach(() => {
  for (const store of testStores.splice(0)) {
    try { store.close(); } catch { /* Some tests close their store explicitly. */ }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('AgentLoop', () => {
  it('summarizes the end of a long fetched article and corrects the answer without fetching again', async () => {
    const article = '# Article\n' + 'Main text '.repeat(3_800) + '\nFINAL_CONCLUSION: delivery guarantees.';
    const { store, directory } = createService();
    let answers = 0;
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      if (request.role === 'planner.correction') {
        expect(JSON.parse(request.user).scope).toBe('answer');
        expect((request.outputSchema as any).properties.action.enum).not.toContain('revise_plan_or_input');
        return { data: { action: 'revise_answer', reason: 'Include the conclusion from the saved evidence.' },
          usage: { inputTokens: 1, outputTokens: 1 } };
      }
      const results = JSON.parse(request.user).results;
      expect(results[1].output.body).toBe(article);
      answers++;
      return { data: { summary: answers === 1 ? 'Introduction only.' : 'Full summary: delivery guarantees.',
        details: [], warnings: [], nextSteps: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    const agents: AgentServices = {
      runPlanner: async () => ({ status: 'ready', intent: 'read article', acceptanceCriteria: ['Include the conclusion'],
        requiredCapabilities: [], steps: [
          { id: 'head', capabilityKey: 'network.request', description: 'Inspect response headers', dependsOn: [],
            input: { url: 'https://example.test/article', method: 'HEAD' } },
          { id: 'article', capabilityKey: 'network.request', description: 'Read the complete article', dependsOn: ['head'],
            input: { url: 'https://example.test/article', method: 'GET' } },
        ] }),
      runPlannerReview: async () => ({ action: 'continue', reason: 'Read succeeded.' }),
      runResponder: input => runner.runResponder(input),
      runCorrection: input => runner.runCorrection(input),
      runImplementer: async () => { throw new Error('Use the network builtin.'); },
      runEvaluator: async input => {
        const missing = input.target === 'task-answer' && !(input.output as { answer: string }).answer.includes('delivery guarantees');
        return { targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
          status: missing ? 'retry' : 'pass', verdict: missing ? 'revise' : 'pass', score: missing ? 0.5 : 1,
          failures: missing ? [{ code: 'MISSING_CONCLUSION', message: 'Include the final conclusion.' }] : [],
          recommendations: [], evidence: [] };
      },
    };
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => new Response(init?.method === 'HEAD' ? null : article));
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor({ fetch }), directory);
    const service = new TaskService(store, createAgentLoop(store, directory, agents, broker), broker);
    const task = await service.createAndWait({ message: 'Read this article and summarize all sections', attachments: [], permissionMode: 'full' });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(task.result).toContain('Full summary: delivery guarantees.');
    expect(answers).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.listStepOperations(task.id, 'article', '1.0.0')).toHaveLength(1);
  });

  it('executes a file-size scan with an inline script longer than 500 characters', async () => {
    const script = `
      const fs = require('node:fs');
      const path = require('node:path');
      const root = process.argv[1];
      const files = [];
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.bin')) continue;
        const fullPath = path.join(root, entry.name);
        const metadata = fs.statSync(fullPath);
        files.push({ path: fullPath, bytes: metadata.size });
      }
      files.sort((left, right) => right.bytes - left.bytes);
      console.log(JSON.stringify({ largest: files[0], scanned: files.length }));
    `;
    expect(script.length).toBeGreaterThan(500);
    const agents: AgentServices = {
      runPlanner: async input => ({ status: 'ready', intent: 'find largest file',
        acceptanceCriteria: ['Return the largest file path and byte count'], requiredCapabilities: [],
        steps: [{ id: 'scan', capabilityKey: 'process.run', description: 'Scan the file sizes', dependsOn: [],
          input: { command: process.execPath, args: ['-e', script, input.workspaceRoot!] } }] }),
      runPlannerReview: async () => ({ action: 'continue', reason: 'File sizes were observed.' }),
      runResponder: input => new AgentRunner(new ModelGateway({ complete: async request => {
        const evidence = JSON.parse(request.user).results[0].output;
        expect(evidence).not.toHaveProperty('stdout');
        const largest = evidence.data.largest;
        return { data: { summary: 'Found the largest file.', details: [
          { label: '完整路径', value: largest.path }, { label: '字节数', value: String(largest.bytes) },
        ], warnings: [], nextSteps: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
      } })).runResponder(input),
      runImplementer: async () => { throw new Error('Use the builtin process tool.'); },
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        status: 'pass', verdict: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
    };
    const { service, store, directory } = createService(agents);
    writeFileSync(join(directory, 'small.bin'), 'small');
    writeFileSync(join(directory, 'largest.bin'), 'x'.repeat(2048));
    const task = await service.createAndWait({ message: 'Find the largest file', attachments: [], permissionMode: 'full' });
    expect(task.status, task.result).toBe('COMPLETED');
    const operation = store.listStepOperations(task.id, 'scan', '1.0.0')[0]!;
    expect(operation.state).toBe('completed');
    const result = operation.result as { value: { exitCode: number; stdout: string } };
    expect(result.value.exitCode).toBe(0);
    expect(JSON.parse(result.value.stdout)).toEqual({
      largest: { path: join(directory, 'largest.bin'), bytes: 2048 }, scanned: 2,
    });
    expect(task.result).toContain('结果摘要：\nFound the largest file.');
    expect(task.result).toContain(`完整路径：${join(directory, 'largest.bin')}`);
    expect(task.result).not.toMatch(/stdout|stderr|exitCode/);
  });

  it('replans a process request rejected by the broker before execution without claiming uncertain side effects', async () => {
    const reviews: boolean[] = [];
    const agents: AgentServices = {
      runPlanner: async () => ({ status: 'ready', intent: 'run a command', acceptanceCriteria: ['Output verified'],
        requiredCapabilities: [], steps: [{ id: 'bad-cwd', capabilityKey: 'process.run', description: 'Run the command',
          dependsOn: [], input: { command: process.execPath, args: ['-e', 'console.log("verified")'], cwd: 'x'.repeat(4097) } }] }),
      runPlannerReview: async input => {
        if (input.outcome.status === 'success') return { action: 'continue', reason: 'Output verified.' };
        expect(input.outcome.failure.code).toBe('INVALID_PROCESS_ARGUMENTS');
        reviews.push(input.safeToReplay);
        return { action: 'replan', reason: 'Use the valid workspace directory.', plan: {
          status: 'ready', intent: 'run a command', acceptanceCriteria: ['Output verified'], requiredCapabilities: [],
          steps: [{ id: 'valid-cwd', capabilityKey: 'process.run', description: 'Run in the workspace', dependsOn: [],
            input: { command: process.execPath, args: ['-e', 'console.log("verified")'], cwd: input.workspaceRoot } }],
        } };
      },
      runImplementer: async () => { throw new Error('Use the builtin process tool.'); },
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        status: 'pass', verdict: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
    };
    const { service, store } = createService(agents);
    const task = await service.createAndWait({ message: 'Run the command', attachments: [], permissionMode: 'full' });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(reviews).toEqual([true]);
    expect(store.listStepOperations(task.id, 'bad-cwd', '1.0.0')).toHaveLength(0);
    expect(store.listStepOperations(task.id, 'valid-cwd', '1.0.0')).toHaveLength(1);
  });

  it('runs delegated steps with peer result requests and main Agent review', async () => {
    const reviewed: string[] = [];
    let reviewProtocol: A2AProtocol;
    const agents: AgentServices = {
      runPlanner: async input => ({ status: 'ready', intent: 'read two files',
        acceptanceCriteria: ['Both files were read'], requiredCapabilities: [], steps: [
          { id: 'a', capabilityKey: 'filesystem.read_text', description: 'Read first', dependsOn: [],
            input: { path: join(input.workspaceRoot!, 'a.txt') } },
          { id: 'b', capabilityKey: 'filesystem.read_text', description: 'Read second using first result',
            dependsOn: ['a'], input: { path: join(input.workspaceRoot!, 'b.txt') } },
        ] }),
      runPlannerReview: async input => {
        const root = reviewProtocol.listAgents(input.taskId).find(agent => agent.role === 'orchestrator')!;
        expect(reviewProtocol.listInbox(root.id).some(message => message.type === 'artifact'
          && (message.payload as { stepId?: string }).stepId === input.step.id
          && message.status === 'read')).toBe(true);
        reviewed.push(input.step.id);
        return { action: 'continue', reason: 'The observed result satisfies this step.' };
      },
      runImplementer: async () => { throw new Error('Use the maintained reader.'); },
      runResponder: async input => input.results.map(result => (result.output as { content: string }).content).join(', '),
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        status: 'pass', verdict: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
    };
    const { service, store, directory, protocol } = createService(agents, true);
    reviewProtocol = protocol!;
    writeFileSync(join(directory, 'a.txt'), 'first');
    writeFileSync(join(directory, 'b.txt'), 'second');
    const task = await service.createAndWait({ message: 'Read both files', attachments: [], permissionMode: 'full' });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(reviewed).toEqual(['a', 'b']);
    const all = protocol!.listAgents(task.id);
    expect(all.filter(agent => agent.role.startsWith('task-worker-'))).toHaveLength(2);
    const root = all.find(agent => agent.role === 'orchestrator')!;
    const workers = all.filter(agent => agent.role.startsWith('task-worker-'))
      .sort((left, right) => left.role.localeCompare(right.role));
    const peerRequest = protocol!.listInbox(workers[0]!.id).find(message => message.type === 'request'
      && (message.payload as { kind?: string }).kind === 'dependency.request')!;
    const peerResponse = protocol!.listInbox(workers[1]!.id).find(message => message.type === 'response')!;
    expect(peerRequest.senderAgentId).toBe(workers[1]!.id);
    expect(peerResponse).toMatchObject({ correlationId: peerRequest.id, status: 'read' });
    expect(protocol!.listInbox(root.id).filter(message => message.type === 'artifact')).toHaveLength(2);
    expect(store.listEvents(task.id).some(event => event.type === 'plan.reviewed')).toBe(true);
    expect(store.listEvents(task.id).map(event => event.type)).toEqual(expect.arrayContaining([
      'team.dispatched', 'agent.peer_exchange', 'agent.result_reported',
    ]));
  });

  it('sends a reviewed plan change to child Agents without replaying completed work', async () => {
    let firstPath = '';
    let replacementPath = '';
    const agents: AgentServices = {
      runPlanner: async input => {
        firstPath = join(input.workspaceRoot!, 'first.txt');
        replacementPath = join(input.workspaceRoot!, 'replacement.txt');
        return { status: 'ready', intent: 'read relevant evidence', acceptanceCriteria: ['Read two sources'],
          requiredCapabilities: [], steps: [
            { id: 'first', capabilityKey: 'filesystem.read_text', description: 'Read first',
              dependsOn: [], input: { path: firstPath } },
            { id: 'outdated', capabilityKey: 'filesystem.read_text', description: 'Read outdated',
              dependsOn: ['first'], input: { path: join(input.workspaceRoot!, 'outdated.txt') } },
          ] };
      },
      runPlannerReview: async input => input.step.id === 'first'
        ? { action: 'replan', reason: 'Use the replacement source.', plan: {
          status: 'ready', intent: 'read replacement evidence', acceptanceCriteria: ['Read two sources'],
          requiredCapabilities: [], steps: [
            { id: 'first', capabilityKey: 'filesystem.read_text', description: 'Read first',
              dependsOn: [], input: { path: firstPath } },
            { id: 'replacement', capabilityKey: 'filesystem.read_text', description: 'Read replacement',
              dependsOn: ['first'], input: { path: replacementPath } },
          ],
        } }
        : { action: 'continue', reason: 'Replacement source was read.' },
      runImplementer: async () => { throw new Error('Use the maintained reader.'); },
      runResponder: async input => input.results.map(result => (result.output as { content: string }).content).join(', '),
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        status: 'pass', verdict: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
    };
    const { service, store, directory, protocol } = createService(agents, true);
    writeFileSync(join(directory, 'first.txt'), 'first evidence');
    writeFileSync(join(directory, 'replacement.txt'), 'replacement evidence');
    const task = await service.createAndWait({ message: 'Read relevant evidence', attachments: [], permissionMode: 'full' });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(store.listStepOperations(task.id, 'first', '1.0.0')).toHaveLength(1);
    expect(store.listStepOperations(task.id, 'outdated', '1.0.0')).toHaveLength(0);
    expect(store.listStepOperations(task.id, 'replacement', '1.0.0')).toHaveLength(1);
    const workers = protocol!.listAgents(task.id).filter(agent => agent.role.startsWith('task-worker-'));
    expect(workers).toHaveLength(2);
    expect(workers.flatMap(worker => protocol!.listInbox(worker.id)).some(message => message.type === 'request'
      && (message.payload as { stepId?: string }).stepId === 'replacement')).toBe(true);
    expect(store.listEvents(task.id).some(event => event.type === 'plan.revised')).toBe(true);
  });

  it('uses a maintained text tool without asking the model to generate one', async () => {
    const agents: AgentServices = {
      runPlanner: async () => ({ status: 'ready', intent: 'replace text', acceptanceCriteria: ['replacement complete'],
        requiredCapabilities: [], steps: [{ id: 'replace', capabilityKey: 'text.replace',
          description: 'Replace a literal phrase', dependsOn: [],
          input: { text: 'hello world', search: 'world', replacement: 'friend' } }] }),
      runImplementer: async () => { throw new Error('A maintained tool must be used.'); },
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        status: 'pass', verdict: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
    };
    const { service, store } = createService(agents);
    const task = await service.createAndWait({ message: 'Replace world with friend', attachments: [] });
    expect(task.status).toBe('COMPLETED');
    expect(task.result).toContain('hello friend');
    expect(task.metrics.generatedCapabilityCount).toBe(0);
    expect(task.metrics.reusedCapabilityCount).toBe(1);
    expect(store.getCapabilityVersion('text.replace', '1.0.0')?.manifest.provenance.sourceTaskId).toBe('builtin');
  });

  it('injects the latest same-session failure evidence into a repair request', async () => {
    let diagnostic: unknown;
    const agents: AgentServices = {
      runPlanner: async input => {
        diagnostic = input.diagnosticContext;
        return { status: 'answer', intent: 'diagnose prior failure', answer: '已读取上一轮失败记录。',
          acceptanceCriteria: [], requiredCapabilities: [], steps: [] };
      },
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        status: 'pass', verdict: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
      runImplementer: async () => { throw new Error('not needed'); },
    };
    const { service, store } = createService(agents);
    const session = store.createSession('repair');
    const failed = store.createTask({ message: '创建 app.ts', attachments: [], sessionId: session.id });
    failed.status = 'FAILED';
    failed.result = '任务未完成：路径不存在';
    store.saveTask(failed);
    store.appendEvent(failed.id, { type: 'step.failed', payload: { stepId: 'write', failureCode: 'BAD_PATH' } });

    const task = await service.createAndWait({ sessionId: session.id, message: '请根据上轮错误日志排查并修复', attachments: [], permissionMode: 'full' });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(diagnostic).toMatchObject({ taskId: failed.id, status: 'FAILED', result: '任务未完成：路径不存在' });
    expect((diagnostic as { entries: Array<{ type: string; details: Record<string, unknown> }> }).entries)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'step.failed', details: expect.objectContaining({ failureCode: 'BAD_PATH' }) })]));
  });

  it('uses the real AgentRunner file implementer with its gateway receiver intact', async () => {
    const roles: string[] = [];
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      roles.push(request.role);
      if (request.role === 'planner.route') return { data: { status: 'ready' }, usage: { inputTokens: 1, outputTokens: 1 } };
      if (request.role === 'planner') {
        const context = JSON.parse(request.user) as { workspaceRoot: string };
        return { data: { status: 'ready', intent: 'write a small game', acceptanceCriteria: ['Game file exists'],
          requiredCapabilities: [], steps: [{ id: 'game', capabilityKey: 'filesystem.write_text',
            description: 'Create game file', dependsOn: [], input: { path: join(context.workspaceRoot, 'game.html'),
              generation: { instruction: 'Write a minimal playable HTML game.' } } }] },
        usage: { inputTokens: 1, outputTokens: 1 } };
      }
      if (request.role === 'implementer.file') return { data: { content: '<!doctype html><title>Game</title><button>Play</button>' },
        usage: { inputTokens: 1, outputTokens: 1 } };
      if (request.role === 'planner.review') return { data: { action: 'continue', reason: 'The game file was verified.' },
        usage: { inputTokens: 1, outputTokens: 1 } };
      if (request.role === 'evaluator') return { data: { status: 'pass', verdict: 'pass', score: 1,
        failures: [], recommendations: [], evidence: ['Verified file operation'] },
      usage: { inputTokens: 1, outputTokens: 1 } };
      throw new Error(`Unexpected model role: ${request.role}`);
    } }));
    const { service, store, directory } = createService(runner);
    const task = await service.createAndWait({ message: '做一个小游戏，写到项目目录', attachments: [], permissionMode: 'full' });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(readFileSync(join(directory, 'game.html'), 'utf8')).toContain('<button>Play</button>');
    expect(roles).toContain('implementer.file');
    expect(store.listStepOperations(task.id, 'game', '1.0.0')).toHaveLength(1);
  });

  it('blocks a file-implementer program exception before consuming five corrective rounds', async () => {
    let calls = 0;
    const agents: AgentServices = {
      runPlanner: async input => ({ status: 'ready', intent: 'write file', acceptanceCriteria: ['File exists'],
        requiredCapabilities: [], steps: [{ id: 'file', capabilityKey: 'filesystem.write_text',
          description: 'Write source file', dependsOn: [], input: { path: join(input.workspaceRoot!, 'broken.js'),
            generation: { instruction: 'Write source.' } } }] }),
      runFileImplementer: async () => { calls += 1; throw new TypeError("Cannot read properties of undefined (reading 'gateway')"); },
      runImplementer: async () => { throw new Error('Use the maintained writer'); },
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        status: 'pass', verdict: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
    };
    const { service, store, directory } = createService(agents);
    const task = await service.createAndWait({ message: 'Write a file', attachments: [], permissionMode: 'full' });
    expect(task.status).toBe('BLOCKED');
    expect(task.result).toContain('程序或连接异常');
    expect(calls).toBe(1);
    expect(task.correctionState.roundsUsed).toBe(0);
    expect(store.listStepOperations(task.id, 'file', '1.0.0')).toHaveLength(0);
    expect(existsSync(join(directory, 'broken.js'))).toBe(false);
  });
  it('trusts a verified existing target over a contradictory evaluator without repeating the operation', async () => {
    let evaluations = 0;
    const agents: AgentServices = {
      runPlanner: async input => ({ status: 'ready', intent: 'prepare workspace',
        acceptanceCriteria: ['Workspace exists'], requiredCapabilities: [],
        steps: [{ id: 'prepare', capabilityKey: 'filesystem.mkdir', description: 'Ensure workspace exists',
          dependsOn: [], input: { path: join(input.workspaceRoot!, 'existing') } }] }),
      runImplementer: async () => { throw new Error('Use the maintained capability'); },
      runEvaluator: async input => {
        evaluations += 1;
        expect(input.verification).toMatchObject({ mode: 'live_observation', passed: 1, failed: 0, blocked: 0 });
        return { targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'mistaken-review',
          status: 'retry', verdict: 'revise', score: 0, failures: [{ code: 'DIR_NOT_CREATED', message: 'created:false' }],
          recommendations: [], evidence: [] };
      },
    };
    const { service, store, directory } = createService(agents);
    mkdirSync(join(directory, 'existing'));
    const task = await service.createAndWait({ message: 'Ensure my workspace exists', attachments: [], permissionMode: 'full' });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(task.correctionState.roundsUsed).toBe(0);
    expect(evaluations).toBe(1);
    expect(store.listStepOperations(task.id, 'prepare', '1.0.0')).toHaveLength(1);
    expect(store.listEvents(task.id).some(event => event.type === 'step.verified'
      && event.payload.evaluator === 'conflicted')).toBe(true);
  });

  it('reviews a successful step and replaces the remaining global plan', async () => {
    const { store, directory } = createService();
    const first = { id: 'first', capabilityKey: 'filesystem.read_text', description: 'Read initial evidence',
      dependsOn: [], input: { path: join(directory, 'one.md') } };
    const oldSecond = { id: 'old-second', capabilityKey: 'filesystem.read_text', description: 'Read outdated source',
      dependsOn: ['first'], input: { path: join(directory, 'old.md') } };
    const newSecond = { id: 'new-second', capabilityKey: 'filesystem.read_text', description: 'Read relevant source',
      dependsOn: ['first'], input: { path: join(directory, 'two.md') } };
    writeFileSync(first.input.path, 'first evidence');
    writeFileSync(newSecond.input.path, 'second evidence');
    const reviews: string[] = [];
    const agents: AgentServices = {
      runPlanner: async () => ({ status: 'ready', intent: 'review two sources', acceptanceCriteria: ['Use both sources'],
        requiredCapabilities: [], steps: [first, oldSecond] }),
      runPlannerReview: async input => {
        reviews.push(input.step.id);
        expect(input.outcome.status).toBe('success');
        if (input.step.id === 'first') {
          expect(input.results).toHaveLength(1);
          return { action: 'replan', reason: 'The first source points to a different second source.',
            plan: { status: 'ready', intent: 'review relevant sources', acceptanceCriteria: ['Use both sources'],
              requiredCapabilities: [], steps: [first, newSecond] } };
        }
        return { action: 'continue', reason: 'The second source supports the goal.' };
      },
      runImplementer: async () => { throw new Error('Use maintained reader'); },
      runResponder: async input => input.results.map(item => (item.output as { content: string }).content).join('; '),
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        status: 'pass', verdict: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
    };
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor(), directory);
    const task = await new TaskService(store, createAgentLoop(store, directory, agents, broker), broker)
      .createAndWait({ message: 'Review the relevant sources', attachments: [], permissionMode: 'full' });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(reviews).toEqual(['first', 'new-second']);
    expect(task.result).toContain('second evidence');
    expect(store.listStepOperations(task.id, 'first', '1.0.0')).toHaveLength(1);
    expect(store.listStepOperations(task.id, 'old-second', '1.0.0')).toHaveLength(0);
    expect(store.listEvents(task.id).filter(event => event.type === 'plan.reviewed')).toHaveLength(2);
  });

  it('sends a failed outcome to global planning and changes direction without a local patch', async () => {
    const { store, directory } = createService();
    const validPath = join(directory, 'actual.md');
    writeFileSync(validPath, 'actual evidence');
    const observed: Array<{ status: string; completed: string[]; safe: boolean }> = [];
    const agents: AgentServices = {
      runPlanner: async () => ({ status: 'ready', intent: 'read evidence', acceptanceCriteria: ['Read evidence'],
        requiredCapabilities: [], steps: [{ id: 'wrong-direction', capabilityKey: 'filesystem.read_text',
          description: 'Read assumed path', dependsOn: [], input: { path: join(directory, 'missing.md') } }] }),
      runPlannerReview: async input => {
        observed.push({ status: input.outcome.status, completed: input.completedStepIds, safe: input.safeToReplay });
        if (input.outcome.status === 'failure') {
          expect(input.outcome.failure.reason).toBeTruthy();
          return { action: 'replan', reason: 'The assumed source does not exist; use the actual source.',
            plan: { status: 'ready', intent: 'read actual evidence', acceptanceCriteria: ['Read evidence'],
              requiredCapabilities: [], steps: [{ id: 'actual-source', capabilityKey: 'filesystem.read_text',
                description: 'Read actual path', dependsOn: [], input: { path: validPath } }] } };
        }
        return { action: 'continue', reason: 'Actual evidence was read.' };
      },
      runStepRepair: async () => { throw new Error('Local patch must not run'); },
      runCorrection: async () => { throw new Error('Local correction must not run'); },
      runImplementer: async () => { throw new Error('Use maintained reader'); },
      runResponder: async input => String((input.results[0]?.output as { content?: string })?.content),
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        status: 'pass', verdict: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
    };
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor(), directory);
    const task = await new TaskService(store, createAgentLoop(store, directory, agents, broker), broker)
      .createAndWait({ message: 'Read the actual evidence', attachments: [], permissionMode: 'full' });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(task.result).toContain('actual evidence');
    expect(observed.map(item => item.status)).toEqual(['failure', 'success']);
    expect(observed[0]?.completed).toEqual([]);
    expect(task.correctionState.roundsUsed).toBe(1);
  });

  it('sends an unusable evaluator decision to global planning before stopping', async () => {
    let reviewed = 0;
    const agents: AgentServices = {
      runPlanner: async () => ({ status: 'ready', intent: 'count lines', acceptanceCriteria: ['Return two'],
        requiredCapabilities: [], steps: [{ id: 'count', capabilityKey: 'text.count_lines',
          description: 'Count lines', dependsOn: [], input: { text: 'a\nb' } }] }),
      runPlannerReview: async input => {
        reviewed += 1;
        expect(input.outcome.status).toBe('failure');
        return { action: 'block', reason: 'Evaluator requested approval without an operation to authorize.' };
      },
      runImplementer: async () => { throw new Error('Use builtin'); },
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'builtin', evaluatorRunId: 'review',
        status: 'wait_approval', verdict: 'reject', score: 0, failures: [], recommendations: [], evidence: [] }),
    };
    const { service } = createService(agents);
    const task = await service.createAndWait({ message: 'Count lines', attachments: [], permissionMode: 'full' });
    expect(task.status).toBe('BLOCKED');
    expect(reviewed).toBe(1);
  });

  it('repairs only failed arguments and keeps already completed steps', async () => {
    let fullPlans = 0;
    let repairs = 0;
    const agents: AgentServices = {
      runPlanner: async input => {
        fullPlans += 1;
        return { status: 'ready', intent: 'read two files', acceptanceCriteria: ['Both files read'], requiredCapabilities: [],
          steps: [
            { id: 'first', capabilityKey: 'filesystem.read_text', description: 'Read first file',
              dependsOn: [], input: { path: join(input.workspaceRoot!, 'one.md') } },
            { id: 'second', capabilityKey: 'filesystem.read_text', description: 'Read second file',
              dependsOn: ['first'], input: { path: join(input.workspaceRoot!, 'wrong.md') } },
          ] };
      },
      runStepRepair: async input => {
        repairs += 1;
        expect(input.step.id).toBe('second');
        expect(input.completedStepIds).toEqual(['first']);
        return { path: join(directory, 'two.md') };
      },
      runImplementer: async () => { throw new Error('Use the maintained reader'); },
      runResponder: async input => input.results.map(item => (item.output as { content: string }).content).join(', '),
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        status: 'pass', verdict: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
      runCorrection: async () => ({ action: 'revise_plan_or_input', reason: 'Fix only second path' }),
    };
    const { service, store, directory } = createService(agents);
    writeFileSync(join(directory, 'one.md'), 'one');
    writeFileSync(join(directory, 'two.md'), 'two');
    const task = await service.createAndWait({ message: 'Read both files', attachments: [], permissionMode: 'full' });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(task.result).toContain('one, two');
    expect(fullPlans).toBe(1);
    expect(repairs).toBe(1);
    expect(store.listStepOperations(task.id, 'first', '1.0.0')).toHaveLength(1);
    expect(store.listStepOperations(task.id, 'second', '1.0.0')).toHaveLength(2);
  });

  it('blocks an unchanged repair instead of exhausting five identical retries', async () => {
    const agents: AgentServices = {
      runPlanner: async input => ({ status: 'ready', intent: 'read file', acceptanceCriteria: ['File read'],
        requiredCapabilities: [], steps: [{ id: 'read', capabilityKey: 'filesystem.read_text',
          description: 'Read a missing file', dependsOn: [], input: { path: join(input.workspaceRoot!, 'missing.md') } }] }),
      runStepRepair: async () => ({}),
      runImplementer: async () => { throw new Error('Use the maintained reader'); },
      runResponder: async () => 'unreachable',
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        status: 'pass', verdict: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
      runCorrection: async () => ({ action: 'revise_plan_or_input', reason: 'Repair input' }),
    };
    const { service } = createService(agents);
    const task = await service.createAndWait({ message: 'Read missing file', attachments: [], permissionMode: 'full' });
    expect(task.status).toBe('BLOCKED');
    expect(task.result).toContain('没有改变参数');
    expect(task.correctionState.roundsUsed).toBe(0);
    expect(task.correctionState.currentRound).toMatchObject({ ordinal: 1, target: 'plan_or_input' });
  });

  it('classifies evaluator timeout as model unavailability, not a reason to rebuild or replay tools', async () => {
    const base = new AgentRunner(new ModelGateway(new MockModelProvider()));
    let correctionCalls = 0;
    const agents: AgentServices = {
      runPlanner: input => base.runPlanner(input),
      runImplementer: input => base.runImplementer(input),
      runEvaluator: async input => {
        if (input.phase === 'execution') throw new Error('Ollama request timed out during evaluator after 180000ms.');
        return base.runEvaluator(input);
      },
      runCorrection: async () => { correctionCalls += 1; return { action: 'revise_plan_or_input', reason: 'Retry' }; },
    };
    const { service } = createService(agents);
    const task = await service.createAndWait({ message: 'Count lines', attachments: [
      { id: 'a', filename: 'a.txt', mimeType: 'text/plain', size: 4, content: 'a\nb\n' },
    ] });
    expect(task.status).toBe('BLOCKED');
    expect(task.result).toContain('模型阶段超时');
    expect(task.correctionState.roundsUsed).toBe(0);
    expect(correctionCalls).toBe(0);
  });

  it('delegates source generation to the implementer before writing each planned file', async () => {
    const generated: string[] = [];
    const criteriaSeen: string[][] = [];
    const agents: AgentServices = {
      runPlanner: async input => ({ status: 'ready', intent: 'build a game', acceptanceCriteria: ['The game files exist'],
        requiredCapabilities: [{ name: 'filesystem.write_text', purpose: 'Write source files', riskLevel: 'medium' }],
        steps: [
          { id: 'html', capabilityKey: 'filesystem.write_text', description: 'Create the game page', dependsOn: [],
            input: { path: join(input.workspaceRoot!, 'index.html'), generation: { instruction: 'Write the game page.' } } },
          { id: 'js', capabilityKey: 'filesystem.write_text', description: 'Create game logic', dependsOn: ['html'],
            input: { path: join(input.workspaceRoot!, 'game.js'), generation: { instruction: 'Implement minesweeper logic.' } } },
        ],
      }),
      runFileImplementer: async input => {
        generated.push(input.path);
        return input.path.endsWith('.html') ? '<script src="game.js"></script>' : 'const mines = 10;';
      },
      runImplementer: async () => { throw new Error('Do not generate a new filesystem tool'); },
      runEvaluator: async input => {
        criteriaSeen.push(input.acceptanceCriteria);
        return { targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'file-review',
          status: 'pass', verdict: 'pass', score: 1, failures: [], recommendations: [], evidence: [] };
      },
    };
    const { service, directory } = createService(agents);
    const task = await service.createAndWait({ message: '做一个扫雷小游戏', attachments: [], permissionMode: 'full' });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(generated).toEqual([join(directory, 'index.html'), join(directory, 'game.js')]);
    expect(readFileSync(join(directory, 'index.html'), 'utf8')).toContain('game.js');
    expect(readFileSync(join(directory, 'game.js'), 'utf8')).toContain('mines = 10');
    expect(criteriaSeen).toContainEqual(['Complete this step: Create the game page']);
    expect(criteriaSeen).toContainEqual(['Complete this step: Create game logic']);
  });

  it('generates an evidence-dependent report only after its source step completes', async () => {
    let root = '';
    let evidence: import('../../src/agents/agent-runner.js').FileImplementerInput['verifiedResults'];
    const agents: AgentServices = {
      runPlanner: async () => ({ status: 'ready', intent: 'summarize source into a file',
        acceptanceCriteria: ['The report reflects the source'], requiredCapabilities: [], steps: [
          { id: 'read', capabilityKey: 'filesystem.read_text', description: 'Read evidence', dependsOn: [],
            input: { path: join(root, 'source.txt') } },
          { id: 'report', capabilityKey: 'filesystem.write_text', description: 'Save the report', dependsOn: ['read'],
            input: { path: join(root, 'report.md'), generation: { instruction: 'Summarize the observed source.' } } },
        ] }),
      runFileImplementer: async input => {
        evidence = input.verifiedResults;
        expect(readFileSync(join(root, 'source.txt'), 'utf8')).toBe('Observed fact: 42 jobs.');
        expect(evidence?.[0]?.stepId).toBe('read');
        return `Report: ${(evidence?.[0]?.output as { content?: string }).content}`;
      },
      runPlannerReview: async () => ({ action: 'continue', reason: 'The observed step matches its goal.' }),
      runResponder: async () => 'Report saved from the observed source.',
      runImplementer: async () => { throw new Error('Use maintained capabilities'); },
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        status: 'pass', verdict: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
    };
    const { service, directory } = createService(agents);
    root = directory;
    writeFileSync(join(root, 'source.txt'), 'Observed fact: 42 jobs.');
    const task = await service.createAndWait({ message: 'Read source.txt and save a report.md', attachments: [], permissionMode: 'full' });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(readFileSync(join(root, 'report.md'), 'utf8')).toBe('Report: Observed fact: 42 jobs.');
  });

  it('keeps implemented file content stable across an approval pause', async () => {
    let implementations = 0;
    const agents: AgentServices = {
      runPlanner: async input => ({ status: 'ready', intent: 'build a game', acceptanceCriteria: ['File exists'],
        requiredCapabilities: [], steps: [{ id: 'game', capabilityKey: 'filesystem.write_text',
          description: 'Write the game', dependsOn: [], input: { path: join(input.workspaceRoot!, 'game.js'),
            generation: { instruction: 'Implement the game.' } } }] }),
      runFileImplementer: async () => { implementations += 1; return 'const game = true;'; },
      runImplementer: async () => { throw new Error('Use the maintained writer'); },
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        status: 'pass', verdict: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
    };
    const { service, directory } = createService(agents);
    const pending = await service.createAndWait({ message: '做一个小游戏', attachments: [], permissionMode: 'request' });
    expect(pending.status).toBe('WAITING_FOR_APPROVAL');
    expect(implementations).toBe(1);
    expect(existsSync(join(directory, 'game.js'))).toBe(false);
    const finished = await service.resolveApproval(pending.id, pending.pendingPermission!.requestId, true);
    expect(finished.status, finished.result).toBe('COMPLETED');
    expect(implementations).toBe(1);
    expect(readFileSync(join(directory, 'game.js'), 'utf8')).toBe('const game = true;');
  });

  it('feeds file-generation errors back to the implementer without writing a partial file', async () => {
    const feedbackSeen: Array<string | undefined> = [];
    const agents: AgentServices = {
      runPlanner: async input => ({ status: 'ready', intent: 'build a game', acceptanceCriteria: ['File exists'],
        requiredCapabilities: [], steps: [{ id: 'game', capabilityKey: 'filesystem.write_text',
          description: 'Write game logic', dependsOn: [], input: { path: join(input.workspaceRoot!, 'game.js'),
            generation: { instruction: 'Implement game logic.' } } }] }),
      runFileImplementer: async input => {
        feedbackSeen.push(input.feedback);
        if (!input.feedback) throw new Error('Generated file was incomplete');
        return 'const game = true;';
      },
      runImplementer: async () => { throw new Error('Use the maintained writer'); },
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        status: 'pass', verdict: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
    };
    const { service, directory } = createService(agents);
    const task = await service.createAndWait({ message: '做一个小游戏', attachments: [], permissionMode: 'full' });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(feedbackSeen).toEqual([undefined, 'Generated file was incomplete']);
    expect(task.metrics.retryCount).toBe(1);
    expect(readFileSync(join(directory, 'game.js'), 'utf8')).toBe('const game = true;');
  });
  it('completes a long presentation draft through chunk progress, answer testing, and evaluation', async () => {
    const fallback = new MockModelProvider();
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      const data = JSON.parse(request.user) as { pageNumbers?: number[] };
      if (request.role === 'presentation.draft_pages') return {
        data: { pages: data.pageNumbers!.map(number => ({ number, title: `页面${number}`,
          bullets: ['工作目标', '执行动作', '实际结果'], visualSuggestion: '简洁图表', speakerNotes: '自然说明' })) },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
      if (request.role === 'presentation.draft_speech') return {
        data: { speech: '我将说明试用期的工作和未来的计划。'.repeat(42) },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
      return fallback.complete(request);
    } }));
    const { service, store } = createService(runner);
    const task = await service.createAndWait({ message: '请写员工转正述职PPT的完整文案与页面结构，共12页，'
      + '每页3-5个要点、配图建议、演讲备注，最后加800-1000字演讲逐字稿。只给文案，不生成文件。', attachments: [] });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(task.result).toContain('第12页｜页面12');
    expect(store.listEvents(task.id).filter(event => event.type === 'draft.progress').map(event => event.payload))
      .toEqual(Array.from({ length: 5 }, (_, index) => ({ completed: index + 1, total: 5 })));
    expect(task.metrics.generatedCapabilityCount).toBe(0);
  });
  it('revises a failed writing answer with the draft role rather than a tool-result responder', async () => {
    let evaluations = 0;
    let draftCorrections = 0;
    const agents: AgentServices = {
      runPlanner: async () => ({ status: 'answer', intent: 'draft presentation copy',
        acceptanceCriteria: ['A complete presentation draft'], requiredCapabilities: [], steps: [], answer: '初稿' }),
      runImplementer: async () => { throw new Error('No tool needed'); },
      runEvaluator: async () => {
        evaluations += 1;
        return { targetId: 'answer', targetVersion: 'candidate', evaluatorRunId: 'review',
          status: evaluations === 1 ? 'retry' : 'pass', verdict: evaluations === 1 ? 'revise' : 'pass',
          score: evaluations === 1 ? 0.4 : 1,
          failures: evaluations === 1 ? [{ code: 'MISSING_DETAIL', message: 'Need fuller page detail.' }] : [],
          recommendations: [], evidence: [] };
      },
      runCorrection: async () => ({ action: 'revise_answer', reason: 'Add page detail.' }),
      runResponder: async () => { throw new Error('Tool-result responder must not edit an original draft'); },
      runDraftCorrection: async input => {
        draftCorrections += 1;
        expect(input.feedback?.reason).toContain('fuller page detail');
        return '修订后包含完整的逐页内容与演讲稿。';
      },
    };
    const { service } = createService(agents);
    const task = await service.createAndWait({ message: '写述职PPT逐页文案', attachments: [] });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(draftCorrections).toBe(1);
    expect(task.metrics.retryCount).toBe(1);
  });
  it('creates a real reusable PPTX through one approved desktop write without generating a tool', async () => {
    let generated = 0;
    const agents: AgentServices = {
      runPlanner: async input => ({ status: 'ready', intent: 'create presentation',
        acceptanceCriteria: ['Create a real PPTX on the Desktop'],
        requiredCapabilities: [{ name: 'presentation.create', purpose: 'Create a structured PowerPoint file.', riskLevel: 'medium' }],
        steps: [{ id: 'presentation', capabilityKey: 'presentation.create', description: 'Create the deck', dependsOn: [],
          input: { path: join(input.desktopDirectory!, '转正述职.pptx'), slides: [
            { title: '转正述职', bullets: ['试用期成果', '后续工作计划'] },
            { title: '工作成果', bullets: ['完成用户调研', '推动流程改进'] },
          ] } }],
      }),
      runImplementer: async () => { generated += 1; throw new Error('A maintained presentation tool must be reused'); },
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'ppt-review',
        status: 'pass', verdict: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
      runResponder: async input => `已生成演示文稿：${(input.results[0]?.output as { path: string }).path}`,
    };
    const { service, store, directory } = createService(agents);
    const desktop = join(directory, 'Desktop');
    mkdirSync(desktop);
    const destination = join(desktop, '转正述职.pptx');
    const pending = await service.createAndWait({ message: '把述职内容做成PPT文件放到桌面', attachments: [], permissionMode: 'request' });
    expect(pending.status).toBe('WAITING_FOR_APPROVAL');
    expect(existsSync(destination)).toBe(false);
    expect(generated).toBe(0);
    const approved = await service.resolveApproval(pending.id, pending.pendingPermission!.requestId, true);
    expect(approved.status, approved.result).toBe('COMPLETED');
    expect(readFileSync(destination).subarray(0, 2).toString()).toBe('PK');
    expect(store.listStepOperations(approved.id, 'presentation', '1.0.0')).toHaveLength(1);
    expect(generated).toBe(0);
  });

  it('converts twelve pasted Chinese slides into a real deck without a model-generated tool or JSON echo', async () => {
    const mock = new MockModelProvider();
    const runner = new AgentRunner(new ModelGateway({ complete: request => request.role === 'responder'
      ? Promise.resolve({ data: { summary: '演示文稿已保存到桌面。', details: [], warnings: [], nextSteps: [] }, usage: { inputTokens: 1, outputTokens: 1 } })
      : mock.complete(request) }));
    const { service, directory } = createService(runner);
    mkdirSync(join(directory, 'Desktop'));
    const source = Array.from({ length: 12 }, (_, index) => `**第${index + 1}页｜页面${index + 1}** - 核心内容： 1. 第${index + 1}页主题与“重点” 2. 工作成果 & 计划 - 演讲备注：逐页讲述。`).join(' ');
    const task = await service.createAndWait({ message: `把这份PPT生成文件放到桌面\n用户补充信息：${JSON.stringify({ answer: source })}`,
      attachments: [], permissionMode: 'request' });
    expect(task.status, task.result).toBe('WAITING_FOR_APPROVAL');
    const destination = task.pendingPermission?.operation.target;
    expect(destination).toMatch(/\.pptx$/);
    expect(existsSync(destination!)).toBe(false);
    const completed = await service.resolveApproval(task.id, task.pendingPermission!.requestId, true);
    expect(completed.status, completed.result).toBe('COMPLETED');
    const { default: JSZip } = await import('jszip');
    const archive = await JSZip.loadAsync(readFileSync(destination!), { checkCRC32: true });
    expect(Object.keys(archive.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(12);
    expect(await archive.file('ppt/slides/slide12.xml')!.async('string')).toContain('第12页主题与“重点”');
  });
  it('can turn a completed slide-writing task into a PPTX without asking for the same content again', async () => {
    const mock = new MockModelProvider();
    const runner = new AgentRunner(new ModelGateway({ complete: request => request.role === 'responder'
      ? Promise.resolve({ data: { summary: '演示文稿已保存。', details: [], warnings: [], nextSteps: [] }, usage: { inputTokens: 1, outputTokens: 1 } })
      : mock.complete(request) }));
    const { service, store, directory } = createService(runner);
    mkdirSync(join(directory, 'Desktop'));
    const previous = store.createTask({ message: '写两页述职PPT文案', attachments: [] });
    previous.status = 'COMPLETED';
    previous.result = '**第1页｜工作成果** - 核心内容： 1. 完成项目交付 2. 提升运行稳定性 '
      + '**第2页｜后续计划** - 核心内容： 1. 完善自动化测试 2. 持续优化体验';
    store.saveTask(previous);
    const task = await service.createAndWait({ message: '把刚才这份PPT生成文件放到桌面',
      sourceTaskId: previous.id, attachments: [], permissionMode: 'request' });
    expect(task.status, task.result).toBe('WAITING_FOR_APPROVAL');
    expect(task.attachments).toHaveLength(1);
    expect(task.attachments[0]?.content).toContain('完善自动化测试');
    const done = await service.resolveApproval(task.id, task.pendingPermission!.requestId, true);
    expect(done.status, done.result).toBe('COMPLETED');
    expect(existsSync(task.pendingPermission!.operation.target)).toBe(true);
  });

  it('rejects unrelated or incomplete source tasks and never creates a new task for them', () => {
    const { service, store } = createService();
    const previous = store.createTask({ message: '未完成的草稿', attachments: [] });
    expect(() => service.createAndStart({ message: '把刚才的PPT生成文件', sourceTaskId: previous.id,
      attachments: [] })).toThrow(/source task/i);
    expect(() => service.createAndStart({ message: '把刚才的PPT生成文件', sourceTaskId: 'missing',
      attachments: [] })).toThrow(/source task/i);
  });
  it('does not write a presentation when the user denies desktop permission', async () => {
    const { service, directory } = createService();
    mkdirSync(join(directory, 'Desktop'));
    const source = '**第1页｜封面** - 核心内容： 1. 目标 2. 内容';
    const task = await service.createAndWait({ message: `把这份PPT生成文件放到桌面\n用户补充信息：${JSON.stringify({ answer: source })}`,
      attachments: [], permissionMode: 'request' });
    expect(task.status).toBe('WAITING_FOR_APPROVAL');
    const target = task.pendingPermission!.operation.target;
    expect(existsSync(target)).toBe(false);
    const denied = await service.resolveApproval(task.id, task.pendingPermission!.requestId, false);
    expect(denied.status).not.toBe('COMPLETED');
    expect(existsSync(target)).toBe(false);
  });
  it('returns a conversational answer directly without consulting the test or evaluation gates', async () => {
    let reviewAnswers = 0;
    let evaluations = 0;
    const agents: AgentServices = {
      runPlanner: async () => ({ status: 'answer', answer: '你好！很高兴认识你。', intent: 'greeting',
        acceptanceCriteria: [], requiredCapabilities: [], steps: [] }),
      runImplementer: async () => { throw new Error('No tool'); },
      runEvaluator: async () => {
        evaluations += 1;
        throw new Error('Evaluator must not run for tool-free chat');
      },
    };
    const { store, directory } = createService(agents);
    const tester = new TestAgent(new ModelGateway({ complete: async () => {
      reviewAnswers += 1;
      throw new Error('Answer review must not run for tool-free chat');
    } }));
    const service = new TaskService(store, createAgentLoop(store, directory, agents,
      new PermissionBroker(store, new DefaultHostOperationExecutor(), directory),
      new WindowsDesktopObserver(), {
        generate: () => { throw new Error('No tool'); },
        review: () => { throw new Error('No tool'); },
        reviewAnswer: (async (...args: Parameters<TestAgent['reviewAnswer']>) => {
          reviewAnswers += 1;
          return tester.reviewAnswer(...args);
        }) as TestAgent['reviewAnswer'],
      }));
    const task = await service.createAndWait({ message: '你好', attachments: [] });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(task.result).toBe('你好！很高兴认识你。');
    expect(reviewAnswers).toBe(0);
    expect(evaluations).toBe(0);
    expect(task.correctionState.roundsUsed).toBe(0);
    const events = store.listEvents(task.id);
    expect(events.some(event => event.type === 'task.completed')).toBe(true);
    expect(events.some(event => event.type === 'test.report')).toBe(false);
  });

  it('still gates grounded answers: blocks without consuming a round when evaluation output is invalid', async () => {
    const { store, directory } = createService();
    writeFileSync(join(directory, 'guide.md'), 'Guide content');
    const agents: AgentServices = {
      runPlanner: async () => ({ status: 'ready', intent: 'summarize guide',
        acceptanceCriteria: ['Summarize the guide'], requiredCapabilities: [],
        steps: [{ id: 'read', capabilityKey: 'filesystem.read_text', description: 'Read guide', dependsOn: [], input: { path: join(directory, 'guide.md') } }] }),
      runImplementer: async () => { throw new Error('No tool'); },
      runResponder: async () => '总结：Guide content',
      runEvaluator: async () => { throw Object.assign(new Error('score: expected number to be <=1'),
        { code: 'EVALUATOR_OUTPUT_INVALID' }); },
    };
    const tester = new TestAgent(new ModelGateway(new MockModelProvider()));
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor(), directory);
    const service = new TaskService(store, createAgentLoop(store, directory, agents, broker,
      new WindowsDesktopObserver(), {
        generate: tester.generate.bind(tester), review: tester.review.bind(tester),
        reviewAnswer: tester.reviewAnswer.bind(tester),
      }), broker);
    const task = await service.createAndWait({ message: 'Summarize guide', attachments: [], permissionMode: 'request' });
    expect(task.status).toBe('BLOCKED');
    expect(task.correctionState.roundsUsed).toBe(0);
    expect(task.result).toContain('score');
    expect(store.listEvents(task.id).some(event => event.type === 'test.report'
      && event.payload.passed === 1)).toBe(true);
  });

  it('keeps an unfinished correction round when the draft corrector becomes unavailable', async () => {
    const agents: AgentServices = {
      runPlanner: async () => ({ status: 'answer', answer: 'Incomplete draft', intent: 'draft presentation copy',
        acceptanceCriteria: ['Complete the presentation draft'], requiredCapabilities: [], steps: [] }),
      runImplementer: async () => { throw new Error('No tool'); },
      runCorrection: async () => ({ action: 'revise_answer', reason: 'Complete the draft' }),
      runDraftCorrection: async () => { throw new Error('Draft corrector offline'); },
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        verdict: 'revise', status: 'retry', score: 0, failures: [{ code: 'ANSWER_INCOMPLETE', message: 'Incomplete draft' }],
        recommendations: [], evidence: [] }),
    };
    const { service } = createService(agents);
    const task = await service.createAndWait({ message: '写一份 8 页的PPT文案', attachments: [] });
    expect(task.status).toBe('BLOCKED');
    expect(task.correctionState.roundsUsed).toBe(0);
    expect(task.correctionState.currentRound).toMatchObject({ ordinal: 1, target: 'answer' });
    expect(task.result).toContain('回答纠正当前不可用');
  });

  it('resumes an interrupted answer-correction round from verified results without a second host read', async () => {
    const { store, directory } = createService();
    const path = join(directory, 'guide.md');
    writeFileSync(path, 'Guide content');
    let resumedFeedbackCode: string | undefined;
    const agents: AgentServices = {
      runPlanner: async () => { throw new Error('Saved plan must be reused'); },
      runImplementer: async () => { throw new Error('No new tool required'); },
      runResponder: async input => {
        resumedFeedbackCode = input.feedback?.code;
        return `总结：${String((input.results[0]?.output as { content?: string }).content)}`;
      },
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        verdict: 'pass', status: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
    };
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor(), directory);
    const service = new TaskService(store, createAgentLoop(store, directory, agents, broker), broker);
    const task = store.createTask({ message: 'Summarize guide', attachments: [], permissionMode: 'request' });
    const planner: PlannerDecision = { status: 'ready', intent: 'summarize guide',
      acceptanceCriteria: ['Summarize the guide'], requiredCapabilities: [],
      steps: [{ id: 'read', capabilityKey: 'filesystem.read_text', description: 'Read guide', dependsOn: [], input: { path } }] };
    task.status = 'RETRYING';
    task.correctionState.currentRound = { id: 'round-1', ordinal: 1, target: 'answer', phase: 'test' };
    task.correctionState.failures = [{ stage: 'answer', code: 'ANSWER_INCOMPLETE', reason: 'Missing chapter three' }];
    task.executionCheckpoint = { planner, capabilityName: 'filesystem.read_text', capabilityVersion: '1.0.0',
      stepBindings: [{ stepId: 'read', capabilityKey: 'filesystem.read_text', capabilityId: 'filesystem.read_text', version: '1.0.0' }],
      completedStepIds: ['read'], stepResults: [{ stepId: 'read', output: { content: 'Guide content' }, observedAt: new Date().toISOString() }],
      currentStepId: 'read', operationSequence: 1 };
    store.saveTask(task);
    const operationId = `${task.id}:read:1.0.0:0`;
    const now = new Date().toISOString();
    store.createOperation({ taskId: task.id, operationId, state: 'executing', createdAt: now, updatedAt: now,
      operation: { operationId, permission: 'filesystem.read', action: 'readText', target: path, reason: 'read', arguments: { path } } });
    store.completeOperation(task.id, operationId, { callId: 'read', ok: true, value: 'Guide content' });
    expect(await service.resumeAfterRestart()).toBe(1);
    const finished = store.getTask(task.id)!;
    expect(finished.status).toBe('COMPLETED');
    expect(finished.correctionState.roundsUsed).toBe(1);
    expect(resumedFeedbackCode).toBe('ANSWER_INCOMPLETE');
    expect(store.listStepOperations(task.id, 'read', '1.0.0')).toHaveLength(1);
  });

  it('finishes a correction round after all steps, not after the first passing step', async () => {
    const { store, directory } = createService();
    const agents: AgentServices = {
      runPlanner: async () => { throw new Error('Use saved plan'); },
      runImplementer: async () => { throw new Error('Use saved tool'); },
      runEvaluator: async input => {
        expect(store.getTask(input.taskId)?.correctionState.roundsUsed).toBe(0);
        return { targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
          verdict: 'pass', status: 'pass', score: 1, failures: [], recommendations: [], evidence: [] };
      },
    };
    const task = store.createTask({ message: 'Transform two items', attachments: [] });
    const candidate: CapabilityRecord = {
      id: 'dynamic.echo', version: '1.0.0', status: 'active', normalizedIntent: 'echo',
      code: 'export async function run(input) { return { value: input.value }; }',
      manifest: { id: 'dynamic.echo', capabilityKey: 'dynamic.echo', version: '1.0.0', kind: 'tool',
        name: 'Echo', description: 'Echo a value', inputSchema: {}, outputSchema: {}, entrypoint: 'tool.mjs',
        runtime: 'node-sandbox-v1', permissions: [], riskLevel: 'low', tests: [],
        provenance: { sourceTaskId: 'builtin', generatedAt: new Date().toISOString() } },
      evaluation: { targetId: 'dynamic.echo', targetVersion: '1.0.0', evaluatorRunId: 'review',
        verdict: 'pass', score: 1, failures: [], recommendations: [] }, createdAt: new Date().toISOString(),
    };
    store.saveCapability(candidate);
    const planner: PlannerDecision = { status: 'ready', intent: 'echo', acceptanceCriteria: ['both values returned'],
      requiredCapabilities: [{ name: 'dynamic.echo', purpose: 'Echo', riskLevel: 'low' }],
      steps: [
        { id: 'first', capabilityKey: 'dynamic.echo', description: 'First', dependsOn: [], input: { value: 'a' } },
        { id: 'second', capabilityKey: 'dynamic.echo', description: 'Second', dependsOn: ['first'], input: { value: 'b' } },
      ] };
    task.status = 'RETRYING';
    task.correctionState.currentRound = { id: 'round-1', ordinal: 1, target: 'plan_or_input', phase: 'implement' };
    task.executionCheckpoint = { planner, capabilityName: candidate.id, capabilityVersion: candidate.version,
      stepBindings: planner.steps.map(step => ({ stepId: step.id, capabilityKey: candidate.id,
        capabilityId: candidate.id, version: candidate.version })), completedStepIds: [], stepResults: [],
      currentStepId: 'first', operationSequence: 0 };
    store.saveTask(task);
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor(), directory);
    const resumed = await createAgentLoop(store, directory, agents, broker).run(task.id);
    expect(resumed.status).toBe('COMPLETED');
    expect(resumed.correctionState.roundsUsed).toBe(1);
    expect(store.listEvents(task.id).filter(event => event.type === 'correction.round_finished')).toHaveLength(1);
  });

  it('reviews a checkpointed result after restart before completing the task', async () => {
    const { store, directory } = createService();
    let reviewCalls = 0;
    const agents: AgentServices = {
      runPlanner: async () => { throw new Error('The saved plan must be used'); },
      runPlannerReview: async input => {
        reviewCalls += 1;
        expect(input.outcome).toEqual({ status: 'success', output: { count: 2 } });
        expect(input.completedStepIds).toEqual(['count']);
        return { action: 'continue', reason: 'The count is verified.' };
      },
      runImplementer: async () => { throw new Error('No tool generation expected'); },
      runEvaluator: async () => { throw new Error('The completed operation must not execute again'); },
    };
    const task = store.createTask({ message: 'Count lines', attachments: [] });
    const planner: PlannerDecision = { status: 'ready', intent: 'count lines', acceptanceCriteria: ['Two lines'],
      requiredCapabilities: [], steps: [{ id: 'count', capabilityKey: 'text.count_lines',
        description: 'Count lines', dependsOn: [], input: { text: 'a\nb' } }] };
    task.status = 'EXECUTING';
    task.executionCheckpoint = { planner, capabilityName: 'text.count_lines', capabilityVersion: '1.0.0',
      stepBindings: [{ stepId: 'count', capabilityKey: 'text.count_lines', capabilityId: 'text.count_lines', version: '1.0.0' }],
      completedStepIds: ['count'], stepResults: [{ stepId: 'count', output: { count: 2 }, observedAt: new Date().toISOString() }],
      currentStepId: 'count', operationSequence: 0,
      pendingReview: { stepId: 'count', outcome: 'success', output: { count: 2 }, safeToReplay: true } };
    store.saveTask(task);
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor(), directory);
    const service = new TaskService(store, createAgentLoop(store, directory, agents, broker), broker);
    expect(await service.resumeAfterRestart()).toBe(1);
    expect(store.getTask(task.id)?.status).toBe('COMPLETED');
    expect(reviewCalls).toBe(1);
    expect(store.listEvents(task.id).filter(event => event.type === 'plan.reviewed')).toHaveLength(1);
  });

  it('resumes an interrupted pure built-in step without a host operation journal', async () => {
    const agents: AgentServices = {
      runPlanner: async () => { throw new Error('Use the saved plan'); },
      runPlannerReview: async () => ({ action: 'continue', reason: 'The count matches the text.' }),
      runImplementer: async () => { throw new Error('No tool generation expected'); },
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        status: 'pass', verdict: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
    };
    const { service, store } = createService(agents);
    const task = store.createTask({ message: 'Count two lines', attachments: [] });
    const planner: PlannerDecision = { status: 'ready', intent: 'count lines', acceptanceCriteria: ['Two lines'],
      requiredCapabilities: [], steps: [{ id: 'count', capabilityKey: 'text.count_lines',
        description: 'Count lines', dependsOn: [], input: { text: 'a\nb' } }] };
    task.status = 'EVALUATING';
    task.executionCheckpoint = { planner, capabilityName: 'text.count_lines', capabilityVersion: '1.0.0',
      stepBindings: [{ stepId: 'count', capabilityKey: 'text.count_lines', capabilityId: 'text.count_lines', version: '1.0.0' }],
      completedStepIds: [], stepResults: [], currentStepId: 'count', operationSequence: 0 };
    store.saveTask(task);
    expect(store.listRecoverableTaskIds()).toContain(task.id);
    expect(await service.resumeAfterRestart()).toBe(1);
    expect(store.getTask(task.id)?.status).toBe('COMPLETED');
    expect(store.listEvents(task.id).filter(event => event.type === 'plan.reviewed')).toHaveLength(1);
  });

  it('requires read-only investigation when a failed host operation may have had side effects', async () => {
    const { store, directory } = createService();
    const firstPath = join(directory, 'first-folder');
    const nextPath = join(directory, 'another-folder');
    const agents: AgentServices = {
      runPlanner: async () => { throw new Error('Use saved plan'); },
      runPlannerReview: async input => {
        expect(input.outcome.status).toBe('failure');
        expect(input.safeToReplay).toBe(false);
        return { action: 'replan', reason: 'Try a different write destination.',
          plan: { status: 'ready', intent: 'create folder elsewhere', acceptanceCriteria: ['Folder exists'],
            requiredCapabilities: [], steps: [{ id: 'different-write', capabilityKey: 'filesystem.mkdir',
              description: 'Create another folder', dependsOn: [], input: { path: nextPath } }] } };
      },
      runImplementer: async () => { throw new Error('No tool generation expected'); },
      runEvaluator: async () => { throw new Error('No operation should execute'); },
    };
    const task = store.createTask({ message: 'Create the requested folder', attachments: [] });
    const planner: PlannerDecision = { status: 'ready', intent: 'create folder', acceptanceCriteria: ['Folder exists'],
      requiredCapabilities: [], steps: [{ id: 'first-write', capabilityKey: 'filesystem.mkdir',
        description: 'Create first folder', dependsOn: [], input: { path: firstPath } }] };
    task.status = 'EXECUTING';
    task.executionCheckpoint = { planner, capabilityName: 'filesystem.mkdir', capabilityVersion: '1.0.0',
      stepBindings: [{ stepId: 'first-write', capabilityKey: 'filesystem.mkdir', capabilityId: 'filesystem.mkdir', version: '1.0.0' }],
      completedStepIds: [], stepResults: [], currentStepId: 'first-write', operationSequence: 0,
      pendingReview: { stepId: 'first-write', outcome: 'failure', safeToReplay: false,
        failure: { stage: 'test', code: 'LIVE_TEST_FAILED', reason: 'The postcondition could not be verified.' } } };
    store.saveTask(task);
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor(), directory);
    const service = new TaskService(store, createAgentLoop(store, directory, agents, broker), broker);
    expect(await service.resumeAfterRestart()).toBe(1);
    expect(store.getTask(task.id)?.status).toBe('BLOCKED');
    expect(existsSync(nextPath)).toBe(false);
  });

  it('blocks restart of a corrected write step when its new operation identity has no journal result', async () => {
    const { store, directory } = createService();
    const target = join(directory, 'hm');
    const agents: AgentServices = {
      runPlanner: async () => { throw new Error('Saved plan must be used'); },
      runImplementer: async () => { throw new Error('Builtin required'); },
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        verdict: 'pass', status: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
    };
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor(), directory);
    const service = new TaskService(store, createAgentLoop(store, directory, agents, broker), broker);
    const task = store.createTask({ message: 'Create hm', attachments: [], permissionMode: 'auto' });
    const planner: PlannerDecision = { status: 'ready', intent: 'create folder', acceptanceCriteria: ['folder exists'],
      requiredCapabilities: [], steps: [{ id: 'mkdir', capabilityKey: 'filesystem.mkdir', description: 'Create hm',
        dependsOn: [], input: { path: target } }] };
    task.status = 'RETRYING';
    task.correctionState.currentRound = { id: 'round-1', ordinal: 1, target: 'plan_or_input', phase: 'implement' };
    task.executionCheckpoint = { planner, capabilityName: 'filesystem.mkdir', capabilityVersion: '1.0.0',
      stepBindings: [{ stepId: 'mkdir', capabilityKey: 'filesystem.mkdir', capabilityId: 'filesystem.mkdir', version: '1.0.0' }],
      completedStepIds: [], stepResults: [], currentStepId: 'mkdir', operationSequence: 1 };
    store.saveTask(task);
    const operationId = `${task.id}:mkdir:1.0.0:0`;
    const now = new Date().toISOString();
    store.createOperation({ taskId: task.id, operationId, state: 'executing', createdAt: now, updatedAt: now,
      operation: { operationId, permission: 'filesystem.write', action: 'mkdir', target, reason: 'create', arguments: { path: target } } });
    store.completeOperation(task.id, operationId, { callId: 'mkdir', ok: true, value: { path: target, created: true } });
    expect(await service.resumeAfterRestart()).toBe(0);
    expect(store.getTask(task.id)?.status).toBe('BLOCKED');
    expect(store.getTask(task.id)?.executionCheckpoint?.operationSequence).toBe(1);
    expect(store.listStepOperations(task.id, 'mkdir', '1.0.0')).toHaveLength(1);
  });

  it('blocks a host-capable step with no operation journal instead of silently retrying it', async () => {
    const { store, directory } = createService();
    writeFileSync(join(directory, 'guide.md'), 'Guide');
    const agents: AgentServices = {
      runPlanner: async () => ({ status: 'ready', intent: 'read guide', acceptanceCriteria: ['read'],
        requiredCapabilities: [], steps: [{ id: 'read', capabilityKey: 'filesystem.read_text',
          description: 'Read guide', dependsOn: [], input: { path: join(directory, 'guide.md') } }] }),
      runImplementer: async () => { throw new Error('No generated tool'); },
      runResponder: async () => 'Guide',
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        verdict: 'pass', status: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
    };
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor(), directory);
    vi.spyOn(broker, 'handle').mockRejectedValue(new Error('Journal unavailable before execution'));
    const task = await new TaskService(store, createAgentLoop(store, directory, agents, broker), broker)
      .createAndWait({ message: 'Read guide', attachments: [], permissionMode: 'request' });
    expect(task.status).toBe('BLOCKED');
    expect(task.correctionState.roundsUsed).toBe(0);
    expect(store.listStepOperations(task.id, 'read', '1.0.0')).toHaveLength(0);
  });

  it('keeps a saved generated version when the main agent rejects speculative replacement', async () => {
    const { service, store } = createService({
      runPlanner: async () => ({ status: 'ready', intent: 'transform text', acceptanceCriteria: ['transform'],
        requiredCapabilities: [{ name: 'dynamic.text.transform', purpose: 'Transform text', riskLevel: 'low' }],
        steps: [{ id: 'transform', capabilityKey: 'dynamic.text.transform', description: 'Transform', dependsOn: [], input: {} }] }),
      runImplementer: async () => { throw new Error('Main agent did not authorize generation'); },
      runCorrection: async () => ({ action: 'block', reason: 'Do not replace this version automatically' }),
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        verdict: 'pass', status: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
    });
    store.saveCapability({ id: 'dynamic.text.transform', version: '1.0.0', status: 'active',
      normalizedIntent: 'transform text', code: 'export async function run() { throw new Error("contract failure"); }',
      manifest: { id: 'dynamic.text.transform', capabilityKey: 'dynamic.text.transform', version: '1.0.0', kind: 'tool',
        name: 'Transform', description: 'Transform text', inputSchema: {}, outputSchema: {}, entrypoint: 'tool.mjs',
        runtime: 'node-sandbox-v1', permissions: [], riskLevel: 'low', tests: [],
        provenance: { sourceTaskId: 'old-task', generatedAt: '2026-09-01T00:00:00.000Z' } },
      evaluation: { targetId: 'dynamic.text.transform', targetVersion: '1.0.0', verdict: 'pass', score: 1,
        failures: [], recommendations: [], evaluatorRunId: 'old-evaluation' }, createdAt: '2026-09-01T00:00:00.000Z' });
    const task = await service.createAndWait({ message: 'Transform text', attachments: [] });
    expect(task.status).toBe('BLOCKED');
    expect(store.getCapabilityVersion('dynamic.text.transform', '1.0.0')?.status).toBe('active');
    expect(store.listEvents(task.id).some(event => event.type === 'capability.quarantined')).toBe(false);
  });

  it('ignores a previously saved generated tool when generation is unavailable', async () => {
    const { store, directory } = createService();
    const agents: AgentServices = {
      runPlanner: async () => ({ status: 'ready', intent: 'echo', acceptanceCriteria: ['echoed'],
        requiredCapabilities: [{ name: 'dynamic.echo', purpose: 'Echo input', riskLevel: 'low' }],
        steps: [{ id: 'echo', capabilityKey: 'dynamic.echo', description: 'Echo', dependsOn: [], input: { value: 'a' } }] }),
      runImplementer: async () => { throw new Error('Must not replace the valid tool'); },
      runCorrection: async () => ({ action: 'rebuild_generated_tool', reason: 'Suspected defect' }),
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        verdict: 'pass', status: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
    };
    store.saveCapability({ id: 'dynamic.echo', version: '1.0.0', status: 'active', normalizedIntent: 'echo',
      code: 'export async function run(input) { return { value: input.value }; }',
      manifest: { id: 'dynamic.echo', capabilityKey: 'dynamic.echo', version: '1.0.0', kind: 'tool',
        name: 'Echo', description: 'Echo', inputSchema: {}, outputSchema: {}, entrypoint: 'tool.mjs',
        runtime: 'node-sandbox-v1', permissions: [], riskLevel: 'low', tests: [],
        provenance: { sourceTaskId: 'old-task', generatedAt: new Date().toISOString() } },
      evaluation: { targetId: 'dynamic.echo', targetVersion: '1.0.0', evaluatorRunId: 'old',
        verdict: 'pass', score: 1, failures: [], recommendations: [] }, createdAt: new Date().toISOString() });
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor(), directory);
    const regularTester = new TestAgent(new ModelGateway(new MockModelProvider()));
    const tester: Pick<TestAgent, 'generate' | 'review' | 'reviewAnswer'> = {
      generate: async () => { throw new Error('Tester offline'); },
      review: (...args) => regularTester.review(...args),
      reviewAnswer: (...args) => regularTester.reviewAnswer(...args),
    };
    const task = await new TaskService(store, createAgentLoop(store, directory, agents, broker,
      new WindowsDesktopObserver(), tester), broker).createAndWait({ message: 'Echo a', attachments: [] });
    expect(task.status, task.result).toBe('FAILED');
    expect(task.result).toContain('Must not replace the valid tool');
    expect(store.getCapabilityVersion('dynamic.echo', '1.0.0')?.status).toBe('active');
    expect(store.listEvents(task.id).some(event => event.type === 'capability.quarantined')).toBe(false);
  });

  it('does not load a previously saved generated tool with an invalid input contract', async () => {
    const { store, directory } = createService();
    const agents: AgentServices = {
      runPlanner: async () => ({ status: 'ready', intent: 'read', acceptanceCriteria: ['read'],
        requiredCapabilities: [{ name: 'dynamic.reader', purpose: 'Read a file', riskLevel: 'low' }],
        steps: [{ id: 'read', capabilityKey: 'dynamic.reader', description: 'Read', dependsOn: [], input: {} }] }),
      runImplementer: async () => { throw new Error('Must not replace the tool'); },
      runCorrection: async () => ({ action: 'rebuild_generated_tool', reason: 'Tool returned invalid path' }),
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        verdict: 'pass', status: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
    };
    store.saveCapability({ id: 'dynamic.reader', version: '1.0.0', status: 'active', normalizedIntent: 'read',
      code: 'export async function run(input, host) { return await host.process.run({ command: input.command, args: input.args }); }',
      manifest: { id: 'dynamic.reader', capabilityKey: 'dynamic.reader', version: '1.0.0', kind: 'tool',
        name: 'Reader', description: 'Read', inputSchema: { type: 'object', required: ['command', 'args'],
          properties: { command: { type: 'string', minLength: 1 }, args: { type: 'array' } } }, outputSchema: {}, entrypoint: 'tool.mjs',
        runtime: 'node-sandbox-v1', permissions: ['process'], riskLevel: 'low', tests: [],
        provenance: { sourceTaskId: 'old-task', generatedAt: new Date().toISOString() } },
      evaluation: { targetId: 'dynamic.reader', targetVersion: '1.0.0', evaluatorRunId: 'old',
        verdict: 'pass', score: 1, failures: [], recommendations: [] }, createdAt: new Date().toISOString() });
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor(), directory);
    const task = await new TaskService(store, createAgentLoop(store, directory, agents, broker), broker)
      .createAndWait({ message: 'Read a file', attachments: [] });
    expect(task.status).toBe('FAILED');
    expect(store.getCapabilityVersion('dynamic.reader', '1.0.0')?.status).toBe('active');
    expect(store.listEvents(task.id).some(event => event.type === 'capability.quarantined')).toBe(false);
  });

  it('replans a failed read step from evaluator feedback instead of repeating its bad path', async () => {
    const { store, directory } = createService();
    const validPath = join(directory, 'exists.md');
    writeFileSync(validPath, 'Verified guide content');
    let planCalls = 0;
    const plannedPaths: string[] = [];
    const agents: AgentServices = {
      runPlanner: async input => {
        planCalls += 1;
        const path = input.feedback ? validPath : join(directory, 'missing.md');
        plannedPaths.push(path);
        return { status: 'ready', intent: 'summarize guide', acceptanceCriteria: ['Summarize guide'],
          requiredCapabilities: [], steps: [{ id: 'read', capabilityKey: 'filesystem.read_text',
            description: 'Read guide', dependsOn: [], input: { path } }] };
      },
      runImplementer: async () => { throw new Error('Builtin reader required'); },
      runCorrection: async () => ({ action: 'revise_plan_or_input', reason: 'Fix the file path' }),
      runResponder: async input => String((input.results[0]?.output as { content?: string })?.content),
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        verdict: 'pass', status: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
    };
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor(), directory);
    const task = await new TaskService(store, createAgentLoop(store, directory, agents, broker), broker)
      .createAndWait({ message: 'Summarize the guide', attachments: [], permissionMode: 'request' });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(planCalls).toBe(2);
    expect(plannedPaths).toEqual([join(directory, 'missing.md'), validPath]);
    expect(task.correctionState.roundsUsed).toBe(1);
    expect(task.result).toContain('Verified guide content');
    expect(store.listStepOperations(task.id, 'read', '1.0.0')).toHaveLength(2);
  });

  it('shares the five-round budget between tool construction and step evaluation', async () => {
    let version = 0;
    let toolEvaluations = 0;
    const base = new AgentRunner(new ModelGateway(new MockModelProvider()));
    const agents: AgentServices = {
      runPlanner: input => base.runPlanner(input),
      runImplementer: async input => {
        const result = await base.runImplementer(input);
        return { kind: 'tool_candidate', candidate: { ...result.candidate, version: `1.0.${version++}` } };
      },
      runCorrection: async input => ({ action: input.failure.stage === 'tool' ? 'rebuild_generated_tool' : 'revise_plan_or_input',
        reason: input.failure.reason }),
      runEvaluator: async input => {
        const result = await base.runEvaluator(input);
        if (input.phase === 'tool' && toolEvaluations++ === 0) return {
          ...result, status: 'retry', verdict: 'revise', failures: [{ code: 'TOOL_BAD', message: 'Tool contract incomplete' }],
        };
        if (input.phase === 'execution') return {
          ...result, status: 'retry', verdict: 'revise', failures: [{ code: 'STEP_BAD', message: 'Step result incomplete' }],
        };
        return result;
      },
    };
    const { service, store } = createService(agents);
    const task = await service.createAndWait({ message: 'Count lines', attachments: [
      { id: 'text', filename: 'lines.txt', mimeType: 'text/plain', size: 4, content: 'a\nb\n' },
    ] });
    expect(task.status).toBe('FAILED');
    expect(task.correctionState.roundsUsed).toBe(5);
    expect(task.metrics.retryCount).toBe(5);
    expect(store.listEvents(task.id).filter(event => event.type === 'correction.round_finished')).toHaveLength(5);
  });

  it('shares five complete answer-correction rounds across a whole draft-answer task', async () => {
    let evaluations = 0;
    const agents: AgentServices = {
      runPlanner: async () => ({ status: 'answer', answer: '初稿', intent: 'draft presentation copy',
        acceptanceCriteria: ['A complete presentation draft'], requiredCapabilities: [], steps: [] }),
      runImplementer: async () => { throw new Error('No tool required'); },
      runDraftCorrection: async () => `修订稿 ${evaluations}`,
      runCorrection: async () => ({ action: 'revise_answer', reason: 'Try correcting the answer' }),
      runEvaluator: async input => {
        evaluations += 1;
        return { targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'answer-review',
          status: 'retry', verdict: 'revise', score: 0, recommendations: [], evidence: [],
          failures: [{ code: 'ANSWER_INCOMPLETE', message: 'Missing a required explanation' }] };
      },
    };
    const { service, store } = createService(agents);
    const task = await service.createAndWait({ message: '请写一份 6 页的PPT文案与页面结构，只给文案不生成文件', attachments: [] });
    expect(task.status).toBe('FAILED');
    expect(task.correctionState.roundsUsed).toBe(5);
    expect(task.metrics.retryCount).toBe(5);
    expect(evaluations).toBe(6);
    expect(store.listEvents(task.id).filter(event => event.type === 'correction.round_finished')).toHaveLength(5);
    expect(task.result).toContain('Missing a required explanation');
  });

  it('corrects a rejected file summary from the verified read without reading or generating again', async () => {
    const { store, directory } = createService();
    writeFileSync(join(directory, 'guide.md'), 'Section one. Section two. Section three.');
    const responder = vi.fn(async (input: import('../../src/agents/agent-runner.js').ResponseInput) =>
      input.feedback ? '三节内容：第一、第二和第三节。' : '两节内容：第一和第二节。');
    let answerReviews = 0;
    const agents: AgentServices = {
      runPlanner: async () => ({ status: 'ready', intent: 'summarize guide',
        acceptanceCriteria: ['Summarize all three sections'], requiredCapabilities: [],
        steps: [{ id: 'read-document', capabilityKey: 'filesystem.read_text', description: 'Read guide',
          dependsOn: [], input: { path: join(directory, 'guide.md') } }] }),
      runImplementer: async () => { throw new Error('No generated tool is needed'); },
      runResponder: responder,
      runCorrection: async () => ({ action: 'revise_answer', reason: 'Missing third section' }),
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate',
        evaluatorRunId: 'review', verdict: input.target === 'task-answer'
          && !(input.output as { answer: string }).answer.includes('第三') ? 'revise' : 'pass',
        status: input.target === 'task-answer'
          && !(input.output as { answer: string }).answer.includes('第三') ? 'retry' : 'pass',
        score: 1, failures: input.target === 'task-answer'
          && !(input.output as { answer: string }).answer.includes('第三')
          ? [{ code: 'ANSWER_MISMATCH', message: 'Missing third section' }] : [], recommendations: [], evidence: [] }),
    };
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor(), directory);
    const tester = new TestAgent(new ModelGateway(new MockModelProvider()));
    const loop = createAgentLoop(store, directory, agents, broker, new WindowsDesktopObserver(), {
      generate: tester.generate.bind(tester), review: tester.review.bind(tester),
      reviewAnswer: async (...args) => { answerReviews += 1; return tester.reviewAnswer(...args); },
    });
    const task = await new TaskService(store, loop, broker).createAndWait({
      message: '总结 guide.md 的三节内容', attachments: [], permissionMode: 'request',
    });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(task.correctionState.roundsUsed).toBe(1);
    expect(task.metrics.generatedCapabilityCount).toBe(0);
    expect(store.listStepOperations(task.id, 'read-document', '1.0.0')).toHaveLength(1);
    expect(responder).toHaveBeenCalledTimes(2);
    expect(responder.mock.calls[1]?.[0].feedback?.reason).toContain('third section');
    expect(answerReviews).toBe(2);
  });

  it('reads a local file through the maintained capability and returns a grounded summary', async () => {
    const base = new AgentRunner(new ModelGateway(new MockModelProvider()));
    let responseInput: import('../../src/agents/agent-runner.js').ResponseInput | undefined;
    const { store, directory } = createService();
    const agents: AgentServices = {
      runPlanner: async () => ({ status: 'ready', intent: 'summarize local document',
        acceptanceCriteria: ['Summarize the document in Chinese'], requiredCapabilities: [],
        steps: [{ id: 'read-document', capabilityKey: 'filesystem.read_text', description: 'Read the requested document',
          dependsOn: [], input: { path: join(directory, 'guide.md') } }] }),
      runImplementer: input => base.runImplementer(input),
      runEvaluator: input => base.runEvaluator(input),
      runResponder: async input => {
        responseInput = input;
        return '这份指南介绍了多智能体任务拆解与测试。';
      },
    };
    const content = '多智能体指南：先拆解任务，再验证工具。';
    writeFileSync(join(directory, 'guide.md'), content);
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor(), directory);
    const task = await new TaskService(store, createAgentLoop(store, directory, agents, broker), broker)
      .createAndWait({ message: '请总结 guide.md', attachments: [], permissionMode: 'request' });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(task.result).toBe('这份指南介绍了多智能体任务拆解与测试。');
    expect(responseInput?.results[0]?.output).toEqual({ content });
    expect(task.metrics.generatedCapabilityCount).toBe(0);
  });

  it('does not claim a file summary is complete when no response agent is configured', async () => {
    const base = new AgentRunner(new ModelGateway(new MockModelProvider()));
    const { store, directory } = createService();
    writeFileSync(join(directory, 'guide.md'), 'Guide content');
    const agents: AgentServices = {
      runPlanner: async () => ({ status: 'ready', intent: 'summarize local document',
        acceptanceCriteria: ['Summarize the document'], requiredCapabilities: [],
        steps: [{ id: 'read-document', capabilityKey: 'filesystem.read_text', description: 'Read guide',
          dependsOn: [], input: { path: join(directory, 'guide.md') } }] }),
      runImplementer: input => base.runImplementer(input),
      runEvaluator: input => base.runEvaluator(input),
    };
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor(), directory);
    const task = await new TaskService(store, createAgentLoop(store, directory, agents, broker), broker)
      .createAndWait({ message: 'Summarize guide.md', attachments: [], permissionMode: 'request' });
    expect(task.status).toBe('BLOCKED');
    expect(task.result).toMatch(/总结|回答/);
    expect(store.listStepOperations(task.id, 'read-document', '1.0.0')).toHaveLength(0);
  });

  it('does not compose a successful answer from an HTTP error', async () => {
    const fallback = new MockModelProvider();
    const roles: string[] = [];
    const agents = new AgentRunner(new ModelGateway({ complete: async request => {
      roles.push(request.role);
      return request.role === 'planner'
        ? { data: { status: 'ready', intent: 'weather', requiredCapabilities: [], acceptanceCriteria: ['weather data'],
          steps: [{ id: 'weather', capabilityKey: 'network.request', description: 'Fetch weather', dependsOn: [],
            input: { url: 'https://weather.example.test/current', method: 'GET' } }] }, usage: { inputTokens: 1, outputTokens: 1 } }
        : fallback.complete(request);
    } }));
    const { store, directory } = createService(agents);
    const fetch = vi.fn(async () => new Response('Invalid API key', { status: 401 }));
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor({ fetch }), directory);
    const task = await new TaskService(store, createAgentLoop(store, directory, agents, broker), broker)
      .createAndWait({ message: '深圳天气', attachments: [], permissionMode: 'full' });
    expect(task.status).toBe('BLOCKED');
    expect(roles).not.toContain('responder');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['full', 'request'] as const)('returns a grounded network answer after real execution in %s mode', async permissionMode => {
    const fallback = new MockModelProvider();
    const modelRequests: Array<{ role: string; user: string }> = [];
    const agents = new AgentRunner(new ModelGateway({ complete: async request => {
      modelRequests.push(request);
      const data = request.role === 'planner' ? {
        intent: 'weather', status: 'ready', acceptanceCriteria: ['用中文给出深圳当前气温及来源'], requiredCapabilities: [],
        steps: [{ id: 'weather', capabilityKey: 'network.request', description: 'Fetch Shenzhen current weather', dependsOn: [],
          input: { url: 'https://weather.example.test/current?city=Shenzhen', method: 'GET' } }],
      } : request.role === 'responder' ? { summary: '深圳当前气温 27.9°C。来源：https://weather.example.test/current?city=Shenzhen',
        details: [], warnings: [], nextSteps: [] } : undefined;
      if (request.role === 'implementer') throw new Error('Network results must not require a generated summary tool.');
      return data ? { data, usage: { inputTokens: 1, outputTokens: 1 } } : fallback.complete(request);
    } }));
    const { store, directory } = createService(agents);
    const fetch = vi.fn(async () => new Response('{"current":{"temperature_2m":27.9,"time":"2026-09-24T09:15"}}', { status: 200 }));
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor({ fetch }), directory);
    const tester = new TestAgent(new ModelGateway({ complete: async request => {
      if (request.role === 'tester.review') throw new Error('Maintained network evidence needs no model review.');
      return fallback.complete(request);
    } }));
    const loop = createAgentLoop(store, directory, agents, broker, new WindowsDesktopObserver(), tester);
    const service = new TaskService(store, loop, broker);
    let task = await service.createAndWait({ message: '广东深圳的天气怎么样', attachments: [], permissionMode });
    if (permissionMode === 'request') {
      expect(task.status).toBe('WAITING_FOR_APPROVAL');
      expect(fetch).not.toHaveBeenCalled();
      task = await new TaskService(store, createAgentLoop(store, directory, agents, broker,
        new WindowsDesktopObserver(), tester), broker)
        .resolveApproval(task.id, task.pendingPermission!.requestId, true);
    }
    expect(task.status, task.result).toBe('COMPLETED');
    expect(task.result).toContain('结果摘要：\n深圳当前气温 27.9°C。来源：https://weather.example.test/current?city=Shenzhen');
    expect(store.listEvents(task.id).find(event => event.type === 'answer.sources')?.payload.sources)
      .toEqual([{ title: 'weather.example.test', url: 'https://weather.example.test/current?city=Shenzhen' }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(task.metrics.generatedCapabilityCount).toBe(0);
    const responseInput = JSON.parse(modelRequests.find(request => request.role === 'responder')!.user);
    expect(responseInput.message).toBe('广东深圳的天气怎么样');
    const finalEvaluation = modelRequests.filter(request => request.role === 'evaluator')
      .map(request => JSON.parse(request.user)).find(request => request.target === 'task-answer');
    expect(finalEvaluation).toBeUndefined();
    expect(store.listEvents(task.id).some(event => event.type === 'test.report')).toBe(false);
    expect(store.listEvents(task.id).some(event => event.type === 'step.verified')).toBe(true);
    expect(modelRequests.filter(request => request.role === 'evaluator')
      .map(request => JSON.parse(request.user)).filter(request => request.target === 'network.request')).toHaveLength(0);
    expect(responseInput.results[0]).toMatchObject({ stepId: 'weather',
      sourceUrl: 'https://weather.example.test/current?city=Shenzhen',
      output: { status: 200, ok: true, body: '{"current":{"temperature_2m":27.9,"time":"2026-09-24T09:15"}}' } });
  });

  it('searches the screenshot news question in default request mode and shows article sources', async () => {
    const fallback = new MockModelProvider();
    const requests: Array<{ role: string; user: string }> = [];
    const agents = new AgentRunner(new ModelGateway({ complete: async request => {
      requests.push(request);
      if (request.role === 'planner' || request.role === 'planner.route') {
        throw new Error('A public news question must not become an ungrounded direct answer.');
      }
      if (request.role === 'responder') return { data: { summary: '2026 年的尊界 V800 刹车踏板测试引发争议，报道日期为 10 月 13 日。', details: [], warnings: [], nextSteps: [] },
        usage: { inputTokens: 1, outputTokens: 1 } };
      return fallback.complete(request);
    } }));
    const { store, directory } = createService(agents);
    const rss = `<rss><channel><item><title>尊界V800事件：一场煞车测试如何演变成舆论风暴 - BBC</title>
      <link>https://news.google.com/rss/articles/article-1</link>
      <pubDate>Tue, 13 Oct 2026 09:00:00 GMT</pubDate><source>BBC</source></item></channel></rss>`;
    const fetch = vi.fn(async () => new Response(rss, { status: 200 }));
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor({ fetch }), directory);
    const service = () => new TaskService(store, createAgentLoop(store, directory, agents, broker), broker);
    const question = '前段时间，华为的汽车踏板断裂事件影响很大，你跟我说下那个事情发生了什么';
    let task = await service().createAndWait({ message: question, attachments: [], permissionMode: 'request' });
    expect(task.status).toBe('WAITING_FOR_APPROVAL');
    expect(fetch).not.toHaveBeenCalled();
    expect(task.pendingPermission?.operation.target).toContain('news.google.com/rss/search');
    task = await service().resolveApproval(task.id, task.pendingPermission!.requestId, true);
    expect(task.status, task.result).toBe('COMPLETED');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.listEvents(task.id).find(event => event.type === 'research.searched')?.payload.sourceCount).toBe(1);
    expect(store.listEvents(task.id).find(event => event.type === 'answer.sources')?.payload.sources)
      .toEqual([{ title: '尊界V800事件：一场煞车测试如何演变成舆论风暴 - BBC',
        url: 'https://news.google.com/rss/articles/article-1' }]);
    const response = JSON.parse(requests.find(request => request.role === 'responder')!.user);
    expect(response.results[0].output.articles[0].publishedAt).toBe('2026-10-13T09:00:00.000Z');
    expect(response.results[0].output.body).toBeUndefined();
  });

  it('does not answer a news question when the live feed has no articles', async () => {
    const agents = new AgentRunner(new ModelGateway({ complete: async request => {
      if (request.role === 'responder') throw new Error('The responder must not invent a news answer.');
      return new MockModelProvider().complete(request);
    } }));
    const { store, directory } = createService(agents);
    const fetch = vi.fn(async () => new Response('<rss><channel></channel></rss>', { status: 200 }));
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor({ fetch }), directory);
    const task = await new TaskService(store, createAgentLoop(store, directory, agents, broker), broker)
      .createAndWait({ message: '最近的华为汽车踏板断裂事件怎么回事', attachments: [], permissionMode: 'full' });
    expect(task.status).toBe('BLOCKED');
    expect(task.result).toContain('未返回可核对的文章');
  });

  it('retains earlier network results when a later step resumes from approval', async () => {
    const base = new AgentRunner(new ModelGateway(new MockModelProvider()));
    let response: import('../../src/agents/agent-runner.js').ResponseInput | undefined;
    const agents: AgentServices = {
      runPlanner: async () => ({ status: 'ready', intent: 'compare weather', acceptanceCriteria: ['compare both cities'], requiredCapabilities: [],
        steps: ['first', 'second'].map((id, index) => ({ id, capabilityKey: 'network.request', description: `Read ${id} city`,
          dependsOn: index === 0 ? [] : ['first'], input: { url: `https://weather.example.test/${id}`, method: 'GET' } })) }),
      runEvaluator: input => base.runEvaluator(input), runImplementer: input => base.runImplementer(input),
      runResponder: async input => { response = input; return '两地天气已对比。'; },
    };
    const { store, directory } = createService(agents);
    const fetch = vi.fn(async (url: string | URL | Request) => new Response(String(url).endsWith('/first') ? 'first city: 27' : 'second city: 29'));
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor({ fetch }), directory);
    const service = () => new TaskService(store, createAgentLoop(store, directory, agents, broker), broker);
    let task = await service().createAndWait({ message: 'Compare weather in two cities', attachments: [], permissionMode: 'request' });
    task = await service().resolveApproval(task.id, task.pendingPermission!.requestId, true);
    expect(task.status).toBe('WAITING_FOR_APPROVAL');
    expect(task.executionCheckpoint?.completedStepIds).toEqual(['first']);
    task = await service().resolveApproval(task.id, task.pendingPermission!.requestId, true);
    expect(task.status, task.result).toBe('COMPLETED');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(response?.results.map(result => result.output)).toEqual([
      expect.objectContaining({ body: 'first city: 27' }), expect.objectContaining({ body: 'second city: 29' }),
    ]);
  });

  it('marks a capability-building task from a previous process as blocked with resubmit guidance', async () => {
    const { service, store } = createService();
    const task = store.createTask({ message: 'Create folder', attachments: [], permissionMode: 'request' });
    task.status = 'CAPABILITY_BUILDING';
    store.saveTask(task);
    await service.resumeAfterRestart();
    const recovered = store.getTask(task.id);
    expect(recovered?.status).toBe('BLOCKED');
    expect(recovered?.result).toContain('重新提交');
    expect(store.listEvents(task.id).some((event) => event.type === 'task.blocked')).toBe(true);
  });

  it('does not activate a launch canary when its window never reaches the foreground', async () => {
    const base = new AgentRunner(new ModelGateway(new MockModelProvider()));
    const agents: AgentServices = {
      runPlanner: async () => ({ intent: 'launch local app', acceptanceCriteria: ['window foreground'], requiredCapabilities: [],
        steps: [{ id: 'launch', capabilityKey: 'process.launch', description: 'Launch app', dependsOn: [],
          input: { applicationName: '网易云音乐', args: [] } }], status: 'ready' }),
      runEvaluator: (input) => base.runEvaluator(input),
      runImplementer: (input) => base.runImplementer(input),
    };
    const { store, directory } = createService(agents);
    const calls: HostCall[] = [];
    const broker = new PermissionBroker(store, { execute: async (call) => {
      calls.push(call);
      return { callId: call.callId, ok: true, value: { started: true, pid: 4321 } };
    } }, directory);
    const loop = createAgentLoop(store, directory, agents, broker,
      new WindowsDesktopObserver(async () => ({ running: true, visible: true, foreground: false }), 'win32', 0),
      new TestAgent(new ModelGateway(new MockModelProvider())),
      async () => ({ status: 'resolved', executable: 'C:\\Apps\\cloudmusic.exe', processName: 'cloudmusic' }));
    const task = await new TaskService(store, loop, broker)
      .createAndWait({ message: 'Open music', attachments: [], permissionMode: 'full' });
    expect(task.status).toBe('BLOCKED');
    expect(calls).toHaveLength(1);
    expect(store.getActive('process.launch')).toBeNull();
    expect(store.getCapabilityVersion('process.launch', '1.0.0')?.status).toBe('canary');
  });

  it('reuses parameterized network GET and blocks an unavailable location provider', async () => {
    const base = new AgentRunner(new ModelGateway(new MockModelProvider()));
    const agents: AgentServices = {
      runPlanner: async (input) => input.message.includes('location')
        ? { intent: 'current location', acceptanceCriteria: ['valid coordinates'], requiredCapabilities: [],
          steps: [{ id: 'location', capabilityKey: 'location.current', description: 'Find current location', dependsOn: [], input: {} }], status: 'ready' }
        : { intent: 'fetch a URL', acceptanceCriteria: ['HTTP success'], requiredCapabilities: [],
          steps: [{ id: 'fetch', capabilityKey: 'network.request', description: 'Fetch URL', dependsOn: [],
            input: { url: input.message.includes('first') ? 'https://first.example.test/' : 'https://second.example.test/', method: 'GET' } }], status: 'ready' },
      runEvaluator: (input) => base.runEvaluator(input),
      runImplementer: (input) => base.runImplementer(input),
    };
    const { store, directory } = createService(agents);
    const broker = new PermissionBroker(store, { execute: async (call) => ({ callId: call.callId, ok: true,
      value: call.permission === 'location' ? { supported: false, reason: 'No provider' }
        : { status: 200, ok: true, body: 'sample', headers: {} },
    }) }, directory);
    const service = new TaskService(store, createAgentLoop(store, directory, agents, broker), broker);
    const first = await service.createAndWait({ message: 'Fetch first URL', attachments: [], permissionMode: 'full' });
    const second = await service.createAndWait({ message: 'Fetch second URL', attachments: [], permissionMode: 'full' });
    const location = await service.createAndWait({ message: 'Get location', attachments: [], permissionMode: 'full' });
    expect(first.status).toBe('COMPLETED');
    expect(second.status).toBe('COMPLETED');
    expect(first.metrics.generatedCapabilityCount + second.metrics.generatedCapabilityCount).toBe(0);
    expect(store.getActive('network.request')?.version).toBe('1.0.0');
    expect(location.status).toBe('BLOCKED');
    expect(store.getActive('location.current')).toBeNull();
  });

  it('finishes a bounded short command without requiring a desktop window', async () => {
    const base = new AgentRunner(new ModelGateway(new MockModelProvider()));
    const agents: AgentServices = {
      runPlanner: async () => ({ intent: 'run short command', acceptanceCriteria: ['command exited successfully'], requiredCapabilities: [],
        steps: [{ id: 'run-command', capabilityKey: 'process.run', description: 'Run bounded command', dependsOn: [],
          input: { command: 'node.exe', args: ['--version'] } }], status: 'ready' }),
      runEvaluator: (input) => base.runEvaluator(input),
      runImplementer: (input) => base.runImplementer(input),
    };
    const { store, directory } = createService(agents);
    const broker = new PermissionBroker(store, { execute: async (call) => ({
      callId: call.callId, ok: true, value: { exitCode: 0, stdout: 'v24.0.0', stderr: '' },
    }) }, directory);
    const loop = createAgentLoop(store, directory, agents, broker, new WindowsDesktopObserver(async () => null, 'win32'));
    const task = await new TaskService(store, loop, broker)
      .createAndWait({ message: 'Run node version', attachments: [], permissionMode: 'full' });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(task.result).toContain('v24.0.0');
  });

  it('reviews an existing verified source archive without running git or deleting files', async () => {
    const remote = 'https://github.com/deepseek-ai/deepseek-harness.git';
    const agents: AgentServices = {
      runPlanner: async input => {
        const destination = join(input.workspaceRoot!, 'deepseek-code');
        return { status: 'ready', intent: 'get repository source', acceptanceCriteria: ['Source code is in destination'],
          requiredCapabilities: [], steps: [
            { id: 'folder', capabilityKey: 'filesystem.mkdir', description: 'Create destination', dependsOn: [],
              input: { path: destination } },
            { id: 'clone', capabilityKey: 'process.run', description: 'Get source', dependsOn: ['folder'],
              input: { command: 'git', args: ['clone', '--depth', '1', remote, '.'], cwd: destination } },
          ] };
      },
      runImplementer: async () => { throw new Error('Built-ins must be reused'); },
      runEvaluator: async input => ({ targetId: input.target, targetVersion: 'candidate', evaluatorRunId: 'review',
        status: 'pass', verdict: 'pass', score: 1, failures: [], recommendations: [], evidence: [] }),
      runPlannerReview: async input => ({ action: 'continue', reason: `Verified ${input.step.id}` }),
    };
    const { service, store, directory } = createService(agents);
    const destination = join(directory, 'deepseek-code');
    mkdirSync(destination);
    const readme = '# DeepSeek Harness';
    const pkg = '{"name":"@deepseek-ai/dsh-root"}';
    writeFileSync(join(destination, 'README.md'), readme);
    writeFileSync(join(destination, 'package.json'), pkg);
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    writeFileSync(join(destination, '.jarvis-source.json'), JSON.stringify({ schemaVersion: 1,
      kind: 'github-source-archive', repositoryUrl: remote.replace(/\.git$/, ''),
      readmeSha256: hash(readme), packageSha256: hash(pkg) }));
    const task = await service.createAndWait({ message: '把该仓库的代码放到 deepseek-code', attachments: [], permissionMode: 'full' });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(task.result).toContain('源码归档');
    expect(store.listStepOperations(task.id, 'clone', '1.0.0')).toHaveLength(0);
    expect(store.listEvents(task.id).some(event => event.type === 'step.verified'
      && event.payload.source === 'existing_repository')).toBe(true);
  });

  it('reuses one launch capability for two distinct applications after real-observation evidence', async () => {
    const base = new AgentRunner(new ModelGateway(new MockModelProvider()));
    let evaluatorCalls = 0;
    const agents: AgentServices = {
      runPlanner: async (input) => ({ intent: 'launch a local application', acceptanceCriteria: ['window foreground'], requiredCapabilities: [],
        steps: [{ id: 'launch', capabilityKey: 'process.launch', description: 'Launch app', dependsOn: [],
          input: { applicationName: input.message.includes('网易') ? '网易云音乐' : '百度网盘', args: [] } }], status: 'ready' }),
      runEvaluator: (input) => { evaluatorCalls += 1; return base.runEvaluator(input); },
      runImplementer: (input) => base.runImplementer(input),
    };
    const { store, directory } = createService(agents);
    const calls: HostCall[] = [];
    const broker = new PermissionBroker(store, { execute: async (call) => {
      calls.push(call);
      return { callId: call.callId, ok: true, value: { started: true, pid: 4321 } };
    } }, directory);
    const resolver = async (name: string): Promise<ApplicationResolution> => ({
      status: 'resolved', executable: name === '网易云音乐' ? 'C:\\Apps\\cloudmusic.exe' : 'C:\\Apps\\BaiduNetdisk.exe',
      processName: name === '网易云音乐' ? 'cloudmusic' : 'BaiduNetdisk',
    });
    const loop = createAgentLoop(store, directory, agents, broker,
      new WindowsDesktopObserver(async () => ({ running: true, visible: true, foreground: true }), 'win32'),
      new TestAgent(new ModelGateway(new MockModelProvider())), resolver);
    const service = new TaskService(store, loop, broker);
    const first = await service.createAndWait({ message: '打开网易云音乐', attachments: [], permissionMode: 'full' });
    const second = await service.createAndWait({ message: '打开百度网盘', attachments: [], permissionMode: 'full' });
    expect(first.status, first.result).toBe('COMPLETED');
    expect(second.status, second.result).toBe('COMPLETED');
    expect(calls.map((call) => call.target)).toEqual(['C:\\Apps\\cloudmusic.exe', 'C:\\Apps\\BaiduNetdisk.exe']);
    expect(first.metrics.generatedCapabilityCount + second.metrics.generatedCapabilityCount).toBe(0);
    expect(store.getActive('process.launch')?.version).toBe('1.0.0');
    expect(evaluatorCalls).toBe(0);
    expect([...store.listEvents(first.id), ...store.listEvents(second.id)]
      .filter(event => event.type === 'test.report')).toHaveLength(0);
    expect(store.listEvents(first.id).some(event => event.type === 'step.verified')).toBe(true);
  });

  it('binds a directory step and a read step to their own reusable capabilities', async () => {
    let workspace = '';
    const base = new AgentRunner(new ModelGateway(new MockModelProvider()));
    const agents: AgentServices = {
      runPlanner: async () => ({ intent: 'create and read', acceptanceCriteria: ['directory exists', 'file content returned'],
        requiredCapabilities: [
          { name: 'filesystem.mkdir', purpose: 'Create directory', riskLevel: 'medium' },
          { name: 'filesystem.read_text', purpose: 'Read file', riskLevel: 'low' },
        ],
        steps: [
          { id: 'make-dir', capabilityKey: 'filesystem.mkdir', description: 'Create directory', dependsOn: [], input: { path: join(workspace, 'created') } },
          { id: 'read-file', capabilityKey: 'filesystem.read_text', description: 'Read file', dependsOn: ['make-dir'], input: { path: join(workspace, 'notes.txt') } },
        ], status: 'ready' }),
      runEvaluator: (input) => base.runEvaluator(input),
      runImplementer: (input) => base.runImplementer(input),
      runResponder: async (input) => String((input.results.at(-1)?.output as { content?: string } | undefined)?.content ?? ''),
    };
    const { service, store, directory } = createService(agents);
    workspace = directory;
    writeFileSync(join(directory, 'notes.txt'), 'two targets, two tools', 'utf8');
    const task = await service.createAndWait({ message: 'Create a folder then read my notes', attachments: [], permissionMode: 'full' });
    expect(task.status, task.result).toBe('COMPLETED');
    expect(existsSync(join(directory, 'created'))).toBe(true);
    expect(task.result).toContain('two targets, two tools');
    expect(task.metrics.generatedCapabilityCount).toBe(0);
    expect(store.listEvents(task.id).filter((event) => event.type === 'step.completed').map((event) => event.payload.stepId))
      .toEqual(['make-dir', 'read-file']);
  });

  it('never publishes a generated folder tool hardcoded to the first target', async () => {
    const base = new AgentRunner(new ModelGateway(new MockModelProvider()));
    const agents: AgentServices = {
      runPlanner: async () => ({ intent: 'create a folder', acceptanceCriteria: ['directory created'],
        requiredCapabilities: [{ name: 'dynamic.filesystem.mkdir', purpose: 'Create a directory', riskLevel: 'medium' }],
        steps: [{ id: 'mkdir-1', capabilityKey: 'dynamic.filesystem.mkdir', description: 'Create a directory', dependsOn: [],
          input: { path: 'D:/tmp/alpha' } }], status: 'ready' }),
      runEvaluator: (input) => base.runEvaluator(input),
      runImplementer: async () => ({ kind: 'tool_candidate', candidate: {
        id: 'dynamic.filesystem.mkdir', capabilityKey: 'dynamic.filesystem.mkdir', name: 'dynamic.filesystem.mkdir',
        version: '1.0.0', intent: 'create a folder', description: 'Create a directory',
        inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, entrypoint: 'tool.mjs',
        runtime: 'node-sandbox-v1', permissions: ['filesystem.write'], riskLevel: 'medium', tests: [],
        code: "export async function run(input, host) { return host.fs.mkdir('D:/tmp/alpha'); }",
      } }),
    };
    const { service, store } = createService(agents);
    const task = await service.createAndWait({ message: 'Create alpha folder', attachments: [], permissionMode: 'request' });
    expect(task.status).toBe('FAILED');
    expect(store.getCapabilityVersion('dynamic.filesystem.mkdir', '1.0.0')).toBeNull();
  });

  it('returns a validated informational answer instead of a no-tool placeholder', async () => {
    const base = new AgentRunner(new ModelGateway(new MockModelProvider()));
    const agents: AgentServices = {
      runPlanner: async () => ({ intent: 'greeting', acceptanceCriteria: ['answers greeting'], requiredCapabilities: [],
        steps: [], status: 'answer', answer: '你好，我是贾维斯。' }),
      runEvaluator: (input) => base.runEvaluator(input),
      runImplementer: (input) => base.runImplementer(input),
    };
    const { service, store } = createService(agents);
    const task = await service.createAndWait({ message: '你好', attachments: [] });
    expect(task.status).toBe('COMPLETED');
    expect(task.result).toBe('你好，我是贾维斯。');
    expect(task.metrics.generatedCapabilityCount).toBe(0);
    expect(JSON.stringify(store.listEvents(task.id))).not.toContain('你好，我是贾维斯。');
  });

  it('keeps a falsely successful tool out of active when it never calls the host', async () => {
    const agents = createProcessAgents('export async function run() { return { success: true }; }');
    const { service, store } = createService(agents);
    const task = await service.createAndWait({ message: 'Open cloudmusic', attachments: [], permissionMode: 'full' });
    expect(task.status).toBe('FAILED');
    expect(store.getActive('launch_app')).toBeNull();
    expect(store.listEvents(task.id).some((event) => event.type === 'test.report' && Number(event.payload.failed) > 0)).toBe(true);
  });

  it('blocks fake process success when desktop observation is unavailable and never retries launch', async () => {
    const agents = createProcessAgents('export async function run(input, host) { return await host.process.run({ command: "cloudmusic.exe", args: [] }); }');
    const { store, directory } = createService(agents);
    const calls: HostCall[] = [];
    const executor: HostOperationExecutor = { execute: async (call) => {
      calls.push(call);
      return { callId: call.callId, ok: true, value: { exitCode: 0, stdout: '', stderr: '' } };
    } };
    const broker = new PermissionBroker(store, executor, directory);
    const observer = new WindowsDesktopObserver(async () => null, 'win32');
    const service = new TaskService(store, createAgentLoop(store, directory, agents, broker, observer), broker);
    const task = await service.createAndWait({ message: 'Open cloudmusic', attachments: [], permissionMode: 'full' });
    expect(task.status, task.result).toBe('BLOCKED');
    expect(calls).toHaveLength(1);
    expect(store.getActive('launch_app')).toBeNull();
    expect(store.getCapabilityVersion('launch_app', '1.0.0')).toBeNull();
    expect(store.listEvents(task.id).some((event) => event.type === 'test.report' && event.payload.blocked === 1)).toBe(true);
  });

  it('does not replay a process launch when the final evaluator requests a retry', async () => {
    const base = createProcessAgents('export async function run(input, host) { return await host.process.run({ command: "cloudmusic.exe", args: [] }); }');
    const agents: AgentServices = { ...base, runEvaluator: async (input) => {
      const result = await base.runEvaluator(input);
      return input.phase === 'execution' ? { ...result, status: 'retry', verdict: 'revise', failures: [{ code: 'NOT_YET', message: 'Try again.' }] } : result;
    } };
    const { store, directory } = createService(agents);
    const calls: HostCall[] = [];
    const broker = new PermissionBroker(store, { execute: async (call) => {
      calls.push(call);
      return { callId: call.callId, ok: true, value: { exitCode: 0, stdout: '', stderr: '' } };
    } }, directory);
    const observer = new WindowsDesktopObserver(async () => ({ running: true, visible: true, foreground: true }), 'win32');
    const task = await new TaskService(store, createAgentLoop(store, directory, agents, broker, observer), broker)
      .createAndWait({ message: 'Open cloudmusic', attachments: [], permissionMode: 'full' });
    expect(task.status, task.result).toBe('BLOCKED');
    expect(calls).toHaveLength(1);
    expect(task.executionCheckpoint?.currentStepId).toBe('launch');
    expect(store.getTask(task.id)?.executionCheckpoint?.currentStepId).toBe('launch');
    expect(store.getActive('launch_app')).toBeNull();
  });

  it('records a blocked test report when the test planner fails after a process operation', async () => {
    const agents = createProcessAgents('export async function run(input, host) { return await host.process.run({ command: "cloudmusic.exe", args: [] }); }');
    const { store, directory } = createService(agents);
    const broker = new PermissionBroker(store, { execute: async (call) =>
      ({ callId: call.callId, ok: true, value: { exitCode: 0, stdout: '', stderr: '' } }) }, directory);
    const baseTester = new TestAgent(new ModelGateway(new MockModelProvider()));
    let planCalls = 0;
    const tester: Pick<TestAgent, 'generate' | 'review' | 'reviewAnswer'> = {
      generate: async (...args) => {
        if (++planCalls === 2) throw new Error('TESTER_UNAVAILABLE');
        return baseTester.generate(...args);
      },
      review: (...args) => baseTester.review(...args),
      reviewAnswer: (...args) => baseTester.reviewAnswer(...args),
    };
    const task = await new TaskService(store, createAgentLoop(store, directory, agents, broker,
      new WindowsDesktopObserver(async () => ({ running: true, visible: true, foreground: true }), 'win32'), tester), broker)
      .createAndWait({ message: 'Open cloudmusic', attachments: [], permissionMode: 'full' });
    expect(task.status).toBe('BLOCKED');
    expect(store.listEvents(task.id).some((event) => event.type === 'test.report' && event.payload.blocked === 1)).toBe(true);
  });

  it('cannot activate a canary when the planner supplied no real execution step', async () => {
    const base = createProcessAgents('export async function run(input, host) { return await host.process.run({ command: "cloudmusic.exe", args: [] }); }');
    const agents: AgentServices = { ...base, runPlanner: async () => ({
      intent: 'launch cloudmusic', acceptanceCriteria: ['app window is foreground'],
      requiredCapabilities: [{ name: 'launch_app', purpose: 'Launch cloudmusic.', riskLevel: 'high' }],
      steps: [], status: 'ready',
    }) };
    const { service, store } = createService(agents);
    const task = await service.createAndWait({ message: 'Open cloudmusic', attachments: [], permissionMode: 'full' });
    expect(task.status).toBe('BLOCKED');
    expect(store.getActive('launch_app')).toBeNull();
  });

  it('does not reuse another task’s unverified canary as a ready tool', async () => {
    const base = createProcessAgents('export async function run(input, host) { return await host.process.run({ command: "cloudmusic.exe", args: [] }); }');
    let version = 0;
    const agents: AgentServices = { ...base, runImplementer: async (input) => {
      const result = await base.runImplementer(input);
      return { kind: 'tool_candidate', candidate: { ...result.candidate, version: `1.0.${version++}` } };
    } };
    const { service, store } = createService(agents);
    const first = await service.createAndWait({ message: 'Open cloudmusic', attachments: [], permissionMode: 'request' });
    expect(first.status).toBe('WAITING_FOR_APPROVAL');
    const second = await service.createAndWait({ message: 'Open cloudmusic', attachments: [], permissionMode: 'request' });
    expect(second.status).toBe('WAITING_FOR_APPROVAL');
    expect(second.metrics.reusedCapabilityCount).toBe(0);
    expect(second.metrics.generatedCapabilityCount).toBe(1);
    expect(store.getCapabilityVersion('launch_app', '1.0.0')).toBeNull();
    expect(store.getCapabilityVersion('launch_app', '1.0.1')).toBeNull();
  });
  it('generates a read-only tool for each task without saving it', async () => {
    const { service, store } = createService();
    const attachments: Attachment[] = [{ id: 'file-1', filename: 'notes.txt', mimeType: 'text/plain', size: 4, content: 'a\nb\n' }];

    const first = await service.createAndWait({ message: '统计上传内容有多少行', attachments });
    expect(first.status).toBe('COMPLETED');
    expect(first.result).toContain('2');
    expect(first.metrics.generatedCapabilityCount).toBe(1);

    const second = await service.createAndWait({ message: '统计上传内容有多少行', attachments: [{ ...attachments[0], content: 'x\ny\nz\n' }] });
    expect(second.status).toBe('COMPLETED');
    expect(second.result).toContain('3');
    expect(second.metrics.generatedCapabilityCount).toBe(1);
    expect(second.metrics.reusedCapabilityCount).toBe(0);
    expect(store.getCapabilityVersion('dynamic.text.count_lines', '1.0.0')).toBeNull();
    store.close();
  });

  it('ignores a persisted process tool and generates a temporary replacement', async () => {
    const candidate: ToolCandidate = {
      id: 'execute_local_command', name: 'Execute Local Command', version: '1.0.1', intent: 'launch local app',
      description: 'Launches the requested local application.', inputSchema: {}, outputSchema: {},
      entrypoint: 'tool.mjs', runtime: 'node-sandbox-v1', permissions: ['process'], riskLevel: 'low',
      tests: ['launches the requested app'],
      code: "export async function run(input, host) { const result = await host.process.run({ command: 'node.exe', args: ['--version'] }); return { success: true, result }; }",
    };
    let implementationFeedback: string | undefined;
    let mainDecisions = 0;
    const agents: AgentServices = {
      runPlanner: async () => ({
        intent: 'launch local app', acceptanceCriteria: ['The local application is launched.'],
        requiredCapabilities: [{ name: 'execute_local_command', purpose: 'Launch a local app.', riskLevel: 'high' }],
        steps: [{ id: 'launch-app', description: 'Launch NetEase Cloud Music.', dependsOn: [], input: { message: 'Open NetEase Cloud Music' } }],
        status: 'ready',
      }),
      runImplementer: async (input) => {
        implementationFeedback = input.feedback;
        return { kind: 'tool_candidate', candidate };
      },
      runCorrection: async () => { mainDecisions += 1; return { action: 'rebuild_generated_tool', reason: 'Confirmed bridge mismatch' }; },
      runEvaluator: async (input) => ({
        targetId: input.target, targetVersion: 'candidate', verdict: 'pass', score: 1,
        failures: [], recommendations: [], evaluatorRunId: 'process-evaluator', status: 'pass', evidence: [],
      }),
    };
    const { service, store } = createService(agents);
    const staleCapability: CapabilityRecord = {
      id: 'execute_local_command', version: '1.0.0', status: 'active', normalizedIntent: 'launch local app',
      manifest: {
        id: 'execute_local_command', version: '1.0.0', kind: 'tool', name: 'Execute Local Command',
        description: 'Old process bridge signature.', inputSchema: {}, outputSchema: {}, entrypoint: 'tool.mjs',
        runtime: 'node-sandbox-v1', permissions: ['process'], riskLevel: 'low', tests: [],
        provenance: { sourceTaskId: 'old-task', generatedAt: '2026-09-01T00:00:00.000Z' },
      },
      code: "export async function run(input, host) { try { await host.process.run('node.exe', ['--version']); return { success: true }; } catch (error) { return { success: false, message: error.message }; } }",
      evaluation: { targetId: 'execute_local_command', targetVersion: '1.0.0', verdict: 'pass', score: 1, failures: [], recommendations: [], evaluatorRunId: 'old-evaluator' },
      createdAt: '2026-09-01T00:00:00.000Z',
    };
    store.saveCapability(staleCapability);

    const task = await service.createAndWait({ message: 'Open NetEase Cloud Music', attachments: [], permissionMode: 'request' });

    expect(task.status).toBe('WAITING_FOR_APPROVAL');
    expect(task.metrics.reusedCapabilityCount).toBe(0);
    expect(task.metrics.generatedCapabilityCount).toBe(1);
    expect(implementationFeedback).toBeUndefined();
    expect(mainDecisions).toBe(0);
    expect(task.correctionState.roundsUsed).toBe(0);
    expect(task.correctionState.currentRound).toBeUndefined();
    expect(store.getCapabilityVersion('execute_local_command', '1.0.0')?.status).toBe('active');
    expect(store.getCapabilityVersion('execute_local_command', '1.0.1')).toBeNull();
    store.close();
  });

  it('retries a failed evaluator and then terminates after a passing result', async () => {
    const base = new AgentRunner(new ModelGateway(new MockModelProvider()));
    let executionEvaluations = 0;
    const agents: AgentServices = {
      runPlanner: (input) => base.runPlanner(input),
      runImplementer: (input) => base.runImplementer(input),
      runEvaluator: async (input) => {
        const result = await base.runEvaluator(input);
        if (input.phase === 'execution' && executionEvaluations++ === 0) {
          return { ...result, status: 'retry', verdict: 'revise', failures: [{ code: 'BAD_RESULT', message: 'retry once' }] };
        }
        return result;
      },
    };
    const { service, store } = createService(agents);
    const task = await service.createAndWait({ message: '统计上传内容有多少行', attachments: [{ id: 'f', filename: 'x', mimeType: 'text/plain', size: 4, content: 'a\nb\n' }] });

    expect(task.status, task.result).toBe('COMPLETED');
    expect(task.metrics.retryCount).toBe(1);
    store.close();
  });

  it('gives capability generation the original request and the previous evaluation feedback', async () => {
    const implementationInputs: Array<{ taskContext?: unknown; feedback?: string }> = [];
    let toolEvaluations = 0;
    let executionOutput: unknown;
    const candidate: ToolCandidate = {
      id: 'create_folder', name: 'Folder Maker', version: '1.0.0', intent: 'create folder on desktop',
      description: 'Creates the requested folder.', inputSchema: {}, outputSchema: {},
      entrypoint: 'tool.mjs', runtime: 'node-sandbox-v1', permissions: [], riskLevel: 'low',
      tests: ['returns a result'],
      code: 'export async function run(input) { return { requestedPath: input.message, desktopDirectory: input.desktopDirectory }; }',
    };
    const agents: AgentServices = {
      runPlanner: async () => ({
        intent: 'create folder on desktop', acceptanceCriteria: ['folder created'],
        requiredCapabilities: [{ name: 'create_folder', purpose: 'Create the requested folder.', riskLevel: 'low' }],
        steps: [{ id: 'create-folder', description: 'Create the requested folder.', dependsOn: [] }], status: 'ready',
      }),
      runImplementer: async (input) => {
        implementationInputs.push({ taskContext: input.taskContext, feedback: input.feedback });
        return { kind: 'tool_candidate', candidate };
      },
      runEvaluator: async (input) => {
        if (input.phase === 'execution') executionOutput = input.output;
        if (input.phase === 'tool' && toolEvaluations++ === 0) {
          return {
            targetId: input.target, targetVersion: 'candidate', verdict: 'revise', score: 0.2,
            failures: [{ code: 'INVALID_PATH', message: 'The generated path was empty.' }],
            recommendations: ['Use the path from the task request.'], evaluatorRunId: 'tool-evaluator',
            status: 'retry', evidence: [{ output: input.output }],
          };
        }
        return {
          targetId: input.target, targetVersion: 'candidate', verdict: 'pass', score: 1,
          failures: [], recommendations: [], evaluatorRunId: 'tool-evaluator', status: 'pass',
          evidence: [{ output: input.output }],
        };
      },
    };
    const { service, store, directory } = createService(agents);
    const request = '在桌面创建 hm 文件夹';
    const task = await service.createAndWait({
      message: request,
      attachments: [{ id: 'file-1', filename: 'context.txt', mimeType: 'text/plain', size: 8, content: 'not a path' }],
    });

    expect(task.status).toBe('COMPLETED');
    expect(executionOutput).toEqual({ requestedPath: request, desktopDirectory: join(directory, 'Desktop') });
    expect(implementationInputs).toHaveLength(2);
    expect(implementationInputs[0]?.taskContext).toEqual({
      message: request,
      attachments: [{ filename: 'context.txt', content: 'not a path' }],
      workspaceRoot: directory,
      desktopDirectory: join(directory, 'Desktop'),
      executionInput: {},
    });
    expect(implementationInputs[1]?.feedback).toContain('The generated path was empty.');
    store.close();
  });

  it('passes a planner-resolved absolute path through tool evaluation and pauses before an out-of-workspace write', async () => {
    const target = 'D:\\hm';
    let plannedInput: unknown;
    let dryRunOutput: unknown;
    const candidate: ToolCandidate = {
      id: 'file_system', name: 'File System', version: '1.0.0', intent: 'create a directory at a requested path',
      description: 'Creates the requested directory.',
      inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
      outputSchema: {}, entrypoint: 'tool.mjs', runtime: 'node-sandbox-v1',
      permissions: ['filesystem.write'], riskLevel: 'low', tests: ['creates the requested path'],
      code: 'export async function run(input, host) { return await host.fs.mkdir(input.path); }',
    };
    const agents: AgentServices = {
      runPlanner: async () => ({
        intent: 'create a directory at a requested path', acceptanceCriteria: ['the requested directory is created'],
        requiredCapabilities: [{ name: 'file_system', purpose: 'Create the directory at the requested path.', riskLevel: 'low' }],
        steps: [{ id: 'create-directory', description: 'Create hm under D drive root.', dependsOn: [], input: { operation: { type: 'create_directory', path: target } } }],
        status: 'ready',
      }),
      runImplementer: async (input) => {
        plannedInput = input.taskContext.executionInput;
        return { kind: 'tool_candidate', candidate };
      },
      runEvaluator: async (input) => {
        if (input.phase === 'tool') dryRunOutput = input.output;
        return {
          targetId: input.target, targetVersion: 'candidate', verdict: 'pass', score: 1,
          failures: [], recommendations: [], evaluatorRunId: 'path-evaluator', status: 'pass',
          evidence: [{ output: input.output }],
        };
      },
    };
    const { service, store } = createService(agents);
    const task = await service.createAndWait({
      message: '帮我在D:\\这个位置创建一个hm文件夹', attachments: [], permissionMode: 'request',
    });

    expect(plannedInput).toEqual({ operation: { type: 'create_directory', path: target } });
    expect(dryRunOutput).toMatchObject({ path: target, created: true });
    expect(task.status).toBe('WAITING_FOR_APPROVAL');
    expect(store.getActive('file_system')).toBeNull();
    expect(task.pendingPermission?.operation.target).toBe(target);
    store.close();
  });

  it('stops after five corrective retries instead of looping forever', async () => {
    const base = new AgentRunner(new ModelGateway(new MockModelProvider()));
    const agents: AgentServices = {
      runPlanner: (input) => base.runPlanner(input),
      runImplementer: (input) => base.runImplementer(input),
      runEvaluator: async (input) => {
        const result = await base.runEvaluator(input);
        return input.phase === 'execution'
          ? { ...result, status: 'retry', verdict: 'revise', failures: [{ code: 'ALWAYS_BAD', message: 'never passes' }] }
          : result;
      },
    };
    const { service, store } = createService(agents);
    const task = await service.createAndWait({ message: '统计上传内容有多少行', attachments: [{ id: 'f', filename: 'x', mimeType: 'text/plain', size: 4, content: 'a\nb\n' }] });

    expect(task.status).toBe('FAILED');
    expect(task.metrics.retryCount).toBe(5);
    store.close();
  });

  it('pauses for required user input and can resume the task', async () => {
    const agents: AgentServices = {
      runPlanner: async (input) => ({
        intent: 'need a missing value',
        acceptanceCriteria: ['value is present'],
        requiredCapabilities: [],
        steps: [],
        status: 'needs_user_input',
        inputRequest: { taskId: input.taskId, question: 'What value should I use?', requiredFields: [{ name: 'value', reason: 'required', sensitive: false }], resumeToken: 'resume-1' },
      }),
      runImplementer: async () => { throw new Error('not expected'); },
      runEvaluator: async () => { throw new Error('not expected'); },
    };
    const { service, store } = createService(agents);
    const task = await service.createAndWait({ message: 'do something', attachments: [] });

    expect(task.status).toBe('NEEDS_USER_INPUT');
    expect(store.listEvents(task.id).some((event) => event.type === 'task.needs_user_input')).toBe(true);
    store.close();
  });

  it('completes cleanly when the planner determines that no tool or step is needed', async () => {
    const agents: AgentServices = {
      runPlanner: async () => ({
        intent: 'answer directly',
        acceptanceCriteria: ['request was understood'],
        requiredCapabilities: [],
        steps: [],
        status: 'ready',
      }),
      runImplementer: async () => { throw new Error('not expected'); },
      runEvaluator: async () => { throw new Error('not expected'); },
    };
    const { service, store } = createService(agents);
    const task = await service.createAndWait({ message: '你好', attachments: [] });

    expect(task.status).toBe('COMPLETED');
    expect(task.result).toContain('无需执行');
    store.close();
  });

  it('waits for approval before creating a directory, then resumes and reports success', async () => {
    const { service, store, directory } = createService(createFolderAgents());
    const executor = new DefaultHostOperationExecutor();
    const broker = new PermissionBroker(store, executor, directory);
    const loop = createAgentLoop(store, directory, createFolderAgents(), broker);
    const resumedService = new TaskService(store, loop, broker);
    const task = await resumedService.createAndWait({ message: 'Create hm', attachments: [], permissionMode: 'request' });

    expect(task.status).toBe('WAITING_FOR_APPROVAL');
    expect(task.pendingPermission?.operation.target).toBe(join(realpathSync.native(directory), 'hm'));
    expect(existsSync(join(directory, 'hm'))).toBe(false);

    const result = await resumedService.resolveApproval(task.id, task.pendingPermission!.requestId, true);
    expect(result.status).toBe('COMPLETED');
    expect(store.getActive('create_folder')).toBeNull();
    expect(result.result).toContain(`结果摘要：\n已创建目录 ${join(realpathSync.native(directory), 'hm')}`);
    expect(existsSync(join(directory, 'hm'))).toBe(true);
    expect(store.listEvents(task.id).some((event) => event.type === 'task.permission_approved')).toBe(true);
    store.close();
  });

  it('denial never creates the requested directory', async () => {
    const { store, directory } = createService(createFolderAgents());
    const calls: HostCall[] = [];
    const executor: HostOperationExecutor = {
      execute: async (call: HostCall, context: HostExecutionContext) => {
        calls.push(call);
        return new DefaultHostOperationExecutor().execute(call, context);
      },
    };
    const broker = new PermissionBroker(store, executor, directory);
    const loop = createAgentLoop(store, directory, createFolderAgents(), broker);
    const service = new TaskService(store, loop, broker);
    const task = await service.createAndWait({ message: 'Create hm', attachments: [], permissionMode: 'request' });
    const result = await service.resolveApproval(task.id, task.pendingPermission!.requestId, false);

    expect(result.status).toBe('CANCELLED');
    expect(result.result).toContain('拒绝');
    expect(calls).toHaveLength(0);
    expect(existsSync(join(directory, 'hm'))).toBe(false);
    store.close();
  });

  it('blocks approval after restart because the generated tool was temporary', async () => {
    const { store, directory } = createService(createFolderAgents());
    const firstBroker = new PermissionBroker(store, new DefaultHostOperationExecutor(), directory);
    const firstLoop = createAgentLoop(store, directory, createFolderAgents(), firstBroker);
    const firstService = new TaskService(store, firstLoop, firstBroker);
    const waiting = await firstService.createAndWait({ message: 'Create hm', attachments: [], permissionMode: 'request' });
    expect(waiting.status).toBe('WAITING_FOR_APPROVAL');
    expect(existsSync(join(directory, 'hm'))).toBe(false);
    const filename = store.filename;
    store.close();

    const restoredStore = new SqliteStore(filename);
    testStores.push(restoredStore);
    const executor = new DefaultHostOperationExecutor();
    const execution = vi.spyOn(executor, 'execute');
    const restoredBroker = new PermissionBroker(restoredStore, executor, directory);
    const restoredLoop = createAgentLoop(restoredStore, directory, createFolderAgents(), restoredBroker);
    const restoredService = new TaskService(restoredStore, restoredLoop, restoredBroker);

    const persisted = restoredStore.getTask(waiting.id);
    expect(persisted?.pendingPermission?.requestId).toBe(waiting.pendingPermission?.requestId);
    expect(execution).not.toHaveBeenCalled();
    const blocked = await restoredService.resolveApproval(waiting.id, persisted!.pendingPermission!.requestId, true);
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.result).toContain('临时工具');
    expect(existsSync(join(directory, 'hm'))).toBe(false);
    expect(execution).not.toHaveBeenCalled();
  });

  it('blocks an interrupted generated-tool checkpoint after restart', async () => {
    const agents = createFolderAgents();
    const { service, store, directory } = createService(agents);
    const waiting = await service.createAndWait({ message: 'Create hm', attachments: [], permissionMode: 'request' });
    expect(waiting.status).toBe('WAITING_FOR_APPROVAL');
    const filename = store.filename;
    store.close();
    testStores.splice(testStores.indexOf(store), 1);

    const recoveredStore = new SqliteStore(filename);
    testStores.push(recoveredStore);
    const interrupted = recoveredStore.getTask(waiting.id)!;
    interrupted.status = 'TESTING_LIVE';
    recoveredStore.saveTask(interrupted);
    const replayExecutor = new DefaultHostOperationExecutor();
    const execute = vi.spyOn(replayExecutor, 'execute');
    const recoveredBroker = new PermissionBroker(recoveredStore, replayExecutor, directory);
    const recoveredService = new TaskService(recoveredStore, createAgentLoop(recoveredStore, directory, agents, recoveredBroker), recoveredBroker);

    await expect(recoveredService.resumeAfterRestart()).resolves.toBe(0);
    expect(recoveredStore.getTask(waiting.id)?.status).toBe('BLOCKED');
    expect(existsSync(join(directory, 'hm'))).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not repeat a completed host operation when the evaluator requests a retry', async () => {
    const baseAgents = createFolderAgents();
    let evaluations = 0;
    const agents: AgentServices = {
      ...baseAgents,
      runEvaluator: async (input) => {
        const result = await baseAgents.runEvaluator(input);
        if (input.phase === 'execution' && evaluations++ === 0) {
          return { ...result, status: 'retry', verdict: 'revise', failures: [{ code: 'CHECK_AGAIN', message: 'Recheck the folder result.' }] };
        }
        return result;
      },
    };
    const { store, directory } = createService(agents);
    const baseExecutor = new DefaultHostOperationExecutor();
    const executor: HostOperationExecutor = {
      execute: vi.fn((call: HostCall, context: HostExecutionContext) => baseExecutor.execute(call, context)),
    };
    const broker = new PermissionBroker(store, executor, directory);
    const loop = createAgentLoop(store, directory, agents, broker);
    const service = new TaskService(store, loop, broker);
    const task = await service.createAndWait({ message: 'Create hm', attachments: [], permissionMode: 'auto' });

    expect(task.status, task.result).toBe('COMPLETED');
    expect(task.metrics.retryCount).toBe(1);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    store.close();
  });

  it('preserves the concrete capability-generation error instead of reporting no available capability', async () => {
    const base = createFolderAgents();
    const agents: AgentServices = { ...base, runImplementer: async () => { throw new Error('SPECIFIC_GENERATION_ERROR'); } };
    const { service, store } = createService(agents);
    const task = await service.createAndWait({ message: 'Create hm', attachments: [], permissionMode: 'request' });
    expect(task.status).toBe('FAILED');
    expect(task.result).toContain('SPECIFIC_GENERATION_ERROR');
    expect(task.result).not.toContain('没有可用能力');
    store.close();
  });
});

function createFolderAgents(): AgentServices {
  const candidate: ToolCandidate = {
    id: 'create_folder', name: 'Folder Maker', version: '1.0.0', intent: 'create folder hm',
    description: 'Creates folder hm using the host bridge.', inputSchema: {}, outputSchema: {},
    entrypoint: 'tool.mjs', runtime: 'node-sandbox-v1', permissions: ['filesystem.write'], riskLevel: 'low',
    tests: ['creates hm'],
    code: 'export async function run(input, host) { return await host.fs.mkdir("hm"); }',
  };
  return {
    runPlanner: async (input) => ({
      intent: 'create folder hm', acceptanceCriteria: ['folder exists'],
      requiredCapabilities: [{ name: 'create_folder', purpose: 'Create the requested folder.', riskLevel: 'low' }],
      steps: [{ id: 'create-folder', description: 'Create hm.', dependsOn: [], input: { path: join(input.workspaceRoot ?? '', 'hm') } }], status: 'ready',
    }),
    runImplementer: async () => ({ kind: 'tool_candidate', candidate }),
    runEvaluator: async (input) => ({
      targetId: input.target, targetVersion: 'candidate', verdict: 'pass', score: 1, failures: [],
      recommendations: [], evaluatorRunId: 'folder-evaluator', status: 'pass', evidence: [{ output: input.output }],
    }),
  };
}

function createProcessAgents(code: string): AgentServices {
  const candidate: ToolCandidate = {
    id: 'launch_app', name: 'launch_app', version: '1.0.0', intent: 'launch cloudmusic',
    description: 'Launch cloudmusic.', inputSchema: {}, outputSchema: {}, entrypoint: 'tool.mjs',
    runtime: 'node-sandbox-v1', permissions: ['process'], riskLevel: 'high', tests: ['launches app'], code,
  };
  return {
    runPlanner: async () => ({ intent: 'launch cloudmusic', acceptanceCriteria: ['app window is foreground'],
      requiredCapabilities: [{ name: 'launch_app', purpose: 'Launch cloudmusic.', riskLevel: 'high' }],
      steps: [{ id: 'launch', description: 'Launch app.', dependsOn: [], input: { applicationId: 'cloudmusic' } }], status: 'ready' }),
    runImplementer: async () => ({ kind: 'tool_candidate', candidate }),
    runEvaluator: async (input) => ({ targetId: input.target, targetVersion: 'candidate', verdict: 'pass', score: 1,
      failures: [], recommendations: [], evaluatorRunId: 'process-evaluator', status: 'pass', evidence: [] }),
  };
}

function createAgentLoop(store: SqliteStore, directory: string, agents: AgentServices, permissionBroker: PermissionBroker,
  observer = new WindowsDesktopObserver(),
  tester: Pick<TestAgent, 'generate' | 'review' | 'reviewAnswer'> = new TestAgent(new ModelGateway(new MockModelProvider())),
  appResolver?: (name: string) => Promise<ApplicationResolution>) {
  const sandbox = new SandboxRunner();
  const registry = new CapabilityRegistry(store, sandbox);
  return new AgentLoop({
    store, agents, tester,
    testExecutor: new TestExecutor(sandbox), desktopObserver: observer,
    factory: new ToolFactory(agents), registry, sandbox,
    budget: new BudgetManager({ maxContextTokens: 32_000, outputReserveTokens: 4_000 }),
    scheduler: new AdaptiveScheduler({ maxConcurrency: 3 }), maxRetries: 5, maxSteps: 50,
    permissionBroker, workspaceRoot: directory, desktopDirectory: join(directory, 'Desktop'),
    appResolver,
  });
}
