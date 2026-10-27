import { describe, expect, it } from 'vitest';
import { reportForEvent } from '../../src/runtime/test-executor.js';

describe('persisted test report', () => {
  it('stores counts and assertion codes without model case IDs or raw evidence', () => {
    const payload = reportForEvent({ mode: 'sandbox', passed: 0, failed: 1, blocked: 0, reason: 'OUTPUT_MISMATCH',
      cases: [{ id: 'SECRET_KEY_ABC', mode: 'sandbox', status: 'failed', codes: ['OUTPUT_MISMATCH'],
        evidence: [{ kind: 'raw', code: 'MY_API_TOKEN' }] }],
    });
    expect(payload).toMatchObject({ passed: 0, failed: 1, cases: [{ id: 'case-1', status: 'failed', codes: ['OUTPUT_MISMATCH'] }] });
    expect(payload.cases[0]?.evidence).toEqual([]);
    expect(JSON.stringify(payload)).not.toMatch(/SECRET_KEY_ABC|MY_API_TOKEN/);
  });
});
