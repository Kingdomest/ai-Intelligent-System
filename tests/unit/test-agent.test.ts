import { describe, expect, it } from 'vitest';
import { parseTestPlan } from '../../src/agents/test-agent.js';
import { TestAgent } from '../../src/agents/test-agent.js';
import { ModelGateway } from '../../src/model/gateway.js';
import { MockModelProvider } from '../../src/model/mock-provider.js';
import type { ModelRequest } from '../../src/model/gateway.js';
import { getBuiltin } from '../../src/capabilities/builtin-catalog.js';
import { SandboxRunner } from '../../src/capabilities/sandbox-runner.js';
import { TestExecutor } from '../../src/runtime/test-executor.js';

const base = {
  cases: [{ id: 'normal', mode: 'sandbox', input: { path: 'C:/safe' }, hostBehavior: 'success',
    assertions: [{ type: 'host_call', permission: 'filesystem.write', action: 'mkdir', target: 'C:/safe' }] }],
};

describe('test plan contract', () => {
  it('rejects an answer that omits a required verified step before model review', async () => {
    const agent = new TestAgent(new ModelGateway({ complete: async () => {
      throw new Error('Deterministic answer coverage must veto first.');
    } }));
    const result = await agent.reviewAnswer('task-1', { answer: '总结完成', criteria: ['Summarize the file'],
      verifiedStepIds: [], requiredStepIds: ['read-file'] });
    expect(result.verdict).toBe('blocked');
  });

  it('rejects an empty answer without allowing model pass', async () => {
    const agent = new TestAgent(new ModelGateway(new MockModelProvider()));
    const result = await agent.reviewAnswer('task-1', { answer: '   ', criteria: [],
      verifiedStepIds: [], requiredStepIds: [] });
    expect(result.verdict).toBe('fail');
  });

  it('forwards the casual-chat flag so greeting answers are not failed for structure', async () => {
    const seen: ModelRequest[] = [];
    const agent = new TestAgent(new ModelGateway({ complete: async request => {
      seen.push(request);
      return { data: { verdict: 'pass', reason: 'ok' }, usage: { inputTokens: 0, outputTokens: 0 } };
    } }));
    const result = await agent.reviewAnswer('task-1', { answer: '你好小明！很高兴认识你。', criteria: [],
      verifiedStepIds: [], requiredStepIds: [], isCasualChat: true });
    expect(result.verdict).toBe('pass');
    expect(seen[0]!.system).toContain('isCasualChat is true the user request is greeting or small talk');
    expect(seen[0]!.system).toContain('criteria is empty and requiredStepIds is empty');
    expect(seen[0]!.system).toContain('Never invent criteria of your own');
    expect(JSON.parse(seen[0]!.user).isCasualChat).toBe(true);
  });

  it('checks the maintained file reader at two paths and propagates host failure without consulting the model', async () => {
    const agent = new TestAgent(new ModelGateway({ complete: async () => {
      throw new Error('Maintained file-read contract must be deterministic.');
    } }));
    const input = { path: 'C:/Documents/first.md' };
    const plan = await agent.generate('read-file', { name: 'filesystem.read_text', permissions: ['filesystem.read'],
      executionInput: input, acceptanceCriteria: ['Read and summarize the file'] });
    const executor = new TestExecutor(new SandboxRunner());
    const valid = await executor.runSandbox(getBuiltin('filesystem.read_text')!.code, plan, input);
    expect(valid.failed).toBe(0);
    expect(valid.passed).toBe(3);
    const hardcoded = await executor.runSandbox(
      'export async function run(input, host) { return { content: await host.fs.readText("C:/Documents/first.md") }; }', plan, input);
    expect(hardcoded.failed).toBeGreaterThan(0);
    const swallowsFailure = await executor.runSandbox(
      'export async function run(input, host) { try { return { content: await host.fs.readText(input.path) }; } catch { return { content: "fake" }; } }', plan, input);
    expect(swallowsFailure.failed).toBeGreaterThan(0);
  });

  it.each([
    { name: 'filesystem.write_text', permissions: ['filesystem.write'], executionInput: { path: 'C:/demo/out.txt', content: '内容' } },
    { name: 'filesystem.mkdir', permissions: ['filesystem.write'], executionInput: { path: 'D:\\demo' } },
    { name: 'filesystem.remove', permissions: ['filesystem.write'], executionInput: { path: 'D:\\demo\\old.txt' } },
    { name: 'process.run', permissions: ['process'], executionInput: { command: 'node', args: ['--version'] } },
    { name: 'process.launch', permissions: ['process'], executionInput: { executable: 'C:/Apps/app.exe', args: [], workspaceRoot: 'C:/w' } },
    { name: 'location.current', permissions: ['location'], executionInput: {} },
    { name: 'text.count_lines', permissions: [], executionInput: { text: 'first\nsecond' } },
    { name: 'text.replace', permissions: [], executionInput: { text: 'one two one', search: 'one', replacement: 'three' } },
    { name: 'json.format', permissions: [], executionInput: { text: '{"a":1}' } },
  ])('ships a deterministic sandbox plan for the $name builtin that passes against the maintained code', async item => {
    const agent = new TestAgent(new ModelGateway({ complete: async () => {
      throw new Error('Maintained builtins must never depend on model-generated test plans.');
    } }));
    const plan = await agent.generate('plan-task', { name: item.name,
      permissions: item.permissions as import('../../src/domain/contracts.js').CapabilityPermission[],
      executionInput: item.executionInput, acceptanceCriteria: [] });
    const executor = new TestExecutor(new SandboxRunner());
    const report = await executor.runSandbox(getBuiltin(item.name)!.code, plan, item.executionInput);
    expect(report.failed).toBe(0);
    expect(report.blocked).toBe(0);
    expect(report.passed).toBeGreaterThan(0);
  });

  it('passes maintained builtins deterministically at review while still vetoing real failures', async () => {
    const agent = new TestAgent(new ModelGateway({ complete: async () => {
      throw new Error('Maintained review must be deterministic.');
    } }));
    const passing = { cases: [], passed: 4, failed: 0, blocked: 0, mode: 'sandbox' as const };
    expect((await agent.review('review-task', passing, { maintainedBuiltin: true })).verdict).toBe('pass');
    const failing = { cases: [], passed: 1, failed: 2, blocked: 0, mode: 'sandbox' as const, reason: 'OUTPUT_MISMATCH' };
    expect((await agent.review('review-task', failing, { maintainedBuiltin: true })).verdict).toBe('fail');
  });

  it('accepts passing deterministic file-read evidence without a model veto', async () => {
    const agent = new TestAgent(new ModelGateway({ complete: async () => {
      throw new Error('Passing maintained file-read evidence must not require another model call.');
    } }));
    const review = await agent.review('read-file', {
      cases: [{ id: 'file-read', mode: 'sandbox', status: 'passed', codes: [], evidence: [] }],
      mode: 'sandbox', passed: 1, failed: 0, blocked: 0,
    }, { maintainedFilesystemRead: true });
    expect(review.verdict).toBe('pass');
  });

  it('validates the reusable network contract without inventing live data in sandbox tests', async () => {
    const agent = new TestAgent(new ModelGateway({ complete: async () => {
      throw new Error('Built-in network tests must not depend on invented model fixtures.');
    } }));
    const input = { url: 'https://weather.example.test/current?city=Shenzhen', method: 'GET' };
    const plan = await agent.generate('network', { name: 'network.request', permissions: ['network'],
      executionInput: input, acceptanceCriteria: ['Report current weather'] });
    const executor = new TestExecutor(new SandboxRunner());
    const valid = await executor.runSandbox(getBuiltin('network.request')!.code, plan, input);
    expect(valid.failed).toBe(0);
    expect(valid.passed).toBeGreaterThanOrEqual(3);
    const hardcoded = await executor.runSandbox(
      'export async function run(input, host) { return await host.network.request({url:"https://weather.example.test/current?city=Shenzhen",method:"GET"}); }', plan, input);
    expect(hardcoded.failed).toBeGreaterThan(0);
    const swallowsFailure = await executor.runSandbox(
      'export async function run(input, host) { try { return await host.network.request(input); } catch { return {status:200}; } }', plan, input);
    expect(swallowsFailure.failed).toBeGreaterThan(0);
  });

  it('accepts declarative host contract cases', () => {
    expect(parseTestPlan(base, ['filesystem.write']).cases).toHaveLength(1);
  });

  it.each([
    { ...base, script: 'Remove-Item C:/' },
    { cases: [{ ...base.cases[0], assertions: [{ type: 'javascript', code: '1+1' }] }] },
    { cases: [{ ...base.cases[0], assertions: [{ type: 'host_call', permission: 'process', action: 'run' }] }] },
    { cases: [{ id: 'bad-live', mode: 'live_observation', assertions: [{ type: 'output_equals', path: 'success', value: true }] }] },
    { cases: Array.from({ length: 11 }, (_, i) => ({ ...base.cases[0], id: `case-${i}` })) },
  ])('rejects scripts, unknown assertions, undeclared permissions and excess cases', (value) => {
    expect(() => parseTestPlan(value, ['filesystem.write'])).toThrow();
  });

  it('does not let model review override a deterministic failure', async () => {
    const agent = new TestAgent(new ModelGateway(new MockModelProvider()));
    const review = await agent.review('task-1', {
      cases: [{ id: 'normal', mode: 'sandbox', status: 'failed', codes: ['OUTPUT_MISMATCH'], evidence: [] }],
      mode: 'sandbox', passed: 0, failed: 1, blocked: 0, reason: 'OUTPUT_MISMATCH',
    });
    expect(review).toEqual({ verdict: 'fail', reason: 'OUTPUT_MISMATCH' });
  });

  it('accepts a verified maintained network report without a model call', async () => {
    const agent = new TestAgent(new ModelGateway({ complete: async () => {
      throw new Error('A passing maintained network report is already deterministic.');
    } }));
    const review = await agent.review('network', {
      cases: [{ id: 'network-request', mode: 'sandbox', status: 'passed', codes: [], evidence: [] }],
      mode: 'sandbox', passed: 1, failed: 0, blocked: 0,
    }, { maintainedNetwork: true });
    expect(review.verdict).toBe('pass');
  });

  it('does not send attachment bodies or obvious secrets to the test planner', async () => {
    let request: ModelRequest | undefined;
    const provider = new MockModelProvider();
    const agent = new TestAgent(new ModelGateway({ complete: async (input) => {
      request = input;
      return provider.complete(input);
    } }));
    await agent.generate('task-1', { name: 'count_lines', permissions: [], acceptanceCriteria: ['count lines'],
      executionInput: { content: 'PRIVATE_ATTACHMENT_BODY', attachments: [{ filename: 'a.txt', content: 'PRIVATE_ATTACHMENT_BODY' }], apiKey: 'PRIVATE_KEY' },
    });
    expect(request?.user).not.toMatch(/PRIVATE_ATTACHMENT_BODY|PRIVATE_KEY/);
  });

  it('gives generated-tool tests the output contract and accepts nested word-frequency assertions', async () => {
    let request: ModelRequest | undefined;
    const agent = new TestAgent(new ModelGateway({ complete: async input => {
      request = input;
      return { data: { cases: [{ id: 'frequency', mode: 'sandbox', input: { text: 'apple banana apple' },
        assertions: [{ type: 'output_equals', path: '$.frequencies.apple', value: 2 },
          { type: 'output_equals', path: 'totalWords', value: 3 }] }] },
      usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    const outputSchema = { type: 'object', properties: { frequencies: { type: 'object' }, totalWords: { type: 'integer' } } };
    const plan = await agent.generate('frequency-task', { name: 'dynamic.text.word_frequency', permissions: [],
      executionInput: { text: 'apple banana apple' }, acceptanceCriteria: ['Count every word'], outputSchema });
    expect(JSON.parse(request!.user).outputSchema).toEqual(outputSchema);
    const report = await new TestExecutor(new SandboxRunner()).runSandbox(
      'export async function run(input) { return { frequencies: { apple: 2, banana: 1 }, totalWords: 3 }; }',
      plan, { text: 'apple banana apple' });
    expect(report.failed).toBe(0);
  });
});
