/** Public web research used to ground planning and file implementation. */
export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
  age?: string;
}

export interface WebSearchPort {
  search(query: string): Promise<WebSearchResult[]>;
}

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const MAX_RESPONSE_BYTES = 200_000;

export class BraveWebSearch implements WebSearchPort {
  constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {
    if (!apiKey.trim()) throw new Error('BRAVE_SEARCH_API_KEY is required for web research.');
  }

  async search(query: string): Promise<WebSearchResult[]> {
    const safeQuery = validatePublicSearchQuery(query);
    const url = new URL(ENDPOINT);
    url.searchParams.set('q', safeQuery);
    url.searchParams.set('count', '5');
    url.searchParams.set('extra_snippets', 'true');
    const response = await this.fetcher(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Subscription-Token': this.apiKey },
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Web search failed with HTTP ${response.status}.`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (declaredLength > MAX_RESPONSE_BYTES) throw new Error('Web search response exceeded the size limit.');
    if (!response.body) throw new Error('Web search returned an empty response.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) throw new Error('Web search response exceeded the size limit.');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const items = (data as { web?: { results?: unknown } })?.web?.results;
    if (!Array.isArray(items)) return [];
    return items.flatMap((item): WebSearchResult[] => {
      if (!item || typeof item !== 'object') return [];
      const hit = item as Record<string, unknown>;
      if (typeof hit.url !== 'string' || typeof hit.title !== 'string') return [];
      try {
        const source = new URL(hit.url);
        if (source.protocol !== 'https:' || source.username || source.password) return [];
        const snippets = [hit.description, ...(Array.isArray(hit.extra_snippets) ? hit.extra_snippets.slice(0, 3) : [])]
          .filter((value): value is string => typeof value === 'string');
        return [{ title: clean(hit.title, 180), url: source.toString(),
          description: clean(snippets.join(' '), 1_000),
          ...(typeof hit.age === 'string' ? { age: clean(hit.age, 80) } : {}) }];
      } catch { return []; }
    }).slice(0, 5);
  }
}

/** Reject common private data before any query leaves the machine. */
export function validatePublicSearchQuery(query: string): string {
  const value = query.trim().replace(/\s+/g, ' ');
  if (!value || value.length > 180 || value.split(' ').length > 24
    || /(?:https?:\/\/|[a-z]:[\\/]|\\\\|\/Users\/|\/home\/|@|(?:api[_-]?key|token|password|secret)\s*[:=])/i.test(value)
    || /\b[A-Za-z0-9_-]{32,}\b/.test(value)) {
    throw new Error('Search query must be a short public knowledge topic without paths, URLs, or secrets.');
  }
  return value;
}

function clean(value: string, max: number): string {
  return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
