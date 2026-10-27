import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ModelGateway, type ModelProvider } from '../../src/model/gateway.js';
import { OpenAICompatibleProvider } from '../../src/model/openai-compatible-provider.js';

describe('ModelGateway', () => {
  it('validates provider output with the requested schema', async () => {
    const provider: ModelProvider = {
      complete: async () => ({ data: { ok: true }, usage: { inputTokens: 1, outputTokens: 1 } }),
    };
    const gateway = new ModelGateway(provider);

    const result = await gateway.complete(
      { role: 'test', system: 'return JSON', user: '{}' },
      z.object({ ok: z.boolean() }),
    );

    expect(result.data).toEqual({ ok: true });
    expect(result.usage.outputTokens).toBe(1);
  });

  it('rejects malformed provider output before it reaches an agent', async () => {
    const provider: ModelProvider = {
      complete: async () => ({ data: { ok: 'not-a-boolean' }, usage: { inputTokens: 1, outputTokens: 1 } }),
    };
    const gateway = new ModelGateway(provider);

    await expect(
      gateway.complete({ role: 'test', system: 'return JSON', user: '{}' }, z.object({ ok: z.boolean() })),
    ).rejects.toThrow();
  });

  it('records failed validation with the raw model response', async () => {
    const calls: Array<{ completion?: unknown; error?: string }> = [];
    const gateway = new ModelGateway({ complete: async () => ({
      data: { ok: 'invalid' }, usage: { inputTokens: 4, outputTokens: 2 },
    }) }, { start: () => 'trace-1', finish: (_id, outcome) => { calls.push(outcome); } });

    await expect(gateway.complete({ taskId: 'task-1', role: 'planner', system: '', user: '' },
      z.object({ ok: z.boolean() }))).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.completion).toMatchObject({ data: { ok: 'invalid' } });
    expect(calls[0]?.error).toBeTruthy();
  });

  it('retains malformed provider text and status metadata when JSON parsing fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'response-7',
      choices: [{ message: { content: '{"answer":' } }] }), { status: 200 })));
    const outcomes: Array<{ rawResponse?: string; errorDetails?: { statusCode?: number; requestId?: string } }> = [];
    try {
      const gateway = new ModelGateway(new OpenAICompatibleProvider({ baseUrl: 'https://example.com/v1',
        apiKey: 'test-key', model: 'test-model' }),
      { start: () => 'trace-1', finish: (_id, outcome) => { outcomes.push(outcome); } });
      await expect(gateway.complete({ taskId: 'task-1', role: 'planner', system: 'system', user: 'user' },
        z.object({ answer: z.string() }))).rejects.toThrow('not valid JSON');
      expect(outcomes[0]).toMatchObject({ rawResponse: '{"answer":',
        errorDetails: { statusCode: 200, requestId: 'response-7' } });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
