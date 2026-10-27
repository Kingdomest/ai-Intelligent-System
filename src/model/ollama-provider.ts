import type { ModelCompletion, ModelProvider, ModelRequest, ModelRequestDetails } from './gateway.js';

interface OllamaConfig {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
}

interface OllamaResponse {
  model?: string;
  message?: { content?: string | null };
  prompt_eval_count?: number;
  eval_count?: number;
  done?: boolean;
  error?: string;
}

export class OllamaProvider implements ModelProvider {
  constructor(private readonly config: OllamaConfig) {}

  describeRequest(request: ModelRequest): ModelRequestDetails {
    const baseUrl = this.config.baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
    const url = new URL(`${baseUrl}/api/chat`);
    return { provider: 'ollama', endpoint: `${url.origin}${url.pathname}`, model: this.config.model,
      stream: request.role === 'implementer.file', temperature: 0,
      maxOutputTokens: request.maxOutputTokens ?? 4096, timeoutMs: this.config.timeoutMs ?? 120_000,
      responseFormat: request.outputSchema ? 'json-schema' : 'json' };
  }

  async complete(request: ModelRequest): Promise<ModelCompletion> {
    const controller = new AbortController();
    const timeoutMs = this.config.timeoutMs ?? 120_000;
    const stream = request.role === 'implementer.file';
    // A long file can take more than one request window to generate on a local
    // model. Streaming changes the short timer into an *idle* timer; a separate
    // hard deadline prevents an indefinitely active response.
    let idleTimeout: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimeout = () => {
      clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => controller.abort(), timeoutMs);
    };
    resetIdleTimeout();
    const hardLimitMs = stream ? Math.min(600_000, timeoutMs * 4) : timeoutMs;
    const hardTimeout = stream ? setTimeout(() => controller.abort(), hardLimitMs) : undefined;
    const baseUrl = this.config.baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');

    try {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          stream,
          think: false,
          format: request.outputSchema ?? 'json',
          options: { temperature: 0, num_predict: request.maxOutputTokens ?? 4096 },
          messages: [
            { role: 'system', content: `${request.system}\nReturn only valid JSON.` },
            { role: 'user', content: request.user },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new OllamaContentError(`Ollama request failed with status ${response.status}.`,
          await response.text(), response.status);
      }
      const payload = stream
        ? await readStreamedResponse(response, resetIdleTimeout)
        : await readJsonResponse(response);

      const content = payload.message?.content;
      if (!content) throw new Error('Ollama response did not contain message content.');

      let data: unknown;
      try { data = parseJsonContent(content); }
      catch { throw new OllamaContentError('Ollama message content was not valid JSON.', content); }

      return {
        data,
        rawContent: content,
        usage: {
          inputTokens: payload.prompt_eval_count ?? 0,
          outputTokens: payload.eval_count ?? 0,
        },
        requestId: payload.model ? `ollama:${payload.model}` : undefined,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Ollama request timed out during ${request.role} after ${timeoutMs}ms${stream ? ' without output or at the hard deadline' : ''}.`);
      }
      throw error instanceof Error ? error : new Error('Unknown Ollama provider error.');
    } finally {
      clearTimeout(idleTimeout);
      if (hardTimeout) clearTimeout(hardTimeout);
    }
  }
}

class OllamaContentError extends Error {
  constructor(message: string, public readonly rawContent: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'OllamaContentError';
  }
}

async function readJsonResponse(response: Response): Promise<OllamaResponse> {
  const rawBody = await response.text();
  let payload: OllamaResponse;
  try { payload = JSON.parse(rawBody) as OllamaResponse; }
  catch { throw new OllamaContentError('Ollama HTTP response was not valid JSON.', rawBody, response.status); }
  if (!payload || typeof payload !== 'object') {
    throw new OllamaContentError('Ollama HTTP response was not an object.', rawBody, response.status);
  }
  return payload;
}

async function readStreamedResponse(response: Response, onProgress: () => void): Promise<OllamaResponse> {
  if (!response.body) throw new Error('Ollama streaming response has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let content = '';
  let final: OllamaResponse | undefined;
  let complete = false;
  const consume = (line: string): void => {
    if (!line.trim()) return;
    const item = JSON.parse(line) as OllamaResponse;
    if (item.error) throw new OllamaContentError(`Ollama stream failed: ${item.error}`, content);
    if (item.message?.content) {
      content += item.message.content;
      if (content.length > 100_000) throw new Error('Ollama streamed output exceeded the safe size limit.');
      onProgress();
    }
    if (item.done) { final = item; complete = true; }
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (pending.length > 100_000) throw new Error('Ollama stream frame exceeded the safe size limit.');
    }
    pending += decoder.decode();
    consume(pending);
    if (!complete || !final) throw new OllamaContentError('Ollama stream ended without a completion frame.', content);
    return { ...final, message: { content } };
  } finally {
    reader.releaseLock();
  }
}

function parseJsonContent(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}
