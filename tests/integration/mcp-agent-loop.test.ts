import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentServices } from '../../src/runtime/agent-loop.js';
import { AgentLoop } from '../../src/runtime/agent-loop.js';
import { TaskService } from '../../src/runtime/task-service.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { McpService } from '../../src/mcp/service.js';
import { SandboxRunner } from '../../src/capabilities/sandbox-runner.js';
import { CapabilityRegistry } from '../../src/capabilities/registry.js';
import { PermissionBroker } from '../../src/permissions/permission-broker.js';
import { DefaultHostOperationExecutor } from '../../src/permissions/host-operations.js';
import { TestAgent } from '../../src/agents/test-agent.js';
import { ToolFactory } from '../../src/capabilities/tool-factory.js';
import { AgentRunner } from '../../src/agents/agent-runner.js';
import { ModelGateway } from '../../src/model/gateway.js';
import { MockModelProvider } from '../../src/model/mock-provider.js';
import { TestExecutor } from '../../src/runtime/test-executor.js';
import { WindowsDesktopObserver } from '../../src/runtime/windows-desktop-observer.js';
import { BudgetManager } from '../../src/runtime/budget-manager.js';
import { AdaptiveScheduler } from '../../src/runtime/scheduler.js';
import { ToolDiscovery } from '../../src/capabilities/tool-discovery.js';
import { A2AProtocol } from '../../src/agents/a2a-protocol.js';
import { TaskCollaborationRuntime } from '../../src/runtime/task-collaboration.js';

describe('MCP task execution', () => {
  it('binds a planned MCP tool and returns its real file result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jarvis-mcp-loop-'));
    const store = new SqliteStore(join(root, 'tasks.sqlite'));
    const mcp = new McpService(root, root);
    try {
      writeFileSync(join(root, 'sample.txt'), 'read through agent loop');
      const agents: AgentServices = {
        runPlanner: async () => ({ status: 'ready', intent: 'read MCP file',
          acceptanceCriteria: ['Read sample.txt'], requiredCapabilities: [], steps: [
            { id: 'read', capabilityKey: 'mcp.call', description: 'Read sample via MCP', dependsOn: [],
              input: { server: 'filesystem', tool: 'read_text_file', dynamicArgs: { path: join(root, 'sample.txt') } } },
          ] }),
        runImplementer: async () => { throw new Error('Maintained MCP bridge should be used.'); },
        runEvaluator: async input => ({ targetId: input.target, targetVersion: '1.0.0',
          evaluatorRunId: 'mcp-test', status: 'pass', verdict: 'pass', score: 1,
          failures: [], recommendations: [], evidence: [] }),
        runResponder: async input => JSON.stringify(input.results),
      };
      const sandbox = new SandboxRunner();
      const registry = new CapabilityRegistry(store, sandbox);
      const broker = new PermissionBroker(store, new DefaultHostOperationExecutor({ mcp }), root);
      const tester = new TestAgent(new ModelGateway(new MockModelProvider()));
      const loop = new AgentLoop({ store, agents, tester, testExecutor: new TestExecutor(sandbox),
        desktopObserver: new WindowsDesktopObserver(), factory: new ToolFactory(agents), registry, sandbox,
        budget: new BudgetManager({ maxContextTokens: 32_000, outputReserveTokens: 4_000 }),
        scheduler: new AdaptiveScheduler({ maxConcurrency: 1 }), maxRetries: 1, maxSteps: 5,
        permissionBroker: broker, workspaceRoot: root, desktopDirectory: root });
      const task = await new TaskService(store, loop, broker).createAndWait({
        message: 'Read sample through MCP', attachments: [], permissionMode: 'full',
      });
      expect(task.status).toBe('COMPLETED');
      expect(task.result).toContain('read through agent loop');
      expect(store.listStepOperations(task.id, 'read', '1.0.0')[0]?.operation.permission).toBe('mcp');
    } finally {
      await mcp.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('lets the assigned worker search and select an MCP tool for a dynamic step', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jarvis-mcp-select-'));
    const store = new SqliteStore(join(root, 'tasks.sqlite'));
    const mcp = new McpService(root, root);
    const searched: string[] = [];
    const selected: string[] = [];
    try {
      const path = join(root, 'sample.txt');
      writeFileSync(path, 'selected by worker');
      const agents: AgentServices = {
        runPlanner: async () => ({ status: 'ready', intent: 'read sample',
          acceptanceCriteria: ['Read sample.txt'], requiredCapabilities: [
            { name: 'dynamic.filesystem.read_sample', purpose: 'Read a text file', riskLevel: 'low' },
          ], steps: [{ id: 'read', capabilityKey: 'dynamic.filesystem.read_sample',
            description: 'Read sample.txt using an existing tool', dependsOn: [], input: { path } }] }),
        runToolSearch: async input => { searched.push(input.workerRole ?? ''); return ['read text file']; },
        runToolSelection: async input => {
          selected.push(input.workerRole ?? '');
          expect(input.candidates.some(item => item.id === 'mcp:filesystem/read_text_file')).toBe(true);
          return { action: 'use', toolId: 'mcp:filesystem/read_text_file', arguments: { path }, reason: 'Matches read task' };
        },
        runImplementer: async () => { throw new Error('Selected MCP tool should avoid generation.'); },
        runEvaluator: async input => ({ targetId: input.target, targetVersion: '1.0.0',
          evaluatorRunId: 'mcp-select-test', status: 'pass', verdict: 'pass', score: 1,
          failures: [], recommendations: [], evidence: [] }),
        runResponder: async input => JSON.stringify(input.results),
      };
      const sandbox = new SandboxRunner();
      const registry = new CapabilityRegistry(store, sandbox);
      const broker = new PermissionBroker(store, new DefaultHostOperationExecutor({ mcp }), root);
      const loop = new AgentLoop({ store, agents, tester: new TestAgent(new ModelGateway(new MockModelProvider())),
        testExecutor: new TestExecutor(sandbox), desktopObserver: new WindowsDesktopObserver(),
        factory: new ToolFactory(agents), registry, toolDiscovery: new ToolDiscovery(mcp), sandbox,
        collaboration: new TaskCollaborationRuntime(new A2AProtocol(store)),
        budget: new BudgetManager({ maxContextTokens: 32_000, outputReserveTokens: 4_000 }),
        scheduler: new AdaptiveScheduler({ maxConcurrency: 1 }), maxRetries: 1, maxSteps: 5,
        permissionBroker: broker, workspaceRoot: root, desktopDirectory: root });
      const task = await new TaskService(store, loop, broker).createAndWait({
        message: 'Read sample through a discovered tool', attachments: [], permissionMode: 'full',
      });
      expect(task.status, task.result).toBe('COMPLETED');
      expect(task.result).toContain('selected by worker');
      expect(searched).toEqual(['task-worker-0']);
      expect(selected).toEqual(['task-worker-0']);
      expect(store.listEvents(task.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'tool.selected', payload: expect.objectContaining({
          choice: 'mcp', server: 'filesystem', tool: 'read_text_file', workerRole: 'task-worker-0',
        }) }),
      ]));
      const protocol = new A2AProtocol(store);
      const worker = protocol.listAgents(task.id).find(agent => agent.role === 'task-worker-0')!;
      const assignments = protocol.listInbox(worker.id).filter(message =>
        (message.payload as { kind?: string }).kind === 'step.assignment');
      expect(assignments).toHaveLength(1);
      expect(protocol.getPayloadRef(worker.id, assignments[0]!.id)).toMatchObject({
        capabilityKey: 'mcp.call', input: { server: 'filesystem', tool: 'read_text_file', dynamicArgs: { path } },
        parameters: expect.arrayContaining([expect.objectContaining({ name: 'dynamicArgs.path' })]),
      });
    } finally {
      await mcp.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('has the assigned worker create a task-local tool when search finds no match', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jarvis-tool-create-'));
    const store = new SqliteStore(join(root, 'tasks.sqlite'));
    const implementerRoles: string[] = [];
    try {
      const agents: AgentServices = {
        runPlanner: async () => ({ status: 'ready', intent: 'reverse text',
          acceptanceCriteria: ['Return reversed text'], requiredCapabilities: [
            { name: 'dynamic.text.reverse_graphemes', purpose: 'Reverse grapheme sequence', riskLevel: 'low' },
          ], steps: [{ id: 'reverse', capabilityKey: 'dynamic.text.reverse_graphemes',
            description: 'Reverse grapheme sequence in text', dependsOn: [], input: { text: 'hello' } }] }),
        runToolSearch: async () => ['reverse grapheme sequence'],
        runToolSelection: async () => { throw new Error('No candidates should be selected.'); },
        runImplementer: async input => {
          implementerRoles.push(input.workerRole ?? '');
          return { kind: 'tool_candidate', candidate: {
            id: 'reverse_graphemes', capabilityKey: input.capabilityKey, name: 'reverse_graphemes',
            version: '1.0.0', intent: 'reverse text', description: 'Reverse supplied text',
            inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
            outputSchema: { type: 'object', required: ['content'], properties: { content: { type: 'string' } } },
            entrypoint: 'tool.mjs', runtime: 'node-sandbox-v1', permissions: [], riskLevel: 'low',
            tests: ['hello becomes olleh'],
            code: 'export async function run(input) { return { content: Array.from(input.text).reverse().join("") }; }',
          } };
        },
        runEvaluator: async input => ({ targetId: input.target, targetVersion: '1.0.0',
          evaluatorRunId: 'fallback-test', status: 'pass', verdict: 'pass', score: 1,
          failures: [], recommendations: [], evidence: [] }),
      };
      const sandbox = new SandboxRunner();
      const registry = new CapabilityRegistry(store, sandbox);
      const broker = new PermissionBroker(store, new DefaultHostOperationExecutor(), root);
      const loop = new AgentLoop({ store, agents, tester: new TestAgent(new ModelGateway(new MockModelProvider())),
        testExecutor: new TestExecutor(sandbox), desktopObserver: new WindowsDesktopObserver(),
        factory: new ToolFactory(agents), registry, toolDiscovery: new ToolDiscovery(), sandbox,
        collaboration: new TaskCollaborationRuntime(new A2AProtocol(store)),
        budget: new BudgetManager({ maxContextTokens: 32_000, outputReserveTokens: 4_000 }),
        scheduler: new AdaptiveScheduler({ maxConcurrency: 1 }), maxRetries: 1, maxSteps: 5,
        permissionBroker: broker, workspaceRoot: root, desktopDirectory: root });
      const task = await new TaskService(store, loop, broker).createAndWait({
        message: 'Reverse hello', attachments: [], permissionMode: 'full',
      });
      expect(task.status, task.result).toBe('COMPLETED');
      expect(implementerRoles).toEqual(['task-worker-0']);
      expect(task.metrics.generatedCapabilityCount).toBe(1);
      expect(store.listEvents(task.id).some(event => event.type === 'tool.searched'
        && event.payload.candidateCount === 0)).toBe(true);
      expect(store.listEvents(task.id).some(event => event.type === 'tool.selected'
        && event.payload.choice === 'create')).toBe(true);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
