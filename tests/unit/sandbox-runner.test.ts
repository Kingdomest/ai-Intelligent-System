import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxRunner } from '../../src/capabilities/sandbox-runner.js';

const temporaryDirectories: string[] = [];

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-sandbox-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('SandboxRunner host bridge', () => {
  it('rejects shell-based GUI launch disguised as a short process command', async () => {
    await expect(new SandboxRunner().run(
      'export async function run(input, host) { return host.process.run({ command: "cmd.exe", args: ["/c", "start", "cloudmusic"] }); }',
      {}, { mode: 'dry-run' },
    )).rejects.toThrow(/process\.launch/);
  });

  it('exposes a bounded launch host bridge in dry-run mode', async () => {
    const runner = new SandboxRunner();
    const code = 'export async function run(input, host) { return host.process.launch({ executable: input.executable, args: input.args, cwd: input.workspaceRoot }); }';
    const result = await runner.run(code, { executable: 'C:\\Apps\\cloudmusic.exe', args: [], workspaceRoot: 'C:\\demo' }, { mode: 'dry-run' });
    expect(result.output).toMatchObject({ started: true });
    await expect(runner.run(code, { executable: 'C:\\Apps\\cloudmusic.exe', args: [{}], workspaceRoot: 'C:\\demo' }, { mode: 'dry-run' }))
      .rejects.toThrow(/bounded string args array/);
  });

  it('provides only simulated host results while evaluating a candidate', async () => {
    const root = await workspace();
    const runner = new SandboxRunner();
    const result = await runner.run(
      'export async function run(input, host) { return await host.fs.mkdir(input.path); }',
      { path: join(root, 'should-not-exist') },
      { mode: 'dry-run' },
    );
    expect(result.output).toMatchObject({ created: true });
    await expect(stat(join(root, 'should-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects filesystem host calls that do not provide a usable path', async () => {
    await expect(new SandboxRunner().run(
      'export async function run(input, host) { return await host.fs.mkdir(input.path); }',
      { content: '' },
      { mode: 'dry-run' },
    )).rejects.toThrow(/path/i);
  });

  it('forwards typed host calls through IPC and returns the host result', async () => {
    const hostCall = vi.fn(async (call) => ({ callId: call.callId, ok: true, value: { path: call.target, created: true } }));
    const runner = new SandboxRunner();
    const result = await runner.run(
      'export async function run(input, host) { return await host.fs.mkdir(input.path); }',
      { path: 'created-by-host' },
      { mode: 'live', hostCall },
    );
    expect(result.output).toEqual({ path: 'created-by-host', created: true });
    expect(hostCall).toHaveBeenCalledWith(expect.objectContaining({
      permission: 'filesystem.write', action: 'mkdir', target: 'created-by-host',
    }));
  });

  it('returns a live file read larger than the dry-run output ceiling', async () => {
    const content = 'x'.repeat(120_000);
    const result = await new SandboxRunner().run(
      'export async function run(input, host) { return { content: await host.fs.readText(input.path) }; }',
      { path: 'large-guide.md' },
      { mode: 'live', hostCall: async (call) => ({ callId: call.callId, ok: true, value: content }) },
    );
    expect(result.output).toEqual({ content });
  });

  it('allows a live host call to finish within its own bounded host timeout', async () => {
    const result = await new SandboxRunner().run(
      'export async function run(input, host) { return host.network.request({ url: input.url, method: "GET" }); }',
      { url: 'https://example.test/' },
      { mode: 'live', hostCall: async (call) => {
        await new Promise((resolve) => setTimeout(resolve, 2_100));
        return { callId: call.callId, ok: true, value: { status: 200, ok: true, body: '' } };
      } },
    );
    expect(result.output).toMatchObject({ status: 200 });
  }, 8_000);

  it('rejects process calls that use positional arguments instead of a request object during dry-run', async () => {
    await expect(new SandboxRunner().run(
      "export async function run(input, host) { try { await host.process.run('cmd.exe', ['/c', 'start', 'cloudmusic']); return { success: true }; } catch (error) { return { success: false, message: error.message }; } }",
      {},
      { mode: 'dry-run' },
    )).rejects.toThrow(/dry-run host operation validation failed.*command.*args/i);
  });

  it('fails closed if live execution has no operation broker', async () => {
    await expect(new SandboxRunner().run(
      'export async function run(input, host) { return await host.fs.mkdir(input.path); }',
      { path: 'not-authorized' },
      { mode: 'live' },
    )).rejects.toThrow(/No host-operation broker is configured/);
  });

  it('does not expose Node globals or dynamic code generation to generated code', async () => {
    const escapeAttempt = "export async function run(input, host) { const make = (() => 0)['con' + 'structor']; const ambient = make('return this')(); return ambient['pro' + 'cess'].version; }";
    await expect(new SandboxRunner().run(escapeAttempt, {}, { mode: 'dry-run' }))
      .rejects.toThrow(/code generation from strings disallowed/i);
  });

  it('does not expose the Node process global after static policy validation', async () => {
    await expect(new SandboxRunner().run(
      'export async function run() { return process.pid; }',
      {},
      { mode: 'dry-run' },
    )).rejects.toThrow(/process is not defined/i);
  });
});
