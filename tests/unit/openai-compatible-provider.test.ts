import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ModelGateway } from '../../src/model/gateway.js';
import { OpenAICompatibleProvider } from '../../src/model/openai-compatible-provider.js';

afterEach(() => vi.unstubAllGlobals());

function provider() {
  return new OpenAICompatibleProvider({
    baseUrl: 'https://api.deepseek.com', apiKey: 'test-key', model: 'test-model',
  });
}

function mockCompletion(data: unknown) {
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({
    id: 'completion-1', choices: [{ message: { content: JSON.stringify(data) } }],
    usage: { prompt_tokens: 12, completion_tokens: 8 },
  }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('OpenAICompatibleProvider', () => {
  it('delivers the gateway JSON schema, including nested required fields, to the model', async () => {
    const schema = z.object({
      status: z.literal('ready'),
      requiredCapabilities: z.array(z.object({
        name: z.string(), purpose: z.string(), riskLevel: z.enum(['low', 'medium', 'high']),
      })),
      acceptanceCriteria: z.array(z.string()),
    });
    const data = { status: 'ready', requiredCapabilities: [
      { name: 'process.run', purpose: 'Inspect file sizes', riskLevel: 'medium' },
    ], acceptanceCriteria: ['Return the largest file path and size'] };
    const fetch = mockCompletion(data);
    const result = await new ModelGateway(provider()).complete({
      role: 'planner', system: 'Plan the requested work.', user: 'Find the largest file on E:',
    }, schema);

    const [url, init] = fetch.mock.calls[0]!;
    const body = JSON.parse(String(init?.body));
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(body.messages[0].content).toContain('Plan the requested work.');
    expect(body.messages[0].content).toContain(JSON.stringify(z.toJSONSchema(schema)));
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Find the largest file on E:' });
    expect(result.data).toEqual(data);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 8 });
    expect(result.requestId).toBe('completion-1');
  });

  it('uses an explicit model-facing schema while retaining gateway validation', async () => {
    const outputSchema = { type: 'object', properties: { status: { const: 'ready' } }, required: ['status'] };
    const fetch = mockCompletion({ status: 'wrong' });
    await expect(new ModelGateway(provider()).complete({
      role: 'planner', system: 'Return the requested object.', user: '{}', outputSchema,
    }, z.object({ status: z.literal('ready') }))).rejects.toThrow();

    const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
    expect(body.messages[0].content).toContain(JSON.stringify(outputSchema));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(provider().describeRequest({ role: 'planner', system: '', user: '', outputSchema }).responseFormat)
      .toBe('json-schema-instructions');
  });

  it('keeps schema-free requests compatible with the existing JSON instructions', async () => {
    const fetch = mockCompletion({ ok: true });
    const request = { role: 'test', system: 'Be concise.', user: '{}' };
    await expect(provider().complete(request)).resolves.toMatchObject({ data: { ok: true } });
    const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
    expect(body.messages[0].content).toBe('Be concise.\nReturn only valid JSON.');
    expect(provider().describeRequest(request).responseFormat).toBe('json-instructions');
  });
});
