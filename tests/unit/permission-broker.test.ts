import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityRecord, PermissionMode, PermissionOperation } from '../../src/domain/contracts.js';
import { DefaultHostOperationExecutor } from '../../src/permissions/host-operations.js';
import { ApprovalRequiredError, OperationUncertainError, PermissionBroker } from '../../src/permissions/permission-broker.js';
import type { HostCall, HostExecutionContext, HostOperationExecutor } from '../../src/permissions/operation-protocol.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

const temporaryDirectories: string[] = [];
const openStores: SqliteStore[] = [];

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-broker-'));
  temporaryDirectories.push(directory);
  const store = new SqliteStore(join(directory, 'jarvis.sqlite'));
  openStores.push(store);
  return { directory, store };
}

function capability(): CapabilityRecord {
  return {
    id: 'create_folder', version: '1.0.0', status: 'active', normalizedIntent: 'create folder',
    manifest: {
      id: 'create_folder', version: '1.0.0', kind: 'tool', name: 'create_folder', description: 'Create a folder.',
      inputSchema: {}, outputSchema: {}, entrypoint: 'tool.mjs', runtime: 'node-sandbox-v1',
      permissions: ['filesystem.write'], riskLevel: 'low', tests: ['creates folder'],
      provenance: { sourceTaskId: 'task', generatedAt: new Date().toISOString() },
    },
    code: 'export async function run(input, host) { return host.fs.mkdir(input.path); }',
    evaluation: { targetId: 'create_folder', targetVersion: '1.0.0', verdict: 'pass', score: 1, failures: [], recommendations: [], evaluatorRunId: randomUUID() },
    createdAt: new Date().toISOString(),
  };
}

function operation(taskId: string, stepId = 'step-1'): PermissionOperation {
  return {
    operationId: `${taskId}:${stepId}:1.0.0:0`,
    permission: 'filesystem.write', action: 'mkdir', target: 'hm', reason: 'Create the requested hm folder.',
    arguments: { path: 'hm' },
  };
}

function context(taskId: string, mode: PermissionMode, root: string): HostExecutionContext {
  return {
    taskId, mode, workspaceRoot: root, capabilityPermissions: ['filesystem.write'], capabilityVersion: '1.0.0',
    stepId: 'step-1', operationSequence: 0, dryRun: false,
  };
}

function setupTask(store: SqliteStore, mode: PermissionMode = 'request') {
  const task = store.createTask({ message: 'Create folder hm', attachments: [], permissionMode: mode });
  store.saveCapability(capability());
  task.executionCheckpoint = {
    planner: { intent: 'create folder', acceptanceCriteria: [], requiredCapabilities: [], steps: [{ id: 'step-1', description: 'create', dependsOn: [] }], status: 'ready' },
    capabilityName: 'create_folder', capabilityVersion: '1.0.0', completedStepIds: [], currentStepId: 'step-1', operationSequence: 0,
  };
  store.saveTask(task);
  return task;
}

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('PermissionBroker', () => {
  it('requests approval for an exact application launch and denial makes zero host calls', async () => {
    const { directory, store } = createStore();
    const task = setupTask(store, 'request');
    const executor: HostOperationExecutor = { execute: vi.fn(async (call) => ({ callId: call.callId, ok: true, value: { started: true, pid: 1 } })) };
    const broker = new PermissionBroker(store, executor, directory);
    const launch = { ...operation(task.id), permission: 'process' as const, action: 'launch',
      target: 'C:\\Apps\\cloudmusic.exe', arguments: { executable: 'C:\\Apps\\cloudmusic.exe', args: [] } };
    await expect(broker.handle(task.id, launch, { ...context(task.id, 'request', directory), capabilityPermissions: ['process'] }))
      .rejects.toBeInstanceOf(ApprovalRequiredError);
    const requestId = store.getTask(task.id)?.pendingPermission?.requestId;
    await broker.resolve(task.id, requestId!, false);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('never reuses a completed operation ID for different arguments', async () => {
    const { directory, store } = createStore();
    const task = setupTask(store, 'full');
    const executor = new DefaultHostOperationExecutor();
    const execution = vi.spyOn(executor, 'execute');
    const broker = new PermissionBroker(store, executor, directory);
    const target = join(directory, 'result.txt');
    const first = { ...operation(task.id), action: 'writeText', target, arguments: { path: target, content: 'first' } };
    await broker.handle(task.id, first, context(task.id, 'full', directory));
    const changed = { ...first, arguments: { path: target, content: 'second' } };
    await expect(broker.handle(task.id, changed, context(task.id, 'full', directory)))
      .rejects.toBeInstanceOf(OperationUncertainError);
    expect(readFileSync(target, 'utf8')).toBe('first');
    expect(execution).toHaveBeenCalledTimes(1);
  });

  it('rejects process approval when displayed target differs from executed command', async () => {
    const { directory, store } = createStore();
    const task = setupTask(store, 'request');
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor(), directory);
    const call = { ...operation(task.id), permission: 'process' as const, action: 'run', target: 'cmd.exe',
      arguments: { command: 'powershell.exe', args: [] } };
    await expect(broker.handle(task.id, call, { ...context(task.id, 'request', directory), capabilityPermissions: ['process'] }))
      .rejects.toThrow(/command.*target|target.*command/i);
    expect(store.getTask(task.id)?.pendingPermission).toBeUndefined();
  });
  it('waits before a request-mode write, executes only after approval, and reuses the completed result', async () => {
    const { directory, store } = createStore();
    const task = setupTask(store, 'request');
    const realExecutor = new DefaultHostOperationExecutor();
    const executor: HostOperationExecutor = {
      execute: vi.fn((hostCall: HostCall, execution: HostExecutionContext) => realExecutor.execute(hostCall, execution)),
    };
    const broker = new PermissionBroker(store, executor, directory);
    const operationForTask = operation(task.id);

    await expect(broker.handle(task.id, operationForTask, context(task.id, 'request', directory))).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(store.getTask(task.id)?.status).toBe('WAITING_FOR_APPROVAL');
    const canonicalTarget = join(realpathSync.native(directory), 'hm');
    expect(executor.execute).not.toHaveBeenCalled();

    const requestId = store.getTask(task.id)?.pendingPermission?.requestId;
    expect(requestId).toBeTruthy();
    await broker.resolve(task.id, requestId!, true);
    expect(statSync(join(directory, 'hm')).isDirectory()).toBe(true);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(store.getTask(task.id)?.status).toBe('PLAN_READY');

    await expect(broker.handle(task.id, operationForTask, context(task.id, 'request', directory)))
      .resolves.toMatchObject({ path: canonicalTarget, created: true });
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(store.getOperation(task.id, operationForTask.operationId)?.state).toBe('completed');
  });

  it('denying a pending operation produces zero host calls and cancels the task clearly', async () => {
    const { directory, store } = createStore();
    const task = setupTask(store);
    const executor: HostOperationExecutor = { execute: vi.fn(async () => ({ callId: 'unused', ok: true, value: null })) };
    const broker = new PermissionBroker(store, executor, directory);
    await expect(broker.handle(task.id, operation(task.id), context(task.id, 'request', directory))).rejects.toBeInstanceOf(ApprovalRequiredError);
    const requestId = store.getTask(task.id)?.pendingPermission?.requestId;
    await broker.resolve(task.id, requestId!, false);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(store.getTask(task.id)).toMatchObject({ status: 'CANCELLED', result: expect.stringContaining('拒绝了操作') });
    expect(store.getOperation(task.id, operation(task.id).operationId)?.state).toBe('denied');
  });

  it('automatically creates a new in-workspace directory in auto mode', async () => {
    const { directory, store } = createStore();
    const task = setupTask(store, 'auto');
    const executor = new DefaultHostOperationExecutor();
    const broker = new PermissionBroker(store, executor, directory);
    await expect(broker.handle(task.id, operation(task.id), context(task.id, 'auto', directory)))
      .resolves.toMatchObject({ created: true, path: join(realpathSync.native(directory), 'hm') });
    expect(statSync(join(directory, 'hm')).isDirectory()).toBe(true);
    expect(store.getTask(task.id)?.pendingPermission).toBeUndefined();
  });

  it('allows a supported outside-workspace operation without a prompt in full mode', async () => {
    const { directory, store } = createStore();
    const outside = mkdtempSync(join(tmpdir(), 'jarvis-full-outside-'));
    temporaryDirectories.push(outside);
    const task = setupTask(store, 'full');
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor(), directory);
    const target = join(outside, 'requested');
    const canonicalTarget = join(realpathSync.native(outside), 'requested');
    const fullOperation = { ...operation(task.id), operationId: `${task.id}:step-1:1.0.0:full`, target, arguments: { path: target } };
    await expect(broker.handle(task.id, fullOperation, context(task.id, 'full', directory)))
      .resolves.toMatchObject({ path: canonicalTarget, created: true });
    expect(statSync(target).isDirectory()).toBe(true);
    expect(store.getTask(task.id)?.pendingPermission).toBeUndefined();
  });

  it('rejects a host operation with a missing target before reading its length', async () => {
    const { directory, store } = createStore();
    const task = setupTask(store, 'full');
    const executor: HostOperationExecutor = { execute: vi.fn(async () => ({ callId: 'unused', ok: true, value: null })) };
    const broker = new PermissionBroker(store, executor, directory);
    const malformed = { ...operation(task.id), target: undefined } as unknown as PermissionOperation;

    await expect(broker.handle(task.id, malformed, context(task.id, 'full', directory)))
      .rejects.toThrow(/target must be a non-empty string/i);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('restores a pending request from SQLite after a broker restart and rejects stale decisions', async () => {
    const { directory, store } = createStore();
    const task = setupTask(store);
    const firstBroker = new PermissionBroker(store, new DefaultHostOperationExecutor(), directory);
    await expect(firstBroker.handle(task.id, operation(task.id), context(task.id, 'request', directory))).rejects.toBeInstanceOf(ApprovalRequiredError);
    const requestId = store.getTask(task.id)?.pendingPermission?.requestId;
    store.close();
    openStores.splice(openStores.indexOf(store), 1);

    const restored = new SqliteStore(store.filename);
    openStores.push(restored);
    const resumedBroker = new PermissionBroker(restored, new DefaultHostOperationExecutor(), directory);
    await expect(resumedBroker.resolve(task.id, 'stale-request', true)).rejects.toThrow(/stale|does not belong/i);
    await resumedBroker.resolve(task.id, requestId!, true);
    expect(statSync(join(directory, 'hm')).isDirectory()).toBe(true);
    expect(restored.getTask(task.id)?.pendingPermission).toBeUndefined();
  });

  it('does not follow a path redirected outside the workspace while approval is pending', async () => {
    const { directory, store } = createStore();
    const outside = mkdtempSync(join(tmpdir(), 'jarvis-race-outside-'));
    temporaryDirectories.push(outside);
    const task = setupTask(store);
    const target = join(directory, 'redirected', 'new-folder');
    const pendingOperation = {
      ...operation(task.id),
      operationId: `${task.id}:step-1:1.0.0:redirected`,
      target,
      arguments: { path: target },
    };
    const executor: HostOperationExecutor = { execute: vi.fn(async () => ({ callId: 'unused', ok: true, value: null })) };
    const broker = new PermissionBroker(store, executor, directory);
    await expect(broker.handle(task.id, pendingOperation, context(task.id, 'request', directory)))
      .rejects.toBeInstanceOf(ApprovalRequiredError);
    const requestId = store.getTask(task.id)?.pendingPermission?.requestId;
    try {
      symlinkSync(outside, join(directory, 'redirected'), 'junction');
    } catch {
      return;
    }

    await broker.resolve(task.id, requestId!, true);

    expect(executor.execute).not.toHaveBeenCalled();
    expect(() => statSync(join(outside, 'new-folder'))).toThrow();
    expect(store.getOperation(task.id, pendingOperation.operationId)).toMatchObject({
      state: 'completed',
      result: { ok: false, error: { code: 'PATH_CHANGED' } },
    });
  });

  it('rechecks a filesystem target inside the host adapter before performing the operation', async () => {
    const { directory, store } = createStore();
    const outside = mkdtempSync(join(tmpdir(), 'jarvis-adapter-race-'));
    temporaryDirectories.push(outside);
    const task = setupTask(store, 'auto');
    const target = join(directory, 'redirected', 'new-folder');
    const pendingOperation = {
      ...operation(task.id), operationId: `${task.id}:step-1:1.0.0:adapter-race`, target, arguments: { path: target },
    };
    const baseExecutor = new DefaultHostOperationExecutor();
    const executor: HostOperationExecutor = {
      execute: async (call, execution) => {
        try {
          symlinkSync(outside, join(directory, 'redirected'), 'junction');
        } catch {
          return baseExecutor.execute(call, execution);
        }
        return baseExecutor.execute(call, execution);
      },
    };
    const broker = new PermissionBroker(store, executor, directory);

    await expect(broker.handle(task.id, pendingOperation, context(task.id, 'auto', directory))).rejects.toThrow(/target changed/i);

    expect(() => statSync(join(outside, 'new-folder'))).toThrow();
    expect(store.getOperation(task.id, pendingOperation.operationId)).toMatchObject({ state: 'completed', result: { ok: false, error: { code: 'PATH_CHANGED' } } });
  });
});
