import { SqliteStore } from '../storage/sqlite-store.js';
import type {
  AgentMessageRecord,
  AgentMessageStatus,
  AgentSessionRecord,
  AgentStatus,
  CreateAgentInput,
  SendAgentMessageInput,
} from '../domain/contracts.js';

export const A2A_PROTOCOL_VERSION = 'a2a-local-v1';
export const MAX_CHILD_AGENTS = 12;
export const MAX_AGENT_BATCH = 4;
export const MAX_AGENT_NAME_LENGTH = 80;
export const MAX_AGENT_ROLE_LENGTH = 2_000;
export const MAX_AGENT_GOAL_LENGTH = 2_000;
export const MAX_AGENT_MESSAGE_BYTES = 8_000;
export const MAX_AGENT_MESSAGE_BATCH = 20;

const terminalStatuses = new Set<AgentStatus>(['completed', 'failed', 'cancelled']);

export interface AgentCard {
  protocolVersion: typeof A2A_PROTOCOL_VERSION;
  name: string;
  supportedMessageTypes: Array<SendAgentMessageInput['type']>;
  endpoints: {
    sendMessage: string;
    agents: string;
    inbox: string;
  };
  limits: {
    maxChildren: number;
    maxMessageBytes: number;
    maxInboxBatch: number;
  };
}

export class A2AProtocolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'A2AProtocolError';
  }
}

export class A2AProtocol {
  constructor(public readonly store: SqliteStore) {}

  createAgent(input: CreateAgentInput): AgentSessionRecord {
    validateAgentSpec(input);

    let rootTaskId = input.rootTaskId;
    if (rootTaskId && !this.store.getTask(rootTaskId)) {
      throw new A2AProtocolError('ROOT_TASK_NOT_FOUND', `Root task not found: ${rootTaskId}`, 404);
    }
    if (input.parentAgentId) {
      const parent = this.store.getAgent(input.parentAgentId);
      if (!parent) throw new A2AProtocolError('PARENT_AGENT_NOT_FOUND', `Parent Agent not found: ${input.parentAgentId}`, 404);
      if (terminalStatuses.has(parent.status)) {
        throw new A2AProtocolError('PARENT_AGENT_TERMINAL', 'A terminal Agent cannot create a child.', 409);
      }
      if (parent.parentAgentId) {
        throw new A2AProtocolError('CHILD_AGENT_CANNOT_SPAWN', 'Only the root/main Agent may create child Agents.', 403);
      }
      if (rootTaskId && rootTaskId !== parent.rootTaskId) {
        throw new A2AProtocolError('ROOT_TASK_MISMATCH', 'The child root task must match its parent Agent.', 409);
      }
      rootTaskId = parent.rootTaskId;
      const childCount = this.store.listAgents(rootTaskId).filter(agent => Boolean(agent.parentAgentId)).length;
      if (childCount >= MAX_CHILD_AGENTS) {
        throw new A2AProtocolError('CHILD_AGENT_LIMIT', `A root task may create at most ${MAX_CHILD_AGENTS} child Agents.`, 409);
      }
    }

    return this.store.createAgent({ ...input, rootTaskId });
  }

  getAgent(agentId: string): AgentSessionRecord | null {
    return this.store.getAgent(agentId);
  }

  listAgents(rootTaskId?: string): AgentSessionRecord[] {
    return this.store.listAgents(rootTaskId);
  }

  sendMessage(input: SendAgentMessageInput): AgentMessageRecord {
    const sender = this.store.getAgent(input.senderAgentId);
    if (!sender) throw new A2AProtocolError('SENDER_AGENT_NOT_FOUND', `Sender Agent not found: ${input.senderAgentId}`, 404);
    const recipient = this.store.getAgent(input.recipientAgentId);
    if (!recipient) throw new A2AProtocolError('RECIPIENT_AGENT_NOT_FOUND', `Recipient Agent not found: ${input.recipientAgentId}`, 404);
    if (terminalStatuses.has(sender.status)) {
      throw new A2AProtocolError('SENDER_AGENT_TERMINAL', 'A terminal Agent cannot send a message.', 409);
    }
    if (input.type === 'request' && terminalStatuses.has(recipient.status)) {
      throw new A2AProtocolError('RECIPIENT_AGENT_TERMINAL', 'A request cannot be sent to a terminal Agent.', 409);
    }
    if (sender.rootTaskId !== recipient.rootTaskId) {
      throw new A2AProtocolError('ROOT_TASK_MISMATCH', 'Agents may communicate only within the same root task.', 403);
    }
    if (input.rootTaskId !== undefined && input.rootTaskId !== sender.rootTaskId) {
      throw new A2AProtocolError('ROOT_TASK_MISMATCH', 'Message root task does not match the sender Agent.', 409);
    }
    const payloadJson = serializePayload(input.payload);
    if (Buffer.byteLength(payloadJson, 'utf8') > MAX_AGENT_MESSAGE_BYTES) {
      throw new A2AProtocolError('MESSAGE_PAYLOAD_LIMIT', `Agent message payload exceeds ${MAX_AGENT_MESSAGE_BYTES} bytes.`, 413);
    }
    return this.store.sendAgentMessage({ ...input, rootTaskId: sender.rootTaskId, payload: JSON.parse(payloadJson) });
  }

  listInbox(agentId: string, options: { status?: AgentMessageStatus; limit?: number; before?: string } = {}): AgentMessageRecord[] {
    if (!this.store.getAgent(agentId)) throw new A2AProtocolError('AGENT_NOT_FOUND', `Agent not found: ${agentId}`, 404);
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_AGENT_MESSAGE_BATCH)) {
      throw new A2AProtocolError('INBOX_LIMIT', `Inbox limit must be between 1 and ${MAX_AGENT_MESSAGE_BATCH}.`, 400);
    }
    return this.store.listAgentMessages(agentId, options);
  }

  ackMessage(agentId: string, messageId: string, status: Extract<AgentMessageStatus, 'delivered' | 'read' | 'failed'>,
    error?: string): AgentMessageRecord {
    if (!this.store.getAgent(agentId)) throw new A2AProtocolError('AGENT_NOT_FOUND', `Agent not found: ${agentId}`, 404);
    return this.store.ackAgentMessage(agentId, messageId, status, error);
  }

  agentCard(): AgentCard {
    return {
      protocolVersion: A2A_PROTOCOL_VERSION,
      name: 'Jarvis local Agent collaboration network',
      supportedMessageTypes: ['request', 'response', 'event', 'artifact', 'status', 'error'],
      endpoints: {
        sendMessage: '/api/a2a/jsonrpc',
        agents: '/api/a2a/agents',
        inbox: '/api/a2a/agents/{agentId}/inbox',
      },
      limits: {
        maxChildren: MAX_CHILD_AGENTS,
        maxMessageBytes: MAX_AGENT_MESSAGE_BYTES,
        maxInboxBatch: MAX_AGENT_MESSAGE_BATCH,
      },
    };
  }
}

export function validateAgentSpec(input: Pick<CreateAgentInput, 'name' | 'role' | 'goal' | 'capabilities'>): void {
  validateText(input.name, 'name', MAX_AGENT_NAME_LENGTH);
  validateText(input.role, 'role', MAX_AGENT_ROLE_LENGTH);
  validateText(input.goal, 'goal', MAX_AGENT_GOAL_LENGTH);
  if ((input.capabilities?.length ?? 0) > 20) {
    throw new A2AProtocolError('CAPABILITIES_LIMIT', 'An Agent may declare at most 20 capabilities.', 400);
  }
}

function validateText(value: string, field: string, maxLength: number): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new A2AProtocolError('INVALID_AGENT_SPEC', `${field} must not be empty.`, 400);
  }
  if (value.length > maxLength) {
    throw new A2AProtocolError('AGENT_SPEC_LIMIT', `${field} exceeds ${maxLength} characters.`, 400);
  }
}

function serializePayload(payload: unknown): string {
  try {
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) throw new Error('undefined payload');
    return serialized;
  } catch {
    throw new A2AProtocolError('INVALID_MESSAGE_PAYLOAD', 'Agent message payload must be JSON serializable.', 400);
  }
}
