export interface AnswerSource {
  title: string;
  url: string;
}

export function sourcesFromTaskEvents(events: Array<{ type: string; payload: Record<string, unknown> }>): AnswerSource[] {
  const seen = new Set<string>();
  return events.flatMap(event => {
    if (event.type !== 'research.searched' && event.type !== 'answer.sources') return [];
    return Array.isArray(event.payload.sources) ? event.payload.sources : [];
  }).flatMap((item): AnswerSource[] => {
    if (!item || typeof item !== 'object') return [];
    const source = item as Record<string, unknown>;
    if (typeof source.url !== 'string' || typeof source.title !== 'string') return [];
    try {
      const url = new URL(source.url);
      if (url.protocol !== 'https:' || url.username || url.password || seen.has(url.toString())) return [];
      seen.add(url.toString());
      return [{ title: source.title, url: url.toString() }];
    } catch { return []; }
  }).slice(0, 20);
}

export function AnswerSources({ sources }: { sources: AnswerSource[] }) {
  const visible = sourcesFromTaskEvents([{ type: 'answer.sources', payload: { sources } }]);
  if (!visible.length) return null;
  return <details className="answer-sources">
    <summary aria-label={`查看 ${visible.length} 个文章来源`}>
      <svg className="answer-sources-search" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <circle cx="10.8" cy="10.8" r="6.4" /><path d="m16 16 4.5 4.5" />
      </svg>
      <span>搜索到 {visible.length} 个网页</span>
      <span className="answer-sources-sites" aria-hidden="true">
        {visible.slice(0, 3).map((source, index) => <span key={source.url} className="answer-source-site"
          style={{ zIndex: 3 - index }}>{new URL(source.url).hostname.charAt(0).toUpperCase()}</span>)}
      </span>
      <span className="answer-sources-chevron" aria-hidden="true">⌄</span>
    </summary>
    <ol className="answer-source-list">
      {visible.map(source => <li key={source.url}>
        <a href={source.url} target="_blank" rel="noopener noreferrer" title={source.url}>
          <strong>{source.title}</strong>
          <small>{new URL(source.url).hostname}</small>
        </a>
      </li>)}
    </ol>
  </details>;
}
