import type { AgentMessageRecord, AgentSessionRecord, TaskEvent, TaskRun } from '../domain/contracts.js';

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
  taskStatus: TaskRun['status'];
  goal: string;
  acceptanceCriteria: string[];
  rootAgent: Pick<AgentSessionRecord, 'id' | 'name' | 'status'> | null;
  workers: Array<Pick<AgentSessionRecord, 'id' | 'name' | 'status'>>;
  modelRoles: Array<Pick<AgentSessionRecord, 'id' | 'name' | 'status' | 'role'>>;
  steps: TaskFlowStep[];
  replacedSteps: TaskFlowStep[];
  progress: { completed: number; total: number; revisionCount: number };
  activeStepId: string | null;
  exchanges: Array<{ kind: 'assignment' | 'request' | 'response' | 'result' | 'review';
    fromAgentId: string; toAgentId: string; stepId: string; dependencyStepId?: string; createdAt: string }>;
  reviews: Array<{ stepId: string; action: 'continue' | 'replan' | 'block'; createdAt?: string }>;
}

interface Assignment {
  stepId: string;
  description: string;
  capabilityKey: string;
  dependsOn: string[];
  ownerAgentId: string;
  version: string;
  order: number;
}

/** Metadata-only projection; model prompts and tool outputs never enter this response. */
export function buildTaskFlow(task: TaskRun, agents: AgentSessionRecord[],
  messages: AgentMessageRecord[], events: TaskEvent[]): TaskFlow {
  const root = agents.find(agent => !agent.parentAgentId && agent.role === 'orchestrator');
  const workers = agents.filter(agent => agent.parentAgentId === root?.id && /^task-worker-\d+$/.test(agent.role))
    .sort((left, right) => Number(left.role.slice(12)) - Number(right.role.slice(12)));
  const modelRoles = agents.filter(agent => agent.parentAgentId === root?.id && !agent.role.startsWith('task-worker-'));
  const assignments = new Map<string, Assignment>();
  const exchanges: TaskFlow['exchanges'] = [];
  let lastAssignedVersion = '';
  for (const [order, message] of messages.entries()) {
    const payload = objectPayload(message.payload);
    const kind = payload.kind;
    const stepId = text(payload.stepId, 120);
    const dependencyStepId = text(payload.dependencyStepId, 120);
    if (kind === 'step.assignment' && stepId) {
      const version = /:assign:([0-9a-f]{16}):/.exec(message.id)?.[1] ?? 'legacy';
      lastAssignedVersion = version;
      const contract = objectPayload(payload.contract);
      const source = Object.keys(contract).length ? contract : payload;
      assignments.set(`${version}:${stepId}`, { stepId, description: text(source.description ?? source.objective, 500),
        capabilityKey: text(source.capabilityKey, 100),
        dependsOn: Array.isArray(source.dependsOn)
          ? source.dependsOn.filter((value): value is string => typeof value === 'string').slice(0, 50)
            .map(value => value.slice(0, 120)) : [],
        ownerAgentId: message.recipientAgentId, version, order });
      exchanges.push({ kind: 'assignment', fromAgentId: message.senderAgentId,
        toAgentId: message.recipientAgentId, stepId, createdAt: message.createdAt });
    } else if (kind === 'dependency.request' && stepId && dependencyStepId) {
      exchanges.push({ kind: 'request', fromAgentId: message.senderAgentId,
        toAgentId: message.recipientAgentId, stepId, dependencyStepId, createdAt: message.createdAt });
    } else if (kind === 'dependency.result' && dependencyStepId) {
      exchanges.push({ kind: 'response', fromAgentId: message.senderAgentId,
        toAgentId: message.recipientAgentId, stepId: dependencyStepId,
        dependencyStepId, createdAt: message.createdAt });
    } else if (kind === 'step.result' && stepId) {
      exchanges.push({ kind: 'result', fromAgentId: message.senderAgentId,
        toAgentId: message.recipientAgentId, stepId, createdAt: message.createdAt });
    } else if (kind === 'step.review' && stepId) {
      exchanges.push({ kind: 'review', fromAgentId: message.senderAgentId,
        toAgentId: message.recipientAgentId, stepId, createdAt: message.createdAt });
    }
  }

  const latestTeam = [...events].reverse().find(event => event.type === 'team.dispatched');
  const activeVersion = text(latestTeam?.payload?.planVersion, 32) || lastAssignedVersion;
  const statusByStep = new Map<string, FlowStepStatus>();
  const reviewByStep = new Map<string, TaskFlowStep['reviewAction']>();
  const reviews: TaskFlow['reviews'] = [];
  let activeStepId: string | null = null;
  for (const event of events) {
    const stepId = text(event.payload?.stepId, 120);
    if (!stepId) continue;
    if (event.type === 'agent.step_active' || event.type === 'step.started') {
      statusByStep.set(stepId, 'running');
      activeStepId = stepId;
    } else if (event.type === 'step.paused') {
      statusByStep.set(stepId, 'waiting');
      if (activeStepId === stepId) activeStepId = null;
    } else if (event.type === 'step.completed') {
      statusByStep.set(stepId, 'completed');
      if (activeStepId === stepId) activeStepId = null;
    } else if (event.type === 'step.failed') {
      statusByStep.set(stepId, 'failed');
      if (activeStepId === stepId) activeStepId = null;
    } else if (event.type === 'plan.reviewed') {
      const action = event.payload.action;
      if (action === 'continue' || action === 'replan' || action === 'block') {
        reviewByStep.set(stepId, action);
        reviews.push({ stepId, action, createdAt: event.createdAt });
      }
    }
  }
  if (task.status === 'FAILED' || task.status === 'BLOCKED' || task.status === 'CANCELLED') {
    const finalStatus: FlowStepStatus = task.status === 'FAILED' ? 'failed'
      : task.status === 'BLOCKED' ? 'blocked' : 'cancelled';
    for (const assignment of assignments.values()) {
      if (assignment.version !== activeVersion) continue;
      if (statusByStep.get(assignment.stepId) !== 'completed') statusByStep.set(assignment.stepId, finalStatus);
    }
    activeStepId = null;
  }

  const projected = [...assignments.values()].sort((left, right) => left.order - right.order).map(assignment => ({
    id: assignment.stepId,
    description: assignment.description,
    capabilityKey: assignment.capabilityKey,
    dependsOn: assignment.dependsOn,
    ownerAgentId: assignment.ownerAgentId,
    status: (assignment.version === activeVersion ? statusByStep.get(assignment.stepId) ?? 'queued' : 'replaced') as FlowStepStatus,
    reviewAction: reviewByStep.get(assignment.stepId),
    version: assignment.version,
  }));
  const steps = projected.filter(step => step.version === activeVersion).map(({ version: _version, ...step }) => step);
  const currentIds = new Set(steps.map(step => step.id));
  const replacedById = new Map<string, TaskFlowStep>();
  for (const { version, ...step } of projected) {
    if (version !== activeVersion && !currentIds.has(step.id)) replacedById.set(step.id, step);
  }
  const replacedSteps = [...replacedById.values()];
  if (activeStepId && !steps.some(step => step.id === activeStepId && step.status === 'running')) activeStepId = null;
  return {
    taskId: task.id,
    taskStatus: task.status,
    goal: text(task.message, 10_000),
    acceptanceCriteria: task.acceptanceCriteria.slice(0, 50).map(value => text(value, 1_000)),
    rootAgent: root ? { id: root.id, name: root.name, status: root.status } : null,
    workers: workers.map(worker => ({ id: worker.id, name: worker.name, status: worker.status })),
    modelRoles: modelRoles.map(agent => ({ id: agent.id, name: agent.name, role: agent.role, status: agent.status })),
    steps,
    replacedSteps,
    progress: { completed: steps.filter(step => step.status === 'completed').length,
      total: steps.length, revisionCount: events.filter(event => event.type === 'plan.revised').length },
    activeStepId,
    exchanges: exchanges.slice(-40),
    reviews: reviews.slice(-20),
  };
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}
