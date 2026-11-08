export type FlowStepStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'replaced';

export interface TaskFlowStep {
  id: string;
  description: string;
  capabilityKey: string;
  dependsOn: string[];
  ownerAgentId: string;
  status: FlowStepStatus;
  reviewAction?: 'continue' | 'replan' | 'block';
}

export interface TaskFlow {
  taskId: string;
  taskStatus: string;
  goal: string;
  acceptanceCriteria: string[];
  rootAgent: { id: string; name: string; status: string } | null;
  workers: Array<{ id: string; name: string; status: string }>;
  modelRoles: Array<{ id: string; name: string; status: string; role: string }>;
  steps: TaskFlowStep[];
  replacedSteps: TaskFlowStep[];
  progress: { completed: number; total: number; revisionCount: number };
  activeStepId: string | null;
  exchanges: Array<{ kind: 'assignment' | 'request' | 'response' | 'result' | 'review';
    fromAgentId: string; toAgentId: string; stepId: string; dependencyStepId?: string; createdAt: string }>;
  reviews: Array<{ stepId: string; action: 'continue' | 'replan' | 'block'; createdAt?: string }>;
}

export async function fetchTaskFlow(taskId: string, signal?: AbortSignal): Promise<TaskFlow> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/flow`, { signal });
  if (!response.ok) throw new Error(`流程查询失败（${response.status}）`);
  return response.json() as Promise<TaskFlow>;
}

export const stepStatusLabels: Record<FlowStepStatus, string> = {
  queued: '待执行', running: '执行中', waiting: '等待中', completed: '已完成',
  failed: '失败', blocked: '已阻塞', cancelled: '已取消', replaced: '已调整',
};

export const reviewActionLabels = { continue: '通过复盘', replan: '重新规划', block: '已阻塞' } as const;
