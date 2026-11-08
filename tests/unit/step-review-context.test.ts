import { describe, expect, it } from 'vitest';
import { compactVerifiedResult } from '../../src/agents/step-review-context.js';

describe('verified evidence context', () => {
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
});
