import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRunner } from '../../src/agents/agent-runner.js';
import { TestAgent } from '../../src/agents/test-agent.js';
import { CapabilityRegistry } from '../../src/capabilities/registry.js';
import { SandboxRunner } from '../../src/capabilities/sandbox-runner.js';
import { ToolFactory } from '../../src/capabilities/tool-factory.js';
import { buildApp } from '../../src/api/app.js';
import { registerRoutes, type ApiServices } from '../../src/api/routes.js';
import { ModelGateway } from '../../src/model/gateway.js';
import { z } from 'zod';
import { MockModelProvider } from '../../src/model/mock-provider.js';
import { AgentLoop } from '../../src/runtime/agent-loop.js';
import { SessionService } from '../../src/runtime/session-service.js';
import { TestExecutor } from '../../src/runtime/test-executor.js';
import { WindowsDesktopObserver } from '../../src/runtime/windows-desktop-observer.js';
import { BudgetManager } from '../../src/runtime/budget-manager.js';
import { AdaptiveScheduler } from '../../src/runtime/scheduler.js';
import { TaskService } from '../../src/runtime/task-service.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { DefaultHostOperationExecutor } from '../../src/permissions/host-operations.js';
import { PermissionBroker } from '../../src/permissions/permission-broker.js';

const temporaryDirectories: string[] = [];
const openStores: SqliteStore[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createApi() {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-session-api-'));
  temporaryDirectories.push(directory);
  const store = new SqliteStore(join(directory, 'jarvis.sqlite'));
  openStores.push(store);
  const sandbox = new SandboxRunner();
  const permissionBroker = new PermissionBroker(store, new DefaultHostOperationExecutor(), directory);
  const gateway = new ModelGateway(new MockModelProvider());
  const agents = new AgentRunner(gateway);
  const registry = new CapabilityRegistry(store, sandbox);
  const sessionService = new SessionService(store, gateway, 2_000);
  const loop = new AgentLoop({
    store,
    agents,
    tester: new TestAgent(gateway),
    testExecutor: new TestExecutor(sandbox),
    desktopObserver: new WindowsDesktopObserver(),
    factory: new ToolFactory(agents),
    registry,
    sandbox,
    budget: new BudgetManager({ maxContextTokens: 32_000, outputReserveTokens: 4_000 }),
    scheduler: new AdaptiveScheduler({ maxConcurrency: 3 }),
    maxRetries: 5,
    maxSteps: 50,
    permissionBroker,
    workspaceRoot: directory,
    sessionMemory: sessionService,
  });
  const taskService = new TaskService(store, loop, permissionBroker, sessionService);
  const services: ApiServices = { taskService, store, registry, sessionService };
  return { store, services, directory };
}

async function waitForTerminal(app: Awaited<ReturnType<typeof buildApp>>, taskId: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    const payload = response.json();
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(payload.task.status)) return payload;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('task did not reach a terminal state');
}

describe('session API', () => {
  it('returns persisted article sources with the completed assistant message', async () => {
    const { services, store } = createApi();
    const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, services) });
    const session = store.createSession('资料引用');
    const task = store.createTask({ message: '查资料', attachments: [], sessionId: session.id });
    task.status = 'COMPLETED';
    task.result = '已根据资料回答。';
    store.saveTask(task);
    store.appendEvent(task.id, { type: 'research.searched', payload: { sourceCount: 1, sources: [
      { title: '官方文档', url: 'https://docs.example.com/article?token=private' },
    ] } });
    store.insertAssistantMessage(session.id, task.id, task.result);
    const response = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/messages` });
    expect(response.statusCode).toBe(200);
    expect(response.json().messages[0].sources).toEqual([
      { title: '官方文档', url: 'https://docs.example.com/article' },
    ]);
    expect(JSON.stringify(response.json())).not.toContain('private');
    await app.close();
  });

  it('shows scoped model calls and projected events in the trajectory endpoint', async () => {
    const { services, store } = createApi();
    const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, services) });
    const session = store.createSession('Trace');
    const other = store.createSession('Other');
    const task = store.createTask({ message: 'Trace this', attachments: [], sessionId: session.id });
    const unrelated = store.createTask({ message: 'Other task', attachments: [], sessionId: other.id });
    store.appendEvent(task.id, { type: 'task.status', payload: { status: 'EXECUTING', secret: 'hidden' } });
    const now = new Date().toISOString();
    store.createOperation({ taskId: task.id, operationId: 'op-1', state: 'completed',
      operation: { operationId: 'op-1', permission: 'network', action: 'request',
        target: 'https://example.com/data?token=private', reason: 'Fetch', arguments: { token: 'private' } },
      result: { ok: false, error: { code: 'NETWORK_FAILED', message: 'Private details' } },
      createdAt: now, updatedAt: now });
    store.startModelTrace({ role: 'other', taskId: unrelated.id, system: 'x', user: 'y' });
    const gateway = new ModelGateway({ complete: async () => ({
      data: { answer: 'ok' }, usage: { inputTokens: 12, outputTokens: 3 }, requestId: 'model-request',
    }), describeRequest: () => ({ provider: 'test', model: 'trace-model', temperature: 0 }) },
    { start: (request, details) => store.startModelTrace(request, 'trace-model', details),
      finish: (id, outcome) => store.finishModelTrace(id, outcome) });
    await gateway.complete({ taskId: task.id, role: 'planner', system: 'System', user: 'Bearer secret-value' },
      z.object({ answer: z.string() }));
    await gateway.complete({ sessionId: session.id, role: 'session.compaction', system: 'Summarize', user: 'History' },
      z.object({ answer: z.string() }));

    const response = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/trajectory` });
    expect(response.statusCode).toBe(200);
    const entries = response.json().entries;
    expect(entries).toHaveLength(4);
    const model = entries.find((entry: { type: string }) => entry.type === 'planner');
    expect(model.model).toMatchObject({ modelName: 'trace-model', status: 'completed',
      inputTokens: 12, outputTokens: 3, requestId: 'model-request' });
    expect(model.model.user).toContain('[已隐藏]');
    expect(model.model.request).toMatchObject({ provider: 'test', temperature: 0 });
    expect(model.model.request.validationSchema.properties).toHaveProperty('answer');
    expect(model.model.finishedAt).toBeTruthy();
    expect(entries.find((entry: { type: string }) => entry.type === 'session.compaction').taskId).toBeNull();
    const event = entries.find((entry: { kind: string }) => entry.kind === 'event');
    expect(event.payload).toEqual({ status: 'EXECUTING' });
    const operation = entries.find((entry: { kind: string }) => entry.kind === 'operation');
    expect(operation.operation).toMatchObject({ state: 'completed', success: false, errorCode: 'NETWORK_FAILED',
      target: 'https://example.com/data?[query redacted]' });
    expect(JSON.stringify(operation)).not.toContain('Private details');
    expect(response.json().summary).toMatchObject({ events: 1, modelCalls: 2, operations: 1,
      failedOperations: 1, inputTokens: 24, outputTokens: 6 });
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/trajectory` })).json().entries).toHaveLength(3);
    const paged = (await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/trajectory?limit=1` })).json();
    expect(paged.hasMore).toBe(true);
    expect(paged.summary.modelCalls).toBe(2);

    await app.close();
    store.close();
  });

  it('returns a detailed text log scoped to one session', async () => {
    const { services, store } = createApi();
    const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, services) });
    const session = store.createSession('日志会话 A');
    const other = store.createSession('日志会话 B');
    const task = store.createTask({ message: '读取网页', attachments: [], sessionId: session.id });
    const unrelated = store.createTask({ message: '另一会话', attachments: [], sessionId: other.id });
    task.status = 'FAILED';
    task.result = '任务未完成：工具输入无效';
    task.updatedAt = new Date().toISOString();
    store.saveTask(task);
    store.appendEvent(task.id, { type: 'task.failed', payload: { message: '输入参数无效' } });
    const traceId = store.startModelTrace({ taskId: task.id, role: 'planner', system: 's', user: 'u' }, 'trace-model');
    store.finishModelTrace(traceId, { error: '模型请求失败：输入参数无效', rawResponse: '{"error":"bad request"}', errorDetails: { name: 'BadRequestError', statusCode: 400 } });
    store.appendEvent(unrelated.id, { type: 'task.failed', payload: { message: '不应出现在 A' } });

    const response = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/logs` });
    expect(response.statusCode).toBe(200);
    const log = response.json();
    expect(log.scopeId).toBe(session.id);
    expect(log.text).toContain('模型请求失败：输入参数无效');
    expect(log.text).toContain('任务未完成：工具输入无效');
    expect(log.text).toContain('statusCode');
    expect(log.text).not.toContain('不应出现在 A');
    expect(log.summary.errors).toBeGreaterThan(0);

    await app.close();
    store.close();
  });

  it('creates, lists, renames, and deletes sessions', async () => {
    const { services } = createApi();
    const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, services) });

    const created = await app.inject({ method: 'POST', url: '/api/sessions', payload: { title: '周报会话' } });
    expect(created.statusCode).toBe(201);
    const session = created.json().session;
    expect(session.title).toBe('周报会话');
    expect(session.memoryBudget).toBe(services.sessionService.budgetTokens);

    const renamed = await app.inject({ method: 'PATCH', url: `/api/sessions/${session.id}`, payload: { title: '数据整理' } });
    expect(renamed.json().session.title).toBe('数据整理');

    const listed = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(listed.json().sessions.map((item: { id: string }) => item.id)).toEqual([session.id]);

    const removed = await app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}` });
    expect(removed.json().ok).toBe(true);
    const detail = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}` });
    expect(detail.statusCode).toBe(404);

    await app.close();
    services.store.close();
  });

  it('pins and unpins an individual session through the API', async () => {
    const { services } = createApi();
    const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, services) });
    const first = services.store.createSession('需要置顶');
    const recent = services.store.createSession('最近会话');

    const pinned = await app.inject({ method: 'PATCH', url: `/api/sessions/${first.id}`, payload: { pinned: true } });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json().session.pinnedAt).toBeTruthy();
    const list = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(list.json().sessions.map((session: { id: string }) => session.id)).toEqual([first.id, recent.id]);
    expect(list.json().sessions[0].pinnedAt).toBe(pinned.json().session.pinnedAt);

    const unpinned = await app.inject({ method: 'PATCH', url: `/api/sessions/${first.id}`, payload: { pinned: false } });
    expect(unpinned.statusCode).toBe(200);
    expect(unpinned.json().session.pinnedAt).toBeNull();
    const invalid = await app.inject({ method: 'PATCH', url: `/api/sessions/${first.id}`, payload: { pinned: 'yes' } });
    expect(invalid.statusCode).toBe(400);

    await app.close();
    services.store.close();
  });

  it('runs a task inside a session, records both sides, and names the session after the first message', async () => {
    const { services } = createApi();
    const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, services) });
    const session = services.sessionService.createSession();

    const created = await app.inject({
      method: 'POST', url: '/api/tasks',
      payload: { message: '统计上传内容有多少行', sessionId: session.id,
        attachments: [{ id: 'a1', filename: 'notes.txt', mimeType: 'text/plain', size: 6, content: 'a\nb\nc\n' }] },
    });
    expect(created.statusCode).toBe(202);
    const taskId = created.json().taskId;
    const finished = await waitForTerminal(app, taskId);
    expect(finished.task.status).toBe('COMPLETED');
    expect(finished.task.sessionId).toBe(session.id);

    const detail = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}` });
    expect(detail.json().session.title).toBe('统计上传内容有多少行');
    expect(detail.json().session.messageCount).toBeGreaterThanOrEqual(2);

    const messages = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/messages` });
    const roles = messages.json().messages.map((item: { role: string }) => item.role);
    expect(roles[0]).toBe('user');
    expect(roles).toContain('assistant');
    const assistant = messages.json().messages.find((item: { role: string }) => item.role === 'assistant');
    expect(assistant.taskId).toBe(taskId);
    expect(assistant.taskStatus).toBe('COMPLETED');

    await app.close();
    services.store.close();
  });

  it('rejects a second concurrent task in the same session but allows other sessions', async () => {
    const { services } = createApi();
    const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, services) });
    const session = services.sessionService.createSession();

    const first = await app.inject({
      method: 'POST', url: '/api/tasks',
      payload: { message: '统计上传内容有多少行', sessionId: session.id,
        attachments: [{ id: 'a1', filename: 'notes.txt', mimeType: 'text/plain', size: 6, content: 'a\nb\nc\n' }] },
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: 'POST', url: '/api/tasks',
      payload: { message: '再来一个任务', sessionId: session.id },
    });
    expect(second.statusCode).toBe(409);

    const otherSession = services.sessionService.createSession();
    const other = await app.inject({
      method: 'POST', url: '/api/tasks',
      payload: { message: '统计上传内容有多少行', sessionId: otherSession.id,
        attachments: [{ id: 'a2', filename: 'notes.txt', mimeType: 'text/plain', size: 6, content: 'a\nb\nc\n' }] },
    });
    expect(other.statusCode).toBe(202);

    await waitForTerminal(app, first.json().taskId);
    const afterFirstFinishes = await app.inject({
      method: 'POST', url: '/api/tasks',
      payload: { message: '统计上传内容有多少行', sessionId: session.id },
    });
    expect(afterFirstFinishes.statusCode).toBe(202);

    await Promise.all([
      waitForTerminal(app, other.json().taskId),
      waitForTerminal(app, afterFirstFinishes.json().taskId),
    ]);

    await app.close();
    services.store.close();
  });

  it('returns 404 for tasks posted to a missing session', async () => {
    const { services } = createApi();
    const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, services) });
    const response = await app.inject({
      method: 'POST', url: '/api/tasks',
      payload: { message: '孤儿消息', sessionId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
    services.store.close();
  });

  it('pages history backwards with a seq cursor', async () => {
    const { services } = createApi();
    const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, services) });
    const session = services.sessionService.createSession();
    for (let index = 0; index < 5; index += 1) {
      services.sessionService.recordUserTurn(session.id, `task-${index}`, `消息 ${index}`);
    }
    const firstPage = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/messages?limit=2` });
    const body = firstPage.json();
    expect(body.messages.map((item: { content: string }) => item.content)).toEqual(['消息 3', '消息 4']);
    expect(body.hasMore).toBe(true);
    const secondPage = await app.inject({
      method: 'GET', url: `/api/sessions/${session.id}/messages?limit=50&before=${body.messages[0].seq}`,
    });
    expect(secondPage.json().messages.map((item: { content: string }) => item.content))
      .toEqual(['消息 0', '消息 1', '消息 2']);
    expect(secondPage.json().hasMore).toBe(false);

    await app.close();
    services.store.close();
  });

  it('compacts a long session manually and exposes the summary without deleting history', async () => {
    const { services } = createApi();
    const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, services) });
    const session = services.sessionService.createSession();
    for (let index = 0; index < 6; index += 1) {
      services.sessionService.recordUserTurn(session.id, `task-${index}`, `问题 ${index} ${'细节'.repeat(300)}`);
      services.store.appendSessionMessage({ sessionId: session.id, role: 'assistant', content: '结论'.repeat(300), taskId: `task-${index}` });
    }

    const compacted = await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/compact` });
    expect(compacted.statusCode).toBe(200);
    const body = compacted.json();
    expect(body.compacted).toBe(true);
    expect(body.session.summary).toContain('检查点');

    const snapshot = services.store.getSessionMemorySnapshot(session.id)!;
    expect(snapshot.summary).toContain('检查点');
    expect(snapshot.turns.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.tokens).toBeLessThan(services.sessionService.triggerTokens);

    const messages = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/messages` });
    const roles = messages.json().messages.map((item: { role: string }) => item.role);
    expect(roles.filter((role: string) => role === 'user')).toHaveLength(6);
    expect(roles.at(-1)).toBe('compaction');

    await app.close();
    services.store.close();
  });

  it('keeps legacy tasks listable through the unassigned endpoint', async () => {
    const { services, store } = createApi();
    const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, services) });
    const legacy = store.createTask({ message: '没有会话的旧任务', attachments: [] });
    const response = await app.inject({ method: 'GET', url: '/api/legacy-tasks' });
    const task = response.json().tasks.find((item: { id: string }) => item.id === legacy.id);
    expect(task.message).toBe('没有会话的旧任务');
    await app.close();
    store.close();
  });
});
