import { describe, expect, it } from 'vitest';
import { SandboxRunner } from '../../src/capabilities/sandbox-runner.js';
import { TestExecutor } from '../../src/runtime/test-executor.js';
import type { TestPlan } from '../../src/agents/test-agent.js';

const executor = new TestExecutor(new SandboxRunner());

describe('declarative sandbox test executor', () => {
  it('accepts a well-shaped GUI launch request without requiring a short-command exit code', async () => {
    const plan: TestPlan = { cases: [{ id: 'launch', mode: 'sandbox', input: { executable: 'C:\\Apps\\cloudmusic.exe', args: [] },
      hostBehavior: 'success', assertions: [
        { type: 'host_call', permission: 'process', action: 'launch', target: 'C:\\Apps\\cloudmusic.exe' },
        { type: 'output_equals', path: 'started', value: true },
      ] }] };
    const report = await executor.runSandbox('export async function run(input, host) { return host.process.launch({ executable: input.executable, args: input.args }); }', plan, {});
    expect(report).toMatchObject({ passed: 1, failed: 0, blocked: 0 });
  });

  it('checks the actual host-call target and output without local side effects', async () => {
    const plan: TestPlan = { cases: [{ id: 'normal', mode: 'sandbox', input: { path: 'C:/requested' }, hostBehavior: 'success', assertions: [
      { type: 'host_call', permission: 'filesystem.write', action: 'mkdir', target: 'C:/requested' },
      { type: 'output_equals', path: 'created', value: true },
    ] }] };
    const report = await executor.runSandbox('export async function run(input, host) { return host.fs.mkdir(input.path); }', plan, {});
    expect(report).toMatchObject({ passed: 1, failed: 0, blocked: 0 });
    expect(report.cases[0]?.evidence).toContainEqual({ kind: 'sandbox', code: 'HOST_CALL_CONTRACT_CONFIRMED' });
    expect(JSON.stringify(report)).not.toContain('C:/requested');
  });

  it('fails a tool that catches a host failure and falsely reports success', async () => {
    const plan: TestPlan = { cases: [{ id: 'host-fails', mode: 'sandbox', input: { path: 'C:/requested' }, hostBehavior: 'failure', assertions: [
      { type: 'host_call', permission: 'filesystem.write', action: 'mkdir' },
    ] }] };
    const report = await executor.runSandbox('export async function run(input, host) { try { await host.fs.mkdir(input.path); } catch {} return { success: true }; }', plan, {});
    expect(report.failed).toBe(1);
    expect(report.cases[0]?.codes).toContain('FALSE_SUCCESS');
  });

  it('does not treat a caught malformed process request as a pass', async () => {
    const plan: TestPlan = { cases: [{ id: 'process', mode: 'sandbox', input: {}, assertions: [
      { type: 'host_call', permission: 'process', action: 'run' },
    ] }] };
    const report = await executor.runSandbox("export async function run(input, host) { try { await host.process.run('cmd.exe'); } catch {} return { success: true }; }", plan, {});
    expect(report.failed).toBe(1);
  });

  it('can assert missing-input rejection and a boundary output', async () => {
    const plan: TestPlan = { cases: [
      { id: 'missing', mode: 'sandbox', input: { value: null }, assertions: [{ type: 'execution_error' }, { type: 'no_host_call' }] },
      { id: 'boundary', mode: 'sandbox', input: { value: '' }, assertions: [{ type: 'output_equals', path: 'length', value: 0 }] },
    ] };
    const report = await executor.runSandbox('export async function run(input) { if (input.value === null) throw new Error("missing"); return { length: input.value.length }; }', plan, {});
    expect(report).toMatchObject({ passed: 2, failed: 0, blocked: 0 });
  });

  it('does not credit an unrelated crash as proper host-failure handling', async () => {
    const plan: TestPlan = { cases: [{ id: 'host-fails', mode: 'sandbox', input: { path: 'C:/requested' }, hostBehavior: 'failure',
      assertions: [{ type: 'host_call', permission: 'filesystem.write', action: 'mkdir' }] }] };
    const report = await executor.runSandbox('export async function run(input, host) { try { await host.fs.mkdir(input.path); } catch {} throw new Error("unrelated crash"); }', plan, {});
    expect(report.failed).toBe(1);
    expect(report.cases[0]?.codes).toContain('UNRELATED_EXECUTION_ERROR');
  });
});
