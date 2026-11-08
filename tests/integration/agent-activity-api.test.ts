import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { registerRoutes } from '../../src/api/routes.js';
import { createDependencies } from '../../src/runtime/dependencies.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('publishes real role progress through the task API using the wired mock runtime', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-activity-'));
  directories.push(directory);
  const runtime = createDependencies({ dataDir: directory, workspaceRoot: directory, modelMode: 'mock' });
  const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, runtime) });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/tasks', payload: {
      message: 'Count the lines in the supplied text.', permissionMode: 'full',
      attachments: [{ id: 'attachment-1', filename: 'sample.txt', mimeType: 'text/plain',
        size: 4, content: 'a\nb\n' }],
    } });
    expect(created.statusCode).toBe(202);
    const { taskId } = created.json() as { taskId: string };
    let result: { task: { status: string }; events: Array<{ type: string; payload: Record<string, unknown> }> } | undefined;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      result = (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json();
      if (['COMPLETED', 'FAILED', 'BLOCKED'].includes(result!.task.status)) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(result?.task.status).toBe('COMPLETED');
    const activity = result?.events.filter(event => event.type === 'agent.activity') ?? [];
    expect(activity.some(event => event.payload.role === 'planner.route' && event.payload.status === 'completed')).toBe(true);
    expect(activity.some(event => event.payload.role === 'task-worker-0.tool_create'
      && event.payload.status === 'completed')).toBe(true);
    expect(activity.some(event => event.payload.role === 'tester.plan' && event.payload.status === 'completed')).toBe(true);
    expect(activity.every(event => !('prompt' in event.payload) && !('output' in event.payload))).toBe(true);
    const agents = runtime.a2aProtocol.listAgents(taskId);
    const root = agents.find(agent => agent.role === 'orchestrator');
    expect(root?.status).toBe('completed');
    expect(agents.some(agent => agent.parentAgentId === root?.id && agent.role === 'planner'
      && agent.status === 'completed')).toBe(true);
    expect(agents.some(agent => agent.parentAgentId === root?.id && agent.role === 'task-worker-0'
      && agent.status === 'completed')).toBe(true);
    expect(agents.some(agent => agent.parentAgentId === root?.id && agent.role === 'tester'
      && agent.status === 'completed')).toBe(true);
  } finally {
    await app.close();
    runtime.store.close();
  }
}, 30_000);
