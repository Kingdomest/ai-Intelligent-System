import { describe, expect, it } from 'vitest';
import type { TrajectoryEntry } from '../../src/storage/sqlite-store.js';
import { buildSessionLog } from '../../src/runtime/session-logs.js';

describe('session text logs', () => {
  it('renders a session-scoped text log with readable error context', () => {
    const entries: TrajectoryEntry[] = [
      { id: 'event:1', taskId: 'task-a', kind: 'event', type: 'task.status', createdAt: '2026-10-09T10:00:00.000Z', payload: { status: 'EXECUTING' } },
      { id: 'model:1', taskId: 'task-a', kind: 'model', type: 'planner', createdAt: '2026-10-09T10:00:01.000Z', model: {
        status: 'failed', modelName: 'deepseek', system: '', user: '', response: null, rawResponse: '{"error":"bad request"}',
        error: '模型请求失败：输入参数无效', requestId: 'req-a', inputTokens: 12, outputTokens: null, durationMs: 41,
        finishedAt: '2026-10-09T10:00:01.041Z', request: null, errorDetails: { statusCode: 400 },
      } },
    ];
    const result = buildSessionLog({ sessionId: 'session-a', entries, tasks: [{ id: 'task-a', message: '读取网页', status: 'FAILED', result: '任务未完成：工具输入无效', createdAt: '2026-10-09T10:00:00.000Z', updatedAt: '2026-10-09T10:00:01.041Z' }] });

    expect(result.text).toContain('[ERROR]');
    expect(result.text).toContain('session-a');
    expect(result.text).toContain('task-a');
    expect(result.text).toContain('模型请求失败：输入参数无效');
    expect(result.text).toContain('requestId=req-a');
    expect(result.text).toContain('statusCode');
    expect(result.text).toContain('任务未完成：工具输入无效');
    expect(result.summary.errors).toBeGreaterThan(0);
  });

  it('does not mix entries from another session into the requested log', () => {
    const result = buildSessionLog({ sessionId: 'session-a', entries: [
      { id: 'event:1', taskId: 'task-a', kind: 'event', type: 'task.completed', createdAt: '2026-10-09T10:00:00.000Z', payload: {} },
    ], tasks: [] });

    expect(result.text).toContain('session-a');
    expect(result.text).not.toContain('session-b');
  });
});
