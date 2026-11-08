import { afterEach, describe, expect, it } from 'vitest';
import { A2AProtocol } from '../../src/agents/a2a-protocol.js';
import { TaskCollaborationRuntime, recommendedWorkerCount } from '../../src/runtime/task-collaboration.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

const stores: SqliteStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

const steps = [
  { id: 'a', description: 'Read source', capabilityKey: 'filesystem.read_text', dependsOn: [],
    input: { path: 'C:/workspace/source.txt' } },
  { id: 'b', description: 'Use source', capabilityKey: 'filesystem.write_text', dependsOn: ['a'],
    input: { path: 'C:/workspace/result.txt', content: 'result' } },
];

describe('TaskCollaborationRuntime', () => {
  it('reports a verified existing checkout through the process step contract', () => {
    const store = new SqliteStore(':memory:');
    stores.push(store);
    const task = store.createTask({ message: 'Put the repository on the desktop', attachments: [] });
    const protocol = new A2AProtocol(store);
    const team = new TaskCollaborationRuntime(protocol);
    const cloneSteps = [{ id: 'clone_repo', description: 'Clone repository', capabilityKey: 'process.run',
      dependsOn: [], input: { command: 'git', args: ['clone', 'https://github.com/deepseek-ai/deepseek-harness.git', '.'],
        cwd: 'C:/Users/Administrator/Desktop/deepseek-code' } }];
    team.ensurePlan(task.id, cloneSteps);
    const result = { stepId: 'clone_repo', output: {
      repositoryUrl: 'https://github.com/deepseek-ai/deepseek-harness.git',
      path: 'C:/Users/Administrator/Desktop/deepseek-code', alreadyPresent: true,
      source: 'github-source-archive', gitHistory: false,
    }, observedAt: '2026-11-08T00:00:00Z' };
    expect(() => team.completeStep(task.id, cloneSteps, result)).not.toThrow();
    expect(store.listEvents(task.id).some(event => event.type === 'agent.result_reported')).toBe(true);
  });

  it('sizes a team from the dependency graph', () => {
    expect(recommendedWorkerCount([])).toBe(0);
    expect(recommendedWorkerCount(steps.slice(0, 1))).toBe(1);
    expect(recommendedWorkerCount(steps)).toBe(2);
    expect(recommendedWorkerCount([...steps.slice(0, 1),
      { id: 'c', description: 'Independent', dependsOn: [] },
      { id: 'd', description: 'Independent', dependsOn: [] }])).toBe(3);
  });

  it('dispatches steps, delivers A to B on request, and reports each result to the main Agent', () => {
    const store = new SqliteStore(':memory:');
    stores.push(store);
    const task = store.createTask({ message: 'Read and use source', attachments: [] });
    const protocol = new A2AProtocol(store);
    const team = new TaskCollaborationRuntime(protocol);
    team.ensurePlan(task.id, steps);
    const agents = protocol.listAgents(task.id);
    const main = agents.find(agent => agent.role === 'orchestrator')!;
    const [a, b] = agents.filter(agent => agent.role.startsWith('task-worker-'))
      .sort((left, right) => left.role.localeCompare(right.role));
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    const assignment = protocol.listInbox(a!.id).find(message => (message.payload as { kind?: string }).kind === 'step.assignment')!;
    const contract = protocol.getPayloadRef(a!.id, assignment.id) as Record<string, unknown>;
    expect(contract).toMatchObject({ objective: 'Read source', capabilityKey: 'filesystem.read_text',
      input: { path: 'C:/workspace/source.txt' },
      parameters: [{ name: 'path', type: 'string', required: true,
        description: 'Absolute path of the file to read.' }],
      outputSchema: { type: 'object', required: ['content'] } });
    expect(team.beginStep(task.id, steps, 'a', [])).toEqual({});
    const result = { stepId: 'a', output: { content: 'verified finding' }, observedAt: '2026-11-08T00:00:00Z' };
    team.completeStep(task.id, steps, result);
    expect(protocol.listInbox(main.id).some(message => message.type === 'artifact'
      && (message.payload as { stepId?: string }).stepId === 'a' && message.status === 'read')).toBe(true);
    expect(team.beginStep(task.id, steps, 'b', [result])).toEqual({ a: result.output });
    const request = protocol.listInbox(a!.id).find(message => message.type === 'request'
      && (message.payload as { kind?: string }).kind === 'dependency.request')!;
    const response = protocol.listInbox(b!.id).find(message => message.type === 'response')!;
    expect(request).toMatchObject({ senderAgentId: b!.id, status: 'read' });
    expect(response).toMatchObject({ senderAgentId: a!.id, correlationId: request.id,
      payload: { output: result.output, resultRef: 'a' }, status: 'read' });
    expect(store.listEvents(task.id).map(event => event.type)).toEqual(expect.arrayContaining([
      'agent.result_reported', 'agent.peer_exchange',
    ]));
    team.reviewStep(task.id, steps, 'a', 'continue');
    expect(protocol.listInbox(a!.id).some(message => message.type === 'status')).toBe(true);

    const before = protocol.listInbox(main.id).length;
    team.ensurePlan(task.id, steps, [result]);
    expect(protocol.listInbox(main.id)).toHaveLength(before);
  });

  it('rejects a missing dependency before any dependent step runs', () => {
    const store = new SqliteStore(':memory:');
    stores.push(store);
    const task = store.createTask({ message: 'Dependent work', attachments: [] });
    const team = new TaskCollaborationRuntime(new A2AProtocol(store));
    team.ensurePlan(task.id, steps);
    expect(() => team.beginStep(task.id, steps, 'b', [])).toThrow(/missing the verified result/);
    expect(new A2AProtocol(store).listAgents(task.id).find(agent => agent.role === 'task-worker-1')?.status)
      .not.toBe('running');
  });

  it('reassigns a revised step while keeping completed results available', () => {
    const store = new SqliteStore(':memory:');
    stores.push(store);
    const task = store.createTask({ message: 'Revise dependent work', attachments: [] });
    const protocol = new A2AProtocol(store);
    const team = new TaskCollaborationRuntime(protocol);
    team.ensurePlan(task.id, steps);
    const result = { stepId: 'a', output: { content: 'verified' }, observedAt: '2026-11-08T00:00:00Z' };
    team.completeStep(task.id, steps, result);
    const revised = [steps[0]!, { id: 'c', description: 'Revised work', dependsOn: ['a'],
      capabilityKey: 'filesystem.write_text' }];
    team.ensurePlan(task.id, revised, [result]);
    expect(team.beginStep(task.id, revised, 'c', [result])).toEqual({ a: result.output });
    const worker = protocol.listAgents(task.id).find(agent => agent.role === 'task-worker-1')!;
    expect(protocol.listInbox(worker.id).some(message => message.type === 'request'
      && (message.payload as { stepId?: string }).stepId === 'c')).toBe(true);
    expect(protocol.listInbox(worker.id).some(message => message.type === 'response'
      && (message.payload as { dependencyStepId?: string }).dependencyStepId === 'a')).toBe(true);
  });

  it('preserves a completed step owner when replanning changes step order', () => {
    const store = new SqliteStore(':memory:');
    stores.push(store);
    const task = store.createTask({ message: 'Reorder plan', attachments: [] });
    const protocol = new A2AProtocol(store);
    const team = new TaskCollaborationRuntime(protocol);
    team.ensurePlan(task.id, steps);
    const main = protocol.listAgents(task.id).find(agent => agent.role === 'orchestrator')!;
    const firstOwnerId = store.findAssignedStepAgent(task.id, main.id, 'a')!;
    const result = { stepId: 'a', output: { content: 'verified' }, observedAt: '2026-11-08T00:00:00Z' };
    team.completeStep(task.id, steps, result);
    team.ensurePlan(task.id, [steps[1]!, steps[0]!], [result]);
    const assignments = protocol.listInbox(firstOwnerId).filter(message => message.type === 'request'
      && (message.payload as { kind?: string; stepId?: string }).kind === 'step.assignment'
      && (message.payload as { stepId?: string }).stepId === 'a');
    expect(assignments).toHaveLength(2);
    const other = protocol.listAgents(task.id).find(agent => agent.role.startsWith('task-worker-')
      && agent.id !== firstOwnerId)!;
    expect(protocol.listInbox(other.id).some(message => message.type === 'request'
      && (message.payload as { kind?: string; stepId?: string }).kind === 'step.assignment'
      && (message.payload as { stepId?: string }).stepId === 'a')).toBe(false);
  });

  it('issues a new assignment when only an input value changes', () => {
    const store = new SqliteStore(':memory:');
    stores.push(store);
    const task = store.createTask({ message: 'Read a file', attachments: [] });
    const protocol = new A2AProtocol(store);
    const team = new TaskCollaborationRuntime(protocol);
    team.ensurePlan(task.id, [steps[0]!]);
    const changed = [{ ...steps[0]!, input: { path: 'C:/workspace/revised.txt' } }];
    team.ensurePlan(task.id, changed);
    const worker = protocol.listAgents(task.id).find(agent => agent.role === 'task-worker-0')!;
    const assignments = protocol.listInbox(worker.id).filter(message =>
      (message.payload as { kind?: string }).kind === 'step.assignment');
    expect(assignments).toHaveLength(2);
    expect(assignments[0]!.id).not.toBe(assignments[1]!.id);
    expect(assignments.map(message => protocol.getPayloadRef(worker.id, message.id))).toEqual(
      expect.arrayContaining([expect.objectContaining({ input: { path: 'C:/workspace/revised.txt' } })]));
    const oldAssignment = assignments.find(message => (protocol.getPayloadRef(worker.id, message.id) as
      { input: { path: string } }).input.path === 'C:/workspace/source.txt')!;
    expect(oldAssignment.status).toBe('failed');
    expect(oldAssignment.error).toBe('SUPERSEDED');
    expect(team.beginStep(task.id, changed, 'a', [])).toEqual({});
  });

  it('keeps a large assignment available by reference without truncating it', () => {
    const store = new SqliteStore(':memory:');
    stores.push(store);
    const task = store.createTask({ message: 'Count lines', attachments: [] });
    const protocol = new A2AProtocol(store);
    const team = new TaskCollaborationRuntime(protocol);
    const text = 'line\n'.repeat(2_000);
    const large = [{ id: 'count', description: 'Count the supplied text lines',
      capabilityKey: 'text.count_lines', dependsOn: [], input: { text } }];
    team.ensurePlan(task.id, large);
    const worker = protocol.listAgents(task.id).find(agent => agent.role === 'task-worker-0')!;
    const assignment = protocol.listInbox(worker.id)[0]!;
    expect(assignment.payload).toMatchObject({ contractRef: assignment.id });
    expect((assignment.payload as { contract?: unknown }).contract).toBeUndefined();
    expect(protocol.getPayloadRef(worker.id, assignment.id)).toMatchObject({ input: { text } });
    expect(() => protocol.getPayloadRef('unknown-agent', assignment.id)).toThrow(/not found/i);
    expect(team.beginStep(task.id, large, 'count', [])).toEqual({});
  });

  it('rejects a result that violates the declared structure before reporting completion', () => {
    const store = new SqliteStore(':memory:');
    stores.push(store);
    const task = store.createTask({ message: 'Read a file', attachments: [] });
    const protocol = new A2AProtocol(store);
    const team = new TaskCollaborationRuntime(protocol);
    team.ensurePlan(task.id, [steps[0]!]);
    const main = protocol.listAgents(task.id).find(agent => agent.role === 'orchestrator')!;
    expect(() => team.completeStep(task.id, [steps[0]!], {
      stepId: 'a', output: { ok: true }, observedAt: '2026-11-08T00:00:00Z',
    })).toThrow(/declared result structure/);
    expect(protocol.listInbox(main.id).filter(message => message.type === 'artifact')).toHaveLength(0);
  });

  it('returns large verified results by durable reference to the main and dependent workers', () => {
    const store = new SqliteStore(':memory:');
    stores.push(store);
    const task = store.createTask({ message: 'Read and use a large source', attachments: [] });
    const protocol = new A2AProtocol(store);
    const team = new TaskCollaborationRuntime(protocol);
    team.ensurePlan(task.id, steps);
    const agents = protocol.listAgents(task.id);
    const main = agents.find(agent => agent.role === 'orchestrator')!;
    const source = agents.find(agent => agent.role === 'task-worker-0')!;
    const dependent = agents.find(agent => agent.role === 'task-worker-1')!;
    const result = { stepId: 'a', output: { content: 'x'.repeat(10_000) },
      observedAt: '2026-11-08T00:00:00Z' };
    team.completeStep(task.id, steps, result);
    const artifact = protocol.listInbox(main.id).find(message => message.type === 'artifact')!;
    const artifactPayload = artifact.payload as { outputRef: string; output?: unknown };
    expect(artifactPayload.output).toBeUndefined();
    expect(protocol.getPayloadRef(main.id, artifactPayload.outputRef)).toEqual(result.output);
    expect(protocol.getPayloadRef(main.id, artifact.id)).toMatchObject({ output: result.output,
      status: 'completed', stepId: 'a' });
    expect(() => protocol.getPayloadRef(source.id, artifact.id)).toThrow(/not found/i);
    expect(team.beginStep(task.id, steps, 'b', [result])).toEqual({ a: result.output });
    const response = protocol.listInbox(dependent.id).find(message => message.type === 'response')!;
    const responsePayload = response.payload as { outputRef: string; output?: unknown };
    expect(responsePayload.output).toBeUndefined();
    expect(protocol.getPayloadRef(dependent.id, responsePayload.outputRef)).toEqual(result.output);
  });

  it('uses the bound capability schema and task criteria for a dynamic step', () => {
    const store = new SqliteStore(':memory:');
    stores.push(store);
    const task = store.createTask({ message: 'Transform input', attachments: [] });
    const protocol = new A2AProtocol(store);
    const team = new TaskCollaborationRuntime(protocol);
    const dynamic = [{ id: 'transform', description: 'Transform the input value',
      capabilityKey: 'dynamic.text.transform', dependsOn: [], input: { value: 'sample' } }];
    team.ensurePlan(task.id, dynamic, [], { acceptanceCriteria: ['Return uppercase text'],
      schemas: { transform: { version: '1.0.0',
        inputSchema: { type: 'object', required: ['value'], properties: {
          value: { type: 'string', description: 'Text to transform.' },
        } },
        outputSchema: { type: 'object', required: ['transformed'], properties: {
          transformed: { type: 'string' },
        } },
      } } });
    const worker = protocol.listAgents(task.id).find(agent => agent.role === 'task-worker-0')!;
    const assignment = protocol.listInbox(worker.id)[0]!;
    expect(protocol.getPayloadRef(worker.id, assignment.id)).toMatchObject({
      acceptanceCriteria: ['Return uppercase text'],
      parameters: [{ name: 'value', type: 'string', required: true, description: 'Text to transform.' }],
      outputSchema: { required: ['transformed'] },
    });
    expect(team.beginStep(task.id, dynamic, 'transform', [])).toEqual({});
    expect(() => team.completeStep(task.id, dynamic, { stepId: 'transform', output: { wrong: 'SAMPLE' },
      observedAt: '2026-11-08T00:00:00Z' })).toThrow(/declared result structure/);
    team.completeStep(task.id, dynamic, { stepId: 'transform', output: { transformed: 'SAMPLE' },
      observedAt: '2026-11-08T00:00:00Z' });
  });

  it('describes each selected MCP tool argument, including nested required fields', () => {
    const store = new SqliteStore(':memory:');
    stores.push(store);
    const task = store.createTask({ message: 'Find a record', attachments: [] });
    const protocol = new A2AProtocol(store);
    const team = new TaskCollaborationRuntime(protocol);
    const mcpStep = [{ id: 'lookup', description: 'Find the matching record', capabilityKey: 'mcp.call',
      dependsOn: [], input: { server: 'records', tool: 'find', dynamicArgs: { query: 'example', limit: 2 } },
      mcpInputSchema: { type: 'object', required: ['query'], properties: {
        query: { type: 'string', description: 'Search terms for matching records.' },
        limit: { type: 'integer', description: 'Maximum records to return.' },
      } } }];
    team.ensurePlan(task.id, mcpStep);
    const worker = protocol.listAgents(task.id).find(agent => agent.role === 'task-worker-0')!;
    const assignment = protocol.listInbox(worker.id)[0]!;
    expect(protocol.getPayloadRef(worker.id, assignment.id)).toMatchObject({ parameters: [
      expect.objectContaining({ name: 'server' }),
      expect.objectContaining({ name: 'tool' }),
      expect.objectContaining({ name: 'dynamicArgs' }),
      { name: 'dynamicArgs.query', type: 'string', required: true,
        description: 'Search terms for matching records.' },
      { name: 'dynamicArgs.limit', type: 'integer', required: false,
        description: 'Maximum records to return.' },
    ] });
  });
});
