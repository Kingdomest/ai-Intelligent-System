import { summarizeAgentActivity, type ActivityEvent } from './agent-activity.js';

const statusLabels = { running: '执行中', retrying: '超时后重试', completed: '已完成', failed: '本次调用失败', cancelled: '已停止' };

export function AgentActivity({ events }: { events: ActivityEvent[] }) {
  const agents = summarizeAgentActivity(events);
  if (!agents.length) return <small>当前任务尚无 Agent 模型调用记录。</small>;
  return <div className="agent-activity" aria-label="Agent 执行状态">
    {agents.map(agent => <span key={agent.role} className={`agent-activity-item is-${agent.status}`}>
      <span className="agent-activity-indicator" aria-hidden="true" />
      {agent.label}：{statusLabels[agent.status]} · {agent.calls} 次调用
    </span>)}
  </div>;
}
