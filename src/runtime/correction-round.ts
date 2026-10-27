import type { CorrectionFailure, CorrectionState, CorrectionTarget } from '../domain/contracts.js';

export const MAX_CORRECTION_ROUNDS = 5;

export function beginCorrection(state: CorrectionState, target: CorrectionTarget, id: string): CorrectionState {
  if (state.currentRound) {
    if (state.currentRound.id === id) return state;
    throw new Error('A correction round is already in progress.');
  }
  if (state.finishedRoundIds.includes(id)) throw new Error('Correction round already finished.');
  if (state.roundsUsed >= MAX_CORRECTION_ROUNDS) throw new Error('Five correction rounds have been exhausted.');
  return { ...state, currentRound: { id, ordinal: state.roundsUsed + 1, target, phase: 'dispatch' } };
}

export function finishCorrection(state: CorrectionState, id: string, failure?: CorrectionFailure): CorrectionState {
  if (state.finishedRoundIds.includes(id)) return state;
  if (!state.currentRound || state.currentRound.id !== id) throw new Error('Correction round ID does not match.');
  return {
    roundsUsed: state.roundsUsed + 1,
    finishedRoundIds: [...state.finishedRoundIds, id],
    failures: failure ? [...state.failures, failure].slice(-6) : state.failures,
  };
}
