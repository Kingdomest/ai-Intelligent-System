import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TestSummaryCard } from '../../web/src/TestSummaryCard.js';

describe('test summary card', () => {
  it('renders counts and a blocked reason without raw evidence', () => {
    const html = renderToStaticMarkup(createElement(TestSummaryCard, {
      summary: { passed: 2, failed: 0, blocked: 1, reason: 'DESKTOP_OBSERVATION_UNAVAILABLE' },
    }));
    expect(html).toContain('通过 2');
    expect(html).toContain('阻塞 1');
    expect(html).toContain('DESKTOP_OBSERVATION_UNAVAILABLE');
    expect(html).toContain('aria-label="测试结论"');
  });
});
