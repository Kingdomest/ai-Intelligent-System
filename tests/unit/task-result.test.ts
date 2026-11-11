import { describe, expect, it } from 'vitest';
import { AgentRunner } from '../../src/agents/agent-runner.js';
import { ModelGateway, type ModelRequest } from '../../src/model/gateway.js';
import { renderTaskResult, resultForResponse, taskResultContentSchema, toolResultContent } from '../../src/runtime/task-result.js';

const scan = { Root: 'E:\\', Exists: true, Status: 'OK', FullName: 'E:\\games\\largest.pak',
  Length: 9080476205, SizeMB: 8659.82, SkippedCount: 2 };

describe('task result presentation', () => {
  it('decodes process JSON once and preserves the original audit evidence', () => {
    const output = { exitCode: 0, stdout: JSON.stringify(scan) + '\r\n', stderr: '' };
    const original = structuredClone(output);
    expect(resultForResponse(output)).toEqual({ execution: { exitCode: 0 }, data: scan });
    expect(output).toEqual(original);
    expect(resultForResponse({ exitCode: 1, stdout: 'Not JSON', stderr: 'Access denied' }))
      .toEqual({ execution: { exitCode: 1, error: 'Access denied' }, data: 'Not JSON' });
  });

  it('uses the same sections for completion, failure, blocking, and cancellation', () => {
    for (const status of ['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'] as const) {
      const text = renderTaskResult(status, { summary: '结论', details: [{ label: '路径', value: scan.FullName }],
        warnings: ['有 2 项被跳过。'], nextSteps: ['检查访问权限。'] });
      expect(text).toMatch(/^执行状态：/);
      expect(text).toContain('结果摘要：\n结论');
      expect(text).toContain(`关键结果：\n- 路径：${scan.FullName}`);
      expect(text).toContain('说明：\n- 有 2 项被跳过。');
      expect(text).toContain('后续操作：\n- 检查访问权限。');
    }
    const minimal = renderTaskResult('COMPLETED', { summary: '已完成。' });
    expect(minimal).not.toContain('undefined');
    expect(minimal).not.toContain('说明：');
  });

  it('formats a process result as fields rather than double-escaped JSON even without a responder', () => {
    const text = renderTaskResult('COMPLETED', toolResultContent({ exitCode: 0, stdout: JSON.stringify(scan), stderr: '' }));
    expect(text).toContain(`完整路径：${scan.FullName}`);
    expect(text).toContain('文件大小（字节）：9080476205');
    expect(text).not.toMatch(/stdout|stderr|exitCode|\\"/);
  });

  it('requires structured model fields and passes decoded evidence to the responder', async () => {
    let request: ModelRequest | undefined;
    const report = { summary: 'E 盘最大可访问文件已找到。',
      details: [{ label: '完整路径', value: scan.FullName }, { label: '文件大小', value: '8.46 GiB（9,080,476,205 字节）' }],
      warnings: ['扫描跳过了 2 项，结果仅覆盖成功访问的范围。'], nextSteps: [] };
    const runner = new AgentRunner(new ModelGateway({ complete: async input => {
      request = input;
      return { data: report, usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    const text = await runner.runResponder({ taskId: 'scan', message: '找出 E 盘最大文件', acceptanceCriteria: [],
      results: [{ stepId: 'scan', observedAt: '2026-11-12T01:00:00Z',
        output: { exitCode: 0, stdout: JSON.stringify(scan), stderr: '' } }] });
    expect(JSON.parse(request!.user).results[0].output).toEqual({ execution: { exitCode: 0 }, data: scan });
    expect(request!.system).toContain('summary, details, warnings, and nextSteps');
    expect(text).toBe(renderTaskResult('COMPLETED', report));
    expect(text).not.toContain('stdout');
    expect(() => taskResultContentSchema.parse({ answer: '任务已完成：{"stdout":"..."}' })).toThrow();
  });
});
