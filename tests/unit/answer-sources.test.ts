import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { answerSourcesFromEvents, sanitizeAnswerSources } from '../../src/runtime/answer-sources.js';
import { publicTaskEvent } from '../../src/runtime/event-projection.js';
import { AnswerSources, sourcesFromTaskEvents } from '../../web/src/AnswerSources.js';

describe('answer sources', () => {
  it('keeps distinct public links and removes credential parameters', () => {
    const sources = sanitizeAnswerSources([
      { title: '<b>官方文档</b>', url: 'https://docs.example.com/guide?token=private&section=api#top' },
      { title: 'duplicate', url: 'https://docs.example.com/guide?section=api' },
      { title: 'unsafe', url: 'javascript:alert(1)' },
      { title: 'local', url: 'https://localhost/admin' },
    ]);
    expect(sources).toEqual([{ title: '官方文档', url: 'https://docs.example.com/guide?section=api' }]);
  });

  it('projects and aggregates sources from search and verified network responses', () => {
    const events = [
      { type: 'research.searched', payload: { sourceCount: 1, sources: [
        { title: 'Reference', url: 'https://docs.example.com/page?key=hidden' },
      ] } },
      { type: 'answer.sources', payload: { sources: [
        { title: 'Duplicate', url: 'https://docs.example.com/page' },
        { title: 'API', url: 'https://api.example.com/data' },
      ] } },
    ];
    expect(answerSourcesFromEvents(events)).toHaveLength(2);
    const projected = events.map(publicTaskEvent);
    expect(projected[0]?.payload.sources).toEqual([{ title: 'Reference', url: 'https://docs.example.com/page' }]);
    expect(JSON.stringify(projected)).not.toContain('hidden');
    expect(sourcesFromTaskEvents(projected)).toHaveLength(2);
  });

  it('renders the source control above the answer with safe clickable article links', () => {
    const markup = renderToStaticMarkup(createElement(AnswerSources, { sources: [
      { title: '官方文档', url: 'https://docs.example.com/guide' },
      { title: '不安全链接', url: 'javascript:alert(1)' },
    ] }));
    expect(markup).toContain('搜索到 1 个网页');
    expect(markup).toContain('href="https://docs.example.com/guide"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).not.toContain('javascript:');
  });
});
