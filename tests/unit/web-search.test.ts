import { describe, expect, it, vi } from 'vitest';
import { BraveWebSearch, validatePublicSearchQuery } from '../../src/research/web-search.js';

describe('BraveWebSearch', () => {
  it('sends a bounded public query and returns only HTTPS sources', async () => {
    const fetcher = vi.fn(async (_url: URL, _init: RequestInit) => new Response(JSON.stringify({ web: { results: [
      { title: '<b>Official docs</b>', url: 'https://docs.example.com/api', description: 'Current <em>API</em> reference',
        extra_snippets: ['Additional example'], age: '2 days ago' },
      { title: 'Unsafe', url: 'http://internal.example.com', description: 'Ignored' },
    ] } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const search = new BraveWebSearch('test-key', fetcher as unknown as typeof fetch);
    const results = await search.search(' TypeScript  current API ');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url.origin + url.pathname).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(url.searchParams.get('q')).toBe('TypeScript current API');
    expect(url.searchParams.get('extra_snippets')).toBe('true');
    expect(init.headers).toMatchObject({ 'X-Subscription-Token': 'test-key' });
    expect(results).toEqual([{ title: 'Official docs', url: 'https://docs.example.com/api',
      description: 'Current API reference Additional example', age: '2 days ago' }]);
  });

  it('rejects likely private data before making a request', async () => {
    const fetcher = vi.fn();
    const search = new BraveWebSearch('test-key', fetcher as unknown as typeof fetch);
    await expect(search.search('C:\\Users\\Alice\\private-project')).rejects.toThrow(/public knowledge topic/);
    await expect(search.search('alice@example.com project')).rejects.toThrow(/public knowledge topic/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(validatePublicSearchQuery('node  fetch docs')).toBe('node fetch docs');
  });

  it('rejects an oversized response even without a content-length header', async () => {
    const fetcher = vi.fn(async () => new Response('x'.repeat(200_001), { status: 200 }));
    await expect(new BraveWebSearch('test-key', fetcher as unknown as typeof fetch).search('public docs'))
      .rejects.toThrow(/size limit/);
  });
});
