import type { TaskEvent } from '../domain/contracts.js';
import { sanitizeAnswerSources } from './answer-sources.js';

const label = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100) : undefined;
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1000, Math.trunc(value))) : 0;
const duration = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(86_400_000, Math.trunc(value))) : 0;
const promptText = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';

/** An allowlist also makes historical events safe to return without rewriting SQLite. */
export function publicTaskEvent(event: TaskEvent): TaskEvent {
  const source = event.payload ?? {};
  const payload: Record<string, unknown> = {};
  switch (event.type) {
    case 'agent.activity':
      payload.runId = label(source.runId);
      payload.role = label(source.role);
      payload.status = source.status === 'running' || source.status === 'retrying'
        || source.status === 'completed' || source.status === 'failed' || source.status === 'cancelled'
        ? source.status : undefined;
      if (typeof source.durationMs === 'number') payload.durationMs = duration(source.durationMs);
      break;
    case 'task.status':
      payload.status = label(source.status);
      break;
    case 'test.report':
      payload.mode = label(source.mode);
      payload.passed = count(source.passed);
      payload.failed = count(source.failed);
      payload.blocked = count(source.blocked);
      payload.reason = payload.blocked ? '测试证据不足' : payload.failed ? '测试未通过' : null;
      break;
    case 'correction.round_started':
    case 'correction.round_finished':
      payload.ordinal = count(source.ordinal);
      payload.target = label(source.target);
      payload.failureCode = label(source.failureCode);
      payload.category = label(source.category);
      break;
    case 'capability.reused':
    case 'capability.published':
    case 'capability.temporary_registered':
    case 'capability.activated':
    case 'capability.quarantined':
      payload.name = label(source.name);
      payload.version = label(source.version);
      if (event.type === 'capability.quarantined') payload.reason = '已确认工具契约缺陷';
      break;
    case 'step.verified':
      payload.stepId = label(source.stepId);
      payload.source = label(source.source);
      payload.evaluator = label(source.evaluator);
      payload.failureCode = label(source.failureCode);
      break;
    case 'plan.reviewed':
      payload.stepId = label(source.stepId);
      payload.outcome = source.outcome === 'success' || source.outcome === 'failure' ? source.outcome : undefined;
      payload.action = source.action === 'continue' || source.action === 'replan' || source.action === 'block'
        ? source.action : undefined;
      break;
    case 'plan.revised':
      payload.stepId = label(source.stepId);
      payload.remaining = count(source.remaining);
      break;
    case 'step.started':
    case 'step.paused':
    case 'step.failed':
    case 'step.completed':
      payload.stepId = label(source.stepId);
      payload.capability = label(source.capability);
      payload.version = label(source.version);
      if (event.type !== 'step.started' && typeof source.durationMs === 'number') payload.durationMs = duration(source.durationMs);
      if (event.type === 'step.failed') payload.failureCode = label(source.failureCode);
      break;
    case 'file.implemented':
      payload.stepId = label(source.stepId);
      break;
    case 'context.compacted':
      payload.estimatedInputTokens = count(source.estimatedInputTokens);
      break;
    case 'draft.progress':
      payload.completed = count(source.completed);
      payload.total = count(source.total);
      break;
    case 'research.searched':
      payload.sourceCount = count(source.sourceCount);
      payload.sources = sanitizeAnswerSources(source.sources);
      break;
    case 'answer.sources':
      payload.sources = sanitizeAnswerSources(source.sources);
      break;
    case 'task.needs_user_input': {
      const request = source.request && typeof source.request === 'object'
        ? source.request as Record<string, unknown> : {};
      const requiredFields = Array.isArray(request.requiredFields)
        ? request.requiredFields.slice(0, 10).map(field => {
          const item = field && typeof field === 'object' ? field as Record<string, unknown> : {};
          return { name: label(item.name), reason: '执行所需', sensitive: item.sensitive === true };
        }) : [];
      const names = requiredFields.map(field => field.name).filter(Boolean).join('、');
      const sensitive = requiredFields.some(field => field.sensitive);
      const modelOptions = !sensitive && Array.isArray(request.options)
        ? request.options.slice(0, 3).flatMap(option => {
          const item = option && typeof option === 'object' ? option as Record<string, unknown> : {};
          const label = promptText(item.label, 80);
          const value = promptText(item.value, 200);
          return label && value ? [{ label, value, description: promptText(item.description, 160) }] : [];
        }) : [];
      const candidates = Array.isArray(request.candidates)
        ? request.candidates.filter((candidate): candidate is string => typeof candidate === 'string'
          && /^[A-Za-z]:\\[^\r\n]{1,240}\.exe$/i.test(candidate)).slice(0, 3) : [];
      payload.request = {
        question: promptText(request.question, 240) || (names ? `请补充执行任务所需的信息：${names}` : '请补充执行任务所需的信息。'),
        options: modelOptions.length === 3 ? modelOptions : candidates.map(candidate => ({ label: candidate, value: candidate })),
        requiredFields,
      };
      break;
    }
    case 'task.permission_requested':
    case 'task.permission_approved':
    case 'task.permission_denied':
    case 'task.operation_completed':
    case 'task.permission_resolved':
      payload.permission = label(source.permission);
      payload.action = label(source.action);
      payload.risk = label(source.risk);
      payload.success = source.success === true;
      payload.approved = source.approved === true;
      break;
    case 'task.completed':
    case 'task.cancelled':
    case 'task.blocked':
    case 'task.failed':
    case 'task.input_received':
      // The task result carries the user-facing explanation; events remain metadata-only.
      break;
    default:
      break;
  }
  return { type: event.type, payload, createdAt: event.createdAt };
}
