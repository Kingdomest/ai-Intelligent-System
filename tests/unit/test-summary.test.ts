import { describe, expect, it } from 'vitest';
import { summarizeTestEvents } from '../../web/src/test-summary.js';

describe('chat test summary', () => {
  it('uses the latest report for each stage after a corrected retry', () => {
    const result = summarizeTestEvents([
      { type: 'test.report', payload: { mode: 'sandbox', passed: 0, failed: 1, blocked: 0, reason: 'OUTPUT_MISMATCH' } },
      { type: 'test.report', payload: { mode: 'sandbox', passed: 2, failed: 0, blocked: 0, reason: null } },
      { type: 'test.report', payload: { mode: 'live_observation', passed: 1, failed: 0, blocked: 0, reason: null } },
    ]);
    expect(result).toEqual({ passed: 3, failed: 0, blocked: 0, reason: null });
  });

  it('preserves a blocked live conclusion when task events are restored', () => {
    const result = summarizeTestEvents([{ type: 'test.report', payload: {
      mode: 'live_observation', passed: 0, failed: 0, blocked: 1, reason: 'DESKTOP_OBSERVATION_UNAVAILABLE',
    } }]);
    expect(result).toMatchObject({ blocked: 1, reason: 'DESKTOP_OBSERVATION_UNAVAILABLE' });
  });

  it('includes the latest answer-review test in the restored summary', () => {
    const result = summarizeTestEvents([{ type: 'test.report', payload: {
      mode: 'answer_review', passed: 0, failed: 1, blocked: 0, reason: 'ANSWER_EMPTY',
    } }]);
    expect(result).toMatchObject({ failed: 1, reason: 'ANSWER_EMPTY' });
  });
});
