import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpService } from '../../src/mcp/service.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { PermissionBroker, ApprovalRequiredError } from '../../src/permissions/permission-broker.js';
import { DefaultHostOperationExecutor } from '../../src/permissions/host-operations.js';
import type { CapabilityRecord } from '../../src/domain/contracts.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const item of cleanup.splice(0).reverse()) await item(); });

describe('bundled MCP servers', () => {
  it('discovers real tools and confines filesystem to read-only workspace access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-mcp-test-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'sample.txt'), 'MCP connected', 'utf8');
    const service = new McpService(root, root);
    cleanup.push(() => service.close());

    const tools = await service.listTools();
    expect(tools.some(item => item.server === 'filesystem' && item.name === 'read_text_file')).toBe(true);
    expect(tools.some(item => item.server === 'filesystem' && item.name === 'write_file')).toBe(false);
    expect(tools.some(item => item.server === 'memory' && item.name === 'search_nodes')).toBe(true);

    const output = await service.call('filesystem', 'read_text_file', { path: join(root, 'sample.txt') });
    expect(JSON.stringify(output)).toContain('MCP connected');
    await expect(service.call('filesystem', 'write_file', { path: join(root, 'sample.txt'), content: 'changed' }))
      .rejects.toThrow('unavailable');
    await expect(service.call('filesystem', 'read_text_file', { path: join(tmpdir(), 'outside.txt') }))
      .rejects.toThrow();
    await service.call('memory', 'create_entities', { entities: [
      { name: 'MCP integration probe', entityType: 'test', observations: ['local memory is connected'] },
    ] });
    const memory = await service.call('memory', 'search_nodes', { query: 'MCP integration probe' });
    expect(JSON.stringify(memory)).toContain('local memory is connected');
  }, 30_000);

  it('sends an MCP call through approval and the operation journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-mcp-approval-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'sample.txt'), 'approved MCP result', 'utf8');
    const store = new SqliteStore(join(root, 'tasks.sqlite'));
    cleanup.push(async () => store.close());
    const service = new McpService(root, root);
    cleanup.push(() => service.close());
    const now = new Date().toISOString();
    const capability: CapabilityRecord = {
      id: 'mcp.call', version: '1.0.0', status: 'canary', normalizedIntent: 'mcp call',
      manifest: { id: 'mcp.call', version: '1.0.0', kind: 'tool', name: 'mcp.call',
        description: 'Call MCP', inputSchema: {}, outputSchema: {}, entrypoint: 'tool.mjs',
        runtime: 'node-sandbox-v1', permissions: ['mcp'], riskLevel: 'medium', tests: [],
        provenance: { sourceTaskId: 'builtin', generatedAt: now } },
      code: '', evaluation: { targetId: 'mcp.call', targetVersion: '1.0.0', verdict: 'pass',
        score: 1, failures: [], recommendations: [], evaluatorRunId: 'test' }, createdAt: now,
    };
    store.saveCapability(capability);
    const task = store.createTask({ message: 'Read sample via MCP', attachments: [], permissionMode: 'request' });
    task.executionCheckpoint = { planner: {}, capabilityName: 'mcp.call', capabilityVersion: '1.0.0',
      completedStepIds: [], currentStepId: 'read', operationSequence: 0 };
    store.saveTask(task);
    const broker = new PermissionBroker(store, new DefaultHostOperationExecutor({ mcp: service }), root);
    const operation = { operationId: `${task.id}:read:1.0.0:0`, permission: 'mcp' as const,
      action: 'call', target: 'filesystem/read_text_file', reason: 'Read the requested file.',
      arguments: { server: 'filesystem', tool: 'read_text_file', arguments: { path: join(root, 'sample.txt') } } };
    const context = { taskId: task.id, mode: 'request' as const, workspaceRoot: root,
      capabilityPermissions: ['mcp' as const], capabilityVersion: '1.0.0', stepId: 'read',
      operationSequence: 0, dryRun: false };
    await expect(broker.handle(task.id, operation, context)).rejects.toBeInstanceOf(ApprovalRequiredError);
    const requestId = store.getTask(task.id)?.pendingPermission?.requestId;
    expect(requestId).toBeTruthy();
    await broker.resolve(task.id, requestId!, true);
    const output = await broker.handle(task.id, operation, context);
    expect(JSON.stringify(output)).toContain('approved MCP result');
    expect(store.listStepOperations(task.id, 'read', '1.0.0')[0]?.state).toBe('completed');
  }, 30_000);
});
