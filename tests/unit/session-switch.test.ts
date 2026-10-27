import { describe, expect, it } from 'vitest';
import { sessionSwitchReset } from '../../web/src/session-switch.js';

describe('session switch composer state', () => {
  it('clears stale task state before the next session finishes loading', () => {
    expect(sessionSwitchReset()).toEqual({
      task: null,
      busy: false,
      supplement: '',
      supplementSubmitting: false,
    });
  });
});
