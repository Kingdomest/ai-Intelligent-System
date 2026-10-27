import type { TaskEvent } from '../domain/contracts.js';

export interface AnswerSource {
  title: string;
  url: string;
}

/** Only public web URLs can appear in the answer's source list. */
export function sanitizeAnswerSources(value: unknown): AnswerSource[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const sources: AnswerSource[] = [];
  for (const item of value.slice(0, 30)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.url !== 'string') continue;
    try {
      const url = new URL(record.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') continue;
      const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
      if (!hostname.includes('.') || hostname === 'localhost' || hostname.endsWith('.localhost')
        || hostname.endsWith('.local') || /^\d+(?:\.\d+){3}$/.test(hostname)) continue;
      for (const key of [...url.searchParams.keys()]) {
        if (/key|token|secret|password|signature|authorization|session/i.test(key)) url.searchParams.delete(key);
      }
      url.hash = '';
      const canonical = url.toString();
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      const title = typeof record.title === 'string' ? record.title.replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ').trim().slice(0, 180) : '';
      sources.push({ title: title || hostname, url: canonical });
      if (sources.length >= 20) break;
    } catch { /* Ignore malformed source URLs. */ }
  }
  return sources;
}

export function answerSourcesFromEvents(events: TaskEvent[]): AnswerSource[] {
  return sanitizeAnswerSources(events.flatMap(event =>
    event.type === 'research.searched' || event.type === 'answer.sources'
      ? Array.isArray(event.payload.sources) ? event.payload.sources : []
      : []));
}
