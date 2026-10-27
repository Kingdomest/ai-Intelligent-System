import type { AgentMessageRecord, AgentSessionRecord, CreateAgentInput, SendAgentMessageInput } from '../domain/contracts.js';
import {
  A2AProtocol,
  A2AProtocolError,
  MAX_AGENT_BATCH,
  MAX_CHILD_AGENTS,
  validateAgentSpec,
} from '../agents/a2a-protocol.js';

export type AgentChildSpec = Omit<CreateAgentInput, 'parentAgentId' | 'rootTaskId'>;
export type AgentSendInput = Omit<SendAgentMessageInput, 'senderAgentId'>;

/**
 * Orchestrates the parent side of a dynamic team.  The controller deliberately
 * does not run model turns; it creates bounded identities and routes messages
 * through the protocol so a future execution loop can subscribe to the inbox.
 */
export class AgentController {
  constructor(private readonly protocol: A2AProtocol) {}

  spawnChildren(parentAgentId: string, specs: AgentChildSpec[]): AgentSessionRecord[] {
    if (specs.length < 1 || specs.length > MAX_AGENT_BATCH) {
      throw new A2AProtocolError('AGENT_BATCH_LIMIT', `A create call must contain between 1 and ${MAX_AGENT_BATCH} child Agents.`, 400);
    }
    const parent = this.protocol.getAgent(parentAgentId);
    if (!parent) throw new A2AProtocolError('PARENT_AGENT_NOT_FOUND', `Parent Agent not found: ${parentAgentId}`, 404);
    if (parent.parentAgentId) {
      throw new A2AProtocolError('CHILD_AGENT_CANNOT_SPAWN', 'Only the root/main Agent may create child Agents.', 403);
    }
    const existingChildren = this.protocol.listAgents(parent.rootTaskId).filter(agent => Boolean(agent.parentAgentId)).length;
    if (existingChildren + specs.length > MAX_CHILD_AGENTS) {
      throw new A2AProtocolError('CHILD_AGENT_LIMIT', `A root task may create at most ${MAX_CHILD_AGENTS} child Agents.`, 409);
    }

    const requestedIds = new Set<string>();
    for (const spec of specs) {
      validateAgentSpec(spec);
      if (spec.id) {
        if (requestedIds.has(spec.id) || this.protocol.getAgent(spec.id)) {
          throw new A2AProtocolError('AGENT_ID_CONFLICT', `Agent ID is already in use: ${spec.id}`, 409);
        }
        requestedIds.add(spec.id);
      }
    }
    return this.protocol.store.createAgents(specs.map(spec => ({ ...spec, parentAgentId, rootTaskId: parent.rootTaskId })));
  }

  send(parentAgentId: string, input: AgentSendInput): AgentMessageRecord {
    return this.protocol.sendMessage({ ...input, senderAgentId: parentAgentId });
  }
}
