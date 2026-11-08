import { randomUUID } from 'node:crypto';
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
  signal?: AbortSignal;
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

export class TaskCancelledError extends Error {
  constructor() {
    super('Task cancelled by user.');
    this.name = 'TaskCancelledError';
  }
}

export interface ModelTraceRecorder {
  start(request: ModelRequest, details?: ModelRequestDetails): string;
  finish(id: string, outcome: { completion?: ModelCompletion; error?: string; cancelled?: boolean; rawResponse?: string;
    errorDetails?: { name: string; statusCode?: number; requestId?: string } }): void;
}

export interface ModelActivityEvent {
  taskId: string;
  runId: string;
  role: string;
  status: 'running' | 'retrying' | 'completed' | 'failed' | 'cancelled';
  durationMs?: number;
}

export class ModelGateway {
  private readonly activeRequests = new Map<string, Set<AbortController>>();
  private readonly cancelledTasks = new Set<string>();
  constructor(private readonly provider: ModelProvider, private readonly trace?: ModelTraceRecorder,
    private readonly onActivity?: (event: ModelActivityEvent) => void) {}

  cancelTask(taskId: string): void {
    this.cancelledTasks.add(taskId);
    for (const controller of this.activeRequests.get(taskId) ?? []) controller.abort();
  }

  clearTaskCancellation(taskId: string): void {
    this.cancelledTasks.delete(taskId);
  }

  async complete<T>(request: ModelRequest, schema: ZodType<T>): Promise<ModelCompletion & { data: T }> {
    if (request.taskId && this.cancelledTasks.has(request.taskId)) throw new TaskCancelledError();
    // Callers may provide a provider-specific format schema when the validation
    // schema contains deliberately open-ended data (for example, generated
    // capability arguments). Keep Zod as the source of truth for validation,
    // while allowing providers to receive a bounded grammar that they can
    // generate reliably.
    const providerRequest = { ...request, outputSchema: request.outputSchema ?? z.toJSONSchema(schema) };
    const controller = new AbortController();
    if (request.taskId) {
      const active = this.activeRequests.get(request.taskId) ?? new Set<AbortController>();
      active.add(controller);
      this.activeRequests.set(request.taskId, active);
    }
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
    providerRequest.signal = signal;
    let details: ModelRequestDetails | undefined;
    try { details = this.provider.describeRequest?.(providerRequest); }
    catch { /* Descriptive metadata must not stop inference. */ }
    const runId = randomUUID();
    const startedAt = Date.now();
    const reportActivity = (status: ModelActivityEvent['status']) => {
      if (!request.taskId) return;
      try { this.onActivity?.({ taskId: request.taskId, runId, role: request.role, status,
        ...(status === 'completed' || status === 'failed' || status === 'cancelled' ? { durationMs: Date.now() - startedAt } : {}) }); }
      catch { /* Activity reporting must not change the model outcome. */ }
    };
    reportActivity('running');
    let traceId: string | undefined;
    if ((request.taskId || request.sessionId) && this.trace) {
      try { traceId = this.trace.start(providerRequest, details); }
      catch { /* Tracing must not stop a model call. */ }
    }
    let completion: ModelCompletion | undefined;
    try {
      if (signal.aborted) throw new TaskCancelledError();
      try {
        completion = await this.provider.complete(providerRequest);
      } catch (error) {
        if (signal.aborted) throw new TaskCancelledError();
        // Local inference is side-effect-free. Give a timed-out planner one
        // bounded second attempt before failing the whole task.
        const retryable = details?.provider === 'ollama' && request.role === 'planner'
          && error instanceof Error && /Ollama request timed out/i.test(error.message);
        if (!retryable) throw error;
        if (traceId) {
          try { this.trace?.finish(traceId, { error: error.message,
            errorDetails: { name: error.name } }); } catch { /* Keep recovery available. */ }
        }
        traceId = undefined;
        reportActivity('retrying');
        if (this.trace && (request.taskId || request.sessionId)) {
          try { traceId = this.trace.start(providerRequest, details); } catch { /* Keep recovery available. */ }
        }
        completion = await this.provider.complete(providerRequest);
      }
      if (signal.aborted) throw new TaskCancelledError();
      const data = schema.parse(completion.data);
      if (traceId) {
        try { this.trace?.finish(traceId, { completion }); } catch { /* Keep the model result usable. */ }
      }
      reportActivity('completed');
      return { ...completion, data };
    } catch (error) {
      const cancelled = error instanceof TaskCancelledError || signal.aborted;
      if (traceId) {
        const details = error && typeof error === 'object'
          ? error as { name?: unknown; statusCode?: unknown; requestId?: unknown; rawContent?: unknown } : {};
        try { this.trace?.finish(traceId, { completion, error: error instanceof Error ? error.message : String(error), cancelled,
          rawResponse: typeof details.rawContent === 'string' ? details.rawContent : undefined,
          errorDetails: { name: typeof details.name === 'string' ? details.name : 'Error',
            statusCode: typeof details.statusCode === 'number' ? details.statusCode : undefined,
            requestId: typeof details.requestId === 'string' ? details.requestId : undefined } }); }
        catch { /* Preserve the original model error. */ }
      }
      reportActivity(cancelled ? 'cancelled' : 'failed');
      throw error;
    } finally {
      if (request.taskId) {
        const active = this.activeRequests.get(request.taskId);
        active?.delete(controller);
        if (active?.size === 0) this.activeRequests.delete(request.taskId);
      }
    }
  }
}

export const modelUsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
});
