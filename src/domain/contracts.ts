export type TaskStatus =
  | 'INTAKE'
  | 'BUDGET_CHECK'
  | 'CONTEXT_COMPACTING'
  | 'CONTEXT_READY'
  | 'CAPABILITY_ANALYSIS'
  | 'CAPABILITY_BUILDING'
  | 'IMPLEMENTING_FILES'
  | 'TEST_PLANNING'
  | 'TESTING_SANDBOX'
  | 'TESTING_LIVE'
  | 'TEST_REVIEW'
  | 'PLAN_READY'
  | 'EXECUTING'
  | 'EVALUATING'
  | 'WAITING_FOR_APPROVAL'
  | 'NEEDS_USER_INPUT'
  | 'RETRYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED';

export type CapabilityKind = 'tool' | 'workflow' | 'policy';
export type PermissionMode = 'request' | 'auto' | 'full';
export type CapabilityPermission = CapabilityManifest['permissions'][number];

export interface PermissionOperation {
  operationId: string;
  permission: CapabilityPermission;
  action: string;
  target: string;
  reason: string;
  arguments: Record<string, unknown>;
}

export interface PermissionContext {
  workspaceRoot: string;
  containsTaskData: boolean;
  targetExists: boolean;
  destructive: boolean;
  external: boolean;
}

export interface PendingPermissionRequest {
  requestId: string;
  taskId: string;
  operation: PermissionOperation;
  risk: 'low' | 'medium' | 'high';
  createdAt: string;
}

export interface ExecutionCheckpoint {
  planner: unknown;
  capabilityName: string;
  capabilityVersion: string;
  stepBindings?: StepBinding[];
  completedStepIds: string[];
  stepResults?: Array<{ stepId: string; output: unknown; observedAt: string }>;
  currentStepId: string;
  operationSequence: number;
  pendingReview?: {
    stepId: string;
    outcome: 'success' | 'failure';
    output?: unknown;
    failure?: CorrectionFailure;
    verification?: StepVerificationEvidence;
    safeToReplay: boolean;
  };
}

export interface StepVerificationEvidence {
  mode: 'sandbox' | 'live_observation';
  passed: number;
  failed: number;
  blocked: number;
  checks: Array<{ id: string; status: 'passed' | 'failed' | 'blocked'; codes: string[] }>;
}

export type CorrectionTarget = 'answer' | 'plan_or_input' | 'generated_tool';

export interface CorrectionFailure {
  stage: 'plan' | 'tool' | 'execution' | 'test' | 'answer';
  code: string;
  reason: string;
  stepId?: string;
  capabilityId?: string;
  version?: string;
}

export interface CorrectionState {
  roundsUsed: number;
  finishedRoundIds: string[];
  currentRound?: {
    id: string;
    ordinal: number;
    target: CorrectionTarget;
    phase: 'dispatch' | 'implement' | 'test' | 'evaluate';
  };
  failures: CorrectionFailure[];
}

export interface StepBinding {
  stepId: string;
  capabilityKey: string;
  capabilityId: string;
  version: string;
}

export type OperationJournalState = 'pending' | 'approved' | 'denied' | 'executing' | 'completed' | 'unknown';

export interface OperationJournalRecord {
  taskId: string;
  operationId: string;
  requestId?: string;
  state: OperationJournalState;
  operation: PermissionOperation;
  result?: unknown;
  createdAt: string;
  updatedAt: string;
}
export type CapabilityStatus =
  | 'draft'
  | 'sandbox_testing'
  | 'evaluated'
  | 'approved'
  | 'canary'
  | 'active'
  | 'deprecated'
  | 'rollback'
  | 'rejected';

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  content?: string;
}

export interface CreateTaskInput {
  message: string;
  attachments: Attachment[];
  permissionMode?: PermissionMode;
  sourceTaskId?: string;
  sessionId?: string;
}

export interface TaskRun {
  id: string;
  message: string;
  attachments: Attachment[];
  status: TaskStatus;
  permissionMode: PermissionMode;
  pendingPermission?: PendingPermissionRequest;
  executionCheckpoint?: ExecutionCheckpoint;
  correctionState: CorrectionState;
  acceptanceCriteria: string[];
  result?: string;
  currentStepId?: string;
  sessionId?: string;
  metrics: {
    generatedCapabilityCount: number;
    reusedCapabilityCount: number;
    retryCount: number;
  };
  retryCounts: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  type: string;
  payload: Record<string, unknown>;
  createdAt?: string;
}

export interface UserInputRequest {
  taskId: string;
  question: string;
  requiredFields: Array<{ name: string; reason: string; sensitive: boolean }>;
  resumeToken: string;
  options?: Array<{ label: string; value: string; description?: string }>;
}

export interface CapabilityManifest {
  id: string;
  capabilityKey?: string;
  version: string;
  kind: CapabilityKind;
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  entrypoint: string;
  runtime: 'node-sandbox-v1';
  permissions: Array<'filesystem.read' | 'filesystem.write' | 'network' | 'location' | 'process' | 'mcp'>;
  riskLevel: 'low' | 'medium' | 'high';
  tests: string[];
  provenance: { sourceTaskId: string; generatedAt: string; migratedFromActive?: boolean };
}

export interface EvaluationRecord {
  targetId: string;
  targetVersion: string;
  verdict: 'pass' | 'revise' | 'reject';
  score: number;
  failures: Array<{ code: string; message: string; evidence?: unknown }>;
  recommendations: string[];
  evaluatorRunId: string;
}

export interface CapabilityRecord {
  id: string;
  version: string;
  status: CapabilityStatus;
  normalizedIntent: string;
  manifest: CapabilityManifest;
  code: string;
  evaluation: EvaluationRecord;
  createdAt: string;
}

export interface TaskStore {
  createTask(input: CreateTaskInput): TaskRun;
  getTask(taskId: string): TaskRun | null;
  saveTask(task: TaskRun): void;
  appendEvent(taskId: string, event: TaskEvent): void;
  listEvents(taskId: string): TaskEvent[];
}

export interface CapabilityStore {
  saveCapability(capability: CapabilityRecord): void;
  findByIntent(intent: string): CapabilityRecord | null;
  getActive(capabilityId: string): CapabilityRecord | null;
}

export type SessionStatus = 'active' | 'archived';

export interface SessionRecord {
  id: string;
  title: string;
  status: SessionStatus;
  pinnedAt: string | null;
  /** Current compaction checkpoint text; null until the first compaction. */
  summary: string | null;
  /** Watermark: messages with seq <= summarySeq are folded into the summary. */
  summarySeq: number;
  memoryTokens: number;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionListItem extends SessionRecord {
  preview: string | null;
}

export type SessionMessageRole = 'user' | 'assistant' | 'compaction';

export interface SessionMessageRecord {
  seq: number;
  sessionId: string;
  taskId?: string;
  role: SessionMessageRole;
  content: string;
  status: 'pending' | 'final';
  tokens: number;
  createdAt: string;
  taskStatus?: TaskStatus;
}

export interface MemoryTurn {
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  taskId?: string;
}

/**
 * The bounded view a session injects into model prompts: the compaction
 * checkpoint plus the verbatim messages after the watermark. Rebuildable
 * from SQLite alone, so it survives restarts exactly.
 */
export interface SessionMemorySnapshot {
  summary?: string;
  summarySeq: number;
  turns: MemoryTurn[];
  tokens: number;
}

/**
 * Bounded, redacted evidence from the most recent failed task in a session.
 * This is model context, not the public trajectory payload: secrets and large
 * prompts/results are removed before it leaves the store.
 */
export interface DiagnosticEvidenceEntry {
  kind: 'event' | 'model' | 'operation';
  type: string;
  createdAt: string;
  details: Record<string, unknown>;
}

export interface DiagnosticContext {
  taskId: string;
  status: Extract<TaskStatus, 'FAILED' | 'BLOCKED' | 'CANCELLED'>;
  request: string;
  result?: string;
  entries: DiagnosticEvidenceEntry[];
}

/**
 * A bounded local Agent-to-Agent collaboration identity.  The identity is
 * persisted independently from the model implementation so it can survive a
 * process restart and later be attached to a dynamic execution loop.
 */
export type AgentStatus = 'queued' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type AgentMessageType = 'request' | 'response' | 'event' | 'artifact' | 'status' | 'error';
export type AgentMessageStatus = 'queued' | 'delivered' | 'read' | 'failed';

export interface AgentSessionRecord {
  id: string;
  parentAgentId?: string;
  rootTaskId?: string;
  name: string;
  role: string;
  goal: string;
  capabilities: string[];
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentInput {
  id?: string;
  parentAgentId?: string;
  rootTaskId?: string;
  name: string;
  role: string;
  goal: string;
  capabilities?: string[];
  status?: AgentStatus;
}

export interface AgentMessageRecord {
  id: string;
  rootTaskId?: string;
  senderAgentId: string;
  recipientAgentId: string;
  type: AgentMessageType;
  correlationId?: string;
  payload: unknown;
  status: AgentMessageStatus;
  error?: string;
  createdAt: string;
  deliveredAt?: string;
  readAt?: string;
}

export interface SendAgentMessageInput {
  messageId?: string;
  rootTaskId?: string;
  senderAgentId: string;
  recipientAgentId: string;
  type: AgentMessageType;
  correlationId?: string;
  payload: unknown;
}
