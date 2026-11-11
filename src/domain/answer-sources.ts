export interface AnswerSource {
  title: string;
  url: string;
}

/** Resolve known reader URLs to their original article, then validate the target. */
function articleUrl(value: string): URL | null {
  let url = new URL(value);
  for (let depth = 0; depth < 4; depth++) {
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') return null;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!hostname.includes('.') || hostname === 'localhost' || hostname.endsWith('.localhost')
      || hostname.endsWith('.local') || /^\d+(?:\.\d+){3}$/.test(hostname)) return null;
    if (hostname !== 'r.jina.ai') return url;
    let target = url.pathname.slice(1);
    if (/^https?%3a%2f%2f/i.test(target)) target = decodeURIComponent(target);
    if (!target) return url;
    if (!/^https?:\/\//i.test(target)) return null;
    url = new URL(target + url.search);
  }
  return null;
}

/** Shared by the API and UI, including source events saved by older versions. */
export function sanitizeAnswerSources(value: unknown): AnswerSource[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const sources: AnswerSource[] = [];
  for (const item of value.slice(0, 30)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.url !== 'string') continue;
    try {
      const url = articleUrl(record.url);
      if (!url) continue;
      const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
      for (const key of [...url.searchParams.keys()]) {
        if (/key|token|secret|password|signature|authorization|session/i.test(key)) url.searchParams.delete(key);
      }
      url.hash = '';
      const canonical = url.toString();
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      const title = typeof record.title === 'string' ? record.title.replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ').trim().slice(0, 180) : '';
      const readerLabel = /^(?:https?:\/\/)?r\.jina\.ai\/?$/i.test(title);
      sources.push({ title: !title || readerLabel && hostname !== 'r.jina.ai' ? hostname : title, url: canonical });
      if (sources.length >= 20) break;
    } catch { /* Ignore malformed source URLs. */ }
  }
  return sources;
}
