export type ActivityEvent = { type: string; payload: Record<string, unknown> };

export type AgentActivity = {
  role: string;
  label: string;
  status: 'running' | 'retrying' | 'completed' | 'failed' | 'cancelled';
  calls: number;
};

const roleLabels: Record<string, string> = {
  planner: '规划 Agent',
  implementer: '实施 Agent',
  tester: '测试 Agent',
  evaluator: '评估 Agent',
  responder: '回答 Agent',
  presentation: '演示文稿 Agent',
};

export function summarizeAgentActivity(events: ActivityEvent[]): AgentActivity[] {
  const byRole = new Map<string, { label: string; runs: Map<string, AgentActivity['status']>;
    latest: AgentActivity['status'] }>();
  for (const event of events) {
    if (event.type !== 'agent.activity') continue;
    const role = event.payload.role;
    const runId = event.payload.runId;
    const status = event.payload.status;
    if (typeof role !== 'string' || typeof runId !== 'string'
      || (status !== 'running' && status !== 'retrying' && status !== 'completed' && status !== 'failed' && status !== 'cancelled')) continue;
    const family = role.split('.')[0] ?? role;
    if (!roleLabels[family]) continue;
    const item = byRole.get(family) ?? { label: roleLabels[family], runs: new Map(), latest: status };
    item.runs.set(runId, status);
    item.latest = status;
    byRole.set(family, item);
  }
  return [...byRole].map(([role, item]) => ({ role, label: item.label,
    status: [...item.runs.values()].includes('retrying') ? 'retrying'
      : [...item.runs.values()].includes('running') ? 'running' : item.latest,
    calls: item.runs.size }));
}
