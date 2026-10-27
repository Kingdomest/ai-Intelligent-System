import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CapabilityPermission, OperationJournalRecord } from '../domain/contracts.js';
import type { HostCall, HostCallResult } from '../permissions/operation-protocol.js';
import type { TestAssertion, TestCaseResult, TestPlan, TestReport } from '../agents/test-agent.js';
import { SandboxRunner } from '../capabilities/sandbox-runner.js';
import { SqliteStore } from '../storage/sqlite-store.js';
import { WindowsDesktopObserver } from './windows-desktop-observer.js';
import { canonicalizeFilesystemPath } from '../permissions/policy.js';
import { isShellGuiLaunch } from '../permissions/process-contract.js';
import { presentationInputSchema, verifyPresentationFile } from '../presentations/render.js';

export class TestExecutor {
  constructor(private readonly sandbox: SandboxRunner) {}

  async runLive(
    store: SqliteStore, taskId: string, stepId: string, version: string,
    permissions: CapabilityPermission[], plan: Pick<TestPlan, 'cases'>,
    observer: WindowsDesktopObserver, expectedApplicationId?: string, expectedTarget?: string,
    minimumOperationSequence = 0,
  ): Promise<TestReport> {
    const operations = store.listStepOperations(taskId, stepId, version)
      .filter(record => Number(record.operationId.split(':').at(-1)) >= minimumOperationSequence);
    if (!operations.length) return summarize([liveResult('host-operation', 'blocked', ['NO_HOST_OPERATION'])], 'live_observation');
    const cases: TestCaseResult[] = [];
    for (const operation of operations) {
      const codes: string[] = [];
      const needsTarget = operation.operation.permission === 'filesystem.write';
      const targetMissing = needsTarget && (!expectedTarget?.trim()
        || (!path.isAbsolute(expectedTarget) && !path.win32.isAbsolute(expectedTarget)));
      if (targetMissing) codes.push('TARGET_NOT_SPECIFIED');
      if (!permissions.includes(operation.operation.permission)) codes.push('UNDECLARED_HOST_PERMISSION');
      if (operation.state !== 'completed') {
        cases.push(liveResult('host-operation', 'blocked', ['HOST_OPERATION_UNCERTAIN']));
        continue;
      }
      const result = operation.result as HostCallResult | undefined;
      if (result?.ok !== true) codes.push('HOST_OPERATION_FAILED');
      if (expectedTarget && (operation.operation.permission === 'filesystem.read'
        || operation.operation.permission === 'filesystem.write')
        && !sameTarget(operation.operation.target, expectedTarget)) codes.push('TARGET_MISMATCH');
      if (result?.ok === true && operation.operation.permission === 'filesystem.write') {
        const matches = await verifyFilesystemEffect(operation);
        if (!matches) codes.push('FILESYSTEM_EFFECT_MISSING');
      }
      if (result?.ok === true && operation.operation.permission === 'network') {
        const response = result.value && typeof result.value === 'object' ? result.value as Record<string, unknown> : {};
        if (response.ok !== true || typeof response.status !== 'number' || response.status < 200 || response.status >= 300) {
          codes.push('HTTP_RESPONSE_FAILED');
        }
      }
      if (result?.ok === true && operation.operation.permission === 'location') {
        const location = result.value && typeof result.value === 'object' ? result.value as Record<string, unknown> : {};
        if (location.supported !== true) {
          cases.push(liveResult('host-operation', 'blocked', ['LOCATION_UNAVAILABLE']));
          continue;
        }
        if (typeof location.latitude !== 'number' || !Number.isFinite(location.latitude) || Math.abs(location.latitude) > 90
          || typeof location.longitude !== 'number' || !Number.isFinite(location.longitude) || Math.abs(location.longitude) > 180) {
          codes.push('INVALID_LOCATION');
        }
      }
      if (result?.ok === true && operation.operation.permission === 'process') {
        const value = result.value && typeof result.value === 'object' ? result.value as Record<string, unknown> : {};
        if (operation.operation.action === 'launch') {
          if (value.started !== true || value.pid !== null && (typeof value.pid !== 'number' || value.pid <= 0)) {
            codes.push('PROCESS_LAUNCH_FAILED');
          }
        } else if (value.exitCode !== 0) {
          codes.push('PROCESS_EXIT_FAILED');
        }
      }
      cases.push(liveResult('host-operation', codes.length
        ? targetMissing && codes.length === 1 ? 'blocked' : 'failed' : 'passed', codes));
    }

    if (operations.some((item) => item.operation.permission === 'process'
      && (item.operation.action === 'launch' || !!expectedApplicationId))) {
      const desktopAssertions = plan.cases.flatMap((item) => item.mode === 'live_observation' ? item.assertions : [])
        .filter((assertion): assertion is Extract<TestAssertion, { applicationId: string }> => 'applicationId' in assertion);
      const types = new Set<string>(desktopAssertions.map((assertion) => assertion.type));
      const identities = [...new Set(desktopAssertions.map((assertion) => assertion.applicationId))];
      if (identities.length !== 1 || !['process_running', 'window_visible', 'foreground_window'].every((type) => types.has(type))) {
        cases.push(liveResult('desktop', 'blocked', ['DESKTOP_ASSERTIONS_INCOMPLETE']));
      } else if (!expectedApplicationId || identities[0]?.toLowerCase() !== expectedApplicationId.toLowerCase()
        || !operations.some((item) => item.operation.permission === 'process'
          && processTargetsApplication(item, expectedApplicationId))) {
        cases.push(liveResult('desktop', 'blocked', ['APPLICATION_ID_NOT_BOUND_TO_OPERATION']));
      } else {
        const authorized = operations.some((item) => item.operation.permission === 'process' && item.state === 'completed'
          && (item.result as HostCallResult | undefined)?.ok === true);
        const observation = await observer.observe(identities[0]!, authorized);
        cases.push(liveResult('desktop', observation.status, observation.codes));
      }
    }
    return summarize(cases, 'live_observation');
  }

  async runSandbox(code: string, plan: TestPlan, defaultInput: Record<string, unknown>): Promise<TestReport> {
    const cases: TestCaseResult[] = [];
    for (const item of plan.cases.filter((value) => value.mode === 'sandbox')) {
      const calls: HostCall[] = [];
      const codes: string[] = [];
      // A rejected host call is contract evidence (the tool must not execute
      // invalid requests), not a case failure by itself.
      const hostFaults: string[] = [];
      let output: unknown;
      let executionFailed = false;
      try {
        const result = await this.sandbox.run(code, { ...defaultInput, ...item.input }, {
          mode: 'dry-run',
          hostCall: async (call) => {
            calls.push(call);
            const fault = validateCall(call);
            if (fault) {
              // When the case expects an execution error, a rejected host call
              // is the expected evidence; otherwise a rejected request must
              // fail the case so tools cannot swallow malformed requests.
              if (item.assertions.some((assertion) => assertion.type === 'execution_error')) hostFaults.push(fault);
              else codes.push(fault);
              return failed(call, fault);
            }
            if (item.hostBehavior === 'failure') return failed(call, 'SIMULATED_HOST_FAILURE');
            return simulatedSuccess(call);
          },
        });
        output = result.output;
      } catch (error) {
        executionFailed = true;
        if (item.hostBehavior === 'failure'
          && (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'SIMULATED_HOST_FAILURE')) {
          codes.push('UNRELATED_EXECUTION_ERROR');
        }
        if (item.hostBehavior !== 'failure' && !item.assertions.some((assertion) => assertion.type === 'execution_error')) codes.push('EXECUTION_ERROR');
      }
      for (const assertion of item.assertions) {
        if (assertion.type === 'host_call') {
          if (!calls.some((call) => call.permission === assertion.permission && call.action === assertion.action
            && (assertion.target === undefined || call.target === assertion.target))) codes.push('HOST_CONTRACT_MISMATCH');
        } else if (assertion.type === 'output_equals') {
          if (!sameJson(readPath(output, assertion.path), assertion.value)) codes.push('OUTPUT_MISMATCH');
        } else if (assertion.type === 'output_contains') {
          if (!String(readPath(output, assertion.path) ?? '').includes(assertion.text)) codes.push('OUTPUT_TEXT_MISSING');
        } else if (assertion.type === 'execution_error') {
          if (!executionFailed) codes.push('EXPECTED_ERROR_MISSING');
        } else if (assertion.type === 'no_host_call') {
          if (calls.length > 0) codes.push('UNEXPECTED_HOST_CALL');
        }
      }
      const expectedCalls = item.assertions.filter((assertion): assertion is Extract<TestAssertion, { type: 'host_call' }> => assertion.type === 'host_call');
      if (calls.some((call) => !expectedCalls.some((assertion) => assertion.permission === call.permission && assertion.action === call.action))) {
        codes.push('UNEXPECTED_HOST_CALL');
      }
      if (item.hostBehavior === 'failure') {
        if (calls.length === 0) codes.push('HOST_FAILURE_NOT_EXERCISED');
        if (!executionFailed && claimsSuccess(output)) codes.push('FALSE_SUCCESS');
      }
      const uniqueCodes = [...new Set(codes)];
      const passed = uniqueCodes.length === 0;
      const evidence = passed
        ? [...hostFaults.map((value) => ({ kind: 'assertion', code: value })),
          { kind: 'sandbox', code: calls.length ? 'HOST_CALL_CONTRACT_CONFIRMED' : 'OUTPUT_ASSERTIONS_CONFIRMED' }]
        : uniqueCodes.map((value) => ({ kind: 'assertion', code: value }));
      cases.push({ id: item.id, mode: 'sandbox', status: passed ? 'passed' : 'failed', codes: uniqueCodes, evidence });
    }
    if (cases.length === 0) cases.push({ id: 'sandbox-required', mode: 'sandbox', status: 'blocked', codes: ['NO_SANDBOX_CASES'], evidence: [] });
    return summarize(cases, 'sandbox');
  }
}

function sameTarget(actual: string, expected: string): boolean {
  try {
    const windows = process.platform === 'win32' || path.win32.isAbsolute(actual) || path.win32.isAbsolute(expected);
    const api = windows ? path.win32 : path;
    const left = api.normalize(actual);
    const right = api.normalize(canonicalizeFilesystemPath(expected, api.dirname(expected)));
    return windows ? left.toLowerCase() === right.toLowerCase() : left === right;
  } catch {
    return false;
  }
}

function processTargetsApplication(record: OperationJournalRecord, applicationId: string): boolean {
  const name = applicationId.toLowerCase().replace(/\.exe$/, '');
  const arguments_ = record.operation.arguments;
  if (record.operation.action === 'launch') {
    const executable = typeof arguments_.executable === 'string' ? arguments_.executable : '';
    return executable === record.operation.target
      && (executable.split(/[\\/]/).at(-1)?.toLowerCase().replace(/\.exe$/, '') ?? '') === name;
  }
  const command = typeof arguments_.command === 'string' ? arguments_.command : '';
  const filename = command.split(/[\\/]/).at(-1)?.toLowerCase().replace(/\.exe$/, '') ?? '';
  if (filename === name) return true;
  if (!['cmd', 'powershell', 'pwsh'].includes(filename)) return false;
  const args = Array.isArray(arguments_.args) ? arguments_.args : [];
  return args.some((arg) => typeof arg === 'string'
    && arg.replace(/^['"]|['"]$/g, '').split(/[\\/]/).at(-1)?.toLowerCase().replace(/\.exe$/, '') === name);
}

function liveResult(id: string, status: TestCaseResult['status'], codes: string[]): TestCaseResult {
  return { id, mode: 'live_observation', status, codes,
    evidence: status === 'passed'
      ? [{ kind: id === 'desktop' ? 'desktop' : 'journal',
        code: id === 'desktop' ? 'FOREGROUND_WINDOW_CONFIRMED' : 'AUTHORIZED_OPERATION_COMPLETED' }]
      : codes.map((code) => ({ kind: 'assertion', code })) };
}

async function verifyFilesystemEffect(record: OperationJournalRecord): Promise<boolean> {
  try {
    const path = record.operation.target;
    if (record.operation.action === 'remove') {
      try { await stat(path); return false; } catch (error) {
        return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
      }
    }
    const details = await stat(path);
    if (record.operation.action === 'mkdir') return details.isDirectory();
    if (record.operation.action === 'createPresentation') {
      const parsed = presentationInputSchema.safeParse(record.operation.arguments);
      const output = (record.result as HostCallResult | undefined)?.value as { sha256?: string } | undefined;
      return parsed.success && typeof output?.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(output.sha256)
        && await verifyPresentationFile(path, parsed.data, output.sha256);
    }
    if (record.operation.action === 'writeText') {
      const content = record.operation.arguments.content;
      if (!details.isFile() || typeof content !== 'string' || details.size !== Buffer.byteLength(content)) return false;
      return await readFile(path, 'utf8') === content;
    }
    return false;
  } catch {
    return false;
  }
}

export function summarize(cases: TestCaseResult[], mode: TestReport['mode']): TestReport {
  const failed = cases.filter((item) => item.status === 'failed').length;
  const blocked = cases.filter((item) => item.status === 'blocked').length;
  return {
    cases,
    passed: cases.filter((item) => item.status === 'passed').length,
    failed, blocked, mode,
    reason: cases.find((item) => item.status !== 'passed')?.codes.join(', '),
  };
}

export function reportForEvent(report: TestReport): {
  mode: TestReport['mode']; passed: number; failed: number; blocked: number; reason: string | null;
  cases: Array<{ id: string; status: TestCaseResult['status']; codes: string[]; evidence: Array<{ kind: string; code: string }> }>;
} {
  const cases = report.cases.map((item, index) => ({
    id: `case-${index + 1}`, status: item.status,
    codes: item.codes.filter((code) => /^[A-Z][A-Z0-9_]{1,80}$/.test(code)),
    evidence: item.evidence.filter((entry) => ['sandbox', 'journal', 'desktop', 'assertion'].includes(entry.kind)
      && /^[A-Z][A-Z0-9_]{1,80}$/.test(entry.code)),
  }));
  return {
    mode: report.mode, passed: report.passed, failed: report.failed, blocked: report.blocked,
    reason: cases.find((item) => item.status !== 'passed')?.codes.join(', ') || null,
    cases,
  };
}

function failed(call: HostCall, code: string): HostCallResult {
  return { callId: call.callId, ok: false, error: { code, message: code } };
}

function validateCall(call: HostCall): string | undefined {
  if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) return 'INVALID_HOST_CALL';
  if (typeof call.target !== 'string' || !call.target.trim()) return 'INVALID_HOST_CALL';
  if (call.permission === 'process') {
    const { args } = call.arguments;
    const command = call.action === 'launch' ? call.arguments.executable : call.arguments.command;
    if (typeof command !== 'string' || !command.trim() || !Array.isArray(args)
      || args.length > 100 || !args.every((item) => typeof item === 'string')) return 'INVALID_HOST_CALL';
    if (call.action === 'run' && isShellGuiLaunch(command, args)) return 'INVALID_PROCESS_ACTION';
  }
  if ((call.permission === 'filesystem.read' || call.permission === 'filesystem.write')
    && (typeof call.arguments.path !== 'string' || !call.arguments.path.trim())) return 'INVALID_HOST_CALL';
  if (call.action === 'createPresentation' && !presentationInputSchema.safeParse(call.arguments).success) return 'INVALID_PRESENTATION';
  if (call.permission === 'network' && !/^https?:\/\//i.test(call.target)) return 'INVALID_HOST_CALL';
  return undefined;
}

function simulatedSuccess(call: HostCall): HostCallResult {
  const path = String(call.arguments.path ?? call.target);
  if (call.permission === 'filesystem.write' && call.action === 'mkdir') return { callId: call.callId, ok: true, value: { path, created: true } };
  if (call.permission === 'filesystem.write' && call.action === 'remove') return { callId: call.callId, ok: true, value: { path, removed: true } };
  if (call.permission === 'filesystem.write' && call.action === 'createPresentation') {
    const input = presentationInputSchema.parse(call.arguments);
    return { callId: call.callId, ok: true, value: { path, slideCount: input.slides.length,
      bytesWritten: 0, sha256: 'dry-run-not-a-real-file' } };
  }
  if (call.permission === 'filesystem.write') return { callId: call.callId, ok: true, value: { path, bytesWritten: Buffer.byteLength(String(call.arguments.content ?? '')) } };
  if (call.permission === 'filesystem.read') return { callId: call.callId, ok: true, value: '[simulated contents]' };
  if (call.permission === 'process') return { callId: call.callId, ok: true,
    value: call.action === 'launch' ? { started: true, pid: 1234 } : { exitCode: 0, stdout: '', stderr: '' } };
  if (call.permission === 'network') return { callId: call.callId, ok: true, value: { status: 200, body: '' } };
  if (call.permission === 'location') return { callId: call.callId, ok: true, value: { supported: false, reason: 'No provider configured.' } };
  return failed(call, 'INVALID_HOST_CALL');
}

function readPath(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split('.').reduce<unknown>((current, key) => current && typeof current === 'object'
    ? (current as Record<string, unknown>)[key] : undefined, value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function claimsSuccess(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const object = value as Record<string, unknown>;
  return object.success === true || object.ok === true || object.created === true || object.removed === true
    || typeof object.bytesWritten === 'number' || object.exitCode === 0;
}
