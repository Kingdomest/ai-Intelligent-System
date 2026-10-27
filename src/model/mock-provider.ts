import type { ModelCompletion, ModelProvider, ModelRequest, ModelRequestDetails } from './gateway.js';
import type { TestPlan } from '../agents/test-agent.js';

export class MockModelProvider implements ModelProvider {
  public calls = 0;

  describeRequest(_request: ModelRequest): ModelRequestDetails { return { provider: 'mock', model: 'mock' }; }

  async complete(request: ModelRequest): Promise<ModelCompletion> {
    this.calls += 1;
    if (request.role === 'planner.route') return this.completion({ status: 'ready' });
    if (request.role === 'planner.correction') return this.completion({ action: 'revise_answer', reason: 'Correct the failed answer.' });
    if (request.role === 'session.compaction') return this.completion({ summary: mockSessionSummary(request.user) });
    if (request.role === 'planner') {
      return this.completion({
        intent: 'count lines uploaded content',
        acceptanceCriteria: ['result contains a line count'],
        requiredCapabilities: [{ name: 'count_lines', purpose: 'Count lines in uploaded text.', riskLevel: 'low' }],
        steps: [{ id: 'execute-count-lines', capabilityKey: 'dynamic.text.count_lines', description: 'Count lines in the uploaded content.', dependsOn: [], input: {} }],
        status: 'ready',
      });
    }

    if (request.role === 'evaluator') {
      return this.completion({
        status: 'pass',
        verdict: 'pass',
        score: 1,
        failures: [],
        recommendations: [],
        evidence: ['The candidate output satisfies the MVP criterion.'],
      });
    }

    if (request.role === 'tester.plan') {
      const context = JSON.parse(request.user) as { name: string; permissions: string[]; executionInput?: { applicationId?: string } };
      const permission = context.permissions[0];
      const action = permission === 'filesystem.write' ? 'mkdir'
        : permission === 'filesystem.read' ? 'readText'
          : permission === 'network' ? 'request'
            : permission === 'location' ? 'current' : context.name === 'process.launch' ? 'launch' : 'run';
      const cases: TestPlan['cases'] = permission ? [
        { id: 'normal', mode: 'sandbox', hostBehavior: 'success', assertions: [{ type: 'host_call', permission: permission as 'process', action }] },
        { id: 'host-failure', mode: 'sandbox', hostBehavior: 'failure', assertions: [{ type: 'host_call', permission: permission as 'process', action }] },
      ] : context.name === 'count_lines'
        ? [{ id: 'two-lines', mode: 'sandbox', input: { content: 'a\nb\n' }, assertions: [{ type: 'output_equals', path: 'count', value: 2 }] }]
        : [{ id: 'returns-output', mode: 'sandbox', assertions: [{ type: 'output_contains', path: '', text: '' }] }];
      if (permission === 'process' && (context.name === 'process.launch' || context.executionInput?.applicationId)) cases.push({ id: 'desktop', mode: 'live_observation', assertions: [
        { type: 'process_running', applicationId: context.executionInput?.applicationId ?? 'cloudmusic' },
        { type: 'window_visible', applicationId: context.executionInput?.applicationId ?? 'cloudmusic' },
        { type: 'foreground_window', applicationId: context.executionInput?.applicationId ?? 'cloudmusic' },
      ] });
      return this.completion({ cases });
    }

    if (request.role === 'tester.review') return this.completion({ verdict: 'pass', reason: 'Deterministic checks passed.' });
    if (request.role === 'tester.answer') return this.completion({ verdict: 'pass', reason: 'Answer structure passed.' });

    if (request.role === 'implementer') {
      return this.completion({
        kind: 'tool_candidate',
        candidate: {
          id: 'count_lines',
          name: 'count_lines',
          version: '1.0.0',
          intent: 'count lines uploaded content',
          description: 'Counts non-empty line boundaries in supplied text content.',
          inputSchema: { type: 'object', required: ['content'], properties: { content: { type: 'string' } } },
          outputSchema: { type: 'object', required: ['count'], properties: { count: { type: 'number' } } },
          entrypoint: 'tool.mjs',
          runtime: 'node-sandbox-v1',
          permissions: [],
          riskLevel: 'low',
          tests: ['a\\nb\\n produces count 2'],
          code: "export async function run(input) {\n  const content = String(input.content ?? '');\n  return { count: content.length === 0 ? 0 : content.split(/\\r?\\n/).filter(Boolean).length };\n}\n",
        },
      });
    }

    return this.completion({ ok: true });
  }

  private completion(data: unknown): ModelCompletion {
    return {
      data,
      usage: { inputTokens: 64, outputTokens: 32 },
      requestId: 'mock-request',
    };
  }
}

/** Deterministic checkpoint for mock mode: short enough to pass the shrink gate on long spans. */
function mockSessionSummary(user: string): string {
  let transcript: Array<{ role?: string; content?: string }> = [];
  try {
    const parsed = JSON.parse(user) as { transcript?: unknown };
    if (Array.isArray(parsed.transcript)) transcript = parsed.transcript as typeof transcript;
  } catch {
    transcript = [];
  }
  const firstUser = transcript.find(item => item.role === 'user')?.content ?? '';
  return `【会话检查点】\n## 用户目标与意图\n${firstUser.slice(0, 200)}\n## 已完成的工作与结论\n共 ${transcript.length} 条早前消息，已完成对应工作。\n## 未完成事项与下一步\n按最近原文继续。`;
}
