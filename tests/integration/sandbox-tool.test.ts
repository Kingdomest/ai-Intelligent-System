import { describe, expect, it } from 'vitest';
import { SandboxRunner } from '../../src/capabilities/sandbox-runner.js';

describe('SandboxRunner', () => {
  it('executes a pure tool and returns JSON output', async () => {
    const runner = new SandboxRunner();
    const result = await runner.run(
      "export async function run(input) { return { count: String(input.content).split(/\\r?\\n/).filter(Boolean).length }; }",
      { content: 'a\nb\n' },
      { timeoutMs: 2_000, maxOutputBytes: 10_000 },
    );

    expect(result.output).toEqual({ count: 2 });
  });

  it('terminates a tool that exceeds its timeout', async () => {
    const runner = new SandboxRunner();

    await expect(
      runner.run('export async function run() { while (true) {} }', {}, { timeoutMs: 100, maxOutputBytes: 10_000 }),
    ).rejects.toThrow(/timed out/i);
  });
});
