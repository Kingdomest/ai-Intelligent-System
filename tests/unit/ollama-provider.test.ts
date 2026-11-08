import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from '../../src/model/ollama-provider.js';
import { OpenAICompatibleProvider } from '../../src/model/openai-compatible-provider.js';

afterEach(() => vi.unstubAllGlobals());

describe('OllamaProvider', () => {
  it('applies shorter role-specific request deadlines across both providers', () => {
    const local = new OllamaProvider({ baseUrl: 'http://localhost:11434', model: 'test',
      timeoutMs: 300_000, reviewTimeoutMs: 120_000, routeTimeoutMs: 180_000 });
    const external = new OpenAICompatibleProvider({ baseUrl: 'https://example.com/v1', apiKey: 'key', model: 'test',
      timeoutMs: 300_000, reviewTimeoutMs: 120_000, routeTimeoutMs: 180_000 });
    for (const provider of [local, external]) {
      expect(provider.describeRequest({ role: 'planner', system: '', user: '' }).timeoutMs).toBe(300_000);
      expect(provider.describeRequest({ role: 'planner.route', system: '', user: '' }).timeoutMs).toBe(180_000);
      expect(provider.describeRequest({ role: 'planner.review', system: '', user: '' }).timeoutMs).toBe(120_000);
    }
  });

  it('keeps malformed model content for trajectory diagnostics', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: { content: '{"ok":' } }),
      { status: 200 })));
    await expect(new OllamaProvider({ baseUrl: 'http://localhost:11434', model: 'test' }).complete({
      role: 'planner', system: 'Return JSON', user: '{}',
    })).rejects.toMatchObject({ rawContent: '{"ok":', name: 'OllamaContentError' });
  });

  it('streams file implementation output and assembles structured JSON with final usage', async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const frames = [
        { model: 'local-model', message: { content: '{"content":"<ht' }, done: false },
        { model: 'local-model', message: { content: 'ml>ok</html>"}' }, done: false },
        { model: 'local-model', done: true, prompt_eval_count: 18, eval_count: 9 },
      ];
      return new Response(frames.map(item => JSON.stringify(item)).join('\n') + '\n', { status: 200 });
    }));
    const result = await new OllamaProvider({ baseUrl: 'http://localhost:11434', model: 'local-model' }).complete({
      role: 'implementer.file', system: 'Return JSON', user: '{}', maxOutputTokens: 2048,
    });
    expect(requestBody?.stream).toBe(true);
    expect(result.data).toEqual({ content: '<html>ok</html>' });
    expect(result.usage).toEqual({ inputTokens: 18, outputTokens: 9 });
  });

  it('still times out a file stream that produces no content', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => new Response(
      new ReadableStream({ start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
      } }), { status: 200 })));
    await expect(new OllamaProvider({ baseUrl: 'http://localhost:11434', model: 'local-model', timeoutMs: 5 })
      .complete({ role: 'implementer.file', system: '', user: '{}' }))
      .rejects.toThrow(/implementer\.file.*5ms/);
  });
  it('uses native Ollama chat with thinking disabled and structured JSON output', async () => {
    let requestUrl = '';
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        model: 'qwen3.6-27b-tools:latest',
        message: { content: '{"ok":true}' },
        prompt_eval_count: 3,
        eval_count: 2,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const result = await new OllamaProvider({
      baseUrl: 'http://192.168.80.1:11434/v1',
      model: 'qwen3.6-27b-tools:latest',
    }).complete({
      role: 'planner',
      system: 'Return JSON',
      user: '{}',
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });

    expect(requestUrl).toBe('http://192.168.80.1:11434/api/chat');
    expect(requestBody?.think).toBe(false);
    expect(requestBody?.format).toEqual({ type: 'object', properties: { ok: { type: 'boolean' } } });
    expect(result.data).toEqual({ ok: true });
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });

  it('limits output tokens per bounded generation request', async () => {
    let outputLimit: number | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      outputLimit = (JSON.parse(String(init?.body)) as { options: { num_predict: number } }).options.num_predict;
      return new Response(JSON.stringify({ message: { content: '{"ok":true}' } }), { status: 200 });
    }));
    await new OllamaProvider({ baseUrl: 'http://localhost:11434', model: 'test' }).complete({
      role: 'presentation.draft_pages', system: 'Return JSON', user: '{}', maxOutputTokens: 2304,
    });
    expect(outputLimit).toBe(2304);
  });

  it('reports the model role and limit when a request times out', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    await expect(new OllamaProvider({ baseUrl: 'http://localhost:11434', model: 'test', timeoutMs: 5 })
      .complete({ role: 'presentation.draft_pages', system: '', user: '{}' }))
      .rejects.toThrow(/presentation\.draft_pages.*5ms/);
  });
});
