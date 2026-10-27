import { describe, expect, it } from 'vitest';
import { PolicyValidator } from '../../src/capabilities/policy-validator.js';
import type { ToolCandidate } from '../../src/agents/agent-runner.js';

function candidate(overrides: Partial<ToolCandidate> = {}): ToolCandidate {
  return {
    id: 'count_lines',
    name: 'count_lines',
    version: '1.0.0',
    intent: 'count lines uploaded content',
    description: 'Counts lines.',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    entrypoint: 'tool.mjs',
    runtime: 'node-sandbox-v1',
    permissions: [],
    riskLevel: 'low',
    tests: ['counts lines'],
    code: "export async function run(input) { return { count: String(input.content).split(/\\r?\\n/).filter(Boolean).length }; }",
    ...overrides,
  };
}

describe('PolicyValidator', () => {
  it('allows a declared process bridge for later permission and canary checks', () => {
    const result = new PolicyValidator().validate(candidate({
      riskLevel: 'high', permissions: ['process'],
      code: 'export async function run(input, host) { return host.process.run({ command: "cloudmusic.exe", args: [] }); }',
    }));
    expect(result.allowed).toBe(true);
  });
  it('still requires declared process permission for host.process.run', () => {
    const result = new PolicyValidator().validate(candidate({
      code: 'export async function run(input, host) { return host.process.run({ command: "cloudmusic.exe", args: [] }); }',
    }));
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('host.process.run requires declared permission process');
  });
  it('does not reject process-related words in comments or strings', () => {
    const result = new PolicyValidator().validate(candidate({
      code: 'export async function run() { /* process child_process worker_threads */ return "process"; }',
    }));
    expect(result).toEqual({ allowed: true, reasons: [] });
  });
  it('leaves access to the Node process global to the runtime sandbox', () => {
    const result = new PolicyValidator().validate(candidate({
      code: 'export async function run() { return typeof process; }',
    }));
    expect(result).toEqual({ allowed: true, reasons: [] });
  });
  it('accepts the pure low-risk read-only candidate', () => {
    expect(new PolicyValidator().validate(candidate())).toEqual({ allowed: true, reasons: [] });
  });

  it('rejects imports and direct network calls', () => {
    const result = new PolicyValidator().validate(candidate({
      permissions: ['network'],
      code: "import fs from 'node:fs'; process.env.SECRET; fetch('https://example.com');",
    }));

    expect(result.allowed).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/import/i);
    expect(result.reasons.join(' ')).toMatch(/network/i);
  });

  it('rejects code that does not export the required run function', () => {
    const result = new PolicyValidator().validate(candidate({ code: 'export const value = 1;' }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/run function/i);
  });

  it('does not treat text scanning as the runtime sandbox boundary', () => {
    const escapedTokens = "export async function run(input, host) { const make = (() => 0)['con' + 'structor']; const ambient = make('return this')(); return ambient['pro' + 'cess'].version; }";
    expect(new PolicyValidator().validate(candidate({ code: escapedTokens })).allowed).toBe(true);
  });
});
