import { describe, expect, it } from 'vitest';
import { ANSWER_RESULT_BUDGET, buildStepReviewContext, compactVerifiedResult } from '../../src/agents/step-review-context.js';

describe('verified evidence context', () => {
  it('preserves the end of a long article for final synthesis while keeping step previews short', () => {
    const article = 'Introduction\n' + 'article text\n'.repeat(3_000) + '\nFinal section: packet structure and conclusion.';
    const preview = compactVerifiedResult({ body: article }) as { body: { truncated: boolean } };
    expect(preview.body.truncated).toBe(true);
    const answer = compactVerifiedResult({ body: article }, ANSWER_RESULT_BUDGET);
    expect(answer).toEqual({ body: article });
  });

  it('does not mark complete readable content as truncated just because scripts were large', () => {
    const html = `<html><script>${'tracking();'.repeat(30_000)}</script><h1>Article</h1><p>Complete conclusion.</p></html>`;
    const result = compactVerifiedResult({ body: html }) as { body: string };
    expect(typeof result.body).toBe('string');
    expect(result.body).toContain('Complete conclusion.');
    expect(result.body).not.toContain('tracking');
  });

  it('bounds a large HTML response while preserving its status and an explicit truncation marker', () => {
    const output = compactVerifiedResult({ status: 200, ok: true,
      headers: { 'content-type': 'text/html', 'set-cookie': 'secret' },
      body: `<script>ignore()</script><h1>Relevant fact</h1>${'<p>More text</p>'.repeat(7000)}` });
    const serialized = JSON.stringify(output);
    expect(serialized.length).toBeLessThan(9_000);
    expect(serialized).toContain('Relevant fact');
    expect(serialized).toContain('truncated');
    expect(serialized).not.toContain('set-cookie');
    expect(serialized).not.toContain('ignore()');
  });

  it('preserves whitespace in a counted text when the planner reviews the result', () => {
    const step = { id: 'count', capabilityKey: 'text.count_lines', description: 'Count lines',
      dependsOn: [], input: { text: 'a\nb\nc' } };
    const context = buildStepReviewContext({ taskId: 'count', message: 'Count a\nb\nc',
      plan: { status: 'ready', intent: 'count lines', acceptanceCriteria: ['Three lines'],
        requiredCapabilities: [], steps: [step] }, step, completedStepIds: ['count'],
      results: [{ stepId: 'count', output: { count: 3 }, observedAt: new Date().toISOString() }],
      outcome: { status: 'success', output: { count: 3 } }, safeToReplay: true,
      workspaceRoot: 'D:/demo', desktopDirectory: 'D:/demo/Desktop' });
    expect((context.currentStep as { input: { text: string } }).input.text).toBe('a\nb\nc');
  });

  it('shows passed desktop postconditions to the planner after a launch', () => {
    const step = { id: 'launch', capabilityKey: 'process.launch', description: 'Open app', dependsOn: [],
      input: { applicationName: 'Demo', args: [] } };
    const verification = { mode: 'live_observation' as const, passed: 2, failed: 0, blocked: 0,
      checks: [{ id: 'host-operation', status: 'passed' as const, codes: [] },
        { id: 'desktop', status: 'passed' as const, codes: [] }] };
    const context = buildStepReviewContext({ taskId: 'launch', message: 'Open Demo and confirm its window',
      plan: { status: 'ready', intent: 'launch app', acceptanceCriteria: ['Window foreground'],
        requiredCapabilities: [], steps: [step] }, step, completedStepIds: ['launch'], results: [],
      outcome: { status: 'success', output: { started: true, pid: 42 } }, verification,
      safeToReplay: true, workspaceRoot: 'D:/demo', desktopDirectory: 'D:/demo/Desktop' });
    expect(context.verification).toEqual(verification);
  });
});
