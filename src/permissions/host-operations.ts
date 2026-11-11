import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { lookup as resolveDns } from 'node:dns/promises';
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import type { CapabilityPermission } from '../domain/contracts.js';
import type { HostCall, HostCallResult, HostExecutionContext, HostOperationExecutor } from './operation-protocol.js';
import { canonicalizeFilesystemPath } from './policy.js';
import { hasBoundedProcessArgs, isShellGuiLaunch } from './process-contract.js';
import { presentationInputSchema, writePresentation } from '../presentations/render.js';
import type { McpService } from '../mcp/service.js';

export interface HostOperationAdapters {
  fetch?: typeof fetch;
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  autoGet?: (url: URL, address: string, signal: AbortSignal, maxOutputBytes: number, headers: Record<string, string>) => Promise<AutomaticGetResult>;
  runProcess?: (command: string, args: string[], cwd: string, timeoutMs: number, maxOutputBytes: number) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  launchApplication?: (executable: string, args: string[], cwd: string) => Promise<{ started: boolean; pid: number | null }>;
  location?: () => Promise<{ latitude: number; longitude: number }>;
  maxReadBytes?: number;
  maxWriteBytes?: number;
  maxNetworkBodyBytes?: number;
  maxNetworkResponseBytes?: number;
  maxOutputBytes?: number;
  timeoutMs?: number;
  mcp?: McpService;
}

export interface AutomaticGetResult {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
}

const supportedPermissions = new Set<CapabilityPermission>(['filesystem.read', 'filesystem.write', 'network', 'location', 'process', 'mcp']);

export class DefaultHostOperationExecutor implements HostOperationExecutor {
  constructor(private readonly adapters: HostOperationAdapters = {}) {}

  async execute(operation: HostCall, context: HostExecutionContext): Promise<HostCallResult> {
    if (!supportedPermissions.has(operation.permission)) return failed(operation.callId, 'UNSUPPORTED_PERMISSION', 'This permission is not supported.');
    if (!context.capabilityPermissions.includes(operation.permission)) {
      return failed(operation.callId, 'UNDECLARED_PERMISSION', `Capability did not declare ${operation.permission}.`);
    }
    try {
      if (context.dryRun) return this.dryRun(operation, context);
      const value = await this.executeLive(operation, context);
      return { callId: operation.callId, ok: true, value };
    } catch (error) {
      return failed(operation.callId, errorCode(error), error instanceof Error ? error.message : String(error));
    }
  }

  private dryRun(operation: HostCall, context: HostExecutionContext): HostCallResult {
    const pathValue = stringArg(operation, 'path') || operation.target;
    const resolvedPath = resolveHostPath(pathValue, context.workspaceRoot);
    switch (operation.action.toLowerCase()) {
      case 'createpresentation': {
        const input = presentationInputSchema.parse(operation.arguments);
        return { callId: operation.callId, ok: true, value: { path: resolvedPath,
          slideCount: input.slides.length, bytesWritten: 0, sha256: 'dry-run-not-a-real-file' } };
      }
      case 'read':
      case 'readtext':
      case 'read_text':
        return { callId: operation.callId, ok: true, value: '[dry-run file contents]' };
      case 'write':
      case 'writetext':
      case 'write_text':
        return { callId: operation.callId, ok: true, value: { path: resolvedPath, bytesWritten: Buffer.byteLength(stringArg(operation, 'content')) } };
      case 'mkdir':
      case 'createdirectory':
      case 'create_directory':
        return { callId: operation.callId, ok: true, value: { path: resolvedPath, created: true } };
      case 'remove':
      case 'delete':
        return { callId: operation.callId, ok: true, value: { path: resolvedPath, removed: true } };
      case 'request':
        return { callId: operation.callId, ok: true, value: { status: 200, body: '[dry-run network response]' } };
      case 'run':
        return { callId: operation.callId, ok: true, value: { exitCode: 0, stdout: '[dry-run process output]', stderr: '' } };
      case 'launch': {
        const request = launchRequest(operation, context.workspaceRoot);
        return { callId: operation.callId, ok: true, value: { started: true, pid: null, executable: request.executable } };
      }
      case 'current':
        return { callId: operation.callId, ok: true, value: { supported: false, reason: 'No location provider is configured.' } };
      case 'call':
        return operation.permission === 'mcp'
          ? { callId: operation.callId, ok: true, value: { server: operation.arguments.server,
            tool: operation.arguments.tool, content: [{ type: 'text', text: '[dry-run MCP result]' }] } }
          : failed(operation.callId, 'UNSUPPORTED_ACTION', `Unsupported host action: ${operation.action}`);
      default:
        return failed(operation.callId, 'UNSUPPORTED_ACTION', `Unsupported host action: ${operation.action}`);
    }
  }

  private async executeLive(operation: HostCall, context: HostExecutionContext): Promise<unknown> {
    const pathValue = stringArg(operation, 'path') || operation.target;
    const targetPath = resolveHostPath(pathValue, context.workspaceRoot);
    const filesystemOperation = operation.permission === 'filesystem.read' || operation.permission === 'filesystem.write';
    const stableTargetPath = filesystemOperation
      ? canonicalizeFilesystemPath(targetPath, context.workspaceRoot)
      : targetPath;
    const absolutePath = path.isAbsolute(pathValue) || path.win32.isAbsolute(pathValue);
    if (filesystemOperation && absolutePath && !samePathIdentity(targetPath, stableTargetPath)) {
      throw Object.assign(new Error('Filesystem target changed after permission evaluation; the operation was not executed.'), { code: 'PATH_CHANGED' });
    }
    switch (operation.action.toLowerCase()) {
      case 'createpresentation': {
        const input = presentationInputSchema.parse(operation.arguments);
        assertStableFilesystemPath(stableTargetPath, context.workspaceRoot);
        return writePresentation(stableTargetPath, input);
      }
      case 'read':
      case 'readtext':
      case 'read_text': {
        const maxReadBytes = this.adapters.maxReadBytes ?? 1_000_000;
        assertStableFilesystemPath(stableTargetPath, context.workspaceRoot);
        const metadata = await stat(stableTargetPath);
        if (metadata.size > maxReadBytes) throw new Error('File exceeds the configured read limit.');
        assertStableFilesystemPath(stableTargetPath, context.workspaceRoot);
        const file = await readFile(stableTargetPath);
        if (file.byteLength > maxReadBytes) throw new Error('File exceeds the configured read limit.');
        return file.toString('utf8');
      }
      case 'write':
      case 'writetext':
      case 'write_text': {
        const content = stringArg(operation, 'content');
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > (this.adapters.maxWriteBytes ?? 1_000_000)) throw new Error('File content exceeds the configured write limit.');
        assertStableFilesystemPath(stableTargetPath, context.workspaceRoot);
        await writeFile(stableTargetPath, content, { encoding: 'utf8' });
        return { path: stableTargetPath, bytesWritten: bytes };
      }
      case 'mkdir':
      case 'createdirectory':
      case 'create_directory': {
        assertStableFilesystemPath(stableTargetPath, context.workspaceRoot);
        const existed = await pathExists(stableTargetPath);
        assertStableFilesystemPath(stableTargetPath, context.workspaceRoot);
        await mkdir(stableTargetPath, { recursive: true });
        return { path: stableTargetPath, created: !existed };
      }
      case 'remove':
      case 'delete': {
        assertStableFilesystemPath(stableTargetPath, context.workspaceRoot);
        await rm(stableTargetPath, { recursive: false, force: false });
        return { path: stableTargetPath, removed: true };
      }
      case 'request':
        return this.request(operation, context);
      case 'run':
        return this.runProcess(operation, context);
      case 'launch':
        return this.launchApplication(operation, context);
      case 'current':
        return this.adapters.location
          ? { supported: true, ...(await this.adapters.location()) }
          : { supported: false, reason: 'No location provider is configured.' };
      case 'call': {
        if (operation.permission !== 'mcp' || !this.adapters.mcp) {
          throw Object.assign(new Error('MCP client is not configured.'), { code: 'MCP_UNAVAILABLE' });
        }
        const { server, tool, arguments: args } = operation.arguments;
        if (typeof server !== 'string' || typeof tool !== 'string' || operation.target !== `${server}/${tool}`
          || !args || typeof args !== 'object' || Array.isArray(args)) {
          throw Object.assign(new Error('Invalid MCP tool request.'), { code: 'INVALID_MCP_REQUEST' });
        }
        return this.adapters.mcp.call(server, tool, args as Record<string, unknown>);
      }
      default:
        throw Object.assign(new Error(`Unsupported host action: ${operation.action}`), { code: 'UNSUPPORTED_ACTION' });
    }
  }

  private async request(operation: HostCall, context: HostExecutionContext): Promise<unknown> {
    const url = operation.target;
    const method = stringArg(operation, 'method').toUpperCase();
    const body = operation.arguments.body;
    if (!url || !method || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
      throw Object.assign(new Error('Network request must include a valid URL and method.'), { code: 'INVALID_REQUEST' });
    }
    if (typeof body === 'string' && Buffer.byteLength(body) > (this.adapters.maxNetworkBodyBytes ?? 100_000)) {
      throw new Error('Network request body exceeds the configured limit.');
    }
    const headers = validateHeaders(operation.arguments.headers);
    const parsedUrl = new URL(url);
    const automaticRequest = context.mode === 'auto' && !context.approvalGranted;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.adapters.timeoutMs ?? 30_000);
    try {
      let pinnedAddress: string | undefined;
      if (automaticRequest) {
        if (method !== 'GET' || parsedUrl.protocol !== 'https:' || parsedUrl.search || parsedUrl.hash || (parsedUrl.port && parsedUrl.port !== '443')) {
          throw Object.assign(new Error('Automatic network access is restricted to public HTTPS GET requests without URL payloads.'), { code: 'NETWORK_POLICY' });
        }
        const lookup = (this.adapters.lookup ?? ((hostname) => resolveDns(hostname, { all: true, verbatim: true })))(parsedUrl.hostname);
        const addresses = await withAbort(lookup, controller.signal);
        if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
          throw Object.assign(new Error('Automatic network access cannot reach private or reserved IP addresses.'), { code: 'NETWORK_POLICY' });
        }
        pinnedAddress = addresses[0].address;
      }
      const maxOutputBytes = this.adapters.maxNetworkResponseBytes ?? this.adapters.maxOutputBytes ?? 1_000_000;
      if (automaticRequest && pinnedAddress) {
        return await (this.adapters.autoGet ?? requestPinnedHttps)(parsedUrl, pinnedAddress, controller.signal, maxOutputBytes, headers);
      }
      const response = await (this.adapters.fetch ?? fetch)(url, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : typeof body === 'string' ? body : undefined,
        redirect: context.mode === 'auto' ? 'manual' : 'follow',
        signal: controller.signal,
      });
      const text = await readBoundedResponseText(response, maxOutputBytes);
      const responseHeaders = allowlistedHeaders(Object.fromEntries(response.headers.entries()));
      return { status: response.status, ok: response.ok, headers: responseHeaders, body: text };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async runProcess(operation: HostCall, context: HostExecutionContext) {
    const command = stringArg(operation, 'command');
    const args = operation.arguments.args;
    const cwd = typeof operation.arguments.cwd === 'string'
      ? resolveHostPath(operation.arguments.cwd, context.workspaceRoot)
      : context.workspaceRoot;
    if (!command || !hasBoundedProcessArgs(args)) {
      throw Object.assign(new Error('Process operation must include a command and a bounded string argument list.'), { code: 'INVALID_REQUEST' });
    }
    if (isShellGuiLaunch(command, args)) {
      throw Object.assign(new Error('GUI applications must use process.launch, not process.run.'), { code: 'INVALID_PROCESS_ACTION' });
    }
    return this.adapters.runProcess
      ? this.adapters.runProcess(command, args, cwd, this.adapters.timeoutMs ?? 120_000, this.adapters.maxOutputBytes ?? 100_000)
      : runChild(command, args, cwd, this.adapters.timeoutMs ?? 120_000, this.adapters.maxOutputBytes ?? 100_000);
  }

  private async launchApplication(operation: HostCall, context: HostExecutionContext): Promise<{ started: boolean; pid: number | null }> {
    const request = launchRequest(operation, context.workspaceRoot);
    return this.adapters.launchApplication
      ? this.adapters.launchApplication(request.executable, request.args, request.cwd)
      : launchDetached(request.executable, request.args, request.cwd);
  }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(Object.assign(new Error('Network request timed out.'), { code: 'NETWORK_TIMEOUT' }));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(Object.assign(new Error('Network request timed out.'), { code: 'NETWORK_TIMEOUT' }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function launchRequest(operation: HostCall, workspaceRoot: string): { executable: string; args: string[]; cwd: string } {
  const executable = stringArg(operation, 'executable');
  const args = operation.arguments.args;
  const cwd = typeof operation.arguments.cwd === 'string'
    ? resolveHostPath(operation.arguments.cwd, workspaceRoot) : workspaceRoot;
  if (!executable || !path.win32.isAbsolute(executable) && !path.isAbsolute(executable)
    || path.win32.extname(executable).toLowerCase() !== '.exe'
    || operation.target !== executable || !Array.isArray(args) || args.length > 20
    || !args.every((item) => typeof item === 'string' && item.length <= 500)) {
    throw Object.assign(new Error('Application launch requires an absolute .exe path and a bounded string args array.'), { code: 'INVALID_REQUEST' });
  }
  return { executable, args, cwd };
}

function launchDetached(executable: string, args: string[], cwd: string): Promise<{ started: boolean; pid: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.removeListener('error', reject);
      child.unref();
      resolve({ started: true, pid: child.pid ?? null });
    });
  });
}

function requestPinnedHttps(
  url: URL,
  address: string,
  signal: AbortSignal,
  maxOutputBytes: number,
  headers: Record<string, string>,
): Promise<AutomaticGetResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: AutomaticGetResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result!);
    };
    const onAbort = () => request.destroy(new Error('Network request timed out.'));
    const request = httpsRequest({
      hostname: address,
      port: 443,
      path: `${url.pathname || '/'}${url.search}`,
      method: 'GET',
      headers: { ...headers, host: url.host },
      servername: url.hostname,
      rejectUnauthorized: true,
      agent: false,
    }, (response) => {
      response.on('data', (chunk: Buffer) => {
        totalBytes += chunk.byteLength;
        if (totalBytes > maxOutputBytes) {
          request.destroy(new Error('Network response exceeds the configured limit.'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => finish(undefined, {
        status: response.statusCode ?? 0,
        ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
        headers: allowlistedHeaders(response.headers),
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('error', (error) => finish(error));
    });
    request.on('error', (error) => finish(error));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    else request.end();
  });
}

function allowlistedHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const safe = new Set(['content-type', 'content-length', 'cache-control']);
  return Object.fromEntries(Object.entries(headers)
    .filter(([name, value]) => safe.has(name.toLowerCase()) && typeof value === 'string') as Array<[string, string]>);
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      totalBytes += item.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error('Network response exceeds the configured limit.');
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export function resolveHostPath(target: string, workspaceRoot: string): string {
  if (!target.trim()) throw new Error('Filesystem operation requires a path.');
  const api = path.win32.isAbsolute(target) || path.win32.isAbsolute(workspaceRoot) ? path.win32 : path;
  return api.isAbsolute(target) ? api.resolve(target) : api.resolve(workspaceRoot, target);
}

function assertStableFilesystemPath(targetPath: string, workspaceRoot: string): void {
  try {
    const current = canonicalizeFilesystemPath(targetPath, workspaceRoot);
    if (!samePathIdentity(current, targetPath)) throw new Error('The resolved target differs from the approved path.');
  } catch {
    throw Object.assign(new Error('Filesystem target changed or could not be safely resolved; the operation was not executed.'), { code: 'PATH_CHANGED' });
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

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function stringArg(operation: HostCall, key: string): string {
  const value = operation.arguments[key];
  return typeof value === 'string' ? value : '';
}

function validateHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Network headers must be an object.');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20 || entries.some(([key, item]) => key.length > 256 || typeof item !== 'string' || item.length > 4096)) {
    throw new Error('Network headers exceed the configured limits.');
  }
  return Object.fromEntries(entries as Array<[string, string]>);
}

function failed(callId: string, code: string, message: string): HostCallResult {
  return { callId, ok: false, error: { code, message } };
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'HOST_OPERATION_FAILED';
}

function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    const [a, b, c] = octets;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || b === 0 && c === 0)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
      || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')
      || normalized.startsWith('ff') || normalized.includes('::ffff:')) return false;
    const firstSegment = normalized.split(':')[0];
    const firstWord = Number.parseInt(firstSegment || '0', 16);
    return firstWord >= 0x2000 && firstWord <= 0x3fff;
  }
  return false;
}

function runChild(command: string, args: string[], cwd: string, timeoutMs: number, maxOutputBytes: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let overflow = false;
    let timedOut = false;
    let terminating = false;
    const stopTree = () => {
      if (terminating) return;
      terminating = true;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'],
          { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => child.kill());
        killer.once('close', () => child.kill());
      } else {
        child.kill();
      }
    };
    const timeout = setTimeout(() => { timedOut = true; stopTree(); }, timeoutMs);
    const collect = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.byteLength > maxOutputBytes) {
        overflow = true;
        stopTree();
        return;
      }
      if (target === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (exitCode) => {
      clearTimeout(timeout);
      if (overflow) return reject(new Error('Process output exceeded the configured limit.'));
      if (timedOut) return reject(new Error(`Process timed out after ${timeoutMs}ms.`));
      resolve({ exitCode, stdout, stderr });
    });
  });
}
