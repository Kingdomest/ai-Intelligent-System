import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDependencies } from '../../src/runtime/dependencies.js';
import { PolicyValidator } from '../../src/capabilities/policy-validator.js';
import type { ToolCandidate } from '../../src/agents/agent-runner.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Jarvis MVP flow', () => {
  it('generates task-local capabilities without carrying them into the next request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-mvp-'));
    temporaryDirectories.push(directory);
    const runtime = createDependencies({ dataDir: directory, modelMode: 'mock' });
    try {
    const first = await runtime.taskService.createAndWait({
      message: '统计上传内容有多少行',
      attachments: [{ id: 'one', filename: 'one.txt', mimeType: 'text/plain', size: 4, content: 'a\nb\n' }],
    });
    const team = runtime.a2aProtocol.listAgents(first.id);
    const main = team.find(agent => agent.role === 'orchestrator')!;
    const worker = team.find(agent => agent.role === 'task-worker-0')!;
    expect(worker.parentAgentId).toBe(main.id);
    expect(runtime.a2aProtocol.listInbox(main.id).some(message => message.type === 'artifact'
      && (message.payload as { kind?: string }).kind === 'step.result')).toBe(true);
    const second = await runtime.taskService.createAndWait({
      message: '统计上传内容有多少行',
      attachments: [{ id: 'two', filename: 'two.txt', mimeType: 'text/plain', size: 6, content: 'a\nb\nc\n' }],
    });

    expect(first.status).toBe('COMPLETED');
    expect(second.status).toBe('COMPLETED');
    expect(first.result).toContain('2');
    expect(second.result).toContain('3');
    expect(second.metrics.generatedCapabilityCount).toBe(1);
    expect(second.metrics.reusedCapabilityCount).toBe(0);
    expect(runtime.store.listActiveCapabilities().every((capability) =>
      capability.manifest.provenance.sourceTaskId === 'builtin')).toBe(true);
    expect((runtime.modelProvider as { calls?: number }).calls).toBeGreaterThan(0);
    } finally {
      await runtime.mcp.close();
      runtime.store.close();
    }
  }, 20_000);

  it('rejects an unsafe generated candidate before sandbox execution', () => {
    const candidate = {
      runtime: 'node-sandbox-v1',
      riskLevel: 'low',
      permissions: [],
      code: "import child_process from 'node:child_process'; export async function run() {}",
    } as unknown as ToolCandidate;
    expect(new PolicyValidator().validate(candidate).allowed).toBe(false);
  });
});
