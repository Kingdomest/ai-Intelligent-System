import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { HostCall, HostCallResult, HostCallHandler } from '../permissions/operation-protocol.js';
import { isShellGuiLaunch } from '../permissions/process-contract.js';
import { presentationInputSchema } from '../presentations/render.js';

export interface SandboxLimits {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface SandboxRunOptions extends SandboxLimits {
  mode?: 'dry-run' | 'live';
  hostCall?: HostCallHandler;
}

export interface SandboxResult {
  output: unknown;
  durationMs: number;
}

const runnerSource = `
const vm = require('node:vm');
const pending = new Map();
let callSequence = 0;
function hostCall(permission, action, target, reason, args) {
  const callId = 'host-' + (++callSequence);
  return new Promise((resolve, reject) => {
    pending.set(callId, { resolve, reject });
    process.send({ type: 'host-call', call: { callId, permission, action, target, reason, arguments: args } }, (error) => {
      if (error) {
        pending.delete(callId);
        reject(error);
      }
    });
  });
}
process.on('message', async (message) => {
  if (message?.type === 'host-result') {
    const item = pending.get(message.result.callId);
    if (!item) return;
    pending.delete(message.result.callId);
    item.resolve(JSON.stringify(message.result));
    return;
  }
  if (message?.type !== 'run') return;
  try {
    const code = String(message.code ?? '').replace(/^\\s*export\\s+async\\s+function\\s+run\\s*\\(/m, 'async function run(');
    if (code === String(message.code ?? '')) throw new Error('tool must export an async run function');
    // Candidate code gets only JSON-cloned inputs and vm-native bridge wrappers; never expose the runner's Node objects.
    const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
    context.__hostRpc = hostCall;
    context.__inputJson = JSON.stringify(message.input ?? null);
    vm.runInContext(
      \`(() => {
        const rpc = globalThis.__hostRpc;
        const inputJson = globalThis.__inputJson;
        delete globalThis.__hostRpc;
        delete globalThis.__inputJson;
        const invoke = (permission, action, target, reason, args) => {
          const safeArgs = JSON.parse(JSON.stringify(args));
          return new Promise((resolve, reject) => {
            Promise.resolve(rpc(permission, action, target, reason, safeArgs)).then((wire) => {
              const result = JSON.parse(wire);
              if (result.ok) resolve(result.value);
              else {
                const error = new Error(result.error?.message || 'Host operation failed.');
                error.code = result.error?.code;
                reject(error);
              }
            }, (error) => reject(new Error(String(error?.message || 'Host operation failed.'))));
          });
        };
        const host = Object.freeze({
          fs: Object.freeze({
            readText: (path) => invoke('filesystem.read', 'readText', path, 'Read text requested by the task.', { path }),
            writeText: (path, content) => invoke('filesystem.write', 'writeText', path, 'Write task output to this file.', { path, content }),
            mkdir: (path) => invoke('filesystem.write', 'mkdir', path, 'Create the requested directory.', { path }),
            remove: (path) => invoke('filesystem.write', 'remove', path, 'Remove the requested file or directory.', { path }),
          }),
          presentation: Object.freeze({ create: (request) => {
            if (!request || typeof request.path !== 'string' || !request.path.trim()
              || !Array.isArray(request.slides) || !request.slides.length) throw new Error('Invalid presentation input.');
            return invoke('filesystem.write', 'createPresentation', request.path,
              'Create a PowerPoint file without replacing an existing file.', request);
          } }),
          network: Object.freeze({ request: (request) => invoke('network', 'request', request.url, 'Make an outbound ' + String(request.method).toUpperCase() + ' request.', request) }),
          process: Object.freeze({ run: (request) => invoke(
            'process',
            'run',
            request && typeof request.command === 'string' ? request.command : '',
            'Run the requested process with explicit arguments.',
            request && typeof request === 'object' && !Array.isArray(request) ? request : {},
          ), launch: (request) => invoke(
            'process',
            'launch',
            request && typeof request.executable === 'string' ? request.executable : '',
            'Launch the exact approved application.',
            request && typeof request === 'object' && !Array.isArray(request) ? request : {},
          ) }),
          location: Object.freeze({ current: () => invoke('location', 'current', 'device location', 'Retrieve the current device location.', {}) }),
        });
        globalThis.host = host;
        globalThis.input = JSON.parse(inputJson);
      })()\`,
      context,
      { timeout: 500 },
    );
    const script = new vm.Script(\`'use strict';\\n\${code}\\n;run(input, host);\`, { filename: 'generated-capability.js' });
    const output = await script.runInContext(context, { timeout: 500 });
    const outputJson = JSON.stringify(output ?? null);
    process.send({ type: 'result', outputJson }, () => process.disconnect());
  } catch (error) {
    process.send({
      type: 'failure',
      code: error && typeof error === 'object' && 'code' in error ? error.code : 'SANDBOX_EXECUTION_FAILED',
      message: error instanceof Error ? error.stack ?? error.message : String(error),
    }, () => process.disconnect());
  }
});
`;

export class SandboxRunner {
  async run(code: string, input: unknown, options: SandboxRunOptions = {}): Promise<SandboxResult> {
    const startedAt = Date.now();
    const mode = options.mode ?? 'dry-run';
    const timeoutMs = options.timeoutMs ?? (mode === 'live' ? 15_000 : 2_000);
    // Host reads allow up to 1 MB; JSON escaping can expand their serialized output.
    const maxOutputBytes = options.maxOutputBytes ?? (mode === 'live' ? 8_000_000 : 100_000);
    const directory = await mkdtemp(join(tmpdir(), `jarvis-sandbox-${randomUUID()}-`));
    const runnerPath = join(directory, 'runner.cjs');
    await writeFile(runnerPath, runnerSource, 'utf8');

    try {
      return await new Promise<SandboxResult>((resolve, reject) => {
        const child = fork(runnerPath, [], {
          cwd: directory,
          execArgv: ['--permission', `--allow-fs-read=${directory}`],
          env: {
            PATH: process.env.PATH ?? '',
            SystemRoot: process.env.SystemRoot ?? '',
            WINDIR: process.env.WINDIR ?? '',
            TEMP: directory,
            TMP: directory,
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        let finished = false;
        let outputTooLarge = false;
        let timedOut = false;
        let receivedOutputJson: string | undefined;
        let receivedFailure: { message: string; code: string } | undefined;
        const dryRunHostFailures: string[] = [];
        const finish = (error?: Error, output?: unknown) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve({ output, durationMs: Date.now() - startedAt });
        };
        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs);

        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          stdout += chunk;
          if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutputBytes) {
            outputTooLarge = true;
            child.kill();
          }
        });
        child.stderr?.on('data', (chunk: string) => {
          stderr += chunk;
          if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutputBytes) {
            outputTooLarge = true;
            child.kill();
          }
        });
        child.on('message', async (message: unknown) => {
          if (!message || typeof message !== 'object' || !('type' in message)) return;
          const payload = message as { type: string; call?: HostCall; outputJson?: string; message?: string; code?: string };
          if (payload.type === 'host-call' && payload.call) {
            let result: HostCallResult;
            if (!options.hostCall) {
              result = mode === 'dry-run'
                ? defaultDryRun(payload.call)
                : { callId: payload.call.callId, ok: false, error: { code: 'HOST_BROKER_UNAVAILABLE', message: 'No host-operation broker is configured.' } };
            } else {
              try {
                result = await options.hostCall(payload.call);
              } catch (error) {
                result = {
                  callId: payload.call.callId,
                  ok: false,
                  error: { code: 'HOST_CALL_FAILED', message: error instanceof Error ? error.message : String(error) },
                };
              }
            }
            if (mode === 'dry-run' && !options.hostCall && !result.ok && result.error?.message) {
              dryRunHostFailures.push(result.error.message);
            }
            if (child.connected && !finished) child.send({ type: 'host-result', result });
          } else if (payload.type === 'result') {
            const serialized = payload.outputJson ?? 'null';
            if (Buffer.byteLength(serialized) > maxOutputBytes) {
              outputTooLarge = true;
              child.kill();
            } else {
              receivedOutputJson = serialized;
            }
          } else if (payload.type === 'failure') {
            receivedFailure = {
              message: `Sandbox failed: ${payload.message ?? stderr ?? 'unknown error'}`,
              code: payload.code ?? 'SANDBOX_EXECUTION_FAILED',
            };
          }
        });
        child.on('error', (error) => finish(error));
        child.on('close', (exitCode) => {
          if (finished) return;
          if (timedOut) return finish(new Error(`Sandbox timed out after ${timeoutMs}ms.`));
          if (outputTooLarge) return finish(new Error('Sandbox output exceeded the configured limit.'));
          if (receivedFailure) {
            const failure = new Error(receivedFailure.message);
            Object.assign(failure, { code: receivedFailure.code });
            return finish(failure);
          }
          if (receivedOutputJson !== undefined) {
            if (dryRunHostFailures.length > 0) {
              return finish(new Error(`Dry-run host operation validation failed: ${dryRunHostFailures.join('; ')}`));
            }
            try {
              return finish(undefined, JSON.parse(receivedOutputJson));
            } catch (error) {
              return finish(error instanceof Error ? error : new Error('Sandbox output was not valid JSON.'));
            }
          }
          finish(new Error(`Sandbox failed: ${stderr || `exit code ${exitCode}`}`));
        });
        child.send({ type: 'run', input, code });
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function defaultDryRun(call: HostCall): HostCallResult {
  const args = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
    ? call.arguments
    : {};
  const pathValue = typeof args.path === 'string' ? args.path : call.target;
  if (call.permission === 'location') {
    return { callId: call.callId, ok: true, value: { supported: false, reason: 'No location provider is configured.' } };
  }
  if ((call.permission === 'filesystem.read' || call.permission === 'filesystem.write')
    && (typeof pathValue !== 'string' || !pathValue.trim())) {
    return { callId: call.callId, ok: false, error: { code: 'INVALID_PATH', message: 'Filesystem operation requires a valid path.' } };
  }
  if (call.permission === 'filesystem.write' && call.action === 'mkdir') {
    return { callId: call.callId, ok: true, value: { path: pathValue, created: true } };
  }
  if (call.permission === 'filesystem.write' && call.action === 'createPresentation') {
    const input = presentationInputSchema.safeParse(args);
    if (!input.success) return { callId: call.callId, ok: false,
      error: { code: 'INVALID_PRESENTATION', message: 'Structured presentation input is invalid.' } };
    return { callId: call.callId, ok: true, value: { path: pathValue,
      slideCount: input.data.slides.length, bytesWritten: 0, sha256: 'dry-run-not-a-real-file' } };
  }
  if (call.permission === 'filesystem.write') {
    const content = typeof args.content === 'string' ? args.content : '';
    return { callId: call.callId, ok: true, value: { path: pathValue, bytesWritten: Buffer.byteLength(content) } };
  }
  if (call.permission === 'filesystem.read') return { callId: call.callId, ok: true, value: '[dry-run file contents]' };
  if (call.permission === 'network') return { callId: call.callId, ok: true, value: { status: 200, body: '[dry-run network response]' } };
  if (call.permission === 'process') {
    const launch = call.action === 'launch';
    const command = launch ? args.executable : args.command;
    const processArgs = args.args;
    if (typeof command !== 'string' || !command.trim() || !Array.isArray(processArgs)
      || processArgs.length > 100 || !processArgs.every((item) => typeof item === 'string')) {
      return { callId: call.callId, ok: false, error: { code: 'INVALID_REQUEST', message: `host.process.${launch ? 'launch' : 'run'} expects a request object with a non-empty command and a bounded string args array.` } };
    }
    if (launch) return { callId: call.callId, ok: true, value: { started: true, pid: null } };
    if (isShellGuiLaunch(command, processArgs)) {
      return { callId: call.callId, ok: false, error: { code: 'INVALID_PROCESS_ACTION', message: 'GUI applications must use process.launch.' } };
    }
    return { callId: call.callId, ok: true, value: { exitCode: 0, stdout: '[dry-run process output]', stderr: '' } };
  }
  return { callId: call.callId, ok: true, value: { exitCode: 0, stdout: '[dry-run process output]', stderr: '' } };
}
