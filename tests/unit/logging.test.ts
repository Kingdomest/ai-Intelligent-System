import { describe, expect, it } from 'vitest';
import type { TrajectoryEntry, TrajectorySummary } from '../../web/src/session-api.js';
import { countLogFailures, logEntryMessage, logEntrySeverity } from '../../web/src/logging.js';

describe('agent log formatting', () => {
  it('marks failed model calls as errors and keeps the readable provider message', () => {
    const entry: TrajectoryEntry = {
      id: 'model:1', taskId: 'task-1', kind: 'model', type: 'planner', createdAt: '2026-10-09T10:00:00.000Z',
      model: {
        status: 'failed', modelName: 'deepseek', system: '', user: '', response: null, rawResponse: '{"error":"bad request"}',
        error: '模型请求失败：输入参数无效', requestId: 'req-1', inputTokens: 12, outputTokens: null,
        durationMs: 41, finishedAt: '2026-10-09T10:00:00.041Z', request: null, errorDetails: { statusCode: 400 },
      },
    };

    expect(logEntrySeverity(entry)).toBe('error');
    expect(logEntryMessage(entry)).toContain('模型请求失败：输入参数无效');
    expect(logEntryMessage(entry)).toContain('请求 ID req-1');
  });

  it('counts model and tool failures for the header badge', () => {
    const summary: TrajectorySummary = {
      events: 8, modelCalls: 5, failedModels: 2, operations: 4, failedOperations: 1,
      inputTokens: 0, outputTokens: 0, modelDurationMs: 0,
    };
    expect(countLogFailures(summary)).toBe(3);
  });

  it('keeps task failure rows understandable when event text was redacted', () => {
    const entry: TrajectoryEntry = {
      id: 'event:1', taskId: 'task-1', kind: 'event', type: 'task.failed', createdAt: '2026-10-09T10:00:00.000Z', payload: {},
    };
    expect(logEntryMessage(entry)).toContain('任务执行失败');
  });

  it('treats failed test reports as error logs', () => {
    const entry: TrajectoryEntry = {
      id: 'event:2', taskId: 'task-1', kind: 'event', type: 'test.report', createdAt: '2026-10-09T10:00:00.000Z',
      payload: { failed: 1, blocked: 0, reason: '测试未通过' },
    };
    expect(logEntrySeverity(entry)).toBe('error');
  });
});
