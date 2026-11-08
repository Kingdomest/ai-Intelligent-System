import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDependencies } from '../../src/runtime/dependencies.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('runtime dependencies', () => {
  it('installs reusable foundational capabilities when the runtime starts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-builtins-'));
    temporaryDirectories.push(directory);
    const runtime = createDependencies({ dataDir: directory, modelMode: 'mock' });
    try {
      expect(runtime.registry.findUsableByKey('filesystem.mkdir')?.status).toBe('canary');
      expect(runtime.registry.findUsableByKey('process.launch')?.version).toBe('1.0.0');
    } finally {
      runtime.store.close();
    }
  });

  it('supports an explicit Ollama OpenAI-compatible model configuration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-ollama-'));
    temporaryDirectories.push(directory);
    const runtime = createDependencies({
      dataDir: directory,
      modelMode: 'ollama',
      modelBaseUrl: 'http://192.168.80.1:11434/v1',
      modelName: 'qwen3.6-27b-tools:latest',
      modelApiKey: 'ollama',
    });

    const config = runtime.config;
    runtime.store.close();
    expect(config.modelMode).toBe('ollama');
    expect(config.modelName).toBe('qwen3.6-27b-tools:latest');
    expect(config.modelRequestTimeoutMs).toBe(300_000);
    expect(config.modelReviewTimeoutMs).toBe(120_000);
    expect(config.modelRouteTimeoutMs).toBe(180_000);
    expect(isAbsolute((config as { desktopDirectory?: string }).desktopDirectory ?? '')).toBe(true);
  });

  it('sends a configured DeepSeek-compatible request with the API key', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-deepseek-'));
    temporaryDirectories.push(directory);
    const requests: Array<{ url: string; authorization: string | undefined; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') ?? undefined,
        body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 4, completion_tokens: 2 } }), { status: 200 });
    }));
    const runtime = createDependencies({ dataDir: directory, modelMode: 'openai',
      modelBaseUrl: 'https://api.deepseek.com///', modelName: 'deepseek-flash', modelApiKey: 'test-api-key' });
    try {
      const result = await runtime.modelProvider.complete({ role: 'planner', system: 'Return JSON', user: '{}' });
      expect(result.data).toEqual({ ok: true });
      expect(requests).toEqual([{ url: 'https://api.deepseek.com/chat/completions',
        authorization: 'Bearer test-api-key', body: expect.objectContaining({ model: 'deepseek-flash' }) }]);
    } finally {
      runtime.store.close();
    }
  });

  it('requires an API key before starting the remote model runtime', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-remote-key-'));
    temporaryDirectories.push(directory);
    expect(() => createDependencies({ dataDir: directory, modelMode: 'openai',
      modelBaseUrl: 'https://api.deepseek.com', modelName: 'deepseek-flash', modelApiKey: '  ' }))
      .toThrow('MODEL_API_KEY is required');
  });
});
