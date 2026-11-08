import { A2AProtocol, MAX_AGENT_BATCH, MAX_CHILD_AGENTS } from '../agents/a2a-protocol.js';
import { buildStepAssignment, buildStepResult, planVersion, stepAssignmentSchema,
  type StepAssignmentContract } from '../agents/delegation-contract.js';
import type { AgentSessionRecord } from '../domain/contracts.js';
import { AgentController } from './agent-controller.js';

export interface CollaborativeStep {
  id: string;
  description: string;
  capabilityKey?: string;
  /** Bound key for a legacy plan that omitted capabilityKey. */
  assignmentCapabilityKey?: string;
  dependsOn: string[];
  input?: Record<string, unknown>;
  assignmentInput?: Record<string, unknown>;
  acceptanceCriteria?: string[];
  parameterDescriptions?: Record<string, string>;
  /** Selected MCP tool's argument schema, retained for nested parameter metadata. */
  mcpInputSchema?: unknown;
}

export interface StepObservation {
  stepId: string;
  output: unknown;
  observedAt: string;
}

export interface DelegationOptions {
  acceptanceCriteria?: string[];
  schemas?: Record<string, { inputSchema?: unknown; outputSchema?: unknown; version?: string }>;
}

interface Team {
  root: AgentSessionRecord;
  workers: AgentSessionRecord[];
  owners: Map<string, AgentSessionRecord>;
  version: string;
}

/** Turns a validated planner DAG into bounded, durable step assignments. */
export function recommendedWorkerCount(steps: CollaborativeStep[], limit = 3): number {
  if (!steps.length) return 0;
  const byId = new Map(steps.map(step => [step.id, step]));
  const depths = new Map<string, number>();
  const depth = (id: string, visiting = new Set<string>()): number => {
    if (depths.has(id)) return depths.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const value = Math.max(0, ...(byId.get(id)?.dependsOn ?? []).map(parent => depth(parent, visiting) + 1));
    visiting.delete(id);
    depths.set(id, value);
    return value;
  };
  const widths = new Map<number, number>();
  for (const step of steps) widths.set(depth(step.id), (widths.get(depth(step.id)) ?? 0) + 1);
  const width = Math.max(...widths.values());
  // Two stages can exchange results even when the plan is a strict chain.
  return Math.min(Math.max(1, limit), MAX_AGENT_BATCH, steps.length,
    Math.max(steps.length > 1 ? 2 : 1, width));
}

export class TaskCollaborationRuntime {
  private readonly controller: AgentController;
  private readonly activeVersions = new Map<string, string>();

  constructor(private readonly protocol: A2AProtocol, private readonly maxWorkers = 3) {
    this.controller = new AgentController(protocol);
  }

  ensurePlan(taskId: string, steps: CollaborativeStep[], results: StepObservation[] = [], options: DelegationOptions = {}):
    { workerCount: number; newAssignments: number; planVersion: string } {
    const version = planVersion(steps, options.acceptanceCriteria ?? [], options.schemas);
    const team = this.team(taskId, steps, version);
    this.activeVersions.set(taskId, version);
    let newAssignments = 0;
    for (const step of steps) {
      const owner = team.owners.get(step.id)!;
      const messageId = `${taskId}:assign:${team.version}:${step.id}:${owner.id}`;
      const contract = buildStepAssignment(step, team.version,
        step.acceptanceCriteria ?? options.acceptanceCriteria ?? [], options.schemas?.[step.id]);
      this.protocol.store.saveAgentPayloadRef(messageId, taskId, owner.id, contract);
      const reference = { kind: 'step.assignment', contractVersion: 1, stepId: step.id,
        planVersion: team.version, contractRef: messageId,
        description: step.description.slice(0, 500), capabilityKey: step.capabilityKey ?? '',
        dependsOn: step.dependsOn.slice(0, 50) };
      const inline = { ...reference, contract };
      const payload = Buffer.byteLength(JSON.stringify(inline), 'utf8') <= 7_500 ? inline
        : Buffer.byteLength(JSON.stringify(reference), 'utf8') <= 7_500 ? reference
          : { kind: reference.kind, contractVersion: 1, stepId: step.id,
            planVersion: team.version, contractRef: messageId };
      if (!this.protocol.store.getAgentMessage(messageId)) newAssignments++;
      this.sendAndRead(team.root.id, owner.id, 'request', payload, messageId, false, step.id);
      this.protocol.store.supersedeAgentStepAssignments(taskId, step.id, messageId);
    }
    // Rehydrate result notifications after a restart or approval pause.
    for (const result of results) {
      if (team.owners.has(result.stepId)) this.publishResult(team, result);
    }
    return { workerCount: team.workers.length, newAssignments, planVersion: team.version };
  }

  assignedWorkerRole(taskId: string, steps: CollaborativeStep[], stepId: string): string | undefined {
    return this.team(taskId, steps).owners.get(stepId)?.role;
  }

  beginStep(taskId: string, steps: CollaborativeStep[], stepId: string,
    results: StepObservation[]): Record<string, unknown> {
    const team = this.team(taskId, steps);
    const step = steps.find(item => item.id === stepId);
    const worker = team.owners.get(stepId);
    if (!step || !worker) throw new Error(`No subagent assignment for step ${stepId}.`);
    const assignmentId = `${taskId}:assign:${team.version}:${step.id}:${worker.id}`;
    const assignment = this.protocol.store.getAgentMessage(assignmentId);
    if (!assignment || assignment.recipientAgentId !== worker.id) throw new Error(`Step ${stepId} has no valid assignment.`);
    const contract = this.assignment(worker.id, assignmentId);
    if (contract.planVersion !== team.version || contract.stepId !== step.id
      || contract.objective !== step.description
      || contract.capabilityKey !== (step.assignmentCapabilityKey ?? step.capabilityKey)
      || JSON.stringify(contract.input) !== JSON.stringify(step.assignmentInput ?? step.input ?? {})
      || JSON.stringify(contract.dependsOn) !== JSON.stringify(step.dependsOn)
      || Object.keys(contract.input).some(name => !contract.parameters.some(parameter => parameter.name === name))) {
      throw new Error(`Step ${stepId} assignment differs from the current plan.`);
    }
    const dependencies: Record<string, unknown> = {};
    for (const dependencyId of step.dependsOn) {
      const result = results.find(item => item.stepId === dependencyId);
      if (!result) throw new Error(`Step ${stepId} is missing the verified result of ${dependencyId}.`);
      const source = team.owners.get(dependencyId);
      if (!source) throw new Error(`No subagent owns dependency ${dependencyId}.`);
      if (source.id !== worker.id) {
        const requestId = `${taskId}:need:${team.version}:${stepId}:${dependencyId}`;
        const isNew = !this.protocol.store.getAgentMessage(requestId);
        const request = this.sendAndRead(worker.id, source.id, 'request', {
          kind: 'dependency.request', stepId, dependencyStepId: dependencyId,
        }, requestId);
        const response = this.sendAndRead(source.id, worker.id, 'response', {
          kind: 'dependency.result', dependencyStepId: dependencyId,
          observedAt: result.observedAt, resultRef: dependencyId,
          ...this.outputPayload(taskId, `${request.id}:response:output`, worker.id, result.output),
        }, `${request.id}:response`, true, request.id);
        if (response.correlationId !== request.id) throw new Error('Subagent response correlation failed.');
        if (isNew) this.protocol.store.appendEvent(taskId, { type: 'agent.peer_exchange', payload: {
          stepId, dependencyStepId: dependencyId,
        } });
      }
      dependencies[dependencyId] = result.output;
    }
    if (assignment.status !== 'read') this.protocol.ackMessage(worker.id, assignmentId, 'read');
    this.protocol.store.updateAgentStatus(worker.id, 'running');
    this.protocol.store.appendEvent(taskId, { type: 'agent.step_active', payload: {
      stepId, agentId: worker.id, agentName: worker.name, description: step.description.slice(0, 180),
    } });
    return dependencies;
  }

  completeStep(taskId: string, steps: CollaborativeStep[], result: StepObservation): void {
    const team = this.team(taskId, steps);
    this.publishResult(team, result);
    const worker = team.owners.get(result.stepId)!;
    this.protocol.store.updateAgentStatus(worker.id, 'waiting');
  }

  failStep(taskId: string, steps: CollaborativeStep[], stepId: string, code: string): void {
    const team = this.team(taskId, steps);
    const worker = team.owners.get(stepId);
    if (!worker) return;
    this.sendAndRead(worker.id, team.root.id, 'error', {
      kind: 'step.failed', stepId, code,
    }, `${taskId}:failed:${team.version}:${stepId}:${code}`);
    this.protocol.store.updateAgentStatus(worker.id, 'waiting');
  }

  reviewStep(taskId: string, steps: CollaborativeStep[], stepId: string,
    action: 'continue' | 'replan' | 'block'): void {
    const team = this.team(taskId, steps);
    const worker = team.owners.get(stepId);
    if (!worker) return;
    this.sendAndRead(team.root.id, worker.id, 'status', {
      kind: 'step.review', stepId, action,
    }, `${taskId}:review:${team.version}:${stepId}:${action}`);
  }

  private publishResult(team: Team, result: StepObservation): void {
    const worker = team.owners.get(result.stepId)!;
    const taskId = team.root.rootTaskId!;
    const assignmentId = `${taskId}:assign:${team.version}:${result.stepId}:${worker.id}`;
    const contract = this.assignment(worker.id, assignmentId);
    const structuredResult = buildStepResult(contract, result);
    const messageId = `${taskId}:result:${team.version}:${result.stepId}:${result.observedAt}`;
    const isNew = !this.protocol.store.getAgentMessage(messageId);
    this.protocol.store.saveAgentPayloadRef(messageId, taskId, team.root.id, structuredResult);
    this.sendAndRead(worker.id, team.root.id, 'artifact', {
      kind: 'step.result', contractVersion: 1, planVersion: team.version,
      stepId: result.stepId, observedAt: result.observedAt, status: 'completed',
      resultRef: result.stepId,
      ...this.outputPayload(taskId, `${messageId}:output`, team.root.id, result.output),
    }, messageId);
    if (isNew) this.protocol.store.appendEvent(taskId, { type: 'agent.result_reported', payload: {
      stepId: result.stepId,
    } });
  }

  private assignment(workerId: string, assignmentId: string): StepAssignmentContract {
    const contract = this.protocol.getPayloadRef(workerId, assignmentId);
    return stepAssignmentSchema.parse(contract);
  }

  private outputPayload(taskId: string, payloadId: string, recipientId: string, output: unknown):
    { output: unknown } | { outputRef: string; outputBytes: number } {
    const serialized = JSON.stringify(output);
    if (serialized === undefined) throw new Error('Step output must be JSON serializable.');
    if (Buffer.byteLength(serialized, 'utf8') <= 4_000) return { output };
    this.protocol.store.saveAgentPayloadRef(payloadId, taskId, recipientId, output);
    return { outputRef: payloadId, outputBytes: Buffer.byteLength(serialized, 'utf8') };
  }

  private team(taskId: string, steps: CollaborativeStep[], versionOverride?: string): Team {
    const agents = this.protocol.listAgents(taskId);
    let root = agents.find(agent => !agent.parentAgentId && agent.role === 'orchestrator');
    if (!root) root = this.protocol.createAgent({ rootTaskId: taskId, name: 'Jarvis 主 Agent',
      role: 'orchestrator', goal: '分析任务、分派步骤、复盘结果并调整计划', status: 'running' });
    let workers = agents.filter(agent => agent.parentAgentId === root.id && /^task-worker-\d+$/.test(agent.role))
      .sort((a, b) => Number(a.role.slice(12)) - Number(b.role.slice(12)));
    const desired = recommendedWorkerCount(steps, this.maxWorkers);
    const occupied = agents.filter(agent => agent.parentAgentId === root.id).length;
    const addCount = Math.min(Math.max(0, desired - workers.length), MAX_CHILD_AGENTS - occupied);
    if (addCount > 0) {
      const created = this.controller.spawnChildren(root.id, Array.from({ length: addCount }, (_, index) => ({
        name: `任务子 Agent ${workers.length + index + 1}`,
        role: `task-worker-${workers.length + index}`,
        goal: '执行分派步骤，向主 Agent 报告结果，并响应同任务子 Agent 的依赖请求',
        status: 'queued' as const,
      })));
      workers = [...workers, ...created];
    }
    if (steps.length && !workers.length) throw new Error('No child Agent slot remains for this task.');
    const owners = new Map(steps.map((step, index) => {
      const previousId = this.protocol.store.findAssignedStepAgent(taskId, root.id, step.id);
      return [step.id, workers.find(worker => worker.id === previousId) ?? workers[index % workers.length]!];
    }));
    const version = versionOverride ?? this.activeVersions.get(taskId) ?? planVersion(steps, []);
    return { root, workers, owners, version };
  }

  private sendAndRead(senderAgentId: string, recipientAgentId: string,
    type: 'request' | 'response' | 'artifact' | 'status' | 'error', payload: unknown,
    messageId: string, acknowledge = true, correlationId?: string) {
    const message = this.protocol.sendMessage({ messageId, senderAgentId, recipientAgentId,
      type, payload, correlationId });
    return acknowledge && message.status !== 'read'
      ? this.protocol.ackMessage(recipientAgentId, message.id, 'read') : message;
  }
}
