import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
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
      let retries = 0;
      for (;;) {
        try {
          completion = await this.provider.complete(providerRequest);
          break;
        } catch (error) {
          if (signal.aborted) throw new TaskCancelledError();
          const allowedRetries = modelRetryAllowance(error);
          if (retries >= allowedRetries) throw error;
          if (traceId) {
            try { this.trace?.finish(traceId, { error: error instanceof Error ? error.message : String(error),
              errorDetails: modelErrorDetails(error) }); } catch { /* Keep recovery available. */ }
          }
          traceId = undefined;
          retries++;
          reportActivity('retrying');
          // Retry only the model request, never the host operation or agent step.
          const backoffMs = 500 * 2 ** (retries - 1);
          try { await delay(Math.round(backoffMs * (0.9 + Math.random() * 0.2)), undefined, { signal }); }
          catch (waitError) { if (signal.aborted) throw new TaskCancelledError(); throw waitError; }
          if (this.trace && (request.taskId || request.sessionId)) {
            try { traceId = this.trace.start(providerRequest, details); } catch { /* Keep recovery available. */ }
          }
        }
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
        const errorData = error && typeof error === 'object'
          ? error as { rawContent?: unknown } : {};
        try { this.trace?.finish(traceId, { completion, error: error instanceof Error ? error.message : String(error), cancelled,
          rawResponse: typeof errorData.rawContent === 'string' ? errorData.rawContent : undefined,
          errorDetails: modelErrorDetails(error) }); }
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

function modelErrorDetails(error: unknown): { name: string; statusCode?: number; requestId?: string } {
  const value = error && typeof error === 'object'
    ? error as { name?: unknown; statusCode?: unknown; requestId?: unknown } : {};
  return { name: typeof value.name === 'string' ? value.name : 'Error',
    statusCode: typeof value.statusCode === 'number' ? value.statusCode : undefined,
    requestId: typeof value.requestId === 'string' ? value.requestId : undefined };
}

function modelRetryAllowance(error: unknown): number {
  if (!error || typeof error !== 'object') return 0;
  const value = error as { code?: unknown; statusCode?: unknown };
  if (value.code === 'TIMEOUT') return 1;
  if (value.code === 'TRANSPORT') return 2;
  if (value.statusCode === 408 || value.statusCode === 429
    || typeof value.statusCode === 'number' && value.statusCode >= 500 && value.statusCode <= 599) return 2;
  return 0;
}

export const modelUsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
});
