import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ModelGateway, type ModelActivityEvent, type ModelProvider } from '../../src/model/gateway.js';
import { ModelProviderError, OpenAICompatibleProvider } from '../../src/model/openai-compatible-provider.js';

describe('ModelGateway', () => {
  it('marks a user-stopped model call as cancelled without retrying it', async () => {
    const activities: ModelActivityEvent[] = [];
    const traces: Array<{ cancelled?: boolean }> = [];
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const complete = vi.fn(async (request: { signal?: AbortSignal }) => {
      started();
      return new Promise<never>((_resolve, reject) => request.signal?.addEventListener('abort',
        () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    });
    const gateway = new ModelGateway({ complete, describeRequest: () => ({ provider: 'ollama' }) },
      { start: () => 'trace-1', finish: (_id, outcome) => { traces.push(outcome); } },
      event => activities.push(event));
    const result = gateway.complete({ taskId: 'task-1', role: 'planner', system: '', user: '' },
      z.object({ ok: z.boolean() }));
    await ready;
    gateway.cancelTask('task-1');
    const stoppedResult = expect(result).rejects.toMatchObject({ name: 'TaskCancelledError' });
    await expect(gateway.complete({ taskId: 'task-1', role: 'planner', system: '', user: '' },
      z.object({ ok: z.boolean() }))).rejects.toMatchObject({ name: 'TaskCancelledError' });
    await stoppedResult;
    expect(complete).toHaveBeenCalledTimes(1);
    expect(traces).toHaveLength(1);
    expect(traces[0]?.cancelled).toBe(true);
    expect(activities.map(item => item.status)).toEqual(['running', 'cancelled']);
  });

  it('reports real role activity around a validated model call without exposing prompts', async () => {
    const activities: ModelActivityEvent[] = [];
    const gateway = new ModelGateway({ complete: async () => ({
      data: { ok: true }, usage: { inputTokens: 1, outputTokens: 1 },
    }) }, undefined, event => activities.push(event));
    await gateway.complete({ taskId: 'task-1', role: 'planner.route', system: 'private system',
      user: 'private user' }, z.object({ ok: z.boolean() }));
    expect(activities.map(item => item.status)).toEqual(['running', 'completed']);
    expect(activities[0]?.runId).toBe(activities[1]?.runId);
    expect(activities[1]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(activities)).not.toContain('private');
  });

  it('keeps inference usable when observability callbacks fail', async () => {
    const gateway = new ModelGateway({
      describeRequest: () => { throw new Error('metadata unavailable'); },
      complete: async () => ({ data: { ok: true }, usage: { inputTokens: 1, outputTokens: 1 } }),
    }, undefined, () => { throw new Error('activity store unavailable'); });
    await expect(gateway.complete({ taskId: 'task-1', role: 'planner', system: '', user: '' },
      z.object({ ok: z.boolean() }))).resolves.toMatchObject({ data: { ok: true } });
  });

  it('reports failure even when model output does not pass validation', async () => {
    const activities: ModelActivityEvent[] = [];
    const gateway = new ModelGateway({ complete: async () => ({
      data: { ok: 'bad' }, usage: { inputTokens: 1, outputTokens: 1 },
    }) }, undefined, event => activities.push(event));
    await expect(gateway.complete({ taskId: 'task-1', role: 'tester.answer', system: '', user: '' },
      z.object({ ok: z.boolean() }))).rejects.toThrow();
    expect(activities.map(item => item.status)).toEqual(['running', 'failed']);
  });

  it('retries a local planner timeout once and reports the retry', async () => {
    const activities: ModelActivityEvent[] = [];
    const traces: Array<{ id: string; error?: string }> = [];
    let traceSequence = 0;
    const complete = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Ollama request timed out during planner after 180000ms.'), { code: 'TIMEOUT' }))
      .mockResolvedValueOnce({ data: { ok: true }, usage: { inputTokens: 1, outputTokens: 1 } });
    const gateway = new ModelGateway({ complete, describeRequest: () => ({ provider: 'ollama' }) },
      { start: () => `trace-${++traceSequence}`, finish: (id, outcome) => { traces.push({ id, error: outcome.error }); } },
      event => activities.push(event));
    await gateway.complete({ taskId: 'task-1', role: 'planner', system: '', user: '' },
      z.object({ ok: z.boolean() }));
    expect(complete).toHaveBeenCalledTimes(2);
    expect(activities.map(item => item.status)).toEqual(['running', 'retrying', 'completed']);
    expect(traces).toEqual([{ id: 'trace-1', error: expect.stringContaining('timed out') },
      { id: 'trace-2', error: undefined }]);
  });

  it('does not retry a permanent provider failure and bounds a repeated timeout', async () => {
    const timeout = Object.assign(new Error('Ollama request timed out during planner after 180000ms.'), { code: 'TIMEOUT' });
    const external = vi.fn().mockRejectedValue(new ModelProviderError('Unauthorized', 401));
    await expect(new ModelGateway({ complete: external, describeRequest: () => ({ provider: 'openai-compatible' }) })
      .complete({ taskId: 'task-1', role: 'planner', system: '', user: '' }, z.object({ ok: z.boolean() })))
      .rejects.toThrow('Unauthorized');
    expect(external).toHaveBeenCalledTimes(1);
    const local = vi.fn().mockRejectedValue(timeout);
    await expect(new ModelGateway({ complete: local, describeRequest: () => ({ provider: 'ollama' }) })
      .complete({ taskId: 'task-1', role: 'planner', system: '', user: '' }, z.object({ ok: z.boolean() })))
      .rejects.toThrow('timed out');
    expect(local).toHaveBeenCalledTimes(2);
  });

  it('retries a timed-out step review once without repeating the host step', async () => {
    const complete = vi.fn().mockRejectedValue(Object.assign(
      new Error('Ollama request timed out during planner.review after 120000ms.'), { code: 'TIMEOUT' }));
    const gateway = new ModelGateway({ complete, describeRequest: () => ({ provider: 'ollama' }) });
    await expect(gateway.complete({ taskId: 'task-1', role: 'planner.review', system: '', user: '' },
      z.object({ ok: z.boolean() }))).rejects.toThrow('timed out');
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('retries rate limits twice and does not retry malformed model output', async () => {
    const rateLimited = vi.fn().mockRejectedValue(new ModelProviderError('Rate limited', 429));
    await expect(new ModelGateway({ complete: rateLimited }).complete(
      { role: 'planner', system: '', user: '' }, z.object({ ok: z.boolean() }))).rejects.toThrow('Rate limited');
    expect(rateLimited).toHaveBeenCalledTimes(3);

    const malformed = vi.fn().mockRejectedValue(new ModelProviderError('Invalid JSON', 200));
    await expect(new ModelGateway({ complete: malformed }).complete(
      { role: 'planner', system: '', user: '' }, z.object({ ok: z.boolean() }))).rejects.toThrow('Invalid JSON');
    expect(malformed).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-progress retry wait without another provider call', async () => {
    const complete = vi.fn().mockRejectedValue(new ModelProviderError('Timeout', undefined, undefined, undefined, 'TIMEOUT'));
    let gateway!: ModelGateway;
    gateway = new ModelGateway({ complete }, undefined, event => {
      if (event.status === 'retrying') gateway.cancelTask(event.taskId);
    });
    await expect(gateway.complete({ taskId: 'task-1', role: 'planner', system: '', user: '' },
      z.object({ ok: z.boolean() }))).rejects.toMatchObject({ name: 'TaskCancelledError' });
    expect(complete).toHaveBeenCalledTimes(1);
  });

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
