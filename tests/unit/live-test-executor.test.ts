import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { SandboxRunner } from '../../src/capabilities/sandbox-runner.js';
import { TestExecutor } from '../../src/runtime/test-executor.js';
import { WindowsDesktopObserver } from '../../src/runtime/windows-desktop-observer.js';

const directories: string[] = [];
const stores: SqliteStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-live-test-'));
  directories.push(directory);
  const store = new SqliteStore(join(directory, 'db.sqlite'));
  stores.push(store);
  const task = store.createTask({ message: 'launch app', attachments: [], permissionMode: 'full' });
  return { store, task, directory };
}

function processOperation(store: SqliteStore, taskId: string, action: 'run' | 'launch' = 'run') {
  const now = new Date().toISOString();
  store.createOperation({ taskId, operationId: `${taskId}:launch:1.0.0:0`, state: 'executing',
    operation: { operationId: `${taskId}:launch:1.0.0:0`, permission: 'process', action,
      target: action === 'launch' ? 'C:\\Apps\\cloudmusic.exe' : 'cloudmusic.exe', reason: 'Launch app',
      arguments: action === 'launch' ? { executable: 'C:\\Apps\\cloudmusic.exe', args: [] } : { command: 'cloudmusic.exe', args: [] } },
    createdAt: now, updatedAt: now });
  store.completeOperation(taskId, `${taskId}:launch:1.0.0:0`, { callId: 'x', ok: true,
    value: action === 'launch' ? { started: true, pid: 4321 } : { exitCode: 0, stdout: '', stderr: '' } });
}

describe('live verification', () => {
  it('verifies only the current corrected attempt instead of counting an earlier failed target', async () => {
    const { store, task, directory } = setup();
    const oldPath = join(realpathSync.native(directory), 'missing.md');
    const newPath = join(realpathSync.native(directory), 'exists.md');
    const now = new Date().toISOString();
    for (const [sequence, target, ok] of [[0, oldPath, false], [1, newPath, true]] as const) {
      const operationId = `${task.id}:read:1.0.0:${sequence}`;
      store.createOperation({ taskId: task.id, operationId, state: 'executing', createdAt: now, updatedAt: now,
        operation: { operationId, permission: 'filesystem.read', action: 'readText', target, reason: 'read', arguments: { path: target } } });
      store.completeOperation(task.id, operationId, { callId: `call-${sequence}`, ok,
        ...(ok ? { value: 'verified' } : { error: { code: 'ENOENT', message: 'missing' } }) });
    }
    const report = await new TestExecutor(new SandboxRunner()).runLive(store, task.id, 'read', '1.0.0',
      ['filesystem.read'], { cases: [] }, new WindowsDesktopObserver(), undefined, newPath, 1);
    expect(report, JSON.stringify(report)).toMatchObject({ passed: 1, failed: 0, blocked: 0 });
  });

  it('blocks a process tool when no desktop application identity was specified', async () => {
    const { store, task } = setup();
    processOperation(store, task.id, 'launch');
    const executor = new TestExecutor(new SandboxRunner());
    const report = await executor.runLive(store, task.id, 'launch', '1.0.0', ['process'], { cases: [] },
      new WindowsDesktopObserver(async () => ({ running: true, visible: true, foreground: true }), 'win32'));
    expect(report.blocked).toBe(1);
  });

  it('requires process, visible window and foreground evidence to pass', async () => {
    const { store, task } = setup();
    processOperation(store, task.id);
    const executor = new TestExecutor(new SandboxRunner());
    const plan = { cases: [{ id: 'desktop', mode: 'live_observation' as const, assertions: [
      { type: 'process_running' as const, applicationId: 'cloudmusic' },
      { type: 'window_visible' as const, applicationId: 'cloudmusic' },
      { type: 'foreground_window' as const, applicationId: 'cloudmusic' },
    ] }] };
    const failed = await executor.runLive(store, task.id, 'launch', '1.0.0', ['process'], plan,
      new WindowsDesktopObserver(async () => ({ running: true, visible: true, foreground: false }), 'win32', 0), 'cloudmusic');
    expect(failed.failed).toBe(1);
    const passed = await executor.runLive(store, task.id, 'launch', '1.0.0', ['process'], plan,
      new WindowsDesktopObserver(async () => ({ running: true, visible: true, foreground: true }), 'win32'), 'cloudmusic');
    expect(passed).toMatchObject({ passed: 2, failed: 0, blocked: 0 });
    expect(passed.cases[0]?.evidence).toContainEqual({ kind: 'journal', code: 'AUTHORIZED_OPERATION_COMPLETED' });
    expect(passed.cases[1]?.evidence).toContainEqual({ kind: 'desktop', code: 'FOREGROUND_WINDOW_CONFIRMED' });
  });

  it('does not credit an unrelated foreground application', async () => {
    const { store, task } = setup();
    processOperation(store, task.id);
    const report = await new TestExecutor(new SandboxRunner()).runLive(store, task.id, 'launch', '1.0.0', ['process'], {
      cases: [{ id: 'desktop', mode: 'live_observation', assertions: [
        { type: 'process_running', applicationId: 'notepad' },
        { type: 'window_visible', applicationId: 'notepad' },
        { type: 'foreground_window', applicationId: 'notepad' },
      ] }],
    }, new WindowsDesktopObserver(async () => ({ running: true, visible: true, foreground: true }), 'win32'), 'notepad');
    expect(report.blocked).toBe(1);
  });

  it('blocks when no completed host operation exists', async () => {
    const { store, task } = setup();
    const report = await new TestExecutor(new SandboxRunner()).runLive(store, task.id, 'launch', '1.0.0', ['process'], { cases: [] },
      new WindowsDesktopObserver(async () => ({ running: true, visible: true, foreground: true }), 'win32'));
    expect(report.blocked).toBe(1);
  });

  it('does not accept a write result when the file content differs', async () => {
    const { store, task, directory } = setup();
    const path = join(directory, 'result.txt');
    writeFileSync(path, 'wrong');
    const now = new Date().toISOString();
    const operationId = `${task.id}:write:1.0.0:0`;
    store.createOperation({ taskId: task.id, operationId, state: 'executing', createdAt: now, updatedAt: now,
      operation: { operationId, permission: 'filesystem.write', action: 'writeText', target: path, reason: 'write', arguments: { path, content: 'expected' } } });
    store.completeOperation(task.id, operationId, { callId: 'x', ok: true, value: { path, bytesWritten: 8 } });
    const report = await new TestExecutor(new SandboxRunner()).runLive(store, task.id, 'write', '1.0.0', ['filesystem.write'], { cases: [] }, new WindowsDesktopObserver());
    expect(report.failed).toBe(1);
    expect(report.cases[0]?.codes).toContain('FILESYSTEM_EFFECT_MISSING');
  });

  it('does not mistake an inaccessible remove target for successful deletion', async () => {
    const { store, task } = setup();
    const now = new Date().toISOString();
    const operationId = `${task.id}:remove:1.0.0:0`;
    store.createOperation({ taskId: task.id, operationId, state: 'executing', createdAt: now, updatedAt: now,
      operation: { operationId, permission: 'filesystem.write', action: 'remove', target: '\0invalid', reason: 'remove', arguments: { path: '\0invalid' } } });
    store.completeOperation(task.id, operationId, { callId: 'x', ok: true, value: { removed: true } });
    const report = await new TestExecutor(new SandboxRunner()).runLive(store, task.id, 'remove', '1.0.0', ['filesystem.write'], { cases: [] }, new WindowsDesktopObserver());
    expect(report.failed).toBe(1);
  });

  it('rejects a real write to a different location than the planner requested', async () => {
    const { store, task, directory } = setup();
    const actual = join(directory, 'wrong.txt');
    const requested = join(directory, 'requested.txt');
    writeFileSync(actual, 'hello');
    const now = new Date().toISOString();
    const operationId = `${task.id}:write:1.0.0:0`;
    store.createOperation({ taskId: task.id, operationId, state: 'executing', createdAt: now, updatedAt: now,
      operation: { operationId, permission: 'filesystem.write', action: 'writeText', target: actual, reason: 'write', arguments: { path: actual, content: 'hello' } } });
    store.completeOperation(task.id, operationId, { callId: 'x', ok: true, value: { path: actual, bytesWritten: 5 } });
    const report = await new TestExecutor(new SandboxRunner()).runLive(store, task.id, 'write', '1.0.0', ['filesystem.write'], { cases: [] }, new WindowsDesktopObserver(), undefined, requested);
    expect(report.failed).toBe(1);
    expect(report.cases[0]?.codes).toContain('TARGET_MISMATCH');
  });

  it('blocks a successful write when the planner never supplied a target path', async () => {
    const { store, task, directory } = setup();
    const actual = join(directory, 'folder');
    mkdirSync(actual);
    const now = new Date().toISOString();
    const operationId = `${task.id}:mkdir:1.0.0:0`;
    store.createOperation({ taskId: task.id, operationId, state: 'executing', createdAt: now, updatedAt: now,
      operation: { operationId, permission: 'filesystem.write', action: 'mkdir', target: actual, reason: 'mkdir', arguments: { path: actual } } });
    store.completeOperation(task.id, operationId, { callId: 'x', ok: true, value: { path: actual, created: true } });
    const report = await new TestExecutor(new SandboxRunner()).runLive(store, task.id, 'mkdir', '1.0.0', ['filesystem.write'], { cases: [] }, new WindowsDesktopObserver());
    expect(report.blocked).toBe(1);
    expect(report.cases[0]?.codes).toContain('TARGET_NOT_SPECIFIED');
  });

  it('does not promote a network tool after an HTTP 500 response', async () => {
    const { store, task } = setup();
    const now = new Date().toISOString();
    const operationId = `${task.id}:request:1.0.0:0`;
    store.createOperation({ taskId: task.id, operationId, state: 'executing', createdAt: now, updatedAt: now,
      operation: { operationId, permission: 'network', action: 'request', target: 'https://example.org/status', reason: 'check', arguments: { url: 'https://example.org/status', method: 'GET' } } });
    store.completeOperation(task.id, operationId, { callId: 'x', ok: true, value: { status: 500, ok: false, headers: {}, body: 'server error' } });
    const report = await new TestExecutor(new SandboxRunner()).runLive(store, task.id, 'request', '1.0.0', ['network'], { cases: [] }, new WindowsDesktopObserver());
    expect(report.failed).toBe(1);
    expect(report.cases[0]?.codes).toContain('HTTP_RESPONSE_FAILED');
    expect(JSON.stringify(report)).not.toContain('server error');
  });

  it('rejects an invalid location result even when the provider claims support', async () => {
    const { store, task } = setup();
    const now = new Date().toISOString();
    const operationId = `${task.id}:location:1.0.0:0`;
    store.createOperation({ taskId: task.id, operationId, state: 'executing', createdAt: now, updatedAt: now,
      operation: { operationId, permission: 'location', action: 'current', target: 'device location', reason: 'locate', arguments: {} } });
    store.completeOperation(task.id, operationId, { callId: 'x', ok: true, value: { supported: true, latitude: 999, longitude: 0 } });
    const report = await new TestExecutor(new SandboxRunner()).runLive(store, task.id, 'location', '1.0.0', ['location'], { cases: [] }, new WindowsDesktopObserver());
    expect(report.failed).toBe(1);
    expect(report.cases[0]?.codes).toContain('INVALID_LOCATION');
  });
});
