import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AgentMessageRecord,
  AgentMessageStatus,
  AgentMessageType,
  AgentSessionRecord,
  AgentStatus,
  CapabilityRecord,
  CorrectionFailure,
  DiagnosticContext,
  DiagnosticEvidenceEntry,
  CorrectionState,
  CreateAgentInput,
  CreateTaskInput,
  ExecutionCheckpoint,
  MemoryTurn,
  OperationJournalRecord,
  OperationJournalState,
  PendingPermissionRequest,
  PermissionMode,
  PermissionOperation,
  SessionListItem,
  SessionMemorySnapshot,
  SessionMessageRecord,
  SessionMessageRole,
  SessionRecord,
  SessionStatus,
  SendAgentMessageInput,
  TaskEvent,
  TaskRun,
  TaskStatus,
} from '../domain/contracts.js';
import { estimateTokens } from '../runtime/session-memory.js';
import { finishCorrection } from '../runtime/correction-round.js';
import { persistableCorrectionFailure } from '../runtime/correction-router.js';
import type { ModelCompletion, ModelRequest, ModelRequestDetails } from '../model/gateway.js';

interface TaskRow {
  id: string;
  message: string;
  attachments_json: string;
  status: TaskRun['status'];
  acceptance_criteria_json: string;
  result: string | null;
  current_step_id: string | null;
  metrics_json: string;
  retry_counts_json: string;
  created_at: string;
  updated_at: string;
  permission_mode: PermissionMode;
  pending_permission_json: string | null;
  execution_checkpoint_json: string | null;
  correction_state_json: string | null;
  session_id: string | null;
}

interface OperationRow {
  task_id: string;
  operation_id: string;
  request_id: string | null;
  state: OperationJournalState;
  operation_json: string;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id?: number;
  task_id?: string;
  type: string;
  payload_json: string;
  created_at: string;
}

interface ModelCallRow {
  id: string;
  task_id: string | null;
  session_id: string | null;
  role: string;
  model_name: string;
  status: string;
  system_prompt: string;
  user_prompt: string;
  response_json: string | null;
  raw_response: string | null;
  error: string | null;
  request_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number | null;
  created_at: string;
  finished_at: string | null;
  request_meta_json: string | null;
  error_meta_json: string | null;
}

export interface TrajectorySummary {
  events: number; modelCalls: number; failedModels: number; operations: number; failedOperations: number;
  inputTokens: number; outputTokens: number; modelDurationMs: number;
}

export interface TrajectoryEntry {
  id: string;
  taskId: string | null;
  createdAt: string;
  kind: 'event' | 'model' | 'operation';
  type: string;
  payload?: Record<string, unknown>;
  model?: {
    status: string; modelName: string; system: string; user: string; response: string | null; rawResponse: string | null; error: string | null;
    requestId: string | null; inputTokens: number | null; outputTokens: number | null; durationMs: number | null;
    finishedAt: string | null; request: Record<string, unknown> | null; errorDetails: Record<string, unknown> | null;
  };
  operation?: { operationId: string; requestId: string | null; state: OperationJournalState;
    permission: string; action: string; target: string; success: boolean | null; errorCode: string | null;
    updatedAt: string; durationMs: number };
}

function traceText(value: string): string {
  const clipped = value.length > 30_000 ? `${value.slice(0, 30_000)}\n…[内容已截断]` : value;
  return clipped.replace(/(Bearer\s+)[^\s"']+/gi, '$1[已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[已隐藏密钥]')
    .replace(/([?&](?:api_?key|token|secret|password)=)[^&#\s]+/gi, '$1[已隐藏]');
}

function diagnosticText(value: string, maxLength = 2_000): string {
  return traceText(value)
    .replace(/\b(?:token|api[_-]?key|password|secret|authorization)\s*[:=]\s*[^\s;]+/gi, '[凭据已隐藏]')
    .slice(0, maxLength);
}

function diagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[内容已截断]';
  if (typeof value === 'string') return diagnosticText(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 12).map(item => diagnosticValue(item, depth + 1));
  if (typeof value !== 'object') return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|api[_-]?key|password|secret|authorization|credential/i.test(key)) continue;
    const safe = diagnosticValue(item, depth + 1);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
}

function diagnosticEntry(entry: TrajectoryEntry): DiagnosticEvidenceEntry | null {
  if (entry.kind === 'event') {
    if (!/failed|blocked|cancelled|error|report|interrupted/i.test(entry.type)) return null;
    return { kind: 'event', type: entry.type, createdAt: entry.createdAt,
      details: (diagnosticValue(entry.payload ?? {}) ?? {}) as Record<string, unknown> };
  }
  if (entry.kind === 'model') {
    if (!entry.model || !['failed', 'interrupted'].includes(entry.model.status)) return null;
    const details: Record<string, unknown> = { status: entry.model.status };
    if (entry.model.error) details.error = diagnosticText(entry.model.error);
    if (entry.model.rawResponse) details.rawResponse = diagnosticText(entry.model.rawResponse, 4_000);
    if (entry.model.errorDetails) details.errorDetails = diagnosticValue(entry.model.errorDetails);
    return { kind: 'model', type: entry.type, createdAt: entry.createdAt, details };
  }
  if (!entry.operation || entry.operation.success !== false) return null;
  return { kind: 'operation', type: entry.type, createdAt: entry.createdAt,
    details: { state: entry.operation.state, permission: entry.operation.permission,
      action: entry.operation.action, target: diagnosticText(entry.operation.target, 1_000),
      errorCode: entry.operation.errorCode } };
}

function boundDiagnosticEntries(entries: DiagnosticEvidenceEntry[], maxChars = 12_000): DiagnosticEvidenceEntry[] {
  const selected: DiagnosticEvidenceEntry[] = [];
  let size = 0;
  for (const entry of entries) {
    const nextSize = JSON.stringify(entry).length;
    if (selected.length > 0 && size + nextSize > maxChars) break;
    selected.push(entry);
    size += nextSize;
  }
  return selected;
}

interface CapabilityRow {
  id: string;
  version: string;
  status: CapabilityRecord['status'];
  normalized_intent: string;
  manifest_json: string;
  code: string;
  evaluation_json: string;
  created_at: string;
}

interface SessionRow {
  id: string;
  title: string;
  status: string;
  pinned_at: string | null;
  summary: string | null;
  summary_seq: number;
  memory_tokens: number;
  message_count: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  seq: number;
  session_id: string;
  task_id: string | null;
  role: string;
  content: string;
  status: string;
  tokens: number;
  created_at: string;
}

interface AgentRow {
  id: string;
  parent_agent_id: string | null;
  root_task_id: string | null;
  name: string;
  role: string;
  goal: string;
  capabilities_json: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface AgentMessageRow {
  id: string;
  root_task_id: string | null;
  sender_agent_id: string;
  recipient_agent_id: string;
  type: string;
  correlation_id: string | null;
  payload_json: string;
  status: string;
  error: string | null;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
}

export function normalizeIntent(intent: string): string {
  return [...new Set(intent.toLowerCase().trim().split(/\s+/).filter(Boolean))].sort().join(' ');
}

function auditTarget(target: string): string {
  if (/^[A-Za-z]:[\\/]/.test(target)) return target;
  try {
    const url = new URL(target);
    if (url.origin === 'null') return target;
    return `${url.origin}${url.pathname}${url.search ? '?[query redacted]' : ''}`;
  } catch {
    return target;
  }
}

export class SqliteStore {
  public readonly filename: string;
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    this.filename = filename;
    if (filename !== ':memory:') {
      mkdirSync(dirname(filename), { recursive: true });
    }
    this.database = new DatabaseSync(filename);
    this.database.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        attachments_json TEXT NOT NULL,
        status TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL,
        result TEXT,
        current_step_id TEXT,
        metrics_json TEXT NOT NULL,
        retry_counts_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        permission_mode TEXT NOT NULL DEFAULT 'request',
        pending_permission_json TEXT,
        execution_checkpoint_json TEXT
      );

      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      CREATE TABLE IF NOT EXISTS capabilities (
        id TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL,
        normalized_intent TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        code TEXT NOT NULL,
        evaluation_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (id, version)
      );

      CREATE INDEX IF NOT EXISTS idx_capabilities_intent
        ON capabilities(normalized_intent, status, created_at);
    `);
    this.migrateTaskPermissionColumns();
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS operation_journal (
        task_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        request_id TEXT,
        state TEXT NOT NULL,
        operation_json TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, operation_id),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_journal_request
        ON operation_journal(task_id, request_id) WHERE request_id IS NOT NULL;
    `);
    this.migrateHostCapabilitiesToCanary();
    this.migrateUnkeyedHostCapabilitiesToCanary();
    this.migrateSessions();
    this.migrateSessionPinColumn();
    this.migrateAgents();
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS model_calls (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id),
        session_id TEXT REFERENCES sessions(id),
        role TEXT NOT NULL,
        model_name TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        user_prompt TEXT NOT NULL,
        response_json TEXT,
        raw_response TEXT,
        error TEXT,
        request_id TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        duration_ms INTEGER,
        created_at TEXT NOT NULL,
        finished_at TEXT,
        request_meta_json TEXT,
        error_meta_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_model_calls_task_time ON model_calls(task_id, created_at);
    `);
    const modelCallColumns = this.database.prepare('PRAGMA table_info(model_calls)').all() as Array<{ name: string; notnull: number }>;
    if (!modelCallColumns.some(column => column.name === 'model_name')) {
      this.database.exec("ALTER TABLE model_calls ADD COLUMN model_name TEXT NOT NULL DEFAULT ''");
    }
    if (!modelCallColumns.some(column => column.name === 'session_id')
      || modelCallColumns.some(column => column.name === 'task_id' && column.notnull === 1)) {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.database.exec(`
          ALTER TABLE model_calls RENAME TO model_calls_previous;
          CREATE TABLE model_calls (
            id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), session_id TEXT REFERENCES sessions(id),
            role TEXT NOT NULL, model_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
            system_prompt TEXT NOT NULL, user_prompt TEXT NOT NULL, response_json TEXT, error TEXT,
            request_id TEXT, input_tokens INTEGER, output_tokens INTEGER, duration_ms INTEGER,
            created_at TEXT NOT NULL, finished_at TEXT
          );
          INSERT INTO model_calls (id, task_id, role, model_name, status, system_prompt, user_prompt,
            response_json, error, request_id, input_tokens, output_tokens, duration_ms, created_at, finished_at)
          SELECT id, task_id, role, model_name, status, system_prompt, user_prompt,
            response_json, error, request_id, input_tokens, output_tokens, duration_ms, created_at, finished_at
          FROM model_calls_previous;
          DROP TABLE model_calls_previous;
          CREATE INDEX idx_model_calls_task_time ON model_calls(task_id, created_at);
        `);
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    }
    const currentModelColumns = new Set((this.database.prepare('PRAGMA table_info(model_calls)').all() as Array<{ name: string }>).map(column => column.name));
    if (!currentModelColumns.has('request_meta_json')) this.database.exec('ALTER TABLE model_calls ADD COLUMN request_meta_json TEXT');
    if (!currentModelColumns.has('error_meta_json')) this.database.exec('ALTER TABLE model_calls ADD COLUMN error_meta_json TEXT');
    if (!currentModelColumns.has('raw_response')) this.database.exec('ALTER TABLE model_calls ADD COLUMN raw_response TEXT');
  }

  /** user_version 3: session management tables and the tasks.session_id column. */
  private migrateSessions(): void {
    const version = this.database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version >= 3) return;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          pinned_at TEXT,
          summary TEXT,
          summary_seq INTEGER NOT NULL DEFAULT 0,
          memory_tokens INTEGER NOT NULL DEFAULT 0,
          message_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS session_messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          task_id TEXT,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'final',
          tokens INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_session_messages ON session_messages(session_id, seq);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_session_messages_task
          ON session_messages(task_id) WHERE task_id IS NOT NULL AND role = 'assistant';
      `);
      const columns = this.database.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'session_id')) {
        this.database.exec('ALTER TABLE tasks ADD COLUMN session_id TEXT REFERENCES sessions(id)');
      }
      this.database.exec('PRAGMA user_version = 3');
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private migrateSessionPinColumn(): void {
    const columns = this.database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'pinned_at')) {
      this.database.exec('ALTER TABLE sessions ADD COLUMN pinned_at TEXT');
    }
  }

  /** user_version 5: persistent Agent identities, inboxes, and full payload references. */
  private migrateAgents(): void {
    const version = this.database.prepare('PRAGMA user_version').get() as { user_version: number };
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS agent_sessions (
          id TEXT PRIMARY KEY,
          parent_agent_id TEXT,
          root_task_id TEXT,
          name TEXT NOT NULL,
          role TEXT NOT NULL,
          goal TEXT NOT NULL,
          capabilities_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'queued',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_sessions_root
          ON agent_sessions(root_task_id, created_at);
        CREATE TABLE IF NOT EXISTS agent_messages (
          id TEXT PRIMARY KEY,
          root_task_id TEXT,
          sender_agent_id TEXT NOT NULL,
          recipient_agent_id TEXT NOT NULL,
          type TEXT NOT NULL,
          correlation_id TEXT,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          error TEXT,
          created_at TEXT NOT NULL,
          delivered_at TEXT,
          read_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_agent_messages_inbox
          ON agent_messages(recipient_agent_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_messages_root
          ON agent_messages(root_task_id, created_at);
        CREATE TABLE IF NOT EXISTS agent_payload_refs (
          id TEXT PRIMARY KEY,
          root_task_id TEXT NOT NULL,
          recipient_agent_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      if (version.user_version < 5) this.database.exec('PRAGMA user_version = 5');
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private migrateUnkeyedHostCapabilitiesToCanary(): void {
    const version = this.database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version >= 2) return;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.database.prepare("SELECT id, version, manifest_json FROM capabilities WHERE status = 'active'")
        .all() as Array<{ id: string; version: string; manifest_json: string }>;
      for (const row of rows) {
        let shouldQuarantine = true;
        let manifest: { capabilityKey?: unknown; permissions?: unknown; provenance?: Record<string, unknown> } | null = null;
        try {
          manifest = JSON.parse(row.manifest_json);
          shouldQuarantine = !manifest || (typeof manifest.capabilityKey !== 'string'
            && Array.isArray(manifest.permissions) && manifest.permissions.length > 0);
        } catch {
          shouldQuarantine = true;
        }
        if (!shouldQuarantine) continue;
        if (manifest) {
          manifest.provenance = { ...(manifest.provenance ?? {}), migratedFromActive: true };
          this.database.prepare("UPDATE capabilities SET status = 'canary', manifest_json = ? WHERE id = ? AND version = ?")
            .run(JSON.stringify(manifest), row.id, row.version);
        } else {
          this.database.prepare("UPDATE capabilities SET status = 'canary' WHERE id = ? AND version = ?")
            .run(row.id, row.version);
        }
      }
      this.database.exec('PRAGMA user_version = 2');
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private migrateHostCapabilitiesToCanary(): void {
    const version = this.database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version >= 1) return;
    this.database.exec('BEGIN IMMEDIATE');
    try {
    const rows = this.database.prepare("SELECT id, version, manifest_json FROM capabilities WHERE status = 'active'")
      .all() as Array<{ id: string; version: string; manifest_json: string }>;
    for (const row of rows) {
      try {
        const manifest = JSON.parse(row.manifest_json) as { permissions?: unknown; provenance?: Record<string, unknown> };
        if (Array.isArray(manifest.permissions) && manifest.permissions.length > 0) {
          manifest.provenance = { ...(manifest.provenance ?? {}), migratedFromActive: true };
          this.database.prepare("UPDATE capabilities SET status = 'canary', manifest_json = ? WHERE id = ? AND version = ? AND status = 'active'")
            .run(JSON.stringify(manifest), row.id, row.version);
        }
      } catch {
        // Corrupt manifests must never remain an active executable capability.
        this.database.prepare("UPDATE capabilities SET status = 'canary' WHERE id = ? AND version = ? AND status = 'active'")
          .run(row.id, row.version);
      }
    }
      this.database.exec('PRAGMA user_version = 1');
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private migrateTaskPermissionColumns(): void {
    const columns = this.database.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('permission_mode')) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'request'");
    }
    if (!names.has('pending_permission_json')) {
      this.database.exec('ALTER TABLE tasks ADD COLUMN pending_permission_json TEXT');
    }
    if (!names.has('execution_checkpoint_json')) {
      this.database.exec('ALTER TABLE tasks ADD COLUMN execution_checkpoint_json TEXT');
    }
    if (!names.has('correction_state_json')) {
      this.database.exec('ALTER TABLE tasks ADD COLUMN correction_state_json TEXT');
    }
  }

  createTask(input: CreateTaskInput): TaskRun {
    const now = new Date().toISOString();
    const task: TaskRun = {
      id: randomUUID(),
      message: input.message,
      attachments: input.attachments,
      status: 'INTAKE',
      permissionMode: input.permissionMode ?? 'request',
      sessionId: input.sessionId,
      acceptanceCriteria: [],
      metrics: { generatedCapabilityCount: 0, reusedCapabilityCount: 0, retryCount: 0 },
      retryCounts: {},
      correctionState: { roundsUsed: 0, finishedRoundIds: [], failures: [] },
      createdAt: now,
      updatedAt: now,
    };
    this.saveTask(task);
    return task;
  }

  getTask(taskId: string): TaskRun | null {
    const row = this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
    return row ? this.taskFromRow(row) : null;
  }

  listRecoverableTaskIds(): string[] {
    const rows = this.database.prepare(`
      SELECT task.id
      FROM tasks AS task
      WHERE task.status IN ('PLAN_READY', 'EXECUTING', 'TEST_PLANNING', 'TESTING_LIVE', 'TEST_REVIEW', 'EVALUATING', 'RETRYING')
        AND task.execution_checkpoint_json IS NOT NULL
        AND task.pending_permission_json IS NULL
        AND (json_extract(task.execution_checkpoint_json, '$.pendingReview.stepId') IS NOT NULL
          OR EXISTS (SELECT 1 FROM capabilities AS pure
              WHERE pure.id = json_extract(task.execution_checkpoint_json, '$.capabilityName')
                AND pure.version = json_extract(task.execution_checkpoint_json, '$.capabilityVersion')
                AND json_extract(pure.manifest_json, '$.provenance.sourceTaskId') = 'builtin'
                AND json_array_length(pure.manifest_json, '$.permissions') = 0)
          OR (EXISTS (SELECT 1 FROM operation_journal AS completed
              WHERE completed.task_id = task.id AND completed.state = 'completed')
            AND NOT EXISTS (SELECT 1 FROM operation_journal AS unsettled
              WHERE unsettled.task_id = task.id AND unsettled.state <> 'completed')))
      ORDER BY task.updated_at ASC
    `).all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  listInterruptedTaskIds(): string[] {
    const rows = this.database.prepare(`
      SELECT id FROM tasks
      WHERE status NOT IN ('COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED', 'WAITING_FOR_APPROVAL', 'NEEDS_USER_INPUT')
      ORDER BY updated_at ASC
    `).all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  saveTask(task: TaskRun): void {
    this.database.prepare(`
      INSERT INTO tasks (
        id, message, attachments_json, status, acceptance_criteria_json, result,
        current_step_id, metrics_json, retry_counts_json, created_at, updated_at,
        permission_mode, pending_permission_json, execution_checkpoint_json, correction_state_json,
        session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        message = excluded.message,
        attachments_json = excluded.attachments_json,
        status = excluded.status,
        acceptance_criteria_json = excluded.acceptance_criteria_json,
        result = excluded.result,
        current_step_id = excluded.current_step_id,
        metrics_json = excluded.metrics_json,
        retry_counts_json = excluded.retry_counts_json,
        updated_at = excluded.updated_at,
        permission_mode = excluded.permission_mode,
        pending_permission_json = excluded.pending_permission_json,
        execution_checkpoint_json = excluded.execution_checkpoint_json,
        correction_state_json = excluded.correction_state_json,
        session_id = excluded.session_id
    `).run(
      task.id,
      task.message,
      JSON.stringify(task.attachments),
      task.status,
      JSON.stringify(task.acceptanceCriteria),
      task.result ?? null,
      task.currentStepId ?? null,
      JSON.stringify(task.metrics),
      JSON.stringify(task.retryCounts),
      task.createdAt,
      task.updatedAt,
      task.permissionMode,
      task.pendingPermission ? JSON.stringify(task.pendingPermission) : null,
      task.executionCheckpoint ? JSON.stringify(task.executionCheckpoint) : null,
      JSON.stringify({ ...task.correctionState,
        failures: task.correctionState.failures.map(persistableCorrectionFailure) }),
      task.sessionId ?? null,
    );
  }

  finishCorrectionRound(taskId: string, roundId: string, failure?: CorrectionFailure): TaskRun {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const task = this.getTask(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (task.correctionState.finishedRoundIds.includes(roundId)) {
        this.database.exec('COMMIT');
        return task;
      }
      const current = task.correctionState.currentRound;
      task.correctionState = finishCorrection(task.correctionState, roundId, failure);
      task.metrics.retryCount = task.correctionState.roundsUsed;
      task.updatedAt = new Date().toISOString();
      this.saveTask(task);
      this.appendEvent(taskId, { type: 'correction.round_finished', payload: {
        ordinal: current!.ordinal, target: current!.target, failureCode: failure?.code ?? null,
      } });
      this.database.exec('COMMIT');
      return task;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getOperation(taskId: string, operationId: string): OperationJournalRecord | null {
    const row = this.database.prepare(`
      SELECT * FROM operation_journal WHERE task_id = ? AND operation_id = ?
    `).get(taskId, operationId) as OperationRow | undefined;
    return row ? this.operationFromRow(row) : null;
  }

  listStepOperations(taskId: string, stepId: string, capabilityVersion: string): OperationJournalRecord[] {
    const prefix = `${taskId}:${stepId}:${capabilityVersion}:`;
    const rows = this.database.prepare('SELECT * FROM operation_journal WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as unknown as OperationRow[];
    return rows.filter((row) => row.operation_id.startsWith(prefix)).map((row) => this.operationFromRow(row));
  }

  createOperation(record: OperationJournalRecord): OperationJournalRecord {
    this.database.prepare(`
      INSERT INTO operation_journal (
        task_id, operation_id, request_id, state, operation_json, result_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, operation_id) DO NOTHING
    `).run(
      record.taskId,
      record.operationId,
      record.requestId ?? null,
      record.state,
      JSON.stringify(record.operation),
      record.result === undefined ? null : JSON.stringify(record.result),
      record.createdAt,
      record.updatedAt,
    );
    const stored = this.getOperation(record.taskId, record.operationId);
    if (!stored) throw new Error('Operation journal insert did not produce a record');
    return stored;
  }

  recordPendingPermission(task: TaskRun, record: OperationJournalRecord): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.saveTask(task);
      this.createOperation(record);
      this.appendEvent(task.id, {
        type: 'task.permission_requested',
        payload: {
          requestId: record.requestId,
          operationId: record.operationId,
          permission: record.operation.permission,
          action: record.operation.action,
          target: auditTarget(record.operation.target),
          reason: record.operation.reason,
          risk: task.pendingPermission?.risk ?? 'medium',
        },
      });
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  recordPermissionDecision(taskId: string, requestId: string, approved: boolean): 'approved' | 'denied' | 'completed' | 'conflict' | 'unknown' {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database.prepare(`
        SELECT * FROM operation_journal WHERE task_id = ? AND request_id = ?
      `).get(taskId, requestId) as OperationRow | undefined;
      if (!row) {
        this.database.exec('COMMIT');
        return 'conflict';
      }
      const record = this.operationFromRow(row);
      const task = this.getTask(taskId);
      if (!task) {
        this.database.exec('COMMIT');
        return 'conflict';
      }
      if (record.state === 'completed') {
        this.database.exec('COMMIT');
        return 'completed';
      }
      if (record.state === 'unknown' || record.state === 'executing') {
        this.database.exec('COMMIT');
        return 'unknown';
      }
      if (record.state === 'denied') {
        this.database.exec('COMMIT');
        return 'denied';
      }
      if (record.state === 'approved') {
        this.database.exec('COMMIT');
        return 'approved';
      }
      if (record.state !== 'pending' || task.pendingPermission?.requestId !== requestId) {
        this.database.exec('COMMIT');
        return 'conflict';
      }

      const nextState = approved ? 'approved' : 'denied';
      this.database.prepare(`
        UPDATE operation_journal SET state = ?, updated_at = ?
        WHERE task_id = ? AND operation_id = ? AND state = 'pending'
      `).run(nextState, new Date().toISOString(), taskId, record.operationId);
      this.appendEvent(taskId, {
        type: approved ? 'task.permission_approved' : 'task.permission_denied',
        payload: { requestId, operationId: record.operationId, permission: record.operation.permission, action: record.operation.action, target: auditTarget(record.operation.target) },
      });
      if (!approved) {
        task.pendingPermission = undefined;
        task.executionCheckpoint = undefined;
        task.status = 'CANCELLED';
        task.result = `任务已停止：你拒绝了操作“${record.operation.action}”（${record.operation.target}），该操作未执行。`;
        task.updatedAt = new Date().toISOString();
        this.saveTask(task);
        this.appendEvent(taskId, { type: 'task.cancelled', payload: { reason: 'permission-denied', operationId: record.operationId } });
      }
      this.database.exec('COMMIT');
      return approved ? 'approved' : 'denied';
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  beginApprovedOperation(taskId: string, operationId: string): boolean {
    return this.transitionOperation(taskId, operationId, ['approved'], 'executing');
  }

  completeOperation(taskId: string, operationId: string, result: unknown): boolean {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database.prepare(`SELECT * FROM operation_journal WHERE task_id = ? AND operation_id = ?`)
        .get(taskId, operationId) as OperationRow | undefined;
      if (!row) {
        this.database.exec('ROLLBACK');
        return false;
      }
      if (row.state === 'completed') {
        this.database.exec('COMMIT');
        return false;
      }
      if (row.state !== 'executing') {
        this.database.exec('ROLLBACK');
        return false;
      }
      this.database.prepare(`
        UPDATE operation_journal SET state = 'completed', result_json = ?, updated_at = ?
        WHERE task_id = ? AND operation_id = ? AND state = 'executing'
      `).run(JSON.stringify(result), new Date().toISOString(), taskId, operationId);
      const task = this.getTask(taskId);
      if (task?.pendingPermission?.operation.operationId === operationId) {
        task.pendingPermission = undefined;
        task.status = 'PLAN_READY';
        task.result = undefined;
        task.updatedAt = new Date().toISOString();
        this.saveTask(task);
      }
      const operation = JSON.parse(row.operation_json) as PermissionOperation;
      const success = !!result && typeof result === 'object' && 'ok' in result && (result as { ok?: unknown }).ok === true;
      this.appendEvent(taskId, {
        type: 'task.operation_completed',
        payload: { operationId, permission: operation.permission, action: operation.action, target: auditTarget(operation.target), success },
      });
      if (row.request_id) {
        this.appendEvent(taskId, {
          type: 'task.permission_resolved',
          payload: { requestId: row.request_id, operationId, approved: true, success },
        });
      }
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  transitionOperation(
    taskId: string,
    operationId: string,
    expectedStates: OperationJournalState[],
    state: OperationJournalState,
    options: { requestId?: string; result?: unknown } = {},
  ): boolean {
    if (expectedStates.length === 0) return false;
    const placeholders = expectedStates.map(() => '?').join(', ');
    const resultJson = options.result === undefined ? null : JSON.stringify(options.result);
    const query = `
      UPDATE operation_journal
      SET state = ?, request_id = COALESCE(?, request_id), result_json = COALESCE(?, result_json), updated_at = ?
      WHERE task_id = ? AND operation_id = ? AND state IN (${placeholders})
    `;
    const updated = this.database.prepare(query).run(
      state,
      options.requestId ?? null,
      resultJson,
      new Date().toISOString(),
      taskId,
      operationId,
      ...expectedStates,
    );
    return Number(updated.changes) === 1;
  }

  markInFlightOperationsUnknown(): number {
    const updated = this.database.prepare(`
      UPDATE operation_journal SET state = 'unknown', updated_at = ? WHERE state = 'executing'
    `).run(new Date().toISOString());
    return Number(updated.changes);
  }

  recoverInterruptedOperations(): number {
    const affected = this.database.prepare(`
      SELECT DISTINCT task_id, operation_id FROM operation_journal WHERE state = 'executing'
    `).all() as Array<{ task_id: string; operation_id: string }>;
    if (!affected.length) return 0;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.markInFlightOperationsUnknown();
      for (const item of affected) {
        const task = this.getTask(item.task_id);
        if (!task || task.status === 'COMPLETED' || task.status === 'FAILED' || task.status === 'BLOCKED' || task.status === 'CANCELLED') continue;
        task.pendingPermission = undefined;
        task.executionCheckpoint = undefined;
        task.status = 'BLOCKED';
        task.result = '任务已阻塞：服务重启前操作已开始，但结果无法确认。为避免重复副作用，贾维斯没有重放该操作；请检查目标后重新提交任务。';
        task.updatedAt = new Date().toISOString();
        this.saveTask(task);
        this.appendEvent(item.task_id, {
          type: 'task.operation_unknown',
          payload: { operationId: item.operation_id, recovery: 'not-replayed' },
        });
        this.appendEvent(item.task_id, { type: 'task.blocked', payload: { reason: 'operation outcome unknown after restart' } });
      }
      this.database.exec('COMMIT');
      return affected.length;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  appendEvent(taskId: string, event: TaskEvent): void {
    this.database.prepare(`
      INSERT INTO task_events (task_id, type, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(taskId, event.type, JSON.stringify(event.payload), event.createdAt ?? new Date().toISOString());
  }

  listEvents(taskId: string): TaskEvent[] {
    const rows = this.database.prepare(`
      SELECT type, payload_json, created_at
      FROM task_events
      WHERE task_id = ?
      ORDER BY id ASC
    `).all(taskId) as unknown as EventRow[];
    return rows.map((row) => ({
      type: row.type,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  startModelTrace(request: ModelRequest, modelName = '', details?: ModelRequestDetails): string {
    if (!request.taskId && !request.sessionId) throw new Error('Model trace requires a task or session ID.');
    const id = randomUUID();
    const schemaJson = request.outputSchema === undefined ? null : JSON.stringify(request.outputSchema);
    const requestMeta = JSON.stringify({ ...details,
      validationSchema: schemaJson === null ? null : schemaJson.length > 30_000
        ? traceText(schemaJson) : JSON.parse(traceText(schemaJson)) as unknown });
    this.database.prepare(`INSERT INTO model_calls
      (id, task_id, session_id, role, model_name, status, system_prompt, user_prompt, request_meta_json, created_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
      .run(id, request.taskId ?? null, request.sessionId ?? null, request.role, modelName,
        traceText(request.system), traceText(request.user), requestMeta, new Date().toISOString());
    return id;
  }

  finishModelTrace(id: string, outcome: { completion?: ModelCompletion; error?: string; cancelled?: boolean;
    rawResponse?: string; errorDetails?: { name: string; statusCode?: number; requestId?: string } }): void {
    const started = this.database.prepare('SELECT created_at FROM model_calls WHERE id = ?')
      .get(id) as { created_at: string } | undefined;
    if (!started) return;
    const finishedAt = new Date().toISOString();
    const response = outcome.completion ? traceText(JSON.stringify(outcome.completion.data)) : null;
    const rawResponse = outcome.completion?.rawContent ?? outcome.rawResponse;
    this.database.prepare(`UPDATE model_calls SET status = ?, response_json = ?, raw_response = ?, error = ?, request_id = ?,
      input_tokens = ?, output_tokens = ?, duration_ms = ?, finished_at = ?, error_meta_json = ? WHERE id = ?`)
      .run(outcome.cancelled ? 'cancelled' : outcome.error ? 'failed' : 'completed', response, rawResponse ? traceText(rawResponse) : null,
        outcome.error ? traceText(outcome.error) : null,
        outcome.completion?.requestId ?? outcome.errorDetails?.requestId ?? null, outcome.completion?.usage.inputTokens ?? null,
        outcome.completion?.usage.outputTokens ?? null,
        Math.max(0, Date.parse(finishedAt) - Date.parse(started.created_at)), finishedAt,
        outcome.errorDetails ? JSON.stringify(outcome.errorDetails) : null, id);
  }

  recoverInterruptedModelCalls(): number {
    const now = new Date().toISOString();
    const changed = this.database.prepare(`UPDATE model_calls SET status = 'interrupted',
      error = '服务在模型调用完成前停止，结果未知。', duration_ms = MAX(0, CAST((julianday(?) - julianday(created_at)) * 86400000 AS INTEGER)),
      finished_at = ? WHERE status = 'running'`).run(now, now);
    return Number(changed.changes);
  }

  listTrajectory(scope: { sessionId?: string; taskId?: string }, limit = 100, offset = 0): {
    entries: TrajectoryEntry[]; hasMore: boolean; summary: TrajectorySummary;
  } {
    const selected = scope.sessionId ? 't.session_id = ?' : 't.id = ?';
    const value = scope.sessionId ?? scope.taskId;
    const emptySummary: TrajectorySummary = { events: 0, modelCalls: 0, failedModels: 0, operations: 0,
      failedOperations: 0, inputTokens: 0, outputTokens: 0, modelDurationMs: 0 };
    if (!value) return { entries: [], hasMore: false, summary: emptySummary };
    const fetchCount = limit + offset + 1;
    const events = this.database.prepare(`SELECT e.id, e.task_id, e.type, e.payload_json, e.created_at
      FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE ${selected}
      ORDER BY e.created_at DESC, e.id DESC LIMIT ?`).all(value, fetchCount) as unknown as Array<EventRow & { id: number; task_id: string }>;
    const calls = scope.sessionId
      ? this.database.prepare(`SELECT m.* FROM model_calls m LEFT JOIN tasks t ON t.id = m.task_id
        WHERE m.session_id = ? OR t.session_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT ?`)
        .all(value, value, fetchCount) as unknown as ModelCallRow[]
      : this.database.prepare(`SELECT m.* FROM model_calls m WHERE m.task_id = ?
        ORDER BY m.created_at DESC, m.id DESC LIMIT ?`)
        .all(value, fetchCount) as unknown as ModelCallRow[];
    const operations = this.database.prepare(`SELECT o.* FROM operation_journal o JOIN tasks t ON t.id = o.task_id
      WHERE ${selected} ORDER BY o.created_at DESC, o.operation_id DESC LIMIT ?`)
      .all(value, fetchCount) as unknown as OperationRow[];
    const eventTotals = this.database.prepare(`SELECT COUNT(*) AS total FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE ${selected}`)
      .get(value) as { total: number };
    const modelWhere = scope.sessionId ? 'm.session_id = ? OR t.session_id = ?' : 'm.task_id = ?';
    const modelParams = scope.sessionId ? [value, value] : [value];
    const modelTotals = this.database.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN m.status IN ('failed', 'interrupted') THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(m.input_tokens), 0) AS input_tokens, COALESCE(SUM(m.output_tokens), 0) AS output_tokens,
      COALESCE(SUM(m.duration_ms), 0) AS duration_ms FROM model_calls m LEFT JOIN tasks t ON t.id = m.task_id
      WHERE ${modelWhere}`).get(...modelParams) as { total: number; failed: number; input_tokens: number; output_tokens: number; duration_ms: number };
    const operationTotals = this.database.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN o.state IN ('denied', 'unknown') OR (o.state = 'completed' AND json_extract(o.result_json, '$.ok') = 0)
        THEN 1 ELSE 0 END), 0) AS failed FROM operation_journal o JOIN tasks t ON t.id = o.task_id WHERE ${selected}`)
      .get(value) as { total: number; failed: number };
    const summary: TrajectorySummary = { events: eventTotals.total, modelCalls: modelTotals.total,
      failedModels: modelTotals.failed, operations: operationTotals.total, failedOperations: operationTotals.failed,
      inputTokens: modelTotals.input_tokens, outputTokens: modelTotals.output_tokens,
      modelDurationMs: modelTotals.duration_ms };
    const entries: TrajectoryEntry[] = [
      ...events.map(row => ({ id: `event:${row.id}`, taskId: row.task_id, kind: 'event' as const,
        type: row.type, payload: JSON.parse(row.payload_json) as Record<string, unknown>, createdAt: row.created_at })),
      ...calls.map(row => ({ id: `model:${row.id}`, taskId: row.task_id, kind: 'model' as const,
        type: row.role, createdAt: row.created_at,
        model: { status: row.status, modelName: row.model_name, system: row.system_prompt, user: row.user_prompt,
          response: row.response_json, rawResponse: row.raw_response, error: row.error, requestId: row.request_id,
          inputTokens: row.input_tokens, outputTokens: row.output_tokens, durationMs: row.duration_ms,
          finishedAt: row.finished_at, request: row.request_meta_json ? JSON.parse(row.request_meta_json) as Record<string, unknown> : null,
          errorDetails: row.error_meta_json ? JSON.parse(row.error_meta_json) as Record<string, unknown> : null } })),
      ...operations.map(row => {
        const operation = JSON.parse(row.operation_json) as PermissionOperation;
        const result = row.result_json ? JSON.parse(row.result_json) as { ok?: unknown; error?: { code?: unknown } } : null;
        return { id: `operation:${row.task_id}:${row.operation_id}`, taskId: row.task_id,
          kind: 'operation' as const, type: `${operation.permission}.${operation.action}`, createdAt: row.created_at,
          operation: { operationId: row.operation_id, requestId: row.request_id, state: row.state,
            permission: operation.permission, action: operation.action, target: traceText(auditTarget(operation.target)),
            success: typeof result?.ok === 'boolean' ? result.ok : null,
            errorCode: typeof result?.error?.code === 'string' ? result.error.code : null,
            updatedAt: row.updated_at,
            durationMs: Math.max(0, Date.parse(row.updated_at) - Date.parse(row.created_at)) } };
      }),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { entries: entries.slice(offset, offset + limit), hasMore: entries.length > offset + limit, summary };
  }

  /**
   * Returns only the latest failed task's actionable evidence for a new turn.
   * The full trajectory remains a UI concern; planner context is deliberately
   * small and redacted so a repair request can diagnose itself without asking
   * the user to paste error codes or logs.
   */
  getLatestDiagnosticContext(sessionId: string, excludeTaskId?: string): DiagnosticContext | null {
    const row = excludeTaskId
      ? this.database.prepare(`SELECT * FROM tasks
          WHERE session_id = ? AND id <> ? AND status IN ('FAILED', 'BLOCKED', 'CANCELLED')
          ORDER BY updated_at DESC LIMIT 1`).get(sessionId, excludeTaskId) as TaskRow | undefined
      : this.database.prepare(`SELECT * FROM tasks
          WHERE session_id = ? AND status IN ('FAILED', 'BLOCKED', 'CANCELLED')
          ORDER BY updated_at DESC LIMIT 1`).get(sessionId) as TaskRow | undefined;
    if (!row) return null;
    const task = this.taskFromRow(row);
    const entries = boundDiagnosticEntries(this.listTrajectory({ taskId: task.id }, 100, 0).entries
      .map(diagnosticEntry).filter((entry): entry is DiagnosticEvidenceEntry => entry !== null)
      .slice(0, 24));
    return {
      taskId: task.id,
      status: task.status as DiagnosticContext['status'],
      request: diagnosticText(task.message, 1_000),
      result: task.result ? diagnosticText(task.result, 2_000) : undefined,
      entries,
    };
  }

  saveCapability(capability: CapabilityRecord): void {
    this.database.prepare(`
      INSERT INTO capabilities (
        id, version, status, normalized_intent, manifest_json, code, evaluation_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, version) DO UPDATE SET
        status = excluded.status,
        normalized_intent = excluded.normalized_intent,
        manifest_json = excluded.manifest_json,
        code = excluded.code,
        evaluation_json = excluded.evaluation_json
    `).run(
      capability.id,
      capability.version,
      capability.status,
      normalizeIntent(capability.normalizedIntent),
      JSON.stringify(capability.manifest),
      capability.code,
      JSON.stringify(capability.evaluation),
      capability.createdAt,
    );
  }

  findByIntent(intent: string): CapabilityRecord | null {
    const row = this.database.prepare(`
      SELECT * FROM capabilities
      WHERE normalized_intent = ? AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(normalizeIntent(intent)) as CapabilityRow | undefined;
    return row ? this.capabilityFromRow(row) : null;
  }

  getActive(capabilityId: string): CapabilityRecord | null {
    const row = this.database.prepare(`
      SELECT * FROM capabilities
      WHERE id = ? AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(capabilityId) as CapabilityRow | undefined;
    return row ? this.capabilityFromRow(row) : null;
  }

  findUsableByIntent(intent: string): CapabilityRecord | null {
    const row = this.database.prepare(`
      SELECT * FROM capabilities WHERE normalized_intent = ? AND status IN ('active', 'canary')
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC LIMIT 1
    `).get(normalizeIntent(intent)) as CapabilityRow | undefined;
    return row ? this.capabilityFromRow(row) : null;
  }

  findUsableByKey(key: string): CapabilityRecord | null {
    const row = this.database.prepare(`
      SELECT * FROM capabilities
      WHERE json_extract(manifest_json, '$.capabilityKey') = ? AND status IN ('active', 'canary')
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC
      LIMIT 1
    `).get(key) as CapabilityRow | undefined;
    return row ? this.capabilityFromRow(row) : null;
  }

  getUsable(capabilityId: string): CapabilityRecord | null {
    const row = this.database.prepare(`
      SELECT * FROM capabilities WHERE id = ? AND status IN ('active', 'canary')
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC LIMIT 1
    `).get(capabilityId) as CapabilityRow | undefined;
    return row ? this.capabilityFromRow(row) : null;
  }

  promoteCapability(capabilityId: string, version: string): CapabilityRecord {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getCapabilityVersion(capabilityId, version);
      if (!current || (current.status !== 'canary' && current.status !== 'active')) throw new Error('Canary capability not found.');
      this.database.prepare("UPDATE capabilities SET status = 'deprecated' WHERE id = ? AND version != ? AND status = 'active'")
        .run(capabilityId, version);
      this.database.prepare("UPDATE capabilities SET status = 'active' WHERE id = ? AND version = ? AND status = 'canary'")
        .run(capabilityId, version);
      this.database.exec('COMMIT');
      return { ...current, status: 'active' };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getCapabilityVersion(capabilityId: string, version: string): CapabilityRecord | null {
    const row = this.database.prepare(`
      SELECT * FROM capabilities WHERE id = ? AND version = ?
    `).get(capabilityId, version) as CapabilityRow | undefined;
    return row ? this.capabilityFromRow(row) : null;
  }

  listActiveCapabilities(): CapabilityRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM capabilities
      WHERE status = 'active'
      ORDER BY created_at ASC
    `).all() as unknown as CapabilityRow[];
    return rows.map((row) => this.capabilityFromRow(row));
  }

  deprecateActive(capabilityId: string, exceptVersion: string): void {
    this.database.prepare(`
      UPDATE capabilities
      SET status = 'deprecated'
      WHERE id = ? AND status = 'active' AND version != ?
    `).run(capabilityId, exceptVersion);
  }

  deprecateCapability(capabilityId: string, version: string): void {
    this.database.prepare(`
      UPDATE capabilities
      SET status = 'deprecated'
      WHERE id = ? AND version = ? AND status IN ('active', 'canary')
    `).run(capabilityId, version);
  }

  createAgent(input: CreateAgentInput): AgentSessionRecord {
    return this.createAgents([input])[0]!;
  }

  createAgents(inputs: CreateAgentInput[]): AgentSessionRecord[] {
    if (inputs.length === 0) return [];
    const agents = inputs.map((input) => {
      const now = new Date().toISOString();
      return {
        id: input.id ?? randomUUID(),
        parentAgentId: input.parentAgentId,
        rootTaskId: input.rootTaskId,
        name: input.name,
        role: input.role,
        goal: input.goal,
        capabilities: [...(input.capabilities ?? [])],
        status: input.status ?? 'queued',
        createdAt: now,
        updatedAt: now,
      } satisfies AgentSessionRecord;
    });
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.database.prepare(`
        INSERT INTO agent_sessions
          (id, parent_agent_id, root_task_id, name, role, goal, capabilities_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const agent of agents) {
        insert.run(agent.id, agent.parentAgentId ?? null, agent.rootTaskId ?? null, agent.name, agent.role, agent.goal,
          JSON.stringify(agent.capabilities), agent.status, agent.createdAt, agent.updatedAt);
      }
      this.database.exec('COMMIT');
      return agents;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getAgent(agentId: string): AgentSessionRecord | null {
    const row = this.database.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(agentId) as AgentRow | undefined;
    return row ? this.agentFromRow(row) : null;
  }

  listAgents(rootTaskId?: string): AgentSessionRecord[] {
    const rows = rootTaskId
      ? this.database.prepare('SELECT * FROM agent_sessions WHERE root_task_id = ? ORDER BY created_at ASC, id ASC')
        .all(rootTaskId) as unknown as AgentRow[]
      : this.database.prepare('SELECT * FROM agent_sessions ORDER BY created_at ASC, id ASC').all() as unknown as AgentRow[];
    return rows.map((row) => this.agentFromRow(row));
  }

  updateAgentStatus(agentId: string, status: AgentStatus): AgentSessionRecord {
    const now = new Date().toISOString();
    const result = this.database.prepare('UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, agentId);
    if (Number(result.changes) !== 1) throw new Error(`Agent not found: ${agentId}`);
    return this.getAgent(agentId)!;
  }

  sendAgentMessage(input: SendAgentMessageInput): AgentMessageRecord {
    const id = input.messageId ?? randomUUID();
    const payloadJson = JSON.stringify(input.payload);
    if (payloadJson === undefined) throw new Error('Agent message payload must be JSON serializable.');
    const existing = this.database.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as AgentMessageRow | undefined;
    if (existing) {
      const sameEnvelope = existing.root_task_id === (input.rootTaskId ?? null)
        && existing.sender_agent_id === input.senderAgentId
        && existing.recipient_agent_id === input.recipientAgentId
        && existing.type === input.type
        && existing.correlation_id === (input.correlationId ?? null)
        && existing.payload_json === payloadJson;
      if (!sameEnvelope) throw new Error(`Agent message ${id} has a different envelope.`);
      return this.agentMessageFromRow(existing);
    }
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO agent_messages
        (id, root_task_id, sender_agent_id, recipient_agent_id, type, correlation_id, payload_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)
    `).run(id, input.rootTaskId ?? null, input.senderAgentId, input.recipientAgentId, input.type,
      input.correlationId ?? null, payloadJson, now);
    return this.getAgentMessage(id)!;
  }

  getAgentMessage(messageId: string): AgentMessageRecord | null {
    const row = this.database.prepare('SELECT * FROM agent_messages WHERE id = ?').get(messageId) as AgentMessageRow | undefined;
    return row ? this.agentMessageFromRow(row) : null;
  }

  saveAgentPayloadRef(id: string, rootTaskId: string, recipientAgentId: string, payload: unknown): void {
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) throw new Error('Agent payload reference must be JSON serializable.');
    const existing = this.database.prepare('SELECT root_task_id, recipient_agent_id, payload_json FROM agent_payload_refs WHERE id = ?')
      .get(id) as { root_task_id: string; recipient_agent_id: string; payload_json: string } | undefined;
    if (existing) {
      if (existing.root_task_id !== rootTaskId || existing.recipient_agent_id !== recipientAgentId
        || existing.payload_json !== serialized) throw new Error(`Agent payload reference ${id} has different content.`);
      return;
    }
    this.database.prepare(`INSERT INTO agent_payload_refs (id, root_task_id, recipient_agent_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(id, rootTaskId, recipientAgentId, serialized, new Date().toISOString());
  }

  getAgentPayloadRef(id: string, recipientAgentId: string): unknown | null {
    const row = this.database.prepare('SELECT payload_json FROM agent_payload_refs WHERE id = ? AND recipient_agent_id = ?')
      .get(id, recipientAgentId) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) : null;
  }

  supersedeAgentStepAssignments(rootTaskId: string, stepId: string, currentMessageId: string): void {
    const rows = this.database.prepare(`SELECT id, payload_json FROM agent_messages
      WHERE root_task_id = ? AND type = 'request' AND correlation_id = ?
        AND id <> ? AND status IN ('queued', 'delivered')`)
      .all(rootTaskId, stepId, currentMessageId) as Array<{ id: string; payload_json: string }>;
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as { kind?: unknown };
      if (payload.kind !== 'step.assignment') continue;
      this.database.prepare(`UPDATE agent_messages SET status = 'failed', error = 'SUPERSEDED'
        WHERE id = ? AND status IN ('queued', 'delivered')`).run(row.id);
    }
  }

  findAssignedStepAgent(rootTaskId: string, mainAgentId: string, stepId: string): string | null {
    const rows = this.database.prepare(`
      SELECT recipient_agent_id, payload_json FROM agent_messages
      WHERE root_task_id = ? AND sender_agent_id = ? AND type = 'request' AND correlation_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(rootTaskId, mainAgentId, stepId) as Array<{ recipient_agent_id: string; payload_json: string }>;
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as { kind?: unknown; stepId?: unknown };
      if (payload.kind === 'step.assignment' && payload.stepId === stepId) return row.recipient_agent_id;
    }
    return null;
  }

  listTaskAgentMessages(rootTaskId: string): AgentMessageRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM agent_messages WHERE root_task_id = ? ORDER BY rowid DESC LIMIT 2000
    `).all(rootTaskId) as unknown as AgentMessageRow[];
    return rows.reverse().map(row => this.agentMessageFromRow(row));
  }

  listAgentMessages(recipientAgentId: string, options: {
    status?: AgentMessageStatus;
    limit?: number;
    before?: string;
  } = {}): AgentMessageRecord[] {
    const limit = Math.max(1, Math.min(20, options.limit ?? 20));
    const params: Array<string | number> = [recipientAgentId];
    const conditions = ['recipient_agent_id = ?'];
    if (options.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }
    if (options.before) {
      conditions.push('created_at < ?');
      params.push(options.before);
    }
    params.push(limit);
    const rows = this.database.prepare(`
      SELECT * FROM agent_messages
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(...params) as unknown as AgentMessageRow[];
    return rows.map((row) => this.agentMessageFromRow(row));
  }

  ackAgentMessage(agentId: string, messageId: string, status: Extract<AgentMessageStatus, 'delivered' | 'read' | 'failed'>,
    error?: string): AgentMessageRecord {
    const message = this.getAgentMessage(messageId);
    if (!message) throw new Error(`Agent message not found: ${messageId}`);
    if (message.recipientAgentId !== agentId) throw new Error('Only the recipient Agent can acknowledge a message.');
    if (message.status === 'read' && status !== 'read') return message;
    const now = new Date().toISOString();
    const deliveredAt = message.deliveredAt ?? now;
    const readAt = status === 'read' ? message.readAt ?? now : message.readAt;
    this.database.prepare(`
      UPDATE agent_messages
      SET status = ?, error = ?, delivered_at = ?, read_at = ?
      WHERE id = ?
    `).run(status, error ?? null, deliveredAt, readAt ?? null, messageId);
    return this.getAgentMessage(messageId)!;
  }

  close(): void {
    this.database.close();
  }

  createSession(title?: string): SessionRecord {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      id: randomUUID(),
      title: title?.trim() || '新的会话',
      status: 'active',
      pinnedAt: null,
      summary: null,
      summarySeq: 0,
      memoryTokens: 0,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.database.prepare(`
      INSERT INTO sessions (id, title, status, summary, summary_seq, memory_tokens, message_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, session.title, session.status, session.summary, session.summarySeq,
      session.memoryTokens, session.messageCount, session.createdAt, session.updatedAt);
    return session;
  }

  getSession(sessionId: string): SessionRecord | null {
    const row = this.database.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
    return row ? this.sessionFromRow(row) : null;
  }

  listSessions(options: { limit?: number; cursor?: string; includeArchived?: boolean } = {}): {
    items: SessionListItem[];
    nextCursor: string | null;
  } {
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    const conditions = ['1 = 1'];
    const parameters: Array<string | number> = [];
    if (!options.includeArchived) conditions.push("status = 'active'");
    if (options.cursor) {
      const parts = options.cursor.split('__');
      if (parts.length === 3) {
        const [pinnedAt, updatedAt, id] = parts;
        conditions.push(`(COALESCE(pinned_at, '') < ? OR (COALESCE(pinned_at, '') = ?
          AND (updated_at < ? OR (updated_at = ? AND id < ?))))`);
        parameters.push(pinnedAt!, pinnedAt!, updatedAt!, updatedAt!, id!);
      } else if (parts.length === 2) {
        // Accept cursors created before pinned sessions were introduced.
        conditions.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
        parameters.push(parts[0]!, parts[0]!, parts[1]!);
      }
    }
    parameters.push(limit + 1);
    const rows = this.database.prepare(`
      SELECT s.*, (
        SELECT m.content FROM session_messages m
        WHERE m.session_id = s.id AND m.role = 'user'
        ORDER BY m.seq ASC LIMIT 1
      ) AS preview
      FROM sessions s
      WHERE ${conditions.join(' AND ')}
      ORDER BY COALESCE(s.pinned_at, '') DESC, s.updated_at DESC, s.id DESC
      LIMIT ?
    `).all(...parameters) as unknown as Array<SessionRow & { preview: string | null }>;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((row) => ({ ...this.sessionFromRow(row), preview: row.preview })),
      nextCursor: hasMore ? `${page[page.length - 1]!.pinned_at ?? ''}__${page[page.length - 1]!.updated_at}__${page[page.length - 1]!.id}` : null,
    };
  }

  updateSession(sessionId: string, patch: { title?: string; status?: SessionStatus; pinned?: boolean }): SessionRecord {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (patch.title !== undefined) session.title = patch.title.trim().slice(0, 80) || session.title;
    if (patch.status !== undefined) session.status = patch.status;
    if (patch.pinned !== undefined) session.pinnedAt = patch.pinned ? session.pinnedAt ?? new Date().toISOString() : null;
    if (patch.title !== undefined || patch.status !== undefined) session.updatedAt = new Date().toISOString();
    this.database.prepare('UPDATE sessions SET title = ?, status = ?, pinned_at = ?, updated_at = ? WHERE id = ?')
      .run(session.title, session.status, session.pinnedAt, session.updatedAt, sessionId);
    return session;
  }

  deleteSession(sessionId: string): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM session_messages WHERE session_id = ?').run(sessionId);
      this.database.prepare('UPDATE tasks SET session_id = NULL WHERE session_id = ?').run(sessionId);
      this.database.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  appendSessionMessage(input: {
    sessionId: string;
    taskId?: string;
    role: SessionMessageRole;
    content: string;
    status?: 'pending' | 'final';
  }): SessionMessageRecord {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const now = new Date().toISOString();
      const tokens = estimateTokens(input.content);
      const result = this.database.prepare(`
        INSERT INTO session_messages (session_id, task_id, role, content, status, tokens, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(input.sessionId, input.taskId ?? null, input.role, input.content,
        input.status ?? 'final', tokens, now);
      const seq = Number(result.lastInsertRowid);
      this.database.prepare(`
        UPDATE sessions SET message_count = message_count + 1, updated_at = ? WHERE id = ?
      `).run(now, input.sessionId);
      this.recomputeSessionMemoryTokens(input.sessionId);
      this.database.exec('COMMIT');
      const row = this.database.prepare('SELECT * FROM session_messages WHERE seq = ?').get(seq) as unknown as MessageRow;
      return this.messageFromRow(row);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /** Records the assistant reply of a finished task; idempotent per task. */
  insertAssistantMessage(sessionId: string, taskId: string, content: string): boolean {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.database.prepare(
        "SELECT seq FROM session_messages WHERE task_id = ? AND role = 'assistant'",
      ).get(taskId) as { seq: number } | undefined;
      if (existing) {
        this.database.exec('COMMIT');
        return false;
      }
      const now = new Date().toISOString();
      this.database.prepare(`
        INSERT INTO session_messages (session_id, task_id, role, content, status, tokens, created_at)
        VALUES (?, ?, 'assistant', ?, 'final', ?, ?)
      `).run(sessionId, taskId, content, estimateTokens(content), now);
      this.database.prepare('UPDATE sessions SET message_count = message_count + 1, updated_at = ? WHERE id = ?')
        .run(now, sessionId);
      this.recomputeSessionMemoryTokens(sessionId);
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  listSessionMessages(sessionId: string, options: { before?: number; limit?: number } = {}): {
    items: SessionMessageRecord[];
    hasMore: boolean;
  } {
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    const parameters: Array<string | number> = [sessionId];
    if (options.before !== undefined) parameters.push(options.before);
    parameters.push(limit + 1);
    const rows = this.database.prepare(`
      SELECT m.*, t.status AS task_status
      FROM session_messages m
      LEFT JOIN tasks t ON t.id = m.task_id
      WHERE m.session_id = ? ${options.before !== undefined ? 'AND m.seq < ?' : ''}
      ORDER BY m.seq DESC
      LIMIT ?
    `).all(...parameters) as unknown as Array<MessageRow & { task_status: string | null }>;
    const hasMore = rows.length > limit;
    return {
      items: rows.slice(0, limit).reverse().map((row) => ({
        ...this.messageFromRow(row),
        taskStatus: (row.task_status as TaskStatus | null) ?? undefined,
      })),
      hasMore,
    };
  }

  /** User/assistant messages after the watermark, ascending — the raw material for snapshots and compaction. */
  listMemoryMessages(sessionId: string): SessionMessageRecord[] {
    const session = this.getSession(sessionId);
    if (!session) return [];
    const rows = this.database.prepare(`
      SELECT * FROM session_messages
      WHERE session_id = ? AND seq > ? AND role IN ('user', 'assistant') AND status = 'final'
      ORDER BY seq ASC
    `).all(sessionId, session.summarySeq) as unknown as MessageRow[];
    return rows.map((row) => this.messageFromRow(row));
  }

  getSessionMemorySnapshot(sessionId: string): SessionMemorySnapshot | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    const turns: MemoryTurn[] = this.listMemoryMessages(sessionId).map((message) => ({
      seq: message.seq,
      role: message.role as 'user' | 'assistant',
      content: message.content,
      taskId: message.taskId,
    }));
    return {
      summary: session.summary ?? undefined,
      summarySeq: session.summarySeq,
      turns,
      tokens: session.memoryTokens,
    };
  }

  commitSessionCompaction(sessionId: string, cutoffSeq: number, summary: string): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const now = new Date().toISOString();
      this.database.prepare('UPDATE sessions SET summary = ?, summary_seq = ?, updated_at = ? WHERE id = ?')
        .run(summary, cutoffSeq, now, sessionId);
      this.database.prepare(`
        INSERT INTO session_messages (session_id, role, content, status, tokens, created_at)
        VALUES (?, 'compaction', ?, 'final', ?, ?)
      `).run(sessionId, summary, estimateTokens(summary), now);
      this.database.prepare('UPDATE sessions SET message_count = message_count + 1 WHERE id = ?')
        .run(sessionId);
      this.recomputeSessionMemoryTokens(sessionId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private recomputeSessionMemoryTokens(sessionId: string): void {
    const session = this.database.prepare('SELECT summary, summary_seq FROM sessions WHERE id = ?')
      .get(sessionId) as { summary: string | null; summary_seq: number } | undefined;
    if (!session) return;
    const tail = this.database.prepare(`
      SELECT COALESCE(SUM(tokens), 0) AS total FROM session_messages
      WHERE session_id = ? AND seq > ? AND role IN ('user', 'assistant')
    `).get(sessionId, session.summary_seq) as { total: number };
    const memoryTokens = (session.summary ? estimateTokens(session.summary) : 0) + Number(tail.total);
    this.database.prepare('UPDATE sessions SET memory_tokens = ? WHERE id = ?').run(memoryTokens, sessionId);
  }

  hasActiveTaskInSession(sessionId: string): boolean {
    const row = this.database.prepare(`
      SELECT 1 FROM tasks
      WHERE session_id = ? AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED')
      LIMIT 1
    `).get(sessionId);
    return row !== undefined;
  }

  listUnassignedTasks(limit = 30): TaskRun[] {
    const rows = this.database.prepare(`
      SELECT * FROM tasks WHERE session_id IS NULL ORDER BY updated_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(100, limit))) as unknown as TaskRow[];
    return rows.map((row) => this.taskFromRow(row));
  }

  listTasksForSession(sessionId: string, limit = 1_000): TaskRun[] {
    const rows = this.database.prepare(`
      SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at ASC LIMIT ?
    `).all(sessionId, Math.max(1, Math.min(10_000, limit))) as unknown as TaskRow[];
    return rows.map((row) => this.taskFromRow(row));
  }

  private sessionFromRow(row: SessionRow): SessionRecord {
    return {
      id: row.id,
      title: row.title,
      status: row.status as SessionStatus,
      pinnedAt: row.pinned_at ?? null,
      summary: row.summary ?? null,
      summarySeq: row.summary_seq,
      memoryTokens: row.memory_tokens,
      messageCount: row.message_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private agentFromRow(row: AgentRow): AgentSessionRecord {
    return {
      id: row.id,
      parentAgentId: row.parent_agent_id ?? undefined,
      rootTaskId: row.root_task_id ?? undefined,
      name: row.name,
      role: row.role,
      goal: row.goal,
      capabilities: JSON.parse(row.capabilities_json) as string[],
      status: row.status as AgentStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private agentMessageFromRow(row: AgentMessageRow): AgentMessageRecord {
    return {
      id: row.id,
      rootTaskId: row.root_task_id ?? undefined,
      senderAgentId: row.sender_agent_id,
      recipientAgentId: row.recipient_agent_id,
      type: row.type as AgentMessageType,
      correlationId: row.correlation_id ?? undefined,
      payload: JSON.parse(row.payload_json) as unknown,
      status: row.status as AgentMessageStatus,
      error: row.error ?? undefined,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at ?? undefined,
      readAt: row.read_at ?? undefined,
    };
  }

  private messageFromRow(row: MessageRow): SessionMessageRecord {
    return {
      seq: row.seq,
      sessionId: row.session_id,
      taskId: row.task_id ?? undefined,
      role: row.role as SessionMessageRole,
      content: row.content,
      status: row.status as 'pending' | 'final',
      tokens: row.tokens,
      createdAt: row.created_at,
    };
  }

  private taskFromRow(row: TaskRow): TaskRun {
    return {
      id: row.id,
      message: row.message,
      attachments: JSON.parse(row.attachments_json),
      status: row.status,
      permissionMode: row.permission_mode ?? 'request',
      pendingPermission: row.pending_permission_json ? JSON.parse(row.pending_permission_json) as PendingPermissionRequest : undefined,
      executionCheckpoint: row.execution_checkpoint_json ? JSON.parse(row.execution_checkpoint_json) as ExecutionCheckpoint : undefined,
      correctionState: row.correction_state_json
        ? (() => {
          const parsed = JSON.parse(row.correction_state_json) as CorrectionState;
          return { ...parsed, failures: (parsed.failures ?? []).map(persistableCorrectionFailure) };
        })()
        : { roundsUsed: 0, finishedRoundIds: [], failures: [] },
      acceptanceCriteria: JSON.parse(row.acceptance_criteria_json),
      result: row.result ?? undefined,
      currentStepId: row.current_step_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      metrics: JSON.parse(row.metrics_json),
      retryCounts: JSON.parse(row.retry_counts_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private capabilityFromRow(row: CapabilityRow): CapabilityRecord {
    return {
      id: row.id,
      version: row.version,
      status: row.status,
      normalizedIntent: row.normalized_intent,
      manifest: JSON.parse(row.manifest_json),
      code: row.code,
      evaluation: JSON.parse(row.evaluation_json),
      createdAt: row.created_at,
    };
  }

  private operationFromRow(row: OperationRow): OperationJournalRecord {
    return {
      taskId: row.task_id,
      operationId: row.operation_id,
      requestId: row.request_id ?? undefined,
      state: row.state,
      operation: JSON.parse(row.operation_json) as PermissionOperation,
      result: row.result_json ? JSON.parse(row.result_json) as unknown : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
