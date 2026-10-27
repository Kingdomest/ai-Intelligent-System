import { describe, expect, it } from 'vitest';
import { AdaptiveScheduler } from '../../src/runtime/scheduler.js';

describe('AdaptiveScheduler', () => {
  const plan = {
    steps: [
      { id: 'first', description: 'first', dependsOn: [] },
      { id: 'second', description: 'second', dependsOn: ['first'] },
      { id: 'parallel', description: 'parallel', dependsOn: [] },
    ],
  };

  it('only returns steps whose dependencies are complete', () => {
    const scheduler = new AdaptiveScheduler({ maxConcurrency: 2 });
    expect(scheduler.nextReadyStep(plan, new Set())?.id).toBe('first');
    expect(scheduler.nextReadyStep(plan, new Set(['first']))?.id).toBe('second');
  });

  it('never exceeds the configured hard concurrency limit', () => {
    const scheduler = new AdaptiveScheduler({ maxConcurrency: 2 });
    expect(scheduler.concurrency({ modelLimit: 8, resourceSlots: 4, readySteps: 5 })).toBe(2);
    expect(scheduler.concurrency({ modelLimit: 1, resourceSlots: 4, readySteps: 5 })).toBe(1);
  });
});
