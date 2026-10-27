import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionLogView } from '../../web/src/SessionLogView.js';

describe('session log view', () => {
  it('renders a session selector and text log actions instead of a trajectory inspector', () => {
    const html = renderToStaticMarkup(createElement(SessionLogView, {
      sessionId: 'session-a', taskId: null,
      sessions: [{ id: 'session-a', title: '网页排查', status: 'active', pinnedAt: null, summary: null,
        summarySeq: 0, memoryTokens: 0, messageCount: 2, createdAt: '2026-10-09T10:00:00.000Z',
        updatedAt: '2026-10-09T10:00:00.000Z', preview: null, memoryBudget: 1000 }],
      onSelectSession: () => {},
    }));

    expect(html).toContain('会话文本日志');
    expect(html).toContain('选择会话');
    expect(html).toContain('下载日志');
    expect(html).not.toContain('轨迹详情');
  });
});
