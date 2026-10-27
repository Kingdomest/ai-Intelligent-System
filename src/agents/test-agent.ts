import { z } from 'zod';
import type { CapabilityPermission } from '../domain/contracts.js';
import { ModelGateway } from '../model/gateway.js';

const permissionSchema = z.enum(['filesystem.read', 'filesystem.write', 'network', 'location', 'process']);
const outputEquals = z.strictObject({ type: z.literal('output_equals'), path: z.string().max(120), value: z.json() });
const outputContains = z.strictObject({ type: z.literal('output_contains'), path: z.string().max(120), text: z.string().max(500) });
const hostCall = z.strictObject({
  type: z.literal('host_call'), permission: permissionSchema, action: z.string().min(1).max(80), target: z.string().max(4096).optional(),
});
const executionError = z.strictObject({ type: z.literal('execution_error') });
const noHostCall = z.strictObject({ type: z.literal('no_host_call') });
const desktopAssertion = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('process_running'), applicationId: z.string().min(1).max(120) }),
  z.strictObject({ type: z.literal('window_visible'), applicationId: z.string().min(1).max(120) }),
  z.strictObject({ type: z.literal('foreground_window'), applicationId: z.string().min(1).max(120) }),
]);
export const testAssertionSchema = z.discriminatedUnion('type', [outputEquals, outputContains, hostCall, executionError, noHostCall,
  ...desktopAssertion.options]);
export const testPlanSchema = z.strictObject({
  cases: z.array(z.strictObject({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    mode: z.enum(['sandbox', 'live_observation']),
    input: z.record(z.string(), z.json()).optional(),
    hostBehavior: z.enum(['success', 'failure']).optional(),
    assertions: z.array(testAssertionSchema).min(1).max(12),
  })).min(1).max(10),
});

export type TestPlan = z.infer<typeof testPlanSchema>;
export type TestAssertion = z.infer<typeof testAssertionSchema>;
export type TestCaseResult = {
  id: string;
  mode: 'sandbox' | 'live_observation';
  status: 'passed' | 'failed' | 'blocked';
  codes: string[];
  evidence: Array<{ kind: string; code: string }>;
};
export type TestReport = {
  cases: TestCaseResult[];
  passed: number;
  failed: number;
  blocked: number;
  mode: 'sandbox' | 'live_observation';
  reason?: string;
};

const reviewSchema = z.strictObject({
  verdict: z.enum(['pass', 'fail', 'blocked']),
  reason: z.string().max(500),
});

export function parseTestPlan(value: unknown, permissions: CapabilityPermission[]): TestPlan {
  const plan = testPlanSchema.parse(value);
  if (new Set(plan.cases.map((item) => item.id)).size !== plan.cases.length) throw new Error('Duplicate test case id.');
  for (const item of plan.cases) {
    if (item.mode === 'live_observation' && (item.input || item.hostBehavior)) throw new Error('Live observation cannot execute inputs.');
    if (item.mode === 'live_observation' && item.assertions.some((assertion) => !isDesktop(assertion))) {
      throw new Error('Live observation accepts only desktop assertions.');
    }
    if (item.mode === 'sandbox' && item.assertions.some((assertion) => isDesktop(assertion))) {
      throw new Error('Desktop observations require live mode.');
    }
    for (const assertion of item.assertions) {
      if (assertion.type === 'host_call' && !permissions.includes(assertion.permission)) {
        throw new Error(`Test requested undeclared permission ${assertion.permission}.`);
      }
      if (isDesktop(assertion) && !permissions.includes('process')) throw new Error('Desktop observation requires process permission.');
    }
  }
  return plan;
}

function isDesktop(value: TestAssertion): value is Extract<TestAssertion, { applicationId: string }> {
  return value.type === 'process_running' || value.type === 'window_visible' || value.type === 'foreground_window';
}

export class TestAgent {
  constructor(private readonly gateway: ModelGateway) {}

  async reviewAnswer(taskId: string, input: {
    answer: string; criteria: string[]; verifiedStepIds: string[]; requiredStepIds: string[]; isCasualChat?: boolean;
  }): Promise<{ verdict: 'pass' | 'fail' | 'blocked'; reason: string }> {
    if (!input.answer.trim()) return { verdict: 'fail', reason: 'ANSWER_EMPTY' };
    if (input.requiredStepIds.some(id => !input.verifiedStepIds.includes(id))) {
      return { verdict: 'blocked', reason: 'ANSWER_EVIDENCE_MISSING' };
    }
    const response = await this.gateway.complete({
      role: 'tester.answer', taskId,
      system: 'You are the independent Jarvis test agent. Check that the answer has usable structure and covers the stated criteria. Do not judge factual accuracy; the evaluator will check facts against verified tool results. You cannot override missing evidence or an empty answer. When isCasualChat is true the user request is greeting or small talk: a courteous, on-topic reply passes — never fail it for lacking facts, data, structure or information density. When criteria is empty and requiredStepIds is empty, the request is conversational (greeting, chat, or a question about the user or the session such as identity or preferences): judge ONLY whether the answer is non-empty, coherent, and actually responds to the user\'s question — sessionMemory in the input holds the relevant facts. Never invent criteria of your own, and never fail a correct or hedged short answer for being brief, unstructured, or a single sentence; fail only when the answer is empty or ignores/contradicts the question. Return a concise verdict without quoting the answer.',
      user: JSON.stringify(input),
    }, reviewSchema);
    return response.data;
  }

  async generate(taskId: string, context: {
    name: string; permissions: CapabilityPermission[]; executionInput: Record<string, unknown>; acceptanceCriteria: string[];
  }): Promise<TestPlan> {
    if (context.name === 'text.count_lines') {
      return parseTestPlan({ cases: [
        { id: 'empty', mode: 'sandbox', input: { text: '' }, assertions: [{ type: 'output_equals', path: 'count', value: 0 }] },
        { id: 'mixed-newlines', mode: 'sandbox', input: { text: 'a\r\nb\nc' },
          assertions: [{ type: 'output_equals', path: 'count', value: 3 }] },
        { id: 'terminal-newline', mode: 'sandbox', input: { text: 'a\nb\n' },
          assertions: [{ type: 'output_equals', path: 'count', value: 2 }] },
      ] }, context.permissions);
    }
    if (context.name === 'text.replace') {
      return parseTestPlan({ cases: [
        { id: 'all-occurrences', mode: 'sandbox', input: { text: 'one two one', search: 'one', replacement: 'three' },
          assertions: [{ type: 'output_equals', path: 'content', value: 'three two three' },
            { type: 'output_equals', path: 'replacements', value: 2 }] },
        { id: 'literal-match', mode: 'sandbox', input: { text: 'a.b', search: '.', replacement: '-' },
          assertions: [{ type: 'output_equals', path: 'content', value: 'a-b' }] },
      ] }, context.permissions);
    }
    if (context.name === 'json.format') {
      return parseTestPlan({ cases: [
        { id: 'format-object', mode: 'sandbox', input: { text: '{"a":1}' },
          assertions: [{ type: 'output_equals', path: 'content', value: '{\n  "a": 1\n}' }] },
        { id: 'invalid-json', mode: 'sandbox', input: { text: '{' },
          assertions: [{ type: 'execution_error' }] },
      ] }, context.permissions);
    }
    if (context.name === 'filesystem.read_text') {
      const target = context.executionInput.path;
      if (typeof target !== 'string' || !target.trim()) throw new Error('File-read test requires a non-empty path.');
      const otherTarget = `${target}.jarvis-probe`;
      const call = { type: 'host_call', permission: 'filesystem.read', action: 'readText', target } as const;
      return parseTestPlan({ cases: [
        { id: 'file-read', mode: 'sandbox', hostBehavior: 'success',
          assertions: [call, { type: 'output_contains', path: 'content', text: '[simulated contents]' }] },
        { id: 'file-other-target', mode: 'sandbox', hostBehavior: 'success', input: { path: otherTarget },
          assertions: [{ ...call, target: otherTarget }] },
        { id: 'file-host-failure', mode: 'sandbox', hostBehavior: 'failure',
          assertions: [call, { type: 'execution_error' }] },
      ] }, context.permissions);
    }
    if (context.name === 'filesystem.write_text') {
      const target = context.executionInput.path;
      if (typeof target !== 'string' || !target.trim()) throw new Error('File-write test requires a non-empty path.');
      const otherTarget = `${target}.jarvis-probe`;
      const call = { type: 'host_call', permission: 'filesystem.write', action: 'writeText', target } as const;
      return parseTestPlan({ cases: [
        { id: 'file-write', mode: 'sandbox', hostBehavior: 'success', assertions: [call, { type: 'output_equals', path: 'path', value: target }] },
        { id: 'file-write-other-target', mode: 'sandbox', hostBehavior: 'success',
          input: { path: otherTarget, content: 'probe' },
          assertions: [{ ...call, target: otherTarget }, { type: 'output_equals', path: 'bytesWritten', value: 5 }] },
        { id: 'file-write-missing-path', mode: 'sandbox', input: { path: null, content: null },
          assertions: [{ type: 'host_call', permission: 'filesystem.write', action: 'writeText' }, { type: 'execution_error' }] },
        { id: 'file-write-host-failure', mode: 'sandbox', hostBehavior: 'failure',
          assertions: [call, { type: 'execution_error' }] },
      ] }, context.permissions);
    }
    if (context.name === 'filesystem.mkdir') {
      const target = context.executionInput.path;
      if (typeof target !== 'string' || !target.trim()) throw new Error('Directory-creation test requires a non-empty path.');
      const otherTarget = `${target}.jarvis-probe`;
      const call = { type: 'host_call', permission: 'filesystem.write', action: 'mkdir', target } as const;
      return parseTestPlan({ cases: [
        { id: 'dir-create', mode: 'sandbox', hostBehavior: 'success',
          assertions: [call, { type: 'output_equals', path: 'created', value: true }] },
        { id: 'dir-other-target', mode: 'sandbox', hostBehavior: 'success', input: { path: otherTarget },
          assertions: [{ ...call, target: otherTarget }] },
        { id: 'dir-missing-path', mode: 'sandbox', input: { path: null },
          assertions: [{ type: 'host_call', permission: 'filesystem.write', action: 'mkdir' }, { type: 'execution_error' }] },
        { id: 'dir-host-failure', mode: 'sandbox', hostBehavior: 'failure',
          assertions: [call, { type: 'execution_error' }] },
      ] }, context.permissions);
    }
    if (context.name === 'filesystem.remove') {
      const target = context.executionInput.path;
      if (typeof target !== 'string' || !target.trim()) throw new Error('File-removal test requires a non-empty path.');
      const otherTarget = `${target}.jarvis-probe`;
      const call = { type: 'host_call', permission: 'filesystem.write', action: 'remove', target } as const;
      return parseTestPlan({ cases: [
        { id: 'file-remove', mode: 'sandbox', hostBehavior: 'success',
          assertions: [call, { type: 'output_equals', path: 'removed', value: true }] },
        { id: 'file-remove-other-target', mode: 'sandbox', hostBehavior: 'success', input: { path: otherTarget },
          assertions: [{ ...call, target: otherTarget }] },
        { id: 'file-remove-missing-path', mode: 'sandbox', input: { path: null },
          assertions: [{ type: 'host_call', permission: 'filesystem.write', action: 'remove' }, { type: 'execution_error' }] },
        { id: 'file-remove-host-failure', mode: 'sandbox', hostBehavior: 'failure',
          assertions: [call, { type: 'execution_error' }] },
      ] }, context.permissions);
    }
    if (context.name === 'process.run') {
      const command = context.executionInput.command;
      if (typeof command !== 'string' || !command.trim()) throw new Error('Process-run test requires a non-empty command.');
      const call = { type: 'host_call', permission: 'process', action: 'run', target: command } as const;
      return parseTestPlan({ cases: [
        { id: 'process-run', mode: 'sandbox', hostBehavior: 'success',
          assertions: [call, { type: 'output_equals', path: 'exitCode', value: 0 }] },
        { id: 'process-run-other-command', mode: 'sandbox', hostBehavior: 'success',
          input: { command: 'jarvis-probe-cmd', args: [] },
          assertions: [{ ...call, target: 'jarvis-probe-cmd' }] },
        { id: 'process-run-missing-command', mode: 'sandbox', input: { command: null, args: null },
          assertions: [{ type: 'host_call', permission: 'process', action: 'run' }, { type: 'execution_error' }] },
        { id: 'process-run-host-failure', mode: 'sandbox', hostBehavior: 'failure',
          assertions: [call, { type: 'execution_error' }] },
      ] }, context.permissions);
    }
    if (context.name === 'process.launch') {
      const executable = context.executionInput.executable;
      if (typeof executable !== 'string' || !executable.trim()) throw new Error('Application-launch test requires a non-empty executable.');
      const call = { type: 'host_call', permission: 'process', action: 'launch', target: executable } as const;
      const cases: Array<TestPlan['cases'][number]> = [
        { id: 'app-launch', mode: 'sandbox', hostBehavior: 'success',
          assertions: [call, { type: 'output_equals', path: 'started', value: true }] },
        { id: 'app-launch-missing-executable', mode: 'sandbox', input: { executable: null, args: null },
          assertions: [{ type: 'host_call', permission: 'process', action: 'launch' }, { type: 'execution_error' }] },
        { id: 'app-launch-host-failure', mode: 'sandbox', hostBehavior: 'failure',
          assertions: [call, { type: 'execution_error' }] },
      ];
      const applicationId = typeof context.executionInput.applicationId === 'string' ? context.executionInput.applicationId : undefined;
      if (applicationId) {
        cases.push({ id: 'app-desktop', mode: 'live_observation', assertions: [
          { type: 'process_running', applicationId },
          { type: 'window_visible', applicationId },
          { type: 'foreground_window', applicationId },
        ] });
      }
      return parseTestPlan({ cases }, context.permissions);
    }
    if (context.name === 'location.current') {
      const call = { type: 'host_call', permission: 'location', action: 'current' } as const;
      return parseTestPlan({ cases: [
        // The sandbox models location as unavailable; the contract under test is the pass-through host call.
        { id: 'location-current', mode: 'sandbox', hostBehavior: 'success', assertions: [call] },
        { id: 'location-host-failure', mode: 'sandbox', hostBehavior: 'failure',
          assertions: [call, { type: 'execution_error' }] },
      ] }, context.permissions);
    }
    if (context.name === 'network.request') {
      // The sandbox has no live response body. Test the maintained bridge contract;
      // HTTP status and actual data are verified separately after authorized execution.
      const target = typeof context.executionInput.url === 'string' ? context.executionInput.url : undefined;
      const call = { type: 'host_call', permission: 'network', action: 'request', target } as const;
      return parseTestPlan({ cases: [
        { id: 'network-request', mode: 'sandbox', hostBehavior: 'success', assertions: [call] },
        { id: 'network-other-target', mode: 'sandbox', hostBehavior: 'success',
          input: { url: 'https://example.test/contract-secondary', method: 'GET', headers: {} },
          assertions: [{ ...call, target: 'https://example.test/contract-secondary' }] },
        { id: 'network-host-failure', mode: 'sandbox', hostBehavior: 'failure',
          assertions: [call, { type: 'execution_error' }] },
      ] }, context.permissions);
    }
    if (context.name === 'presentation.create') {
      const target = context.executionInput.path;
      if (typeof target !== 'string' || !/\.pptx$/i.test(target)) throw new Error('Presentation test requires a .pptx target.');
      const otherTarget = target.replace(/\.pptx$/i, '-probe.pptx');
      const call = { type: 'host_call', permission: 'filesystem.write', action: 'createPresentation', target } as const;
      return parseTestPlan({ cases: [
        { id: 'pptx-create', mode: 'sandbox', hostBehavior: 'success', assertions: [
          call, { type: 'output_equals', path: 'path', value: target },
        ] },
        { id: 'pptx-other-target', mode: 'sandbox', hostBehavior: 'success', input: { path: otherTarget },
          assertions: [{ ...call, target: otherTarget }] },
        { id: 'pptx-missing-path', mode: 'sandbox', input: { path: '' },
          assertions: [{ type: 'no_host_call' }, { type: 'execution_error' }] },
        { id: 'pptx-host-failure', mode: 'sandbox', hostBehavior: 'failure',
          assertions: [call, { type: 'execution_error' }] },
      ] }, context.permissions);
    }
    const response = await this.gateway.complete({
      role: 'tester.plan', taskId,
      system: 'You are the independent Jarvis test agent. Return only declarative test cases, never scripts or commands to run. Use at most 10 cases. Sandbox cases may supply input data and bounded output/host-call assertions; use execution_error and no_host_call to verify rejected missing input. Add process/window/foreground live desktop assertions for process.launch, not for short process.run unless it explicitly launches an application. Cover normal, missing or boundary input and host failure when relevant. Do not assert a simulated host result proves real integration.',
      user: JSON.stringify({ ...context, executionInput: summarizeInput(context.executionInput) }),
    }, testPlanSchema);
    return parseTestPlan(response.data, context.permissions);
  }

  async review(taskId: string, report: TestReport, options: {
    maintainedNetwork?: boolean; maintainedFilesystemRead?: boolean; maintainedPresentation?: boolean; maintainedBuiltin?: boolean;
  } = {}): Promise<{ verdict: 'pass' | 'fail' | 'blocked'; reason: string }> {
    if (report.blocked > 0) return { verdict: 'blocked', reason: report.reason ?? '关键条件未验证。' };
    if (report.failed > 0) return { verdict: 'fail', reason: report.reason ?? '确定性断言失败。' };
    if ((options.maintainedNetwork || options.maintainedFilesystemRead || options.maintainedPresentation
      || options.maintainedBuiltin) && report.passed > 0) {
      return { verdict: 'pass', reason: 'Maintained bridge contract and observations passed.' };
    }
    const response = await this.gateway.complete({
      role: 'tester.review', taskId,
      system: 'You are the independent Jarvis test agent. Read only the redacted deterministic evidence. You may veto a pass, but cannot turn a failed or blocked assertion into a pass. Return a concise verdict.',
      user: JSON.stringify(report),
    }, reviewSchema);
    return response.data;
  }
}

function summarizeInput(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[omitted]';
  if (Array.isArray(value)) return value.slice(0, 5).map((item) => summarizeInput(item, depth + 1));
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 200) : value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 32)) {
    if (/^(content|message|body|api.?key|token|password|secret|authorization)$/i.test(key)) {
      result[key] = typeof item === 'string' ? `[omitted ${item.length} characters]` : '[omitted]';
    } else {
      result[key] = summarizeInput(item, depth + 1);
    }
  }
  return result;
}
