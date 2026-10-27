import { describe, expect, it } from 'vitest';
import { shouldSubmitComposerOnEnter } from '../../web/src/composer-keyboard.js';

describe('composer keyboard shortcuts', () => {
  it('submits on an unmodified Enter press', () => {
    expect(shouldSubmitComposerOnEnter({ key: 'Enter' })).toBe(true);
  });

  it('keeps Shift+Enter for a newline', () => {
    expect(shouldSubmitComposerOnEnter({ key: 'Enter', shiftKey: true })).toBe(false);
  });

  it('does not submit while confirming IME text', () => {
    expect(shouldSubmitComposerOnEnter({ key: 'Enter', isComposing: true })).toBe(false);
    expect(shouldSubmitComposerOnEnter({ key: 'Enter', keyCode: 229 })).toBe(false);
  });

  it('ignores modifier shortcuts and other keys', () => {
    expect(shouldSubmitComposerOnEnter({ key: 'Enter', ctrlKey: true })).toBe(false);
    expect(shouldSubmitComposerOnEnter({ key: 'Enter', altKey: true })).toBe(false);
    expect(shouldSubmitComposerOnEnter({ key: 'Enter', metaKey: true })).toBe(false);
    expect(shouldSubmitComposerOnEnter({ key: 'a' })).toBe(false);
  });
});
