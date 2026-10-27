import { describe, expect, it } from 'vitest';
import type { ToolCandidate } from '../../src/agents/agent-runner.js';
import { deriveGenericityFixtures, verifyGenericity } from '../../src/capabilities/genericity-gate.js';
import { SandboxRunner } from '../../src/capabilities/sandbox-runner.js';

const candidate = (code: string, permissions: ToolCandidate['permissions'] = ['filesystem.write']): ToolCandidate => ({
  id: 'dynamic.filesystem.mkdir', capabilityKey: 'dynamic.filesystem.mkdir', name: 'mkdir', version: '1.0.0',
  intent: 'create a directory', description: 'Create a directory', inputSchema: {}, outputSchema: {},
  entrypoint: 'tool.mjs', runtime: 'node-sandbox-v1', permissions, riskLevel: 'medium', tests: [], code,
});

describe('dynamic capability genericity gate', () => {
  const sandbox = new SandboxRunner();
  const inputs: [Record<string, unknown>, Record<string, unknown>] = [{ path: 'D:/tmp/alpha' }, { path: 'D:/tmp/beta' }];

  it('derives a second target without changing unrelated arguments', () => {
    expect(deriveGenericityFixtures({ path: 'D:/tmp/alpha', content: 'hello' })).toEqual([
      { path: 'D:/tmp/alpha', content: 'hello' },
      { path: 'D:/tmp/alpha-jarvis-probe', content: 'hello' },
    ]);
  });

  it('derives a distinct target from a declared domain-specific string field', () => {
    expect(deriveGenericityFixtures({ documentId: 'document-1', message: 'do not vary' })).toEqual([
      { documentId: 'document-1', message: 'do not vary' },
      { documentId: 'document-1-jarvis-probe', message: 'do not vary' },
    ]);
  });

  it('rejects a tool that ignores the second target', async () => {
    const tool = candidate("export async function run(input, host) { return host.fs.mkdir('D:/tmp/alpha'); }");
    expect((await verifyGenericity(tool, inputs, sandbox)).passed).toBe(false);
  });

  it('rejects a fixed host target even when arguments contain the varied input', async () => {
    const tool = candidate("export async function run(input, host) { return host.fs.writeText('D:/tmp/fixed.txt', input.path); }");
    expect((await verifyGenericity(tool, inputs, sandbox)).passed).toBe(false);
  });

  it('accepts a tool whose host target changes with the input', async () => {
    const tool = candidate('export async function run(input, host) { return host.fs.mkdir(input.path); }');
    const report = await verifyGenericity(tool, inputs, sandbox);
    expect(report.passed).toBe(true);
    expect(report.hostCalls.map((call) => call.target)).toEqual(['D:/tmp/alpha', 'D:/tmp/beta']);
  });

  it('rejects missing input and a false-success catch', async () => {
    const good = candidate('export async function run(input, host) { return host.fs.mkdir(input.path); }');
    expect((await verifyGenericity(good, [{}, inputs[1]], sandbox)).passed).toBe(false);
    const falseSuccess = candidate('export async function run(input, host) { try { await host.fs.mkdir(input.path); } catch {} return { success: true }; }');
    expect((await verifyGenericity(falseSuccess, inputs, sandbox)).passed).toBe(false);
  });

  it('rejects a pure computation that returns the same answer for two inputs', async () => {
    const constant = candidate('export async function run(input) { return { count: 2 }; }', []);
    expect((await verifyGenericity(constant, [{ content: 'a\nb' }, { content: 'a\nb\nc' }], sandbox)).passed).toBe(false);
  });
});
