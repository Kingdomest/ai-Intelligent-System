import { describe, expect, it } from 'vitest';
import { beginCorrection, finishCorrection } from '../../src/runtime/correction-round.js';
import type { CorrectionState } from '../../src/domain/contracts.js';

describe('task-level correction round', () => {
  const empty = (): CorrectionState => ({ roundsUsed: 0, finishedRoundIds: [], failures: [] });

  it('counts a whole correction only after its verdict and only once', () => {
    const started = beginCorrection(empty(), 'answer', 'round-1');
    expect(started.roundsUsed).toBe(0);
    expect(started.currentRound).toMatchObject({ id: 'round-1', ordinal: 1, target: 'answer' });
    expect(beginCorrection(started, 'answer', 'round-1')).toEqual(started);

    const finished = finishCorrection(started, 'round-1');
    expect(finished.roundsUsed).toBe(1);
    expect(finished.currentRound).toBeUndefined();
    expect(finishCorrection(finished, 'round-1')).toEqual(finished);
  });

  it('enforces one shared five-round cap', () => {
    let state = empty();
    for (let ordinal = 1; ordinal <= 5; ordinal += 1) {
      state = finishCorrection(beginCorrection(state, 'plan_or_input', `round-${ordinal}`), `round-${ordinal}`);
    }
    expect(state.roundsUsed).toBe(5);
    expect(() => beginCorrection(state, 'answer', 'round-6')).toThrow(/five|5/i);
  });
});
