import { afterEach, describe, expect, it } from 'vitest';
import { A2AProtocol } from '../../src/agents/a2a-protocol.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

const stores: SqliteStore[] = [];

function setup() {
  const store = new SqliteStore(':memory:');
  stores.push(store);
  const protocol = new A2AProtocol(store);
  const task = store.createTask({ message: 'A2A task', attachments: [] });
  const main = protocol.createAgent({ rootTaskId: task.id, name: '主 Agent', role: '统筹', goal: '完成任务' });
  return { store, protocol, task, main };
}

afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

describe('A2AProtocol', () => {
  it('creates same-tree children and delivers an idempotent request', () => {
    const { protocol, task, main } = setup();
    const research = protocol.createAgent({ parentAgentId: main.id, name: '研究 Agent', role: '研究', goal: '收集资料' });
    const writer = protocol.createAgent({ parentAgentId: main.id, rootTaskId: task.id, name: '写作 Agent', role: '写作', goal: '整理资料' });
    expect(research.rootTaskId).toBe(task.id);
    expect(writer.parentAgentId).toBe(main.id);
    const input = { messageId: 'a2a-message-1', senderAgentId: research.id, recipientAgentId: writer.id,
      type: 'request' as const, payload: { question: '请整理研究结论' } };
    expect(protocol.sendMessage(input)).toMatchObject({ id: 'a2a-message-1', status: 'queued', rootTaskId: task.id });
    expect(protocol.sendMessage(input).id).toBe('a2a-message-1');
    expect(protocol.listInbox(writer.id)).toHaveLength(1);
    expect(protocol.ackMessage(writer.id, 'a2a-message-1', 'read').status).toBe('read');
  });

  it('rejects invalid parents and cross-tree messages', () => {
    const { protocol, main } = setup();
    expect(() => protocol.createAgent({ parentAgentId: 'missing', name: 'x', role: 'x', goal: 'x' }))
      .toThrow(/parent agent/i);
    const otherTask = protocol.store.createTask({ message: 'other', attachments: [] });
    const other = protocol.createAgent({ rootTaskId: otherTask.id, name: '其他主 Agent', role: '主', goal: '其他任务' });
    expect(() => protocol.sendMessage({ senderAgentId: main.id, recipientAgentId: other.id, type: 'event', payload: { ok: true } }))
      .toThrow(/same root|root task/i);
  });

  it('enforces child and payload limits and terminal recipient protection', () => {
    const { protocol, main } = setup();
    for (let index = 0; index < 12; index += 1) {
      protocol.createAgent({ parentAgentId: main.id, name: `child-${index}`, role: 'worker', goal: 'work' });
    }
    expect(() => protocol.createAgent({ parentAgentId: main.id, name: 'child-overflow', role: 'worker', goal: 'work' }))
      .toThrow(/12|limit/i);
    const recipient = protocol.listAgents(main.rootTaskId).find(agent => agent.parentAgentId === main.id)!;
    protocol.store.updateAgentStatus(recipient.id, 'completed');
    expect(() => protocol.sendMessage({ senderAgentId: main.id, recipientAgentId: recipient.id, type: 'request', payload: { ok: true } }))
      .toThrow(/terminal|completed|cancelled/i);
    const active = protocol.listAgents(main.rootTaskId).find(agent => agent.parentAgentId === main.id && agent.id !== recipient.id)!;
    expect(() => protocol.sendMessage({ senderAgentId: main.id, recipientAgentId: active.id, type: 'event',
      payload: { content: 'x'.repeat(8_001) } })).toThrow(/payload|8,000|8000/i);
  });

  it('returns a stable local Agent Card', () => {
    const { protocol } = setup();
    expect(protocol.agentCard()).toMatchObject({ protocolVersion: 'a2a-local-v1',
      supportedMessageTypes: expect.arrayContaining(['request', 'response', 'artifact']),
      endpoints: expect.objectContaining({ sendMessage: '/api/a2a/jsonrpc' }) });
  });
});
