import { randomUUID } from 'node:crypto';
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CapabilityRegistry } from '../capabilities/registry.js';
import type { Attachment, CreateTaskInput } from '../domain/contracts.js';
import { TaskService } from '../runtime/task-service.js';
import { ClarificationInputError } from '../runtime/agent-loop.js';
import { SessionMemoryFullError, SessionService } from '../runtime/session-service.js';
import { SqliteStore } from '../storage/sqlite-store.js';
import { MAX_CORRECTION_ROUNDS } from '../runtime/correction-round.js';
import { persistableCorrectionFailure } from '../runtime/correction-router.js';
import { publicTaskEvent } from '../runtime/event-projection.js';
import { answerSourcesFromEvents } from '../runtime/answer-sources.js';
import { buildSessionLog } from '../runtime/session-logs.js';
import { buildTaskFlow } from '../runtime/task-flow.js';
import { registerA2ARoutes } from './a2a-routes.js';
import type { A2AProtocol } from '../agents/a2a-protocol.js';
import type { AgentController } from '../runtime/agent-controller.js';
import type { McpService } from '../mcp/service.js';
import type { ToolDiscovery } from '../capabilities/tool-discovery.js';

export interface ApiServices {
  taskService: Pick<TaskService, 'createAndStart' | 'resumeWithInput' | 'resolveApproval' | 'cancelTask'>;
  store: SqliteStore;
  registry: CapabilityRegistry;
  sessionService: SessionService;
  a2aProtocol?: A2AProtocol;
  agentController?: AgentController;
  mcp?: McpService;
  toolDiscovery?: ToolDiscovery;
}

const taskBodySchema = z.object({
  message: z.string().min(1),
  sourceTaskId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  permissionMode: z.enum(['request', 'auto', 'full']).default('request'),
  attachments: z.array(z.object({
    id: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number(),
    content: z.string().optional(),
  })).default([]),
});

const inputBodySchema = z.object({ values: z.record(z.string(), z.unknown()) });

const sessionCreateSchema = z.object({ title: z.string().trim().max(80).optional() });
const sessionPatchSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  status: z.enum(['active', 'archived']).optional(),
  pinned: z.boolean().optional(),
});
const sessionListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  includeArchived: z.enum(['0', '1']).default('0'),
});
const messageListQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const trajectoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export async function registerRoutes(app: FastifyInstance, services: ApiServices): Promise<void> {
  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 10, parts: 20 },
  });
  if (services.a2aProtocol && services.agentController) {
    registerA2ARoutes(app, services.a2aProtocol, services.agentController, services.store);
  }
  app.get('/api/mcp/servers', async () => ({ servers: services.mcp ? await services.mcp.inspect() : [] }));
  app.get('/api/tools', async () => ({ tools: services.toolDiscovery ? await services.toolDiscovery.list() : [] }));
  app.get('/api/tools/search', async (request, reply) => {
    const parsed = z.object({ query: z.string().trim().min(1).max(500),
      limit: z.coerce.number().int().min(1).max(30).default(8) }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: '需要 query（最多 500 字符）和 1～30 的 limit。' });
    return { query: parsed.data.query, tools: services.toolDiscovery
      ? await services.toolDiscovery.search(parsed.data.query, parsed.data.limit) : [] };
  });

  app.post('/api/tasks', async (request, reply) => {
    try {
      const input = request.isMultipart()
        ? await parseMultipartTask(request)
        : taskBodySchema.parse(request.body);
      if (input.sessionId) {
        const session = services.sessionService.getSession(input.sessionId);
        if (!session) return reply.code(404).send({ error: '会话不存在。' });
        if (session.status === 'archived') return reply.code(409).send({ error: '会话已归档，请先恢复后再继续对话。' });
        if (services.store.hasActiveTaskInSession(input.sessionId)) {
          return reply.code(409).send({ error: '该会话仍有进行中的任务，请等待其结束后再发送新消息。' });
        }
        await services.sessionService.ensureTurnCapacity(input.sessionId);
      }
      const task = services.taskService.createAndStart(input);
      if (input.sessionId) services.sessionService.recordUserTurn(input.sessionId, task.id, input.message);
      return reply.code(202).send({ taskId: task.id, status: task.status, permissionMode: task.permissionMode });
    } catch (error) {
      if (error instanceof SessionMemoryFullError) {
        return reply.code(409).send({ error: error.message, code: error.code });
      }
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid task request.' });
    }
  });

  app.get<{ Params: { taskId: string } }>('/api/tasks/:taskId', async (request, reply) => {
    const task = services.store.getTask(request.params.taskId);
    if (!task) return reply.code(404).send({ error: 'Task not found.' });
    const pendingPermission = task.pendingPermission
      ? { ...task.pendingPermission, operation: { ...task.pendingPermission.operation,
        arguments: task.pendingPermission.operation.permission === 'process'
          ? {
            command: task.pendingPermission.operation.arguments.command,
            executable: task.pendingPermission.operation.arguments.executable,
            args: task.pendingPermission.operation.arguments.args,
            cwd: task.pendingPermission.operation.arguments.cwd ?? null,
          } : {},
      } }
      : undefined;
    const { executionCheckpoint: _internalCheckpoint, correctionState: _internalCorrection, ...publicTask } = task;
    const lastFailure = task.correctionState.failures.at(-1);
    const correction = {
      roundsUsed: task.correctionState.roundsUsed,
      maxRounds: MAX_CORRECTION_ROUNDS,
      currentOrdinal: task.correctionState.currentRound?.ordinal,
      target: task.correctionState.currentRound?.target,
      phase: task.correctionState.currentRound?.phase,
      lastFailure: lastFailure ? (({ code, reason }) => ({ code, reason }))(persistableCorrectionFailure(lastFailure)) : undefined,
    };
    return {
      task: { ...publicTask, correction, attachments: task.attachments.map(({ content: _content, ...metadata }) => metadata), pendingPermission },
      events: services.store.listEvents(task.id).map(publicTaskEvent),
      result: task.result ?? null,
    };
  });

  app.get<{ Params: { taskId: string } }>('/api/tasks/:taskId/flow', async (request, reply) => {
    const task = services.store.getTask(request.params.taskId);
    if (!task) return reply.code(404).send({ error: 'Task not found.' });
    return buildTaskFlow(task, services.store.listAgents(task.id),
      services.store.listTaskAgentMessages(task.id), services.store.listEvents(task.id));
  });

  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/cancel', async (request, reply) => {
    if (!services.store.getTask(request.params.taskId)) return reply.code(404).send({ error: 'Task not found.' });
    try {
      const task = await services.taskService.cancelTask(request.params.taskId);
      return { taskId: task.id, status: task.status };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'Task cannot be stopped.' });
    }
  });

  app.get<{ Params: { taskId: string } }>('/api/tasks/:taskId/trajectory', async (request, reply) => {
    if (!services.store.getTask(request.params.taskId)) return reply.code(404).send({ error: 'Task not found.' });
    const query = trajectoryQuerySchema.parse(request.query ?? {});
    const page = services.store.listTrajectory({ taskId: request.params.taskId }, query.limit, query.offset);
    return { ...page, entries: page.entries.map(entry => entry.kind === 'event'
      ? { ...entry, ...publicTaskEvent({ type: entry.type, payload: entry.payload ?? {}, createdAt: entry.createdAt }) }
      : entry) };
  });

  app.get<{ Params: { taskId: string } }>('/api/tasks/:taskId/logs', async (request, reply) => {
    const task = services.store.getTask(request.params.taskId);
    if (!task) return reply.code(404).send({ error: 'Task not found.' });
    const page = services.store.listTrajectory({ taskId: request.params.taskId }, 10_000, 0);
    const entries = page.entries.map(entry => entry.kind === 'event'
      ? { ...entry, ...publicTaskEvent({ type: entry.type, payload: entry.payload ?? {}, createdAt: entry.createdAt }) }
      : entry);
    return buildSessionLog({ taskId: task.id, entries, tasks: [{ id: task.id, message: task.message, status: task.status,
      result: task.result, createdAt: task.createdAt, updatedAt: task.updatedAt }] });
  });

  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/input', async (request, reply) => {
    try {
      const body = inputBodySchema.parse(request.body);
      const task = await services.taskService.resumeWithInput(request.params.taskId, body.values);
      return reply.code(202).send({ taskId: task.id, status: task.status });
    } catch (error) {
      if (error instanceof ClarificationInputError) {
        return reply.code(422).send({ error: error.message, code: error.code });
      }
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'Task cannot accept input.' });
    }
  });

  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/approval', async (request, reply) => {
    let body: { requestId: string; approved: boolean };
    try {
      body = z.object({ requestId: z.string().min(1), approved: z.boolean() }).parse(request.body);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid approval decision.' });
    }
    try {
      const task = await services.taskService.resolveApproval(request.params.taskId, body.requestId, body.approved);
      return reply.code(202).send({ taskId: task.id, status: task.status, permissionMode: task.permissionMode });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'Approval request cannot be resolved.' });
    }
  });

  app.get('/api/capabilities', async () => ({ capabilities: await services.registry.listTools() }));

  app.post('/api/sessions', async (request, reply) => {
    const body = sessionCreateSchema.parse(request.body ?? {});
    const session = services.sessionService.createSession(body.title);
    return reply.code(201).send({
      session: { ...session, memoryBudget: services.sessionService.budgetTokens },
    });
  });

  app.get('/api/sessions', async (request, reply) => {
    const query = sessionListQuerySchema.parse(request.query ?? {});
    const page = services.sessionService.listSessions({
      limit: query.limit,
      cursor: query.cursor,
      includeArchived: query.includeArchived === '1',
    });
    return {
      sessions: page.items.map(persistableSession(services)),
      nextCursor: page.nextCursor,
    };
  });

  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId', async (request, reply) => {
    const session = services.sessionService.getSession(request.params.sessionId);
    if (!session) return reply.code(404).send({ error: '会话不存在。' });
    return { session: { ...session, memoryBudget: services.sessionService.budgetTokens } };
  });

  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/messages', async (request, reply) => {
    const query = messageListQuerySchema.parse(request.query ?? {});
    if (!services.sessionService.getSession(request.params.sessionId)) {
      return reply.code(404).send({ error: '会话不存在。' });
    }
    const page = services.sessionService.listMessages(request.params.sessionId, {
      before: query.before,
      limit: query.limit,
    });
    return { messages: page.items.map(message => ({ ...persistableMessage(message),
      sources: message.role === 'assistant' && message.taskStatus === 'COMPLETED' && message.taskId
        ? answerSourcesFromEvents(services.store.listEvents(message.taskId)) : [],
    })), hasMore: page.hasMore };
  });

  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/trajectory', async (request, reply) => {
    if (!services.sessionService.getSession(request.params.sessionId)) {
      return reply.code(404).send({ error: '会话不存在。' });
    }
    const query = trajectoryQuerySchema.parse(request.query ?? {});
    const page = services.store.listTrajectory({ sessionId: request.params.sessionId }, query.limit, query.offset);
    return { ...page, entries: page.entries.map(entry => entry.kind === 'event'
      ? { ...entry, ...publicTaskEvent({ type: entry.type, payload: entry.payload ?? {}, createdAt: entry.createdAt }) }
      : entry) };
  });

  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/logs', async (request, reply) => {
    if (!services.sessionService.getSession(request.params.sessionId)) {
      return reply.code(404).send({ error: '会话不存在。' });
    }
    const page = services.store.listTrajectory({ sessionId: request.params.sessionId }, 10_000, 0);
    const entries = page.entries.map(entry => entry.kind === 'event'
      ? { ...entry, ...publicTaskEvent({ type: entry.type, payload: entry.payload ?? {}, createdAt: entry.createdAt }) }
      : entry);
    const tasks = services.store.listTasksForSession(request.params.sessionId).map(task => ({ id: task.id, message: task.message,
      status: task.status, result: task.result, createdAt: task.createdAt, updatedAt: task.updatedAt }));
    return buildSessionLog({ sessionId: request.params.sessionId, entries, tasks });
  });

  app.patch<{ Params: { sessionId: string } }>('/api/sessions/:sessionId', async (request, reply) => {
    let body: z.infer<typeof sessionPatchSchema>;
    try {
      body = sessionPatchSchema.parse(request.body);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid session update.' });
    }
    try {
      const session = services.sessionService.updateSession(request.params.sessionId, body);
      return { session: { ...session, memoryBudget: services.sessionService.budgetTokens } };
    } catch {
      return reply.code(404).send({ error: '会话不存在。' });
    }  });

  app.delete<{ Params: { sessionId: string } }>('/api/sessions/:sessionId', async (request, reply) => {
    if (!services.sessionService.getSession(request.params.sessionId)) {
      return reply.code(404).send({ error: '会话不存在。' });
    }
    services.sessionService.deleteSession(request.params.sessionId);
    return { ok: true };
  });

  app.post<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/compact', async (request, reply) => {
    if (!services.sessionService.getSession(request.params.sessionId)) {
      return reply.code(404).send({ error: '会话不存在。' });
    }
    if (services.store.hasActiveTaskInSession(request.params.sessionId)) {
      return reply.code(409).send({ error: '该会话有进行中的任务，任务结束后才能压缩。' });
    }
    const result = await services.sessionService.compactSession(request.params.sessionId);
    const session = services.sessionService.getSession(request.params.sessionId)!;
    return { ...result, session: { ...session, memoryBudget: services.sessionService.budgetTokens } };
  });

  app.get('/api/legacy-tasks', async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(request.query ?? {});
    const tasks = services.store.listUnassignedTasks(query.limit).map((task) => ({
      id: task.id,
      message: task.message.length > 60 ? `${task.message.slice(0, 60)}…` : task.message,
      status: task.status,
      updatedAt: task.updatedAt,
    }));
    return { tasks };
  });
}

function persistableSession(services: ApiServices) {
  return (session: Awaited<ReturnType<SessionService['listSessions']>>['items'][number]) => ({
    ...session,
    memoryBudget: services.sessionService.budgetTokens,
  });
}

/** Messages are user-visible history; compaction markers carry the checkpoint text. */
function persistableMessage(message: Awaited<ReturnType<SessionService['listMessages']>>['items'][number]) {
  return {
    seq: message.seq,
    taskId: message.taskId,
    role: message.role,
    content: message.content,
    status: message.status,
    createdAt: message.createdAt,
    taskStatus: message.taskStatus,
  };
}

async function parseMultipartTask(request: Parameters<FastifyInstance['post']>[1] extends never ? never : any): Promise<CreateTaskInput> {
  let message = '';
  let permissionMode: unknown = 'request';
  let sourceTaskId: unknown;
  let sessionId: unknown;
  const attachments: Attachment[] = [];
  let totalBytes = 0;

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer();
      totalBytes += buffer.byteLength;
      if (totalBytes > 25 * 1024 * 1024) throw new Error('Total attachment size exceeds 25 MB.');
      if (!isTextMimeType(part.mimetype)) throw new Error(`Unsupported attachment type: ${part.mimetype}`);
      attachments.push({
        id: randomUUID(),
        filename: part.filename,
        mimeType: part.mimetype,
        size: buffer.byteLength,
        content: buffer.toString('utf8'),
      });
    } else if (part.fieldname === 'message') {
      message = String(part.value);
    } else if (part.fieldname === 'permissionMode') {
      permissionMode = part.value;
    } else if (part.fieldname === 'sourceTaskId') {
      sourceTaskId = part.value;
    } else if (part.fieldname === 'sessionId') {
      sessionId = part.value;
    }
  }

  return taskBodySchema.parse({ message, attachments, permissionMode, sourceTaskId, sessionId });
}

function isTextMimeType(mimeType: string): boolean {
  return mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml';
}
