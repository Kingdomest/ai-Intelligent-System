import type { ModelCompletion, ModelProvider, ModelRequest, ModelRequestDetails } from './gateway.js';
import { modelTimeoutMs } from './timeout-policy.js';

interface OpenAIConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  reviewTimeoutMs?: number;
  routeTimeoutMs?: number;
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
    public readonly code?: 'TIMEOUT' | 'TRANSPORT',
  ) {
    super(message);
    this.name = 'ModelProviderError';
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(private readonly config: OpenAIConfig) {}

  describeRequest(request: ModelRequest): ModelRequestDetails {
    const url = new URL(`${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`);
    return { provider: 'openai-compatible', endpoint: `${url.origin}${url.pathname}`, model: this.config.model,
      stream: false, temperature: 0, timeoutMs: this.timeoutFor(request),
      responseFormat: request.outputSchema === undefined ? 'json-instructions' : 'json-schema-instructions' };
  }

  private timeoutFor(request: ModelRequest): number {
    return modelTimeoutMs(request.role, this.config.timeoutMs ?? 120_000,
      this.config.reviewTimeoutMs, this.config.routeTimeoutMs);
  }

  async complete(request: ModelRequest): Promise<ModelCompletion> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutFor(request));
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    try {
      // Compatible endpoints do not all support native JSON Schema output.
      // Always deliver the contract in the prompt; the gateway still validates it.
      const system = request.outputSchema === undefined
        ? `${request.system}\nReturn only valid JSON.`
        : `${request.system}\nReturn only a JSON value matching the following JSON Schema. `
          + `Use the exact field names and types, including all required nested fields. `
          + `Return the value, not the schema, without Markdown or commentary.\nJSON Schema:\n${JSON.stringify(request.outputSchema)}`;
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
            { role: 'system', content: system },
            { role: 'user', content: request.user },
          ],
        }),
        signal: request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal,
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
      if (request.signal?.aborted) throw error;
      if (error instanceof ModelProviderError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ModelProviderError('Model request timed out.', undefined, undefined, undefined, 'TIMEOUT');
      }
      throw new ModelProviderError(error instanceof Error ? error.message : 'Unknown model provider error.',
        undefined, undefined, undefined, error instanceof TypeError ? 'TRANSPORT' : undefined);
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
