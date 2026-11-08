import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRunner } from '../../src/agents/agent-runner.js';
import { TestAgent } from '../../src/agents/test-agent.js';
import { CapabilityRegistry } from '../../src/capabilities/registry.js';
import { SandboxRunner } from '../../src/capabilities/sandbox-runner.js';
import { ToolFactory } from '../../src/capabilities/tool-factory.js';
import { buildApp } from '../../src/api/app.js';
import { registerRoutes, type ApiServices } from '../../src/api/routes.js';
import { ModelGateway, type ModelProvider } from '../../src/model/gateway.js';
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
import { ApprovalRequiredError, PermissionBroker } from '../../src/permissions/permission-broker.js';

const temporaryDirectories: string[] = [];

function multipart(fields: Record<string, string>, file?: { name: string; content: string; type: string }) {
  const boundary = '----jarvis-test-boundary';
  const chunks: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  if (file) {
    chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n${file.content}\r\n`);
  }
  chunks.push(`--${boundary}--\r\n`);
  return { boundary, payload: chunks.join('') };
}

function createApi(modelProvider: ModelProvider = new MockModelProvider()) {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-api-'));
  temporaryDirectories.push(directory);
  const store = new SqliteStore(join(directory, 'jarvis.sqlite'));
  const sandbox = new SandboxRunner();
  const executor = new DefaultHostOperationExecutor();
  const permissionBroker = new PermissionBroker(store, executor, directory);
  const gateway = new ModelGateway(modelProvider);
  const agents = new AgentRunner(gateway);
  const registry = new CapabilityRegistry(store, sandbox);
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
    cancelModelTask: taskId => gateway.cancelTask(taskId),
    clearModelCancellation: taskId => gateway.clearTaskCancellation(taskId),
  });
  const sessionService = new SessionService(store, gateway);
  const taskService = new TaskService(store, loop, permissionBroker, sessionService);
  const services: ApiServices = { taskService, store, registry, sessionService };
  return { store, services, directory, permissionBroker, executor };
}

async function createPendingFolderTask(store: SqliteStore, permissionBroker: PermissionBroker, root: string) {
  const task = store.createTask({ message: 'Create hm', attachments: [], permissionMode: 'request' });
  task.executionCheckpoint = {
    planner: {
      intent: 'create folder hm', acceptanceCriteria: ['folder exists'],
      requiredCapabilities: [{ name: 'create_folder', purpose: 'create hm', riskLevel: 'low' }],
      steps: [{ id: 'create-folder', description: 'Create hm.', dependsOn: [], input: { path: join(root, 'hm') } }], status: 'ready',
    },
    capabilityName: 'filesystem.mkdir', capabilityVersion: '1.0.0', completedStepIds: [], currentStepId: 'create-folder', operationSequence: 0,
  };
  store.saveTask(task);
  const operation = {
    operationId: `${task.id}:create-folder:1.0.0:0`, permission: 'filesystem.write' as const,
    action: 'mkdir', target: 'hm', reason: 'Create the requested directory.', arguments: { path: 'hm' },
  };
  try {
    await permissionBroker.handle(task.id, operation, {
      taskId: task.id, mode: 'request', workspaceRoot: root, capabilityPermissions: ['filesystem.write'],
      capabilityVersion: '1.0.0', stepId: 'create-folder', operationSequence: 0, dryRun: false,
    });
  } catch (error) {
    if (!(error instanceof ApprovalRequiredError)) throw error;
  }
  return store.getTask(task.id)!;
}

async function waitForTerminal(app: Awaited<ReturnType<typeof buildApp>>, taskId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    const payload = response.json();
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(payload.task.status)) return payload;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('task did not reach a terminal state');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('task API', () => {
  it('stops an in-flight model request, records cancellation, and accepts the next session task', async () => {
    const fallback = new MockModelProvider();
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const modelStarted = new Promise<void>(resolve => { started = resolve; });
    let firstPlanner = true;
    const provider: ModelProvider = { async complete(request) {
      if (request.role === 'planner' && firstPlanner) {
        firstPlanner = false;
        signal = request.signal;
        started();
        await new Promise<never>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      return fallback.complete(request);
    } };
    const { services, store } = createApi(provider);
    const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, services) });
    const session = (await app.inject({ method: 'POST', url: '/api/sessions', payload: {} })).json().session.id as string;
    const created = await app.inject({ method: 'POST', url: '/api/tasks', payload: {
      message: 'First task', sessionId: session, attachments: [], permissionMode: 'request',
    } });
    const taskId = created.json().taskId as string;
    await modelStarted;

    const stopped = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/cancel` });
    expect(stopped.json()).toMatchObject({ taskId, status: 'CANCELLED' });
    expect(signal?.aborted).toBe(true);
    expect(store.listEvents(taskId).filter(event => event.type === 'task.cancelled')).toHaveLength(1);
    expect(store.listEvents(taskId).some(event => event.type === 'task.failed')).toBe(false);
    expect(store.listSessionMessages(session).items.some(message => message.taskId === taskId
      && message.role === 'assistant' && message.content.includes('任务已停止'))).toBe(true);
    expect((await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/cancel` })).json().status).toBe('CANCELLED');

    const next = await app.inject({ method: 'POST', url: '/api/tasks', payload: {
      message: 'Second task', sessionId: session, attachments: [], permissionMode: 'request',
    } });
    expect(next.statusCode).toBe(202);
    await waitForTerminal(app, next.json().taskId as string);
    await app.close();
    store.close();
  }, 15_000);

  it('cancels a task awaiting approval and rejects a stale approval', async () => {
    const { services, store, directory, permissionBroker } = createApi();
    const task = await createPendingFolderTask(store, permissionBroker, directory);
    const requestId = task.pendingPermission!.requestId;
    const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, services) });
    const stopped = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/cancel` });
    expect(stopped.json().status).toBe('CANCELLED');
    const approval = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/approval`,
      payload: { requestId, approved: true } });
    expect(approval.statusCode).toBe(409);
    expect(store.getTask(task.id)?.status).toBe('CANCELLED');
    await app.close();
    store.close();
  });

  it('exposes redacted correction progress without the internal round identifier', async () => {
    const { services, store } = createApi();
    const task = store.createTask({ message: 'Summarize a guide', attachments: [] });
    task.correctionState.currentRound = { id: 'private-round-identifier', ordinal: 1,
      target: 'answer', phase: 'test' };
    task.correctionState.failures = [{ stage: 'answer', code: 'ANSWER_MISMATCH', reason: 'Missing section three' }];
    store.saveTask(task);
    const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, services) });
    const response = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}` });
    expect(response.json().task.correction).toMatchObject({ roundsUsed: 0, maxRounds: 5,
      currentOrdinal: 1, target: 'answer', phase: 'test', lastFailure: { code: 'ANSWER_MISMATCH' } });
    expect(response.json().task.correctionState).toBeUndefined();
    expect(response.body).not.toContain('private-round-identifier');
    await app.close();
    store.close();
  });

  it('does not persist or project arbitrary evaluator text as correction feedback', async () => {
    const { services, store } = createApi();
    const task = store.createTask({ message: 'Summarize a guide', attachments: [] });
    task.correctionState.failures = [{ stage: 'answer', code: 'ANSWER_MISMATCH', reason: 'PRIVATE_FILE_BODY' }];
    store.saveTask(task);
    const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, services) });
    const response = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}` });
    expect(response.body).not.toContain('PRIVATE_FILE_BODY');
    expect(JSON.stringify(store.getTask(task.id)?.correctionState)).not.toContain('PRIVATE_FILE_BODY');
    expect(response.json().task.correction.lastFailure.code).toBe('ANSWER_MISMATCH');
    await app.close();
    store.close();
  });

  it('does not expose a finished internal correction round identifier in task events', async () => {
    const { services, store } = createApi();
    const task = store.createTask({ message: 'Summarize a guide', attachments: [] });
    task.correctionState.currentRound = { id: 'private-round-identifier', ordinal: 1,
      target: 'answer', phase: 'evaluate' };
    store.saveTask(task);
    store.finishCorrectionRound(task.id, 'private-round-identifier');
    const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, services) });
    const response = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('private-round-identifier');
    expect(response.json().task.correction.roundsUsed).toBe(1);
    await app.close();
    store.close();
  });

  it('projects legacy and new event payloads without returning untrusted failure text', async () => {
    const { services, store } = createApi();
    const task = store.createTask({ message: 'Summarize a guide', attachments: [] });
    store.appendEvent(task.id, { type: 'test.report', payload: { mode: 'answer_review',
      passed: 0, failed: 1, blocked: 0, reason: 'PRIVATE_FILE_BODY' } });
    store.appendEvent(task.id, { type: 'capability.quarantined', payload: {
      name: 'dynamic.reader', version: '1.0.0', reason: 'PRIVATE_FILE_BODY' } });
    store.appendEvent(task.id, { type: 'task.failed', payload: { message: 'PRIVATE_FILE_BODY' } });
    store.appendEvent(task.id, { type: 'unknown.legacy', payload: { nested: { secret: 'PRIVATE_FILE_BODY' } } });
    const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, services) });
    const response = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('PRIVATE_FILE_BODY');
    expect(response.json().events.find((event: { type: string }) => event.type === 'test.report').payload)
      .toMatchObject({ mode: 'answer_review', failed: 1 });
    await app.close();
    store.close();
  });

  it('does not return attachment bodies or internal execution checkpoints in task polling', async () => {
    const { services, store } = createApi();
    const task = store.createTask({ message: 'Read notes', permissionMode: 'request', attachments: [
      { id: 'attachment-1', filename: 'notes.txt', mimeType: 'text/plain', size: 14, content: 'private-content' },
    ] });
    task.executionCheckpoint = { planner: { secret: 'private-content' }, capabilityName: 'tool', capabilityVersion: '1.0.0',
      completedStepIds: [], currentStepId: 'step', operationSequence: 0 };
    store.saveTask(task);
    const app = await buildApp({ registerRoutes: (instance) => registerRoutes(instance, services) });
    const response = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('private-content');
    expect(response.json().task.attachments[0]).toEqual({ id: 'attachment-1', filename: 'notes.txt', mimeType: 'text/plain', size: 14 });
    expect(response.json().task.executionCheckpoint).toBeUndefined();
    await app.close();
    store.close();
  });

  it('persists a validated permission mode, defaults to request, and rejects unknown modes', async () => {
    const { services, store } = createApi();
    const app = await buildApp({ registerRoutes: (instance) => registerRoutes(instance, services) });

    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { message: 'mode persistence', permissionMode: 'auto' },
    });
    expect(created.statusCode).toBe(202);
    expect(created.json().permissionMode).toBe('auto');
    const fetched = await app.inject({ method: 'GET', url: `/api/tasks/${created.json().taskId}` });
    expect(fetched.json().task.permissionMode).toBe('auto');

    const defaulted = await app.inject({ method: 'POST', url: '/api/tasks', payload: { message: 'default mode' } });
    expect(defaulted.statusCode).toBe(202);
    expect(defaulted.json().permissionMode).toBe('request');

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { message: 'bad mode', permissionMode: 'unrestricted' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(store.getTask(created.json().taskId)?.permissionMode).toBe('auto');

    await waitForTerminal(app, created.json().taskId);
    await waitForTerminal(app, defaulted.json().taskId);
    await app.close();
    store.close();
  });

  it('creates a multipart task, stores the attachment, and exposes final progress', async () => {
    const { services, store } = createApi();
    const app = await buildApp({ registerRoutes: (instance) => registerRoutes(instance, services) });
    const body = multipart({ message: '统计上传内容有多少行' }, { name: 'notes.txt', content: 'a\nb\nc\n', type: 'text/plain' });

    const create = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { 'content-type': `multipart/form-data; boundary=${body.boundary}` },
      payload: body.payload,
    });

    expect(create.statusCode).toBe(202);
    const final = await waitForTerminal(app, create.json().taskId);
    expect(final.task.status).toBe('COMPLETED');
    expect(final.task.result).toContain('3');
    expect(final.events.some((event: { type: string }) => event.type === 'capability.temporary_registered')).toBe(true);
    expect(final.events.some((event: { type: string; payload: { mode?: string; passed?: number } }) =>
      event.type === 'test.report' && event.payload.mode === 'sandbox' && event.payload.passed === 1)).toBe(true);
    expect(final.events.some((event: { type: string; payload: { status?: string } }) =>
      event.type === 'task.status' && event.payload.status === 'TESTING_SANDBOX')).toBe(true);

    await app.close();
    store.close();
  });

  it('accepts a completed presentation draft reference from multipart without returning its contents', async () => {
    const { services, store } = createApi();
    const previous = store.createTask({ message: '写PPT文案', attachments: [] });
    previous.status = 'COMPLETED';
    previous.result = '**第1页｜成果** - 核心内容： 1. 完成开发 2. 通过测试';
    store.saveTask(previous);
    let forwardedSourceTaskId: string | undefined;
    services.taskService = { ...services.taskService, createAndStart: input => {
      forwardedSourceTaskId = input.sourceTaskId;
      return store.createTask(input);
    } };
    const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, services) });
    const body = multipart({ message: '把刚才这份PPT生成文件放桌面', sourceTaskId: previous.id });
    const response = await app.inject({ method: 'POST', url: '/api/tasks',
      headers: { 'content-type': `multipart/form-data; boundary=${body.boundary}` }, payload: body.payload });
    expect(response.statusCode).toBe(202);
    expect(forwardedSourceTaskId).toBe(previous.id);
    const task = store.getTask(response.json().taskId);
    expect(task?.attachments).toHaveLength(0);
    const publicResponse = await app.inject({ method: 'GET', url: `/api/tasks/${task!.id}` });
    expect(publicResponse.body).not.toContain('完成开发');
    await app.close();
    store.close();
  });

  it('returns 404 for an unknown task', async () => {
    const { services, store } = createApi();
    const app = await buildApp({ registerRoutes: (instance) => registerRoutes(instance, services) });

    const response = await app.inject({ method: 'GET', url: '/api/tasks/missing' });
    expect(response.statusCode).toBe(404);

    await app.close();
    store.close();
  });

  it('shows exact bounded process arguments and working directory before approval', async () => {
    const { services, store, directory, permissionBroker } = createApi();
    const task = store.createTask({ message: 'Launch cloudmusic', attachments: [], permissionMode: 'request' });
    store.saveCapability({
      id: 'launch_app', version: '1.0.0', status: 'canary', normalizedIntent: 'launch app',
      manifest: { id: 'launch_app', version: '1.0.0', kind: 'tool', name: 'launch_app', description: 'Launch app',
        inputSchema: {}, outputSchema: {}, entrypoint: 'tool.mjs', runtime: 'node-sandbox-v1', permissions: ['process'],
        riskLevel: 'high', tests: [], provenance: { sourceTaskId: task.id, generatedAt: new Date().toISOString() } },
      code: 'export async function run(input, host) { return host.process.launch({ executable: "C:\\\\Apps\\\\cloudmusic.exe", args: [] }); }',
      evaluation: { targetId: 'launch_app', targetVersion: '1.0.0', verdict: 'pass', score: 1, failures: [], recommendations: [], evaluatorRunId: 'test' },
      createdAt: new Date().toISOString(),
    });
    task.executionCheckpoint = { planner: {}, capabilityName: 'launch_app', capabilityVersion: '1.0.0', completedStepIds: [], currentStepId: 'launch', operationSequence: 0 };
    store.saveTask(task);
    const operation = { operationId: `${task.id}:launch:1.0.0:0`, permission: 'process' as const,
      action: 'launch', target: 'C:\\Apps\\cloudmusic.exe', reason: 'Launch requested app',
      arguments: { executable: 'C:\\Apps\\cloudmusic.exe', args: [] } };
    await expect(permissionBroker.handle(task.id, operation, {
      taskId: task.id, mode: 'request', workspaceRoot: directory, capabilityPermissions: ['process'],
      capabilityVersion: '1.0.0', stepId: 'launch', operationSequence: 0, dryRun: false,
    })).rejects.toBeInstanceOf(ApprovalRequiredError);
    const app = await buildApp({ registerRoutes: (instance) => registerRoutes(instance, services) });
    const response = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}` });
    expect(response.json().task.pendingPermission.operation.arguments).toEqual({ ...operation.arguments, cwd: directory });
    await app.close();
    store.close();
  });

  it('accepts user input for a task waiting for information', async () => {
    const { services, store } = createApi();
    const waiting = store.createTask({ message: 'waiting', attachments: [] });
    waiting.status = 'NEEDS_USER_INPUT';
    store.saveTask(waiting);
    const app = await buildApp({ registerRoutes: (instance) => registerRoutes(instance, services) });

    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${waiting.id}/input`,
      payload: { values: { value: 'provided' } },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().taskId).toBe(waiting.id);

    await app.close();
    store.close();
  });

  it('keeps an invalid clarification pending and accepts a concrete choice', async () => {
    const { services, store } = createApi();
    const waiting = store.createTask({ message: '广东天气怎么样', attachments: [] });
    waiting.status = 'NEEDS_USER_INPUT';
    store.saveTask(waiting);
    store.appendEvent(waiting.id, { type: 'task.needs_user_input', payload: { request: {
      taskId: waiting.id, question: '你想查广东哪个城市？', resumeToken: 'resume-city',
      requiredFields: [{ name: 'city', reason: '天气需要具体城市', sensitive: false }],
      options: [{ label: '广州', value: '广州' }, { label: '深圳', value: '深圳' }, { label: '东莞', value: '东莞' }],
    } } });
    const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, services) });
    const question = await app.inject({ method: 'GET', url: `/api/tasks/${waiting.id}` });
    expect(question.json().events.at(-1).payload.request.options).toHaveLength(3);
    const invalid = await app.inject({ method: 'POST', url: `/api/tasks/${waiting.id}/input`,
      payload: { values: { answer: '广东省' } } });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error).toContain('具体城市');
    expect(store.getTask(waiting.id)?.status).toBe('NEEDS_USER_INPUT');
    expect(store.getTask(waiting.id)?.message).toBe('广东天气怎么样');
    const valid = await app.inject({ method: 'POST', url: `/api/tasks/${waiting.id}/input`,
      payload: { values: { answer: '深圳' } } });
    expect(valid.statusCode).toBe(202);
    expect(valid.json().status).not.toBe('FAILED');
    expect(store.getTask(waiting.id)?.message).toContain('"answer":"深圳"');
    await app.close();
    store.close();
  });

  it('asks a focused follow-up when routing finds a semantically wrong custom answer', async () => {
    const provider: ModelProvider = { async complete(request) {
      expect(request.role).toBe('planner.route');
      return { data: { status: 'ready', scenario: 'weather', clarificationValid: false,
        followUpQuestion: '请提供地球上的具体城市。' }, usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    const { services, store } = createApi(provider);
    const waiting = store.createTask({ message: '广东天气怎么样', attachments: [] });
    waiting.status = 'NEEDS_USER_INPUT';
    store.saveTask(waiting);
    store.appendEvent(waiting.id, { type: 'task.needs_user_input', payload: { request: {
      taskId: waiting.id, question: '你想查广东哪个城市？', resumeToken: 'resume-city',
      requiredFields: [{ name: 'city', reason: '天气需要具体城市', sensitive: false }],
      options: [{ label: '广州', value: '广州' }, { label: '深圳', value: '深圳' }, { label: '东莞', value: '东莞' }],
    } } });
    const app = await buildApp({ registerRoutes: instance => registerRoutes(instance, services) });
    const submitted = await app.inject({ method: 'POST', url: `/api/tasks/${waiting.id}/input`,
      payload: { values: { answer: '火星' } } });
    expect(submitted.statusCode).toBe(202);
    expect(submitted.json().status).toBe('NEEDS_USER_INPUT');
    const detail = (await app.inject({ method: 'GET', url: `/api/tasks/${waiting.id}` })).json();
    const lastQuestion = detail.events.filter((event: { type: string }) => event.type === 'task.needs_user_input').at(-1);
    expect(lastQuestion.payload.request.question).toBe('请提供地球上的具体城市。');
    expect(lastQuestion.payload.request.options).toHaveLength(3);
    await app.close();
    store.close();
  });

  it('resolves the exact approval, resumes the checkpoint, and does not repeat a duplicate decision', async () => {
    const { services, store, directory, permissionBroker, executor } = createApi();
    const task = await createPendingFolderTask(store, permissionBroker, directory);
    expect(task.status).toBe('WAITING_FOR_APPROVAL');
    expect(existsSync(join(directory, 'hm'))).toBe(false);
    const execution = vi.spyOn(executor, 'execute');
    const app = await buildApp({ registerRoutes: (instance) => registerRoutes(instance, services) });
    const pendingView = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}` });
    expect(pendingView.json().task.permissionMode).toBe('request');
    expect(pendingView.json().task.pendingPermission.operation.arguments).toEqual({});

    const response = await app.inject({
      method: 'POST', url: `/api/tasks/${task.id}/approval`,
      payload: { requestId: task.pendingPermission!.requestId, approved: true },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe('COMPLETED');
    expect(existsSync(join(directory, 'hm'))).toBe(true);
    expect(execution).toHaveBeenCalledTimes(1);

    const duplicate = await app.inject({
      method: 'POST', url: `/api/tasks/${task.id}/approval`,
      payload: { requestId: task.pendingPermission!.requestId, approved: true },
    });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json().status).toBe('COMPLETED');
    expect(execution).toHaveBeenCalledTimes(1);

    await app.close();
    store.close();
  });

  it('rejects stale approval IDs and denies without invoking the host', async () => {
    const { services, store, directory, permissionBroker, executor } = createApi();
    const task = await createPendingFolderTask(store, permissionBroker, directory);
    const execution = vi.spyOn(executor, 'execute');
    const app = await buildApp({ registerRoutes: (instance) => registerRoutes(instance, services) });

    const stale = await app.inject({
      method: 'POST', url: `/api/tasks/${task.id}/approval`, payload: { requestId: 'wrong-id', approved: true },
    });
    expect(stale.statusCode).toBe(409);

    const denied = await app.inject({
      method: 'POST', url: `/api/tasks/${task.id}/approval`,
      payload: { requestId: task.pendingPermission!.requestId, approved: false },
    });
    expect(denied.statusCode).toBe(202);
    expect(denied.json().status).toBe('CANCELLED');
    expect(execution).not.toHaveBeenCalled();
    expect(existsSync(join(directory, 'hm'))).toBe(false);

    await app.close();
    store.close();
  });
});
