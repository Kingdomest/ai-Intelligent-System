import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { registerRoutes } from '../../src/api/routes.js';
import { createDependencies } from '../../src/runtime/dependencies.js';

const resources: Array<{ close: () => Promise<void>; directory: string }> = [];

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-a2a-api-'));
  const runtime = createDependencies({ dataDir: directory, modelMode: 'mock' });
  const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, runtime) });
  resources.push({ close: async () => { await app.close(); runtime.store.close(); }, directory });
  const task = runtime.store.createTask({ message: 'a2a task', attachments: [] });
  return { app, runtime, task };
}

afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop()!;
    await resource.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe('A2A local API', () => {
  it('returns the local Agent Card and supports child messaging and acknowledgment', async () => {
    const { app, task } = await setup();
    const card = await app.inject({ method: 'GET', url: '/.well-known/agent-card.json' });
    expect(card.statusCode).toBe(200);
    expect(card.json().protocolVersion).toBe('a2a-local-v1');

    const created = await app.inject({ method: 'POST', url: '/api/a2a/agents',
      payload: { rootTaskId: task.id, name: '主 Agent', role: '统筹', goal: '完成任务' } });
    expect(created.statusCode).toBe(201);
    const mainId = created.json().agent.id;
    const children = await app.inject({ method: 'POST', url: '/api/a2a/agents',
      payload: { parentAgentId: mainId, children: [
        { name: '研究 Agent', role: '研究', goal: '收集资料' },
        { name: '写作 Agent', role: '写作', goal: '形成草稿' },
      ] } });
    expect(children.statusCode).toBe(201);
    expect(children.json().agents).toHaveLength(2);
    const [research, writer] = children.json().agents;
    const sent = await app.inject({ method: 'POST', url: `/api/a2a/agents/${research.id}/messages`,
      payload: { messageId: 'api-message-1', recipientAgentId: writer.id, type: 'artifact',
        payload: { summary: '完成资料整理' } } });
    expect(sent.statusCode).toBe(202);
    expect(sent.json().message.id).toBe('api-message-1');
    const inbox = await app.inject({ method: 'GET', url: `/api/a2a/agents/${writer.id}/inbox?status=queued` });
    expect(inbox.json().messages).toHaveLength(1);
    const ack = await app.inject({ method: 'POST', url: '/api/a2a/messages/api-message-1/ack',
      payload: { agentId: writer.id, status: 'read' } });
    expect(ack.statusCode).toBe(200);
    expect(ack.json().message.status).toBe('read');
  });

  it('rejects cross-tree delivery and supports bounded JSON-RPC envelopes', async () => {
    const { app, task, runtime } = await setup();
    const otherTask = runtime.store.createTask({ message: 'other', attachments: [] });
    const mainA = runtime.a2aProtocol.createAgent({ rootTaskId: task.id, name: 'A', role: '主', goal: 'A' });
    const mainB = runtime.a2aProtocol.createAgent({ rootTaskId: otherTask.id, name: 'B', role: '主', goal: 'B' });
    const denied = await app.inject({ method: 'POST', url: `/api/a2a/agents/${mainA.id}/messages`,
      payload: { recipientAgentId: mainB.id, type: 'event', payload: { text: 'cross-tree' } } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('ROOT_TASK_MISMATCH');

    const rpc = await app.inject({ method: 'POST', url: '/api/a2a/jsonrpc', payload: {
      jsonrpc: '2.0', id: 'rpc-1', method: 'agents/list', params: { rootTaskId: task.id },
    } });
    expect(rpc.statusCode).toBe(200);
    expect(rpc.json()).toMatchObject({ jsonrpc: '2.0', id: 'rpc-1', result: { agents: [{ id: mainA.id }] } });
    const invalid = await app.inject({ method: 'POST', url: '/api/a2a/jsonrpc', payload: {
      jsonrpc: '2.0', id: 'rpc-2', method: 'unknown', params: {},
    } });
    expect(invalid.json()).toMatchObject({ jsonrpc: '2.0', id: 'rpc-2', error: { code: -32601 } });
  });
});
