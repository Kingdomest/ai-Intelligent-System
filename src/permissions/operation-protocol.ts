import type { CapabilityPermission, PermissionMode } from '../domain/contracts.js';

export interface HostCall {
  callId: string;
  permission: CapabilityPermission;
  action: string;
  target: string;
  reason: string;
  arguments: Record<string, unknown>;
}

export interface HostCallResult {
  callId: string;
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string };
}

export interface HostExecutionContext {
  taskId: string;
  mode: PermissionMode;
  workspaceRoot: string;
  capabilityPermissions: CapabilityPermission[];
  capabilityVersion: string;
  stepId: string;
  operationSequence: number;
  dryRun: boolean;
  approvalGranted?: boolean;
}

export interface HostOperationExecutor {
  execute(operation: HostCall, context: HostExecutionContext): Promise<HostCallResult>;
}

export interface CapabilityHost {
  fs: {
    readText(path: string): Promise<string>;
    writeText(path: string, content: string): Promise<{ path: string; bytesWritten: number }>;
    mkdir(path: string): Promise<{ path: string; created: boolean }>;
    remove(path: string): Promise<{ path: string; removed: boolean }>;
  };
  presentation: {
    create(input: { path: string; slides: Array<{ title: string; bullets: string[] }> }): Promise<{
      path: string; bytesWritten: number; slideCount: number; sha256: string;
    }>;
  };
  network: {
    request(request: { url: string; method: string; headers?: Record<string, string>; body?: string }): Promise<unknown>;
  };
  process: {
    run(request: { command: string; args: string[]; cwd?: string }): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
    launch(request: { executable: string; args: string[]; cwd?: string }): Promise<{ started: boolean; pid: number | null }>;
  };
  location: { current(): Promise<{ supported: false; reason: string } | { supported: true; latitude: number; longitude: number }> };
  mcp: { call(server: string, tool: string, args: Record<string, unknown>): Promise<unknown> };
}

export type HostCallHandler = (call: HostCall) => Promise<HostCallResult>;

export function createCapabilityHost(call: HostCallHandler): Readonly<CapabilityHost> {
  let nextId = 0;
  const invoke = async (
    permission: CapabilityPermission,
    action: string,
    target: string,
    reason: string,
    arguments_: Record<string, unknown>,
  ): Promise<unknown> => {
    const callId = `host-${++nextId}`;
    const result = await call({ callId, permission, action, target, reason, arguments: arguments_ });
    if (!result.ok) throw new Error(result.error?.message ?? 'Host operation failed.');
    return result.value;
  };

  return Object.freeze({
    fs: Object.freeze({
      readText: (path: string) => invoke('filesystem.read', 'readText', path, 'Read text requested by the task.', { path }) as Promise<string>,
      writeText: (path: string, content: string) => invoke('filesystem.write', 'writeText', path, 'Write task output to this file.', { path, content }) as Promise<{ path: string; bytesWritten: number }>,
      mkdir: (path: string) => invoke('filesystem.write', 'mkdir', path, 'Create the requested directory.', { path }) as Promise<{ path: string; created: boolean }>,
      remove: (path: string) => invoke('filesystem.write', 'remove', path, 'Remove the requested file or directory.', { path }) as Promise<{ path: string; removed: boolean }>,
    }),
    presentation: Object.freeze({
      create: (input: { path: string; slides: Array<{ title: string; bullets: string[] }> }) => {
        if (!input || typeof input.path !== 'string' || !input.path.trim()
          || !Array.isArray(input.slides) || !input.slides.length) throw new Error('Invalid presentation input.');
        return invoke('filesystem.write', 'createPresentation', input.path,
          'Create a PowerPoint file without replacing an existing file.', input,
        ) as Promise<{ path: string; bytesWritten: number; slideCount: number; sha256: string }>;
      },
    }),
    network: Object.freeze({
      request: (request: { url: string; method: string; headers?: Record<string, string>; body?: string }) => invoke(
        'network', 'request', request.url, `Make an outbound ${request.method.toUpperCase()} request.`, request as unknown as Record<string, unknown>,
      ),
    }),
    process: Object.freeze({
      run: (request: { command: string; args: string[]; cwd?: string }) => invoke(
        'process', 'run', request.command, 'Run the requested process with explicit arguments.', request as unknown as Record<string, unknown>,
      ) as Promise<{ exitCode: number | null; stdout: string; stderr: string }>,
      launch: (request: { executable: string; args: string[]; cwd?: string }) => invoke(
        'process', 'launch', request.executable, 'Launch the exact approved application.', request as unknown as Record<string, unknown>,
      ) as Promise<{ started: boolean; pid: number | null }>,
    }),
    location: Object.freeze({
      current: () => invoke('location', 'current', 'device location', 'Retrieve the current device location.', {}) as Promise<{ supported: false; reason: string } | { supported: true; latitude: number; longitude: number }>,
    }),
    mcp: Object.freeze({
      call: (server: string, tool: string, args: Record<string, unknown>) => invoke('mcp', 'call', `${server}/${tool}`,
        `Call the configured MCP tool ${server}/${tool}.`, { server, tool, arguments: args }),
    }),
  });
}
