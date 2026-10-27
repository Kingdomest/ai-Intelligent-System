import { describe, expect, it } from 'vitest';
import { nextPollDelay, pollTaskUntilTerminal } from '../../web/src/task-polling.js';

describe('task polling', () => {
  it('recovers after transient network failures and delivers the terminal result', async () => {
    const responses = [new Error('offline'), new Error('offline'), { status: 'EXECUTING' }, { status: 'COMPLETED' }];
    const delays: number[] = [];
    const snapshots: string[] = [];
    const result = await pollTaskUntilTerminal(
      async () => { const next = responses.shift()!; if (next instanceof Error) throw next; return next; },
      (value) => value.status === 'COMPLETED',
      (value) => snapshots.push(value.status),
      () => { throw new Error('unexpected permanent failure'); },
      new AbortController().signal,
      async (ms) => { delays.push(ms); },
    );
    expect(result).toBe('terminal');
    expect(snapshots).toEqual(['EXECUTING', 'COMPLETED']);
    expect(delays).toEqual([750, 1500, 750]);
  });

  it('stops after five retries and signals the UI to unlock', async () => {
    let attempts = 0;
    let failures = 0;
    const result = await pollTaskUntilTerminal(
      async () => { attempts += 1; throw new Error('offline'); },
      () => false,
      () => { throw new Error('no snapshot expected'); },
      () => { failures += 1; },
      new AbortController().signal,
      async () => {},
    );
    expect(result).toBe('disconnected');
    expect(attempts).toBe(6);
    expect(failures).toBe(1);
    expect(nextPollDelay(0)).toBe(750);
    expect(nextPollDelay(5)).toBeNull();
  });
});
