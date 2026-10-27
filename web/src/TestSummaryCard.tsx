import type { TestSummary } from './test-summary.js';

export function TestSummaryCard({ summary }: { summary: TestSummary }) {
  return (
    <article className="test-summary" aria-label="测试结论" role="status">
      <strong>测试结论</strong>
      <span>通过 {summary.passed} · 失败 {summary.failed} · 阻塞 {summary.blocked}</span>
      {summary.reason ? <small>主要原因：{summary.reason}</small> : null}
    </article>
  );
}
