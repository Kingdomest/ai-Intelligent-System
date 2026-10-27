import type { ModelCompletion, ModelProvider, ModelRequest, ModelRequestDetails } from './gateway.js';

interface OpenAIConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

interface OpenAIResponse {
  id?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class ModelProviderError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly requestId?: string,
    public readonly rawContent?: string,
  ) {
    super(message);
    this.name = 'ModelProviderError';
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(private readonly config: OpenAIConfig) {}

  describeRequest(_request: ModelRequest): ModelRequestDetails {
    const url = new URL(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`);
    return { provider: 'openai-compatible', endpoint: `${url.origin}${url.pathname}`, model: this.config.model,
      stream: false, temperature: 0, timeoutMs: this.config.timeoutMs ?? 120_000, responseFormat: 'json-instructions' };
  }

  async complete(request: ModelRequest): Promise<ModelCompletion> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 120_000);
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          messages: [
            { role: 'system', content: `${request.system}\nReturn only valid JSON.` },
            { role: 'user', content: request.user },
          ],
        }),
        signal: controller.signal,
      });

      const rawBody = await response.text();
      let payload: OpenAIResponse;
      try { payload = JSON.parse(rawBody) as OpenAIResponse; }
      catch { throw new ModelProviderError('Model HTTP response was not valid JSON.', response.status, undefined, rawBody); }
      if (!payload || typeof payload !== 'object') {
        throw new ModelProviderError('Model HTTP response was not an object.', response.status, undefined, rawBody);
      }
      if (!response.ok) {
        throw new ModelProviderError(`Model request failed with status ${response.status}.`, response.status, payload.id, rawBody);
      }

      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        throw new ModelProviderError('Model response did not contain message content.', response.status, payload.id, rawBody);
      }

      let data: unknown;
      try { data = parseJsonContent(content); }
      catch { throw new ModelProviderError('Model message content was not valid JSON.', response.status, payload.id, content); }

      return {
        data,
        rawContent: content,
        usage: {
          inputTokens: payload.usage?.prompt_tokens ?? 0,
          outputTokens: payload.usage?.completion_tokens ?? 0,
        },
        requestId: payload.id,
      };
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ModelProviderError('Model request timed out.');
      }
      throw new ModelProviderError(error instanceof Error ? error.message : 'Unknown model provider error.');
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseJsonContent(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}
