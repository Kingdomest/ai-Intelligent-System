import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AgentLoop, TaskService } from '../../src/runtime/agent-loop.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

it('turns an uncaught loop error into a terminal task without exposing the error text', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-recovery-'));
  const store = new SqliteStore(join(directory, 'jarvis.sqlite'));
  try {
    const loop = { run: async () => { throw new Error('private prompt or key'); } } as unknown as AgentLoop;
    const task = await new TaskService(store, loop).createAndWait({ message: 'Do work', attachments: [] });
    expect(task.status).toBe('FAILED');
    expect(task.result).not.toContain('private');
    expect(store.listEvents(task.id).at(-1)?.payload).toEqual({ failureCode: 'UNHANDLED_RUNTIME_ERROR' });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
