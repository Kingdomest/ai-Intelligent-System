import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { A2AProtocol, A2AProtocolError } from '../agents/a2a-protocol.js';
import type { AgentController } from '../runtime/agent-controller.js';
import type { SqliteStore } from '../storage/sqlite-store.js';

const agentSpecSchema = z.object({
  id: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().min(1).max(2_000),
  goal: z.string().trim().min(1).max(2_000),
  capabilities: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
});
const rootAgentSchema = agentSpecSchema.extend({ rootTaskId: z.string().uuid() });
const childAgentsSchema = z.object({ parentAgentId: z.string().min(1), children: z.array(agentSpecSchema).min(1).max(4) });
const messageSchema = z.object({
  messageId: z.string().trim().min(1).max(100).optional(),
  recipientAgentId: z.string().min(1),
  type: z.enum(['request', 'response', 'event', 'artifact', 'status', 'error']),
  correlationId: z.string().max(100).optional(),
  payload: z.unknown(),
});
const ackSchema = z.object({
  agentId: z.string().min(1),
  status: z.enum(['delivered', 'read', 'failed']),
  error: z.string().max(500).optional(),
});
const inboxQuerySchema = z.object({
  status: z.enum(['queued', 'delivered', 'read', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
  before: z.string().datetime().optional(),
});
const rpcSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
});

export function registerA2ARoutes(app: FastifyInstance, protocol: A2AProtocol,
  controller: AgentController, store: SqliteStore): void {
  app.get('/.well-known/agent-card.json', async () => protocol.agentCard());

  app.post('/api/a2a/agents', async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown>;
      if ('children' in (body ?? {})) {
        const input = childAgentsSchema.parse(body);
        return reply.code(201).send({ agents: controller.spawnChildren(input.parentAgentId, input.children) });
      }
      const input = rootAgentSchema.parse(body);
      return reply.code(201).send({ agent: protocol.createAgent(input) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/a2a/agents', async (request, reply) => {
    try {
      const query = z.object({ rootTaskId: z.string().uuid() }).parse(request.query);
      return { agents: protocol.listAgents(query.rootTaskId) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { agentId: string } }>('/api/a2a/agents/:agentId', async (request, reply) => {
    const agent = protocol.getAgent(request.params.agentId);
    return agent ? { agent } : reply.code(404).send({ code: 'AGENT_NOT_FOUND', error: 'Agent not found.' });
  });

  app.post<{ Params: { senderAgentId: string } }>('/api/a2a/agents/:senderAgentId/messages', async (request, reply) => {
    try {
      const input = messageSchema.parse(request.body);
      return reply.code(202).send({ message: protocol.sendMessage({ ...input, senderAgentId: request.params.senderAgentId }) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { agentId: string } }>('/api/a2a/agents/:agentId/inbox', async (request, reply) => {
    try {
      const options = inboxQuerySchema.parse(request.query);
      return { messages: protocol.listInbox(request.params.agentId, options) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { messageId: string } }>('/api/a2a/messages/:messageId/ack', async (request, reply) => {
    try {
      const input = ackSchema.parse(request.body);
      return { message: protocol.ackMessage(input.agentId, request.params.messageId, input.status, input.error) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/a2a/jsonrpc', async (request, reply) => {
    const parsed = rpcSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(200).send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    }
    const { id, method, params } = parsed.data;
    try {
      let result: unknown;
      switch (method) {
        case 'message/send': {
          const input = messageSchema.extend({ senderAgentId: z.string().min(1) }).parse(params);
          result = { message: protocol.sendMessage(input) };
          break;
        }
        case 'agents/list': {
          const input = z.object({ rootTaskId: z.string().uuid() }).parse(params);
          result = { agents: protocol.listAgents(input.rootTaskId) };
          break;
        }
        case 'tasks/get': {
          const input = z.object({ taskId: z.string().uuid() }).parse(params);
          const task = store.getTask(input.taskId);
          if (!task) throw new A2AProtocolError('TASK_NOT_FOUND', 'Task not found.', 404);
          result = { task: { id: task.id, status: task.status, result: task.result ?? null } };
          break;
        }
        default:
          return reply.code(200).send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
      }
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      const isParams = error instanceof z.ZodError;
      const message = error instanceof A2AProtocolError ? error.message : 'Invalid params';
      return reply.code(200).send({ jsonrpc: '2.0', id, error: {
        code: isParams ? -32602 : -32000,
        message,
        data: error instanceof A2AProtocolError ? { code: error.code } : undefined,
      } });
    }
  });
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof A2AProtocolError) {
    return reply.code(error.statusCode).send({ code: error.code, error: error.message });
  }
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ code: 'INVALID_REQUEST', error: 'Invalid A2A request.' });
  }
  const message = error instanceof Error ? error.message : 'A2A request failed.';
  if (/Only the recipient Agent can acknowledge/.test(message)) {
    return reply.code(403).send({ code: 'ACK_FORBIDDEN', error: message });
  }
  if (/not found/i.test(message)) return reply.code(404).send({ code: 'NOT_FOUND', error: message });
  return reply.code(409).send({ code: 'A2A_CONFLICT', error: message });
}
