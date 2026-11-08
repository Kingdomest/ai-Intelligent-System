import type { ToolCandidate } from '../agents/agent-runner.js';
import type { CapabilityPermission } from '../domain/contracts.js';
import type { HostCall, HostCallResult } from '../permissions/operation-protocol.js';
import type { SandboxRunner } from './sandbox-runner.js';

export interface GenericityReport {
  passed: boolean;
  reason: string;
  hostCalls: Array<{ permission: string; action: string; target: string }>;
}

export function deriveGenericityFixtures(input: Record<string, unknown>): [Record<string, unknown>, Record<string, unknown>] | null {
  for (const key of variantKeys(input)) {
    const value = input[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    let alternate = `${value}-jarvis-probe`;
    if (key === 'url') {
      try {
        const url = new URL(value);
        url.hostname = 'jarvis-probe.invalid';
        alternate = url.toString();
      } catch { return null; }
    } else if (key === 'content') {
      alternate = `${value}\njarvis-probe`;
    }
    return [input, { ...input, [key]: alternate }];
  }
  return null;
}

export async function verifyGenericity(
  candidate: ToolCandidate,
  fixtures: [Record<string, unknown>, Record<string, unknown>],
  sandbox: SandboxRunner,
): Promise<GenericityReport> {
  const variant = findVariant(fixtures);
  if (!variant) return { passed: false, reason: 'Two distinct input targets are required.', hostCalls: [] };
  const observations: Array<{ output: unknown; calls: HostCall[] }> = [];
  for (const fixture of fixtures) {
    const calls: HostCall[] = [];
    try {
      const run = await sandbox.run(candidate.code, fixture, { mode: 'dry-run', hostCall: async (call) => {
        calls.push(call);
        const fault = validateCall(call, candidate.permissions);
        return fault ? { callId: call.callId, ok: false, error: { code: fault, message: fault } } : simulatedResult(call);
      } });
      if (calls.some((call) => validateCall(call, candidate.permissions))) {
        return report(false, 'Invalid host call contract.', calls);
      }
      observations.push({ output: run.output, calls });
    } catch {
      return report(false, 'Candidate failed on one of the two valid inputs.', calls);
    }
  }
  const [first, second] = observations;
  const allCalls = [...first.calls, ...second.calls];
  if (candidate.permissions.length === 0) {
    return report(JSON.stringify(first.output) !== JSON.stringify(second.output),
      'Pure computation must produce distinguishable asserted outputs for distinct inputs.', allCalls);
  }
  if (!first.calls.length || first.calls.length !== second.calls.length) {
    return report(false, 'Both inputs must make the same number of typed host calls.', allCalls);
  }
  for (let index = 0; index < first.calls.length; index += 1) {
    const left = first.calls[index]!;
    const right = second.calls[index]!;
    if (left.permission !== right.permission || left.action !== right.action) {
      return report(false, 'Host permission/action shape changed across inputs.', allCalls);
    }
    if (left.target === right.target) {
      return report(false, 'Host call ignored the changed target.', allCalls);
    }
    if (!left.target.includes(variant.first) || !right.target.includes(variant.second)) {
      return report(false, 'Host calls were not bound to both supplied targets.', allCalls);
    }
  }
  const failureCalls: HostCall[] = [];
  try {
    const failedRun = await sandbox.run(candidate.code, fixtures[0], { mode: 'dry-run', hostCall: async (call) => {
      failureCalls.push(call);
      return { callId: call.callId, ok: false, error: { code: 'SIMULATED_HOST_FAILURE', message: 'SIMULATED_HOST_FAILURE' } };
    } });
    if (!failureCalls.length || claimsSuccess(failedRun.output)) {
      return report(false, 'Candidate hid a host failure or falsely claimed success.', allCalls);
    }
  } catch {
    if (!failureCalls.length) return report(false, 'Failure simulation made no host call.', allCalls);
  }
  return report(true, 'Two targets and host failure propagation verified in sandbox.', allCalls);
}

function findVariant(fixtures: [Record<string, unknown>, Record<string, unknown>]): { first: string; second: string } | null {
  for (const key of variantKeys(fixtures[0])) {
    const first = fixtures[0][key];
    const second = fixtures[1][key];
    if (typeof first === 'string' && typeof second === 'string' && first.length > 0 && second.length > 0 && first !== second) {
      return { first, second };
    }
  }
  return null;
}

function variantKeys(input: Record<string, unknown>): string[] {
  const preferred = ['path', 'applicationName', 'executable', 'command', 'url'];
  const contextFields = new Set(['message', 'attachments', 'workspaceRoot', 'desktopDirectory', 'content']);
  return [...preferred, ...Object.keys(input).filter((key) => !preferred.includes(key) && !contextFields.has(key)), 'content'];
}

function validateCall(call: HostCall, permissions: readonly CapabilityPermission[]): string | null {
  if (call.permission === 'mcp') return 'GENERATED_MCP_CALL_FORBIDDEN';
  if (!permissions.includes(call.permission)) return 'UNDECLARED_PERMISSION';
  if (!call.target?.trim() || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) return 'INVALID_HOST_CALL';
  if (call.permission === 'filesystem.read' || call.permission === 'filesystem.write') {
    if (typeof call.arguments.path !== 'string' || !call.arguments.path.trim()
      || call.arguments.path !== call.target) return 'INVALID_PATH';
  }
  if (call.permission === 'network') {
    if (call.arguments.url !== call.target) return 'INVALID_NETWORK_REQUEST';
  }
  if (call.permission === 'process') {
    const args = call.arguments.args;
    const command = call.action === 'launch' ? call.arguments.executable : call.arguments.command;
    if (typeof command !== 'string' || !command.trim() || command !== call.target
      || !Array.isArray(args) || args.length > 100
      || !args.every((item) => typeof item === 'string')) return 'INVALID_PROCESS_REQUEST';
  }
  return null;
}

function simulatedResult(call: HostCall): HostCallResult {
  const path = call.arguments.path;
  const value = call.action === 'mkdir' ? { path, created: true }
    : call.action === 'remove' ? { path, removed: true }
      : call.action === 'writeText' ? { path, bytesWritten: String(call.arguments.content ?? '').length }
        : call.action === 'launch' ? { started: true, pid: 1234 }
          : call.permission === 'process' ? { exitCode: 0, stdout: '', stderr: '' }
            : call.permission === 'network' ? { status: 200, ok: true, body: '' }
              : call.permission === 'filesystem.read' ? '[test contents]' : { supported: true, latitude: 0, longitude: 0 };
  return { callId: call.callId, ok: true, value };
}

function claimsSuccess(output: unknown): boolean {
  if (!output || typeof output !== 'object') return false;
  const value = output as Record<string, unknown>;
  return value.success === true || value.ok === true || value.created === true || value.started === true
    || value.exitCode === 0 || typeof value.bytesWritten === 'number';
}

function report(passed: boolean, reason: string, calls: HostCall[]): GenericityReport {
  return { passed, reason, hostCalls: calls.map((call) => ({ permission: call.permission, action: call.action, target: call.target })) };
}
