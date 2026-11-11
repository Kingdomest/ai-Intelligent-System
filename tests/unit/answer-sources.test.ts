import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { answerSourcesFromEvents, sanitizeAnswerSources } from '../../src/runtime/answer-sources.js';
import { publicTaskEvent } from '../../src/runtime/event-projection.js';
import { AnswerSources, sourcesFromTaskEvents } from '../../web/src/AnswerSources.js';

describe('answer sources', () => {
  it('opens the original article for historical reader links and deduplicates direct citations', () => {
    const article = 'https://blog.csdn.net/jackwmj12/article/details/129163012';
    const events = [{ type: 'answer.sources', payload: { sources: [
      { title: 'r.jina.ai', url: `https://r.jina.ai/${article}` },
      { title: 'Duplicate direct source', url: article },
    ] } }];
    const expected = [{ title: 'blog.csdn.net', url: article }];
    expect(answerSourcesFromEvents(events)).toEqual(expected);
    expect(publicTaskEvent(events[0]!).payload.sources).toEqual(expected);
    expect(sourcesFromTaskEvents(events)).toEqual(expected);
    const markup = renderToStaticMarkup(createElement(AnswerSources, { sources: events[0]!.payload.sources }));
    expect(markup).toContain(`href="${article}"`);
    expect(markup).toContain('blog.csdn.net');
    expect(markup).not.toContain('r.jina.ai');
  });

  it('normalizes encoded reader targets while preserving article titles and safe query parameters', () => {
    const target = 'https://docs.example.com/article?section=mqtt&token=private#qos';
    for (const url of [`https://r.jina.ai/${target}`, `https://r.jina.ai/${encodeURIComponent(target)}`]) {
      expect(sanitizeAnswerSources([{ title: 'MQTT explained', url }])).toEqual([
        { title: 'MQTT explained', url: 'https://docs.example.com/article?section=mqtt' },
      ]);
    }
    expect(sanitizeAnswerSources([{ title: '', url: 'https://r.jina.ai/https://r.jina.ai/https://docs.example.com/article' }]))
      .toEqual([{ title: 'docs.example.com', url: 'https://docs.example.com/article' }]);
  });

  it('validates the embedded target and never trusts a reader wrapper to make an unsafe source safe', () => {
    const targets = ['https://localhost/admin', 'https://127.0.0.1/admin', 'https://user:password@docs.example.com/article',
      'https://docs.example.com:8443/article', 'javascript:alert(1)', 'https://internal.local/admin'];
    expect(sanitizeAnswerSources(targets.map(url => ({ title: 'Reader', url: `https://r.jina.ai/${url}` })))).toEqual([]);
    const lookalike = 'https://r.jina.ai.example.com/https://docs.example.com/article';
    expect(sanitizeAnswerSources([{ title: 'Unrelated host', url: lookalike }])[0]?.url).toBe(lookalike);
  });

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
