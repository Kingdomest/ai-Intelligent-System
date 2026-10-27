export type SessionStatus = 'active' | 'archived';

export interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  pinnedAt: string | null;
  summary: string | null;
  summarySeq: number;
  memoryTokens: number;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  preview: string | null;
  memoryBudget: number;
}

export type SessionMessageRole = 'user' | 'assistant' | 'compaction';

export interface SessionMessageRow {
  seq: number;
  taskId?: string;
  role: SessionMessageRole;
  content: string;
  status: 'pending' | 'final';
  createdAt: string;
  taskStatus?: string;
  sources?: Array<{ title: string; url: string }>;
}

export interface LegacyTaskSummary {
  id: string;
  message: string;
  status: string;
  updatedAt: string;
}

export interface CompactionOutcome {
  compacted: boolean;
  reason?: string;
  freedTokens?: number;
  session?: SessionSummary;
}

export interface TrajectoryEntry {
  id: string;
  taskId: string | null;
  createdAt: string;
  kind: 'event' | 'model' | 'operation';
  type: string;
  payload?: Record<string, unknown>;
  model?: {
    status: string;
    modelName: string;
    system: string;
    user: string;
    response: string | null;
    rawResponse: string | null;
    error: string | null;
    requestId: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number | null;
    finishedAt: string | null;
    request: Record<string, unknown> | null;
    errorDetails: Record<string, unknown> | null;
  };
  operation?: {
    operationId: string; requestId: string | null; state: string; permission: string; action: string;
    target: string; success: boolean | null; errorCode: string | null; updatedAt: string; durationMs: number;
  };
}

export interface TrajectorySummary {
  events: number; modelCalls: number; failedModels: number; operations: number; failedOperations: number;
  inputTokens: number; outputTokens: number; modelDurationMs: number;
}

export interface SessionLogLine {
  id: string;
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  source: string;
  taskId: string | null;
  message: string;
  details: Record<string, unknown>;
  text: string;
}

export interface SessionLogDocument {
  scopeId: string;
  scopeType: 'session' | 'task';
  generatedAt: string;
  text: string;
  lines: SessionLogLine[];
  summary: { total: number; info: number; warnings: number; errors: number };
}

export function fetchTrajectory(scope: { sessionId?: string; taskId?: string }, offset = 0, limit = 100): Promise<{
  entries: TrajectoryEntry[]; hasMore: boolean; summary: TrajectorySummary;
}> {
  const route = scope.sessionId ? `/api/sessions/${scope.sessionId}` : `/api/tasks/${scope.taskId}`;
  return request(`${route}/trajectory?offset=${offset}&limit=${limit}`);
}

export function fetchSessionLogs(scope: { sessionId?: string; taskId?: string }): Promise<SessionLogDocument> {
  const route = scope.sessionId ? `/api/sessions/${scope.sessionId}` : `/api/tasks/${scope.taskId}`;
  return request<SessionLogDocument>(`${route}/logs`);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error ?? `请求失败（HTTP ${response.status}）`);
  }
  return response.json() as Promise<T>;
}

export async function fetchSessions(): Promise<{ sessions: SessionSummary[] }> {
  const sessions: SessionSummary[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = cursor ? `?limit=200&cursor=${encodeURIComponent(cursor)}` : '?limit=200';
    const page: { sessions: SessionSummary[]; nextCursor: string | null } = await request(`/api/sessions${query}`);
    sessions.push(...page.sessions);
    if (!page.nextCursor || seen.has(page.nextCursor)) break;
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  return { sessions };
}

export function createSession(title?: string): Promise<{ session: SessionSummary }> {
  return request<{ session: SessionSummary }>('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(title ? { title } : {}),
  });
}

export function renameSession(sessionId: string, title: string): Promise<{ session: SessionSummary }> {
  return request<{ session: SessionSummary }>(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
}

export function setSessionPinned(sessionId: string, pinned: boolean): Promise<{ session: SessionSummary }> {
  return request<{ session: SessionSummary }>(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
}

export function deleteSession(sessionId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/sessions/${sessionId}`, { method: 'DELETE' });
}

export function fetchSession(sessionId: string): Promise<{ session: SessionSummary }> {
  return request<{ session: SessionSummary }>(`/api/sessions/${sessionId}`);
}

export function fetchSessionMessages(sessionId: string, before?: number): Promise<{
  messages: SessionMessageRow[];
  hasMore: boolean;
}> {
  const query = before !== undefined ? `?before=${before}` : '';
  return request<{ messages: SessionMessageRow[]; hasMore: boolean }>(`/api/sessions/${sessionId}/messages${query}`);
}

export function compactSession(sessionId: string): Promise<CompactionOutcome> {
  return request<CompactionOutcome>(`/api/sessions/${sessionId}/compact`, { method: 'POST' });
}

export function fetchLegacyTasks(): Promise<{ tasks: LegacyTaskSummary[] }> {
  return request<{ tasks: LegacyTaskSummary[] }>('/api/legacy-tasks');
}
