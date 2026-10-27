import { describe, expect, it } from 'vitest';
import { getBuiltin } from '../../src/capabilities/builtin-catalog.js';
import { SandboxRunner } from '../../src/capabilities/sandbox-runner.js';
import type { HostCall } from '../../src/permissions/operation-protocol.js';

describe('built-in capability catalog', () => {
  it('uses the same mkdir code for two different paths', async () => {
    const builtin = getBuiltin('filesystem.mkdir');
    expect(builtin).not.toBeNull();
    const calls: HostCall[] = [];
    const sandbox = new SandboxRunner();
    for (const path of ['D:/demo/alpha', 'D:/demo/beta']) {
      await sandbox.run(builtin!.code, { path }, { mode: 'dry-run', hostCall: async (call) => {
        calls.push(call);
        return { callId: call.callId, ok: true, value: { path, created: true } };
      } });
    }
    expect(calls.map((call) => call.target)).toEqual(['D:/demo/alpha', 'D:/demo/beta']);
    expect(calls.every((call) => call.action === 'mkdir')).toBe(true);
  });

  it('has stable keys for all foundational actions', () => {
    for (const key of ['filesystem.read_text', 'filesystem.write_text', 'filesystem.mkdir', 'filesystem.remove',
      'process.run', 'process.launch', 'network.request', 'location.current']) {
      expect(getBuiltin(key)?.key).toBe(key);
      expect(getBuiltin(key)?.version).toBe('1.0.0');
    }
  });
});
