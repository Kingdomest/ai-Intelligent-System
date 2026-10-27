import type { TrajectoryEntry, TrajectorySummary } from './session-api.js';

export type LogSeverity = 'error' | 'warning' | 'info';

const failureEventTypes = new Set(['task.failed', 'task.blocked', 'task.cancelled', 'step.failed']);
const eventFallbackMessages: Record<string, string> = {
  'task.failed': '任务执行失败；请查看关联模型和工具日志',
  'task.blocked': '任务已阻塞；请检查未满足的前置条件',
  'task.cancelled': '任务已取消',
  'step.failed': '执行步骤失败；请检查该步骤的调用详情',
};

export function countLogFailures(summary: TrajectorySummary, entries: TrajectoryEntry[] = []): number {
  const eventFailures = entries.filter(entry => entry.kind === 'event' && logEntrySeverity(entry) === 'error').length;
  return Math.max(0, summary.failedModels) + Math.max(0, summary.failedOperations) + eventFailures;
}

export function logEntrySeverity(entry: TrajectoryEntry): LogSeverity {
  if (entry.kind === 'model') {
    return entry.model?.status === 'failed' || entry.model?.status === 'interrupted' ? 'error' : 'info';
  }
  if (entry.kind === 'operation') {
    if (entry.operation?.state === 'denied') return 'warning';
    return entry.operation?.state === 'unknown' || entry.operation?.success === false ? 'error' : 'info';
  }
  if (failureEventTypes.has(entry.type)) return 'error';
  if (entry.type === 'test.report') {
    if (entry.payload?.failed && Number(entry.payload.failed) > 0) return 'error';
    if (entry.payload?.blocked && Number(entry.payload.blocked) > 0) return 'warning';
  }
  if (typeof entry.payload?.failureCode === 'string') return 'error';
  if (entry.type === 'task.permission_denied' || entry.type === 'task.needs_user_input') return 'warning';
  return 'info';
}

export function logEntryMessage(entry: TrajectoryEntry): string {
  if (entry.kind === 'model') {
    const message = entry.model?.error || (entry.model?.status === 'interrupted' ? '模型调用在完成前中断' : '模型调用完成');
    const requestId = entry.model?.requestId ? ` · 请求 ID ${entry.model.requestId}` : '';
    return `${message}${requestId}`;
  }
  if (entry.kind === 'operation') {
    const operation = entry.operation;
    if (!operation) return '工具操作没有返回详情';
    const prefix = operation.success === false || operation.state === 'unknown' || operation.state === 'denied'
      ? `工具操作${operation.state === 'denied' ? '未授权' : '失败'}` : '工具操作完成';
    const code = operation.errorCode ? ` · 错误码 ${operation.errorCode}` : '';
    return `${prefix}：${operation.action} → ${operation.target}${code}`;
  }
  const payload = entry.payload ?? {};
  const details = [payload.reason, payload.failureCode, payload.status]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  return details.length ? details.join(' · ') : eventFallbackMessages[entry.type] ?? entry.type;
}
