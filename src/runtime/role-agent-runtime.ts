import type { A2AProtocol } from '../agents/a2a-protocol.js';
import type { AgentSessionRecord, AgentStatus, TaskRun } from '../domain/contracts.js';
import type { ModelActivityEvent } from '../model/gateway.js';

const roleNames: Record<string, string> = {
  planner: '规划 Agent', implementer: '实施 Agent', tester: '测试 Agent',
  evaluator: '评估 Agent', responder: '回答 Agent', presentation: '演示文稿 Agent',
};

/** Gives each model role a durable child identity under its task's coordinator. */
export class RoleAgentRuntime {
  constructor(private readonly protocol: A2AProtocol) {}

  onActivity(activity: ModelActivityEvent): AgentSessionRecord | null {
    const family = activity.role.split('.')[0] ?? '';
    const name = roleNames[family];
    if (!name) return null;
    const agents = this.protocol.listAgents(activity.taskId);
    let root = agents.find(agent => !agent.parentAgentId && agent.role === 'orchestrator');
    if (!root) root = this.protocol.createAgent({ rootTaskId: activity.taskId,
      name: 'Jarvis 主 Agent', role: 'orchestrator', goal: '协调任务中的模型角色和执行步骤', status: 'running' });
    if (activity.status === 'running' && root.status !== 'running') {
      root = this.protocol.store.updateAgentStatus(root.id, 'running');
    }
    let child = agents.find(agent => agent.parentAgentId === root.id && agent.role === family);
    if (!child) child = this.protocol.createAgent({ parentAgentId: root.id,
      name, role: family, goal: `执行${name}职责并将结果交回主任务`, status: 'queued' });
    const status: AgentStatus = activity.status === 'running' || activity.status === 'retrying'
      ? 'running' : activity.status === 'cancelled' ? 'cancelled' : 'waiting';
    return this.protocol.store.updateAgentStatus(child.id, status);
  }

  onTaskSettled(task: TaskRun): void {
    const finalStatus: AgentStatus = task.status === 'COMPLETED' ? 'completed'
      : task.status === 'FAILED' || task.status === 'BLOCKED' ? 'failed'
        : task.status === 'CANCELLED' ? 'cancelled' : 'waiting';
    const agents = this.protocol.listAgents(task.id);
    for (const agent of agents) {
      if (agent.role === 'orchestrator' || agent.parentAgentId
        && agents.some(root => root.id === agent.parentAgentId && root.role === 'orchestrator')) {
        this.protocol.store.updateAgentStatus(agent.id, finalStatus);
      }
    }
  }
}
