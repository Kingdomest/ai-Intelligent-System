import { describe, expect, it } from 'vitest';
import { AgentRunner } from '../../src/agents/agent-runner.js';
import { ToolFactory } from '../../src/capabilities/tool-factory.js';
import { ModelGateway } from '../../src/model/gateway.js';
import { MockModelProvider } from '../../src/model/mock-provider.js';

describe('ToolFactory stable keys', () => {
  const input = {
    taskId: 'task-1', intent: 'Count text lines', name: 'count_lines', capabilityKey: 'dynamic.text.count_lines',
    taskContext: { message: 'Count alpha.txt lines', attachments: [], workspaceRoot: 'D:/demo',
      desktopDirectory: 'D:/demo/Desktop', executionInput: { path: 'D:/demo/alpha.txt' } },
  };

  it('rejects a candidate whose capability key embeds this task target', async () => {
    const base = new AgentRunner(new ModelGateway(new MockModelProvider()));
    const factory = new ToolFactory({ runImplementer: async (request) => {
      const result = await base.runImplementer(request);
      return { ...result, candidate: { ...result.candidate, capabilityKey: 'dynamic.text.alpha.txt' } };
    } });
    await expect(factory.build(input)).rejects.toThrow(/capabilityKey|target/i);
  });

  it('accepts a candidate with the requested target-independent key', async () => {
    const base = new AgentRunner(new ModelGateway(new MockModelProvider()));
    const factory = new ToolFactory({ runImplementer: async (request) => {
      const result = await base.runImplementer(request);
      return { ...result, candidate: { ...result.candidate, capabilityKey: 'dynamic.text.count_lines' } };
    } });
    expect((await factory.build(input)).capabilityKey).toBe('dynamic.text.count_lines');
  });
});
