import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { resolveHostPath } from './host-operations.js';
import { canonicalizeFilesystemPath } from './policy.js';
import type {
  OperationJournalRecord,
  CapabilityRecord,
  PermissionContext,
  PermissionOperation,
  PendingPermissionRequest,
  TaskRun,
} from '../domain/contracts.js';
import { SqliteStore } from '../storage/sqlite-store.js';
import { PermissionPolicy } from './policy.js';
import type { HostCall, HostCallResult, HostExecutionContext, HostOperationExecutor } from './operation-protocol.js';
import { hasBoundedProcessArgs, isShellGuiLaunch } from './process-contract.js';

export class ApprovalRequiredError extends Error {
  readonly code = 'APPROVAL_REQUIRED';
  constructor(message = 'This operation is waiting for user approval.') { super(message); }
}

export class PermissionDeniedError extends Error {
  readonly code = 'PERMISSION_DENIED';
  constructor(message: string) { super(message); }
}

export class OperationUncertainError extends Error {
  readonly code = 'OPERATION_UNKNOWN';
  constructor(message: string) { super(message); }
}

export class CapabilityUnavailableError extends Error {
  readonly code = 'CAPABILITY_UNAVAILABLE';
  constructor() { super('The temporary capability is unavailable; resubmit the task to generate it again.'); }
}

export class HostOperationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export class PermissionBroker {
  private capabilityLookup?: (name: string, version: string, taskId: string) => CapabilityRecord | null;

  constructor(
    private readonly store: SqliteStore,
    private readonly executor: HostOperationExecutor,
    private readonly workspaceRoot: string,
    private readonly policy = new PermissionPolicy(),
  ) {}

  useCapabilityLookup(lookup: (name: string, version: string, taskId: string) => CapabilityRecord | null): void {
    this.capabilityLookup = lookup;
  }

  async handle(taskId: string, operation: PermissionOperation, context: HostExecutionContext): Promise<unknown> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (context.taskId !== taskId || context.mode !== task.permissionMode || context.workspaceRoot !== this.workspaceRoot) {
      throw new PermissionDeniedError('Execution context does not match the persisted task permissions.');
    }
    if (!context.capabilityPermissions.includes(operation.permission)) {
      throw new PermissionDeniedError(`Capability did not declare ${operation.permission}.`);
    }
    assertOperationBounded(operation);
    const exactOperation = this.canonicalizeOperation(operation);

    const existing = this.store.getOperation(taskId, exactOperation.operationId);
    if (existing) {
      if (!isDeepStrictEqual(existing.operation, exactOperation)) {
        throw new OperationUncertainError('Operation ID was reused with different permission, target, or arguments; no host operation was replayed.');
      }
      return this.replayOrContinue(existing, exactOperation, context);
    }

    const permissionContext = await this.classify(exactOperation, context);
    const decision = this.policy.decide(task.permissionMode, exactOperation, permissionContext);
    if (decision === 'deny') throw new PermissionDeniedError(`Operation was denied by permission policy: ${exactOperation.action}`);
    if (decision === 'require_approval') {
      if (!task.executionCheckpoint) throw new Error('Cannot request approval without a resumable execution checkpoint.');
      if (task.pendingPermission) {
        if (task.pendingPermission.operation.operationId === exactOperation.operationId) throw new ApprovalRequiredError();
        throw new Error('Another permission request is already pending for this task.');
      }
      const pending: PendingPermissionRequest = {
        requestId: randomUUID(),
        taskId,
        operation: exactOperation,
        risk: this.riskFor(exactOperation, permissionContext),
        createdAt: new Date().toISOString(),
      };
      task.pendingPermission = pending;
      task.status = 'WAITING_FOR_APPROVAL';
      task.result = undefined;
      task.updatedAt = new Date().toISOString();
      const now = new Date().toISOString();
      const record: OperationJournalRecord = {
        taskId,
        operationId: exactOperation.operationId,
        requestId: pending.requestId,
        state: 'pending',
        operation: exactOperation,
        createdAt: now,
        updatedAt: now,
      };
      this.store.recordPendingPermission(task, record);
      throw new ApprovalRequiredError();
    }

    const now = new Date().toISOString();
    this.store.createOperation({
      taskId,
      operationId: exactOperation.operationId,
      state: 'executing',
      operation: exactOperation,
      createdAt: now,
      updatedAt: now,
    });
    const stored = this.store.getOperation(taskId, exactOperation.operationId);
    if (!stored) throw new Error('Operation journal entry was not created.');
    if (stored.state !== 'executing') return this.replayOrContinue(stored, exactOperation, context);
    const result = await this.perform(stored, exactOperation, context);
    if (!result.ok) throw new HostOperationError(result.error?.code ?? 'HOST_OPERATION_FAILED', result.error?.message ?? 'Host operation failed.');
    return result.value;
  }

  async resolve(taskId: string, requestId: string, approved: boolean): Promise<void> {
    const pendingTask = approved ? this.store.getTask(taskId) : null;
    if (pendingTask?.pendingPermission?.requestId === requestId) {
      this.restoreContext(pendingTask, pendingTask.pendingPermission.operation);
    }
    const decision = this.store.recordPermissionDecision(taskId, requestId, approved);
    if (decision === 'conflict') throw new Error('This approval request is stale or does not belong to this task.');
    if (decision === 'unknown') throw new OperationUncertainError('The operation may have started before a service restart and will not be replayed. Check its target before creating a new task.');
    if (decision === 'denied' || decision === 'completed') return;
    if (!approved) return;

    const task = this.store.getTask(taskId);
    const record = task && this.findByRequest(taskId, requestId);
    if (!task || !record) throw new Error('Pending operation could not be restored.');
    const context = this.restoreContext(task, record.operation);
    if (record.state === 'approved') {
      if (!this.store.beginApprovedOperation(taskId, record.operationId)) {
        const latest = this.store.getOperation(taskId, record.operationId);
        if (latest?.state === 'completed') return;
        if (latest?.state === 'unknown' || latest?.state === 'executing') {
          throw new OperationUncertainError('Operation state is uncertain; it was not replayed.');
        }
        throw new Error('Approval could not be applied to the pending operation.');
      }
    } else if (record.state !== 'executing') {
      const latest = this.store.getOperation(taskId, record.operationId);
      if (latest?.state === 'completed') return;
      throw new Error('Approval request is no longer executable.');
    }
    const started = this.store.getOperation(taskId, record.operationId);
    if (!started) throw new Error('Approved operation disappeared from the journal.');
    await this.perform(started, record.operation, context);
  }

  private async replayOrContinue(existing: OperationJournalRecord, operation: PermissionOperation, context: HostExecutionContext): Promise<unknown> {
    if (existing.state === 'completed') return this.resultValue(existing.result, operation.operationId);
    if (existing.state === 'denied') throw new PermissionDeniedError(`User denied operation: ${operation.action}`);
    if (existing.state === 'pending') throw new ApprovalRequiredError();
    if (existing.state === 'unknown' || existing.state === 'executing') {
      throw new OperationUncertainError('Operation outcome is unknown; to prevent duplicate side effects it will not be replayed.');
    }
    if (existing.state === 'approved') {
      if (!this.store.beginApprovedOperation(existing.taskId, existing.operationId)) {
        const latest = this.store.getOperation(existing.taskId, existing.operationId);
        if (latest?.state === 'completed') return this.resultValue(latest.result, operation.operationId);
        throw new OperationUncertainError('Approved operation is not safe to replay.');
      }
      const started = this.store.getOperation(existing.taskId, existing.operationId);
      if (!started) throw new Error('Approved operation disappeared from the journal.');
      const result = await this.perform(started, operation, { ...context, approvalGranted: true });
      if (!result.ok) throw new HostOperationError(result.error?.code ?? 'HOST_OPERATION_FAILED', result.error?.message ?? 'Host operation failed.');
      return result.value;
    }
    throw new Error(`Unsupported operation journal state: ${existing.state}`);
  }

  private async perform(record: OperationJournalRecord, operation: PermissionOperation, context: HostExecutionContext): Promise<HostCallResult> {
    const call: HostCall = {
      callId: `operation:${operation.operationId}`,
      permission: operation.permission,
      action: operation.action,
      target: operation.target,
      reason: operation.reason,
      arguments: operation.arguments,
    };
    if (operation.permission === 'filesystem.read' || operation.permission === 'filesystem.write') {
      try {
        const pathValue = operation.target || stringArg(operation, 'path');
        const currentTarget = canonicalizeFilesystemPath(pathValue, this.workspaceRoot);
        if (!samePathIdentity(operation.target, currentTarget)) {
          const changed = {
            callId: call.callId,
            ok: false,
            error: { code: 'PATH_CHANGED', message: 'Filesystem target changed after permission evaluation; the operation was not executed.' },
          } satisfies HostCallResult;
          this.store.completeOperation(record.taskId, record.operationId, changed);
          return changed;
        }
      } catch {
        const changed = {
          callId: call.callId,
          ok: false,
          error: { code: 'PATH_CHANGED', message: 'Filesystem target could not be safely resolved; the operation was not executed.' },
        } satisfies HostCallResult;
        this.store.completeOperation(record.taskId, record.operationId, changed);
        return changed;
      }
    }
    const result = await this.executor.execute(call, context);
    const normalized = { ...result, callId: call.callId };
    this.store.completeOperation(record.taskId, record.operationId, normalized);
    return normalized;
  }

  private async classify(operation: PermissionOperation, context: HostExecutionContext): Promise<PermissionContext> {
    const filesystem = operation.permission === 'filesystem.read' || operation.permission === 'filesystem.write';
    const targetPath = filesystem ? resolveHostPath(operation.target || stringArg(operation, 'path'), this.workspaceRoot) : '';
    const targetExists = filesystem ? await exists(targetPath) : false;
    const action = operation.action.toLowerCase();
    const destructive = operation.permission === 'filesystem.write'
      && (['remove', 'delete'].includes(action) || targetExists);
    const containsTaskData = operation.permission === 'mcp' || (operation.permission === 'network'
      && (typeof operation.arguments.body === 'string'
        || typeof operation.arguments.content === 'string'
        || operation.arguments.containsTaskData === true
        || hasSensitiveHeaders(operation.arguments.headers)));
    return {
      workspaceRoot: this.workspaceRoot,
      containsTaskData,
      targetExists,
      destructive,
      external: ['network', 'process', 'location', 'mcp'].includes(operation.permission),
    };
  }

  private canonicalizeOperation(operation: PermissionOperation): PermissionOperation {
    if (operation.permission === 'process') {
      return { ...operation, arguments: { ...operation.arguments,
        cwd: resolveHostPath(typeof operation.arguments.cwd === 'string' ? operation.arguments.cwd : '.', this.workspaceRoot),
      } };
    }
    if (operation.permission !== 'filesystem.read' && operation.permission !== 'filesystem.write') return operation;
    const path = operation.target || stringArg(operation, 'path');
    const canonicalPath = canonicalizeFilesystemPath(path, this.workspaceRoot);
    return {
      ...operation,
      target: canonicalPath,
      arguments: { ...operation.arguments, path: canonicalPath },
    };
  }

  private riskFor(operation: PermissionOperation, context: PermissionContext): PendingPermissionRequest['risk'] {
    const action = operation.action.toLowerCase();
    if (operation.permission === 'process' || operation.permission === 'location' || ['remove', 'delete'].includes(action) || context.external && context.containsTaskData) return 'high';
    if (context.destructive || !['filesystem.read', 'filesystem.write'].includes(operation.permission)) return 'medium';
    return 'low';
  }

  private findByRequest(taskId: string, requestId: string): OperationJournalRecord | null {
    const task = this.store.getTask(taskId);
    const operationId = task?.pendingPermission?.requestId === requestId
      ? task.pendingPermission.operation.operationId
      : undefined;
    if (operationId) return this.store.getOperation(taskId, operationId);
    // After a decision is persisted the task still carries the exact pending card until execution is complete.
    const events = this.store.listEvents(taskId);
    const requested = [...events].reverse().find((event) => event.type === 'task.permission_requested' && event.payload.requestId === requestId);
    const id = requested?.payload.operationId;
    return typeof id === 'string' ? this.store.getOperation(taskId, id) : null;
  }

  private restoreContext(task: TaskRun, operation: PermissionOperation): HostExecutionContext {
    const checkpoint = task.executionCheckpoint;
    if (!checkpoint) throw new Error('Execution checkpoint is missing; operation will not be resumed.');
    const capability = this.capabilityLookup
      ? this.capabilityLookup(checkpoint.capabilityName, checkpoint.capabilityVersion, task.id)
      : this.store.getCapabilityVersion(checkpoint.capabilityName, checkpoint.capabilityVersion);
    if (!capability || !capability.manifest.permissions.includes(operation.permission)) {
      throw new CapabilityUnavailableError();
    }
    return {
      taskId: task.id,
      mode: task.permissionMode,
      workspaceRoot: this.workspaceRoot,
      capabilityPermissions: capability.manifest.permissions,
      capabilityVersion: capability.version,
      stepId: checkpoint.currentStepId,
      operationSequence: checkpoint.operationSequence,
      dryRun: false,
      approvalGranted: true,
    };
  }

  private resultValue(value: unknown, operationId: string): unknown {
    if (!value || typeof value !== 'object' || !('ok' in value)) return value;
    const result = value as HostCallResult;
    if (!result.ok) throw new HostOperationError(result.error?.code ?? 'HOST_OPERATION_FAILED', result.error?.message ?? `Operation ${operationId} failed.`);
    return result.value;
  }
}

function samePathIdentity(left: string, right: string): boolean {
  const windowsPath = process.platform === 'win32' || path.win32.isAbsolute(left) || path.win32.isAbsolute(right);
  const api = windowsPath ? path.win32 : path;
  const normalizedLeft = api.normalize(left);
  const normalizedRight = api.normalize(right);
  return windowsPath
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

function stringArg(operation: PermissionOperation, key: string): string {
  const value = operation.arguments[key];
  return typeof value === 'string' ? value : '';
}

async function exists(target: string): Promise<boolean> {
  if (!target) return false;
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function hasSensitiveHeaders(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const safeHeaders = new Set(['accept', 'accept-language', 'user-agent']);
  return Object.keys(value).some((key) => !safeHeaders.has(key.toLowerCase()));
}

function assertOperationBounded(operation: PermissionOperation): void {
  if (typeof operation.target !== 'string' || !operation.target.trim()) {
    throw new PermissionDeniedError('Host operation target must be a non-empty string.');
  }
  if (typeof operation.reason !== 'string' || typeof operation.action !== 'string') {
    throw new PermissionDeniedError('Host operation reason and action must be strings.');
  }
  if (operation.target.length > 4096 || operation.reason.length > 2000 || operation.action.length > 100) {
    throw new PermissionDeniedError('Host operation metadata exceeds the configured limits.');
  }
  if (!operation.arguments || typeof operation.arguments !== 'object' || Array.isArray(operation.arguments)) {
    throw new PermissionDeniedError('Host operation arguments must be an object.');
  }
  if (operation.permission === 'process') {
    const launch = operation.action.toLowerCase() === 'launch';
    const command = launch ? operation.arguments.executable : operation.arguments.command;
    const args = operation.arguments.args;
    const cwd = operation.arguments.cwd;
    if (typeof command !== 'string' || command !== operation.target) {
      throw new PermissionDeniedError('Process command must match the displayed target.');
    }
    if (launch && (!path.win32.isAbsolute(command) || path.win32.extname(command).toLowerCase() !== '.exe')) {
      throw new PermissionDeniedError('Application launch requires an absolute executable path.');
    }
    if (!hasBoundedProcessArgs(args, launch)
      || (cwd !== undefined && (typeof cwd !== 'string' || !cwd.trim() || cwd.length > 4_096))) {
      throw new HostOperationError('INVALID_PROCESS_ARGUMENTS', 'Process arguments or working directory exceed the supported limits.');
    }
    if (!launch && isShellGuiLaunch(command, args)) {
      throw new PermissionDeniedError('GUI applications must use process.launch, not process.run.');
    }
  }
  if (operation.permission === 'mcp') {
    const { server, tool, arguments: args } = operation.arguments;
    if (operation.action !== 'call' || typeof server !== 'string' || typeof tool !== 'string'
      || !/^[a-z][a-z0-9_-]{0,63}$/.test(server) || !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(tool)
      || operation.target !== `${server}/${tool}` || !args || typeof args !== 'object' || Array.isArray(args)
      || JSON.stringify(args).length > 20_000) {
      throw new PermissionDeniedError('MCP call must name a configured server and tool with bounded arguments.');
    }
  }
  const argumentsJson = JSON.stringify(operation.arguments);
  if (argumentsJson.length > 1_100_000 || Object.keys(operation.arguments).length > 32) {
    throw new PermissionDeniedError('Host operation arguments exceed the configured limits.');
  }
  const content = operation.arguments.content;
  const body = operation.arguments.body;
  if ((typeof content === 'string' && Buffer.byteLength(content) > 1_000_000)
    || (typeof body === 'string' && Buffer.byteLength(body) > 100_000)) {
    throw new PermissionDeniedError('Host operation payload exceeds the configured limits.');
  }
}
