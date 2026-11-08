import type { TrajectoryEntry } from '../storage/sqlite-store.js';

export type SessionLogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface SessionLogTask {
  id: string;
  message: string;
  status: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionLogLine {
  id: string;
  timestamp: string;
  level: SessionLogLevel;
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

interface BuildSessionLogInput {
  sessionId?: string;
  taskId?: string;
  entries: TrajectoryEntry[];
  tasks: SessionLogTask[];
  generatedAt?: string;
}

const taskStatusLevels: Record<string, SessionLogLevel> = {
  FAILED: 'ERROR', BLOCKED: 'ERROR', CANCELLED: 'WARN',
};

function safeText(value: unknown, maxLength = 4_000): string {
  if (typeof value !== 'string') return String(value ?? '');
  return value.replace(/\r?\n/g, ' ↵ ')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[已隐藏密钥]')
    .replace(/([?&](?:api_?key|token|secret|password)=)[^&#\s]+/gi, '$1[已隐藏]')
    .replace(/\b(?:token|api[_-]?key|password|secret|authorization)\s*[:=]\s*[^\s;]+/gi, '$1[凭据已隐藏]')
    .slice(0, maxLength);
}

function safeJson(value: unknown, maxLength = 4_000): string {
  try { return safeText(JSON.stringify(value), maxLength); } catch { return '[无法序列化详情]'; }
}

function eventLevel(entry: TrajectoryEntry): SessionLogLevel {
  const payload = entry.payload ?? {};
  if (/failed|error/i.test(entry.type)) return 'ERROR';
  if (/blocked|cancelled|permission_denied/i.test(entry.type)) return 'WARN';
  if (entry.type === 'test.report') {
    if (Number(payload.failed) > 0) return 'ERROR';
    if (Number(payload.blocked) > 0) return 'WARN';
  }
  if (typeof payload.failureCode === 'string' && payload.failureCode) return 'ERROR';
  return 'INFO';
}

function eventMessage(entry: TrajectoryEntry): string {
  const payload = entry.payload ?? {};
  if (typeof payload.message === 'string' && payload.message) return safeText(payload.message);
  if (typeof payload.reason === 'string' && payload.reason) return safeText(payload.reason);
  if (typeof payload.failureCode === 'string' && payload.failureCode) return `失败码：${safeText(payload.failureCode, 240)}`;
  if (typeof payload.status === 'string' && payload.status) return `任务状态：${safeText(payload.status, 120)}`;
  const labels: Record<string, string> = {
    'task.completed': '任务完成', 'task.failed': '任务执行失败', 'task.blocked': '任务已阻塞',
    'task.cancelled': '任务已取消', 'step.failed': '执行步骤失败', 'step.completed': '执行步骤完成',
    'task.permission_denied': '工具操作未获授权', 'task.permission_requested': '请求工具授权',
  };
  return labels[entry.type] ?? entry.type;
}

function modelLine(entry: TrajectoryEntry): { level: SessionLogLevel; source: string; message: string; details: Record<string, unknown> } {
  const model = entry.model;
  const failed = model?.status === 'failed' || model?.status === 'interrupted';
  const cancelled = model?.status === 'cancelled';
  const message = cancelled ? '模型调用已由用户停止' : model?.error ? safeText(model.error)
    : failed ? '模型调用中断，结果未知' : '模型调用完成';
  const details: Record<string, unknown> = {
    model: model?.modelName || '未记录', status: model?.status ?? 'unknown', durationMs: model?.durationMs ?? null,
    inputTokens: model?.inputTokens ?? null, outputTokens: model?.outputTokens ?? null,
  };
  if (model?.requestId) details.requestId = model.requestId;
  if (model?.errorDetails) details.errorDetails = model.errorDetails;
  if (failed && model?.rawResponse) details.rawResponse = safeText(model.rawResponse);
  return { level: failed ? 'ERROR' : cancelled ? 'WARN' : 'INFO', source: `模型/${entry.type}`, message, details };
}

function operationLine(entry: TrajectoryEntry): { level: SessionLogLevel; source: string; message: string; details: Record<string, unknown> } {
  const operation = entry.operation;
  const failed = operation?.success === false || operation?.state === 'unknown';
  const denied = operation?.state === 'denied';
  const message = denied ? '工具操作未获授权' : failed ? '工具操作失败' : '工具操作完成';
  const details: Record<string, unknown> = {
    state: operation?.state ?? 'unknown', permission: operation?.permission ?? 'unknown',
    action: operation?.action ?? 'unknown', target: safeText(operation?.target ?? ''),
    success: operation?.success ?? null, durationMs: operation?.durationMs ?? null,
  };
  if (operation?.requestId) details.requestId = operation.requestId;
  if (operation?.errorCode) details.errorCode = operation.errorCode;
  return { level: failed ? 'ERROR' : denied ? 'WARN' : 'INFO', source: '工具操作', message, details };
}

function lineText(line: Omit<SessionLogLine, 'text'>, scopeType: 'session' | 'task', scopeId: string): string {
  const task = line.taskId ? ` task=${line.taskId}` : '';
  const details = Object.entries(line.details)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : safeJson(value, 2_000)}`)
    .join(' ');
  return `${line.timestamp} [${line.level}] [${line.source}] [${scopeType}=${scopeId}${task}] ${line.message}${details ? ` | ${details}` : ''}`;
}

export function buildSessionLog(input: BuildSessionLogInput): SessionLogDocument {
  const scopeType = input.sessionId ? 'session' : 'task';
  const scopeId = input.sessionId ?? input.taskId ?? 'unknown';
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const lines: Array<Omit<SessionLogLine, 'text'>> = [];
  for (const task of input.tasks) {
    lines.push({ id: `task:start:${task.id}`, timestamp: task.createdAt, level: 'INFO', source: '任务', taskId: task.id,
      message: `任务开始：${safeText(task.message, 1_000)}`, details: { status: task.status } });
    if (task.result) {
      lines.push({ id: `task:result:${task.id}`, timestamp: task.updatedAt, level: taskStatusLevels[task.status] ?? 'INFO', source: '任务结果', taskId: task.id,
        message: safeText(task.result, 4_000), details: { status: task.status } });
    }
  }

  for (const entry of input.entries) {
    let normalized: { level: SessionLogLevel; source: string; message: string; details: Record<string, unknown> };
    if (entry.kind === 'model') normalized = modelLine(entry);
    else if (entry.kind === 'operation') normalized = operationLine(entry);
    else normalized = { level: eventLevel(entry), source: `事件/${entry.type}`, message: eventMessage(entry), details: entry.payload ?? {} };
    lines.push({ id: entry.id, timestamp: entry.createdAt, taskId: entry.taskId, ...normalized,
      details: Object.fromEntries(Object.entries(normalized.details).map(([key, value]) => [key, typeof value === 'string' ? safeText(value) : value])) });
  }

  lines.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  const rendered = lines.map(line => ({ ...line, text: lineText(line, scopeType, scopeId) }));
  const summary = rendered.reduce((result, line) => {
    result.total += 1;
    if (line.level === 'ERROR') result.errors += 1;
    else if (line.level === 'WARN') result.warnings += 1;
    else result.info += 1;
    return result;
  }, { total: 0, info: 0, warnings: 0, errors: 0 });
  const header = [
    '# Jarvis session text log', `# scope=${scopeType}`, `# ${scopeType}Id=${scopeId}`,
    `# generatedAt=${generatedAt}`, `# entries=${rendered.length}`,
  ].join('\n');
  return { scopeId, scopeType, generatedAt, lines: rendered, summary, text: `${header}\n${rendered.map(line => line.text).join('\n')}` };
}
