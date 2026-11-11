import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionMode } from '../../src/domain/contracts.js';
import type { HostCall, HostExecutionContext } from '../../src/permissions/operation-protocol.js';
import { DefaultHostOperationExecutor } from '../../src/permissions/host-operations.js';

const temporaryDirectories: string[] = [];

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-host-'));
  temporaryDirectories.push(directory);
  return directory;
}

function call(overrides: Partial<HostCall> = {}): HostCall {
  return {
    callId: 'call-1',
    permission: 'filesystem.write',
    action: 'mkdir',
    target: 'new-folder',
    reason: 'Create a requested folder.',
    arguments: { path: 'new-folder' },
    ...overrides,
  };
}

function executionContext(root: string, mode: PermissionMode = 'request', dryRun = false, permissions: HostExecutionContext['capabilityPermissions'] = ['filesystem.write']): HostExecutionContext {
  return {
    taskId: 'task-1', mode, workspaceRoot: root, capabilityPermissions: permissions,
    capabilityVersion: '1.0.0', stepId: 'step-1', operationSequence: 1, dryRun,
  };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('DefaultHostOperationExecutor', () => {
  it('reads normal article pages above 100 KB while retaining a bounded network response limit', async () => {
    const html = `<html><body>${'article '.repeat(40_000)}</body></html>`;
    const executor = new DefaultHostOperationExecutor({ fetch: vi.fn(async () => new Response(html)) });
    const request = call({ permission: 'network', action: 'request', target: 'https://example.test/article',
      arguments: { method: 'GET' } });
    const context = executionContext(await workspace(), 'full', false, ['network']);
    const result = await executor.execute(request, context);
    expect(result).toMatchObject({ ok: true, value: { status: 200, body: html } });
    const excessive = new DefaultHostOperationExecutor({ fetch: vi.fn(async () => new Response('x'.repeat(1_000_001))) });
    await expect(excessive.execute(request, context)).resolves.toMatchObject({
      ok: false, error: { message: expect.stringContaining('exceeds the configured limit') },
    });
    const custom = new DefaultHostOperationExecutor({ maxNetworkResponseBytes: 100, fetch: vi.fn(async () => new Response(html)) });
    await expect(custom.execute(request, context)).resolves.toMatchObject({ ok: false });
  });

  it.skipIf(process.platform !== 'win32')('stops a timed-out process and its descendant on Windows', async () => {
    const root = await workspace();
    const pidFile = join(root, 'descendant.pid');
    const script = `const fs=require('node:fs'); const {spawn}=require('node:child_process'); `
      + `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); `
      + `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setInterval(()=>{},1000);`;
    const executor = new DefaultHostOperationExecutor({ timeoutMs: 400 });
    const result = await executor.execute(call({ permission: 'process', action: 'run', target: process.execPath,
      arguments: { command: process.execPath, args: ['-e', script], cwd: root } }),
    executionContext(root, 'full', false, ['process']));
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('timed out') } });
    const pid = Number(await readFile(pidFile, 'utf8'));
    const running = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      for (let attempt = 0; attempt < 10 && running(); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(running()).toBe(false);
    } finally {
      if (running()) { try { process.kill(pid); } catch { /* Already stopped. */ } }
    }
  });

  it('does not run a shell command that starts a GUI app through the short-command API', async () => {
    const root = await workspace();
    const runProcess = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const executor = new DefaultHostOperationExecutor({ runProcess });
    const result = await executor.execute(call({ permission: 'process', action: 'run', target: 'cmd.exe',
      arguments: { command: 'cmd.exe', args: ['/c', 'start', 'cloudmusic'] } }),
    executionContext(root, 'full', false, ['process']));
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_PROCESS_ACTION' } });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it('launches a GUI application without waiting for it to exit', async () => {
    const root = await workspace();
    const launchApplication = vi.fn(async () => ({ started: true, pid: 4321 }));
    const executor = new DefaultHostOperationExecutor({ launchApplication });
    const result = await executor.execute(call({
      permission: 'process', action: 'launch', target: 'C:\\Apps\\cloudmusic.exe',
      arguments: { executable: 'C:\\Apps\\cloudmusic.exe', args: [], cwd: root },
    }), executionContext(root, 'full', false, ['process']));
    expect(result).toMatchObject({ ok: true, value: { started: true, pid: 4321 } });
    expect(launchApplication).toHaveBeenCalledWith('C:\\Apps\\cloudmusic.exe', [], root);
  });

  it('rejects malformed launch arguments in dry-run before any native call', async () => {
    const root = await workspace();
    const launchApplication = vi.fn(async () => ({ started: true, pid: 1 }));
    const executor = new DefaultHostOperationExecutor({ launchApplication });
    const result = await executor.execute(call({
      permission: 'process', action: 'launch', target: 'C:\\Apps\\cloudmusic.exe',
      arguments: { executable: 'C:\\Apps\\cloudmusic.exe', args: [{}] },
    }), executionContext(root, 'full', true, ['process']));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_REQUEST');
    expect(launchApplication).not.toHaveBeenCalled();
  });

  it('simulates directory creation in dry-run mode without touching the filesystem', async () => {
    const root = await workspace();
    const result = await new DefaultHostOperationExecutor().execute(call(), executionContext(root, 'request', true));
    expect(result).toMatchObject({ ok: true, value: { created: true } });
    await expect(readFile(join(root, 'new-folder'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates a directory and safely reads/writes text through live adapters', async () => {
    const root = await workspace();
    const executor = new DefaultHostOperationExecutor();
    const created = await executor.execute(call(), executionContext(root));
    const canonicalRoot = await realpath(root);
    expect(created.ok).toBe(true);
    expect(created.value).toMatchObject({ path: join(canonicalRoot, 'new-folder'), created: true });

    const filePath = join(canonicalRoot, 'notes.txt');
    const written = await executor.execute(call({
      permission: 'filesystem.write', action: 'writeText', target: filePath,
      arguments: { path: filePath, content: 'hello' },
    }), executionContext(root));
    expect(written.value).toMatchObject({ path: filePath, bytesWritten: 5 });
    const read = await executor.execute(call({
      permission: 'filesystem.read', action: 'readText', target: filePath,
      arguments: { path: filePath },
    }), executionContext(root, 'request', false, ['filesystem.read']));
    expect(read.value).toBe('hello');
  });

  it('rejects undeclared host permissions before invoking an adapter', async () => {
    const executor = new DefaultHostOperationExecutor();
    const result = await executor.execute(call(), executionContext(await workspace(), 'full', false, []));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNDECLARED_PERMISSION');
  });

  it('routes HTTP requests and process launches through injectable adapters', async () => {
    const root = await workspace();
    const fakeFetch = vi.fn(async () => new Response('fake response', { status: 200 }));
    const runProcess = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
    const executor = new DefaultHostOperationExecutor({ fetch: fakeFetch, runProcess });
    const network = await executor.execute(call({
      permission: 'network', action: 'request', target: 'https://example.test/data',
      arguments: { url: 'https://example.test/data', method: 'GET' },
    }), executionContext(root, 'full', false, ['network']));
    expect(network.value).toMatchObject({ status: 200, body: 'fake response' });
    expect(fakeFetch).toHaveBeenCalledOnce();

    const processResult = await executor.execute(call({
      permission: 'process', action: 'run', target: 'node',
      arguments: { command: 'node', args: [], cwd: root },
    }), executionContext(root, 'full', false, ['process']));
    expect(processResult.value).toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
    expect(runProcess).toHaveBeenCalledOnce();
    expect(runProcess).toHaveBeenCalledWith('node', [], expect.any(String), 120_000, 100_000);
  });

  it('keeps automatic network execution within the public read-only boundary', async () => {
    const fakeFetch = vi.fn(async () => new Response('should not run'));
    const executor = new DefaultHostOperationExecutor({ fetch: fakeFetch });
    const result = await executor.execute(call({
      permission: 'network', action: 'request', target: 'http://example.test/upload',
      arguments: { url: 'http://example.test/upload', method: 'POST', body: 'task data' },
    }), executionContext(await workspace(), 'auto', false, ['network']));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NETWORK_POLICY');
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('includes automatic DNS lookup in the network deadline', async () => {
    const executor = new DefaultHostOperationExecutor({
      timeoutMs: 5,
      lookup: async () => new Promise<Array<{ address: string; family: number }>>(() => undefined),
    });
    const result = await executor.execute(call({
      permission: 'network', action: 'request', target: 'https://example.test/public',
      arguments: { url: 'https://example.test/public', method: 'GET' },
    }), executionContext(await workspace(), 'auto', false, ['network']));
    expect(result).toMatchObject({ ok: false, error: { code: 'NETWORK_TIMEOUT' } });
  });

  it('pins automatic HTTPS requests to a previously validated public DNS address', async () => {
    const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]);
    const autoGet = vi.fn(async () => ({ status: 200, ok: true, headers: { 'content-type': 'text/plain' }, body: 'pinned response' }));
    const fetch = vi.fn(async () => new Response('unpinned response'));
    const executor = new DefaultHostOperationExecutor({ lookup, autoGet, fetch });
    const result = await executor.execute(call({
      permission: 'network', action: 'request', target: 'https://example.test/public',
      arguments: { url: 'https://example.test/public', method: 'GET' },
    }), executionContext(await workspace(), 'auto', false, ['network']));

    expect(result).toMatchObject({ ok: true, value: { status: 200, body: 'pinned response' } });
    expect(autoGet).toHaveBeenCalledWith(new URL('https://example.test/public'), '93.184.216.34', expect.any(AbortSignal), 1_000_000, {});
    expect(fetch).not.toHaveBeenCalled();
  });

  it('executes an exact auto-mode network request after the user approved it', async () => {
    const fetch = vi.fn(async () => new Response('approved response', { status: 200 }));
    const executor = new DefaultHostOperationExecutor({ fetch });
    const result = await executor.execute(call({
      permission: 'network', action: 'request', target: 'http://127.0.0.1:3000/approved',
      arguments: { url: 'http://127.0.0.1:3000/approved', method: 'POST', body: 'approved payload' },
    }), { ...executionContext(await workspace(), 'auto', false, ['network']), approvalGranted: true });

    expect(result).toMatchObject({ ok: true, value: { status: 200, body: 'approved response' } });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:3000/approved', expect.objectContaining({ method: 'POST', redirect: 'manual' }));
  });

  it('returns an explicit unsupported result for location when no provider exists', async () => {
    const result = await new DefaultHostOperationExecutor().execute(call({
      permission: 'location', action: 'current', target: 'device location', arguments: {},
    }), executionContext(await workspace(), 'full', false, ['location']));
    expect(result.value).toMatchObject({ supported: false });
  });
});
