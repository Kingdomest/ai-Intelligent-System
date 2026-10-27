import { afterEach, describe, expect, it } from 'vitest';
import { A2AProtocol } from '../../src/agents/a2a-protocol.js';
import { AgentController } from '../../src/runtime/agent-controller.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

const stores: SqliteStore[] = [];

afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

describe('AgentController', () => {
  it('creates a bounded child team atomically and sends as the parent', () => {
    const store = new SqliteStore(':memory:');
    stores.push(store);
    const protocol = new A2AProtocol(store);
    const controller = new AgentController(protocol);
    const task = store.createTask({ message: 'team task', attachments: [] });
    const main = protocol.createAgent({ rootTaskId: task.id, name: '主 Agent', role: '统筹', goal: '完成任务' });
    const children = controller.spawnChildren(main.id, [
      { id: 'research', name: '研究', role: '检索资料', goal: '收集来源' },
      { id: 'writer', name: '写作', role: '整理内容', goal: '形成草稿' },
    ]);
    expect(children).toHaveLength(2);
    expect(children.every(child => child.parentAgentId === main.id && child.rootTaskId === task.id)).toBe(true);
    const message = controller.send(main.id, { recipientAgentId: children[0]!.id, type: 'request', payload: { start: true } });
    expect(message.senderAgentId).toBe(main.id);
    expect(protocol.listInbox(children[0]!.id)).toHaveLength(1);
  });

  it('rejects recursive spawning and validates the entire batch before persistence', () => {
    const store = new SqliteStore(':memory:');
    stores.push(store);
    const protocol = new A2AProtocol(store);
    const controller = new AgentController(protocol);
    const task = store.createTask({ message: 'team task', attachments: [] });
    const main = protocol.createAgent({ rootTaskId: task.id, name: '主 Agent', role: '统筹', goal: '完成任务' });
    const child = controller.spawnChildren(main.id, [{ name: '已有', role: '执行', goal: '执行' }])[0]!;
    expect(() => controller.spawnChildren(child.id, [{ name: '递归', role: '执行', goal: '执行' }]))
      .toThrow(/root|main|spawn/i);
    const before = protocol.listAgents(task.id);
    expect(() => controller.spawnChildren(main.id, [
      { name: '有效', role: '执行', goal: '执行' },
      { name: 'x'.repeat(81), role: '执行', goal: '执行' },
    ])).toThrow(/name|80/i);
    expect(protocol.listAgents(task.id)).toHaveLength(before.length);
  });

  it('counts the whole root task tree before starting a batch', () => {
    const store = new SqliteStore(':memory:');
    stores.push(store);
    const protocol = new A2AProtocol(store);
    const controller = new AgentController(protocol);
    const task = store.createTask({ message: 'team task', attachments: [] });
    const main = protocol.createAgent({ rootTaskId: task.id, name: '主 Agent', role: '统筹', goal: '完成任务' });
    store.createAgent({ id: 'other-root', rootTaskId: task.id, name: '旧主 Agent', role: '兼容', goal: '占位' });
    for (let index = 0; index < 11; index += 1) {
      store.createAgent({ id: `existing-${index}`, parentAgentId: 'other-root', rootTaskId: task.id,
        name: `existing-${index}`, role: 'worker', goal: 'work' });
    }
    expect(() => controller.spawnChildren(main.id, [
      { name: 'one', role: 'worker', goal: 'work' },
      { name: 'two', role: 'worker', goal: 'work' },
    ])).toThrow(/12|limit/i);
    expect(protocol.listAgents(task.id).filter(agent => agent.parentAgentId === main.id)).toHaveLength(0);
  });
});
