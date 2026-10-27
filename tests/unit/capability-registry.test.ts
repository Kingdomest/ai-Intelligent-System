import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '../../src/capabilities/registry.js';
import { SandboxRunner } from '../../src/capabilities/sandbox-runner.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import type { EvaluationRecord } from '../../src/domain/contracts.js';
import type { ToolCandidate } from '../../src/agents/agent-runner.js';
import type { CapabilityInvocationContext } from '../../src/capabilities/registry.js';

const temporaryDirectories: string[] = [];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-registry-'));
  temporaryDirectories.push(directory);
  const store = new SqliteStore(join(directory, 'jarvis.sqlite'));
  return { directory, store, registry: new CapabilityRegistry(store, new SandboxRunner()) };
}

function candidate(overrides: Partial<ToolCandidate> = {}): ToolCandidate {
  return {
    id: 'dynamic.text.count_lines', capabilityKey: 'dynamic.text.count_lines', name: 'dynamic.text.count_lines',
    version: '1.0.0', intent: 'count lines', description: 'Count lines in text.',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, entrypoint: 'tool.mjs',
    runtime: 'node-sandbox-v1', permissions: [], riskLevel: 'low', tests: ['counts lines'],
    code: 'export async function run(input) { return { count: input.text.split("\\n").length }; }',
    ...overrides,
  };
}

const evaluation: EvaluationRecord = {
  targetId: 'dynamic.text.count_lines', targetVersion: '1.0.0', verdict: 'pass', score: 1,
  failures: [], recommendations: [], evaluatorRunId: 'eval-1',
};

function invocation(taskId: string, directory: string): CapabilityInvocationContext {
  return {
    taskId, mode: 'full', workspaceRoot: directory, stepId: 'count', operationSequence: 0,
    capabilityVersion: '1.0.0', hostCall: async (call) => ({ callId: call.callId, ok: false }),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('CapabilityRegistry', () => {
  it('installs and reuses maintained built-ins', () => {
    const { store, registry } = setup();
    try {
      registry.installBuiltins();
      expect(registry.findUsableByKey('filesystem.mkdir')?.manifest.provenance.sourceTaskId).toBe('builtin');
      expect(registry.findUsableByKey('text.count_lines')?.status).toBe('active');
    } finally { store.close(); }
  });

  it('keeps generated tools inside their originating task and out of SQLite', async () => {
    const { directory, store, registry } = setup();
    try {
      registry.installBuiltins();
      const record = registry.registerTemporary(candidate(), evaluation, 'task-1');
      expect(record.status).toBe('active');
      expect(registry.findUsableByKey(record.id, 'task-1')).toEqual(record);
      expect(registry.findUsableByKey(record.id, 'task-2')).toBeNull();
      expect(store.getCapabilityVersion(record.id, record.version)).toBeNull();
      expect((await registry.listTools()).some((tool) => tool.name === record.manifest.name)).toBe(false);
      expect(await registry.callTool(record.id, { text: 'a\nb' }, invocation('task-1', directory))).toEqual({ count: 2 });
      await expect(registry.callTool(record.id, { text: 'a\nb' }, invocation('task-2', directory)))
        .rejects.toThrow(/not found/i);
    } finally { store.close(); }
  });

  it('promotes, deprecates, and releases temporary tools without storing them', async () => {
    const { directory, store, registry } = setup();
    try {
      const record = registry.registerTemporary(candidate({ permissions: ['filesystem.read'] }), evaluation, 'task-1');
      expect(record.status).toBe('canary');
      expect(registry.promote(record.id, record.version, 'task-1').status).toBe('active');
      registry.deprecate(record.id, record.version, 'task-1');
      await expect(registry.callTool(record.id, { text: 'a' }, invocation('task-1', directory)))
        .rejects.toThrow(/quarantined/i);
      registry.releaseTask('task-1');
      expect(registry.getVersion(record.id, record.version, 'task-1')).toBeNull();
      expect(store.getCapabilityVersion(record.id, record.version)).toBeNull();
    } finally { store.close(); }
  });

  it('hides previously saved generated tools from the usable catalog', async () => {
    const { store, registry } = setup();
    try {
      const generated = candidate();
      store.saveCapability({
        id: generated.id, version: generated.version, status: 'active', normalizedIntent: generated.intent,
        manifest: { id: generated.id, capabilityKey: generated.id, version: generated.version,
          kind: 'tool', name: generated.name, description: generated.description,
          inputSchema: generated.inputSchema, outputSchema: generated.outputSchema,
          entrypoint: generated.entrypoint, runtime: generated.runtime, permissions: [],
          riskLevel: generated.riskLevel, tests: generated.tests,
          provenance: { sourceTaskId: 'old-task', generatedAt: new Date().toISOString() } },
        code: generated.code, evaluation, createdAt: new Date().toISOString(),
      });
      expect(registry.findUsableByKey(generated.id)).toBeNull();
      expect(registry.getVersion(generated.id, generated.version)).toBeNull();
      expect((await registry.listTools()).some((tool) => tool.name === generated.name)).toBe(false);
    } finally { store.close(); }
  });
});
