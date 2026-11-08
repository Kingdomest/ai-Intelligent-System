import { expect, it } from 'vitest';
import { publicTaskEvent } from '../../src/runtime/event-projection.js';

it('only publishes safe agent activity metadata', () => {
  expect(publicTaskEvent({ type: 'agent.activity', payload: {
    runId: 'run-1', role: 'planner.route', status: 'running',
    prompt: 'secret', output: 'secret', error: 'secret',
  } }).payload).toEqual({ runId: 'run-1', role: 'planner.route', status: 'running' });
});
