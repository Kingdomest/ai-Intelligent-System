import { z, type ZodType } from 'zod';

export interface ModelRequest {
  role: string;
  system: string;
  user: string;
  taskId?: string;
  sessionId?: string;
  context?: Record<string, unknown>;
  outputSchema?: unknown;
  maxOutputTokens?: number;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelCompletion {
  data: unknown;
  usage: ModelUsage;
  requestId?: string;
  rawContent?: string;
}

export interface ModelRequestDetails {
  provider: string;
  endpoint?: string;
  model?: string;
  stream?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  responseFormat?: string;
}

export interface ModelProvider {
  complete(request: ModelRequest): Promise<ModelCompletion>;
  describeRequest?(request: ModelRequest): ModelRequestDetails;
}

export interface ModelTraceRecorder {
  start(request: ModelRequest, details?: ModelRequestDetails): string;
  finish(id: string, outcome: { completion?: ModelCompletion; error?: string; rawResponse?: string;
    errorDetails?: { name: string; statusCode?: number; requestId?: string } }): void;
}

export class ModelGateway {
  constructor(private readonly provider: ModelProvider, private readonly trace?: ModelTraceRecorder) {}

  async complete<T>(request: ModelRequest, schema: ZodType<T>): Promise<ModelCompletion & { data: T }> {
    // Callers may provide a provider-specific format schema when the validation
    // schema contains deliberately open-ended data (for example, generated
    // capability arguments). Keep Zod as the source of truth for validation,
    // while allowing providers to receive a bounded grammar that they can
    // generate reliably.
    const providerRequest = { ...request, outputSchema: request.outputSchema ?? z.toJSONSchema(schema) };
    let traceId: string | undefined;
    if ((request.taskId || request.sessionId) && this.trace) {
      try { traceId = this.trace.start(providerRequest, this.provider.describeRequest?.(providerRequest)); }
      catch { /* Tracing must not stop a model call. */ }
    }
    let completion: ModelCompletion | undefined;
    try {
      completion = await this.provider.complete(providerRequest);
      const data = schema.parse(completion.data);
      if (traceId) {
        try { this.trace?.finish(traceId, { completion }); } catch { /* Keep the model result usable. */ }
      }
      return { ...completion, data };
    } catch (error) {
      if (traceId) {
        const details = error && typeof error === 'object'
          ? error as { name?: unknown; statusCode?: unknown; requestId?: unknown; rawContent?: unknown } : {};
        try { this.trace?.finish(traceId, { completion, error: error instanceof Error ? error.message : String(error),
          rawResponse: typeof details.rawContent === 'string' ? details.rawContent : undefined,
          errorDetails: { name: typeof details.name === 'string' ? details.name : 'Error',
            statusCode: typeof details.statusCode === 'number' ? details.statusCode : undefined,
            requestId: typeof details.requestId === 'string' ? details.requestId : undefined } }); }
        catch { /* Preserve the original model error. */ }
      }
      throw error;
    }
  }
}

export const modelUsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
});
