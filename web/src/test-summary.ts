export type TestSummary = { passed: number; failed: number; blocked: number; reason: string | null };
export type SummaryEvent = { type: string; payload: Record<string, unknown> };

export function summarizeTestEvents(events: SummaryEvent[]): TestSummary | null {
  const latest = new Map<string, TestSummary>();
  for (const event of events) {
    if (event.type !== 'test.report') continue;
    const mode = event.payload.mode;
    if (mode !== 'sandbox' && mode !== 'live_observation' && mode !== 'answer_review') continue;
    latest.set(mode, {
      passed: count(event.payload.passed), failed: count(event.payload.failed), blocked: count(event.payload.blocked),
      reason: typeof event.payload.reason === 'string' ? event.payload.reason.slice(0, 200) : null,
    });
  }
  if (latest.size === 0) return null;
  const reports = [...latest.values()];
  return {
    passed: reports.reduce((sum, report) => sum + report.passed, 0),
    failed: reports.reduce((sum, report) => sum + report.failed, 0),
    blocked: reports.reduce((sum, report) => sum + report.blocked, 0),
    reason: reports.find((report) => report.failed || report.blocked)?.reason ?? null,
  };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}
