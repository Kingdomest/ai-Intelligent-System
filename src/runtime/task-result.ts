import { z } from 'zod';

export const taskResultContentSchema = z.object({
  summary: z.string().trim().min(1).max(400),
  details: z.array(z.object({
    label: z.string().trim().min(1).max(100),
    value: z.string().trim().min(1).max(12_000),
  })).max(30),
  warnings: z.array(z.string().trim().min(1).max(2_000)).max(10),
  nextSteps: z.array(z.string().trim().min(1).max(2_000)).max(10),
});

export type TaskResultContent = z.infer<typeof taskResultContentSchema>;
export type ResultStatus = 'COMPLETED' | 'FAILED' | 'BLOCKED' | 'CANCELLED';

export const taskResultInstructions = [
  'Return a structured task report as JSON with summary, details, warnings, and nextSteps matching the supplied schema. The host renders the template and determines execution status.',
  'summary must directly answer the request in one or two short sentences; keep paths, timestamps, and supporting measurements in details rather than repeating all details in the summary.',
  'details contains readable label/value strings for key findings, exact paths, measurements, and deliverables. warnings contains material evidence limits; nextSteps contains only actions still needed. Use [] for sections with no useful content.',
  'Never display the raw process envelope, serialized JSON, exitCode/stdout/stderr field names, stack traces, or command logs as the answer. Interpret the decoded process data.',
  'For file sizes include the scan scope, exact full path, and human-readable size with exact bytes. Compute GiB from bytes / 1073741824; distinguish GiB from decimal GB and MiB from MB.',
  'For SkippedCount report only the observed count and coverage limitation. Do not infer what was skipped, attribute it to permissions, or recommend administrator privileges unless the results establish permission errors.',
].join(' ');

const statusLabels: Record<ResultStatus, string> = {
  COMPLETED: '任务已完成', FAILED: '任务未完成', BLOCKED: '任务已阻塞', CANCELLED: '任务已停止',
};

/** One text template for chat, API consumers, and persisted session messages. */
export function renderTaskResult(status: ResultStatus,
  content: Pick<TaskResultContent, 'summary'> & Partial<Omit<TaskResultContent, 'summary'>>): string {
  const sections = [`执行状态：${statusLabels[status]}`, `结果摘要：\n${content.summary}`];
  if (content.details?.length) sections.push(`关键结果：\n${content.details.map(item => `- ${item.label}：${item.value}`).join('\n')}`);
  if (content.warnings?.length) sections.push(`说明：\n${content.warnings.map(item => `- ${item}`).join('\n')}`);
  if (content.nextSteps?.length) sections.push(`后续操作：\n${content.nextSteps.map(item => `- ${item}`).join('\n')}`);
  return sections.join('\n\n');
}

/** Decode process JSON without presenting the transport envelope as the answer. */
export function resultForResponse(output: unknown): unknown {
  if (!output || typeof output !== 'object' || !('stdout' in output) || !('exitCode' in output)) return output;
  const process = output as { exitCode: unknown; stdout: unknown; stderr?: unknown };
  let data = process.stdout;
  if (typeof data === 'string' && data.trim()) {
    try { data = JSON.parse(data); } catch { /* Plain command output is also valid evidence. */ }
  }
  return { execution: { exitCode: process.exitCode,
    ...(process.stderr ? { error: process.stderr } : {}) }, data };
}

/** Deterministic presentation when no answer model is configured. */
export function toolResultContent(output: unknown): TaskResultContent {
  const normalized = resultForResponse(output);
  const data = normalized && typeof normalized === 'object' && 'execution' in normalized && 'data' in normalized
    ? normalized.data : normalized;
  const details: TaskResultContent['details'] = [];
  const labels: Record<string, string> = {
    path: '路径', FullName: '完整路径', Root: '扫描范围', Exists: '目标存在', Status: '扫描状态',
    Length: '文件大小（字节）', SizeMB: '文件大小（MB）', LastWriteTime: '最后修改时间',
    SkippedCount: '跳过项目数', count: '统计结果', created: '已创建', removed: '已删除',
    bytesWritten: '写入字节数', content: '内容', replacements: '替换次数',
  };
  const add = (value: unknown, prefix = '', depth = 0): void => {
    if (details.length >= 20 || depth > 3 || value === undefined || value === null) return;
    if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value).slice(0, 20)) {
        add(item, prefix ? `${prefix} / ${labels[key] ?? key}` : labels[key] ?? key, depth + 1);
      }
    } else {
      const text = typeof value === 'boolean' ? value ? '是' : '否' : String(value);
      if (text.trim()) details.push({ label: prefix || '结果', value: text.slice(0, 2_000) });
    }
  };
  add(data);
  let summary = '已完成操作，具体结果如下。';
  if (data && typeof data === 'object' && 'count' in data) summary = `统计结果为 ${data.count}。`;
  else if (data && typeof data === 'object' && 'path' in data) {
    if ('created' in data && data.created) summary = `已创建目录 ${data.path}`;
    else if ('removed' in data && data.removed) summary = `已删除 ${data.path}`;
    else if ('bytesWritten' in data) summary = `已写入 ${data.bytesWritten} 字节到 ${data.path}`;
  }
  return { summary, details, warnings: [], nextSteps: [] };
}
