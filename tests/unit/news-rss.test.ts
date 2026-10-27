import { describe, expect, it } from 'vitest';
import { isPublicNewsQuestion, newsQueryForTurn, newsSearchUrl, parseNewsRss } from '../../src/research/news-rss.js';

describe('public news search', () => {
  it('routes a recent public incident to a live search', () => {
    const question = '前段时间，华为的汽车踏板断裂事件影响很大，你跟我说下那个事情发生了什么';
    expect(isPublicNewsQuestion(question, false)).toBe(true);
    expect(new URL(newsSearchUrl(question)).searchParams.get('q')).toBe(question);
    expect(isPublicNewsQuestion('今天深圳天气怎么样', false)).toBe(false);
    expect(isPublicNewsQuestion('最近我的私有项目发生了什么', false)).toBe(false);
    expect(isPublicNewsQuestion(question, true)).toBe(false);
  });

  it('keeps the prior event topic when the user corrects its year', () => {
    const prior = '前段时间，华为的汽车踏板踩断事件影响很大，你跟我说下那个事情发生了什么';
    expect(newsQueryForTurn('不是的，是2026年的事件', [prior], false)).toBe(`${prior} 2026`);
    expect(newsQueryForTurn('不是的，指的是踏板支架', ['不是的，是2026年的事件', prior], false)).toBe(`${prior} 2026`);
    expect(newsQueryForTurn('请联网搜索一下上面那个事件', ['不是的，是2026年的事件', prior], false)).toBe(`${prior} 2026`);
    expect(newsQueryForTurn('不是的，是2026年的事件', ['我的私有项目出现故障'], false)).toBeNull();
  });

  it('extracts dated article links and rejects malformed links', () => {
    const xml = `<rss><channel>
      <item><title>尊界V800事件：煞车测试 &amp; 舆论 - BBC</title>
      <link>https://news.google.com/rss/articles/article-1</link>
      <pubDate>Tue, 13 Oct 2026 09:00:00 GMT</pubDate><source url="https://bbc.com">BBC</source></item>
      <item><title>Bad</title><link>javascript:alert(1)</link></item>
    </channel></rss>`;
    expect(parseNewsRss(xml)).toEqual([{ title: '尊界V800事件：煞车测试 & 舆论 - BBC',
      url: 'https://news.google.com/rss/articles/article-1', publisher: 'BBC',
      publishedAt: '2026-10-13T09:00:00.000Z' }]);
  });
});
