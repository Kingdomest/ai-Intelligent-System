import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CorrectionStatus } from '../../web/src/CorrectionStatus.js';

describe('correction progress', () => {
  it('shows one active whole-task correction while completed count remains zero', () => {
    const markup = renderToStaticMarkup(createElement(CorrectionStatus, { correction: {
      roundsUsed: 0, maxRounds: 5, currentOrdinal: 1, target: 'answer', phase: 'test',
      lastFailure: { code: 'ANSWER_MISMATCH', reason: 'Missing section three' },
    } }));
    expect(markup).toContain('第 1/5 轮纠正');
    expect(markup).toContain('正在验证');
    expect(markup).toContain('Missing section three');
  });

  it('does not show a retry banner for a task with no corrections', () => {
    const markup = renderToStaticMarkup(createElement(CorrectionStatus, { correction: {
      roundsUsed: 0, maxRounds: 5,
    } }));
    expect(markup).toBe('');
  });
});
