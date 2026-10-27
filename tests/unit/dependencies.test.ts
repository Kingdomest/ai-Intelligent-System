import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDependencies } from '../../src/runtime/dependencies.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
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
    expect(config.modelRequestTimeoutMs).toBeGreaterThanOrEqual(120_000);
    expect(isAbsolute((config as { desktopDirectory?: string }).desktopDirectory ?? '')).toBe(true);
  });
});
