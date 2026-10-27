import { describe, expect, it } from 'vitest';
import { publicTaskEvent } from '../../src/runtime/event-projection.js';

describe('draft progress projection', () => {
  it('keeps only bounded numeric progress and never persists draft text', () => {
    const publicEvent = publicTaskEvent({ type: 'draft.progress', payload: {
      completed: 2, total: 5, content: 'private presentation content', secret: 'PRIVATE',
    } });
    expect(publicEvent.payload).toEqual({ completed: 2, total: 5 });
  });
});
