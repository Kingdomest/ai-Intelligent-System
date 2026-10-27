import { validatePublicSearchQuery } from './web-search.js';

export interface NewsArticle {
  title: string;
  url: string;
  publisher: string;
  publishedAt?: string;
}

const NEWS_HOST = 'news.google.com';

/** Keyless public-news lookup. The URL is executed through the normal network permission broker. */
export function newsSearchUrl(query: string): string {
  const url = new URL(`https://${NEWS_HOST}/rss/search`);
  url.searchParams.set('q', validatePublicSearchQuery(query));
  url.searchParams.set('hl', 'zh-CN');
  url.searchParams.set('gl', 'CN');
  url.searchParams.set('ceid', 'CN:zh-Hans');
  return url.toString();
}

export function isNewsSearchUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === NEWS_HOST && url.pathname === '/rss/search';
  } catch { return false; }
}

export function isPublicNewsQuestion(message: string, hasAttachments: boolean): boolean {
  if (hasAttachments || message.length > 180 || /(?:我的|我们公司|内部|私有|机密|账号|密码)/.test(message)) return false;
  if (!/(?:前段时间|最近|近期|近日|今天|昨天|上周|新闻|事件|事故|争议|舆论|热搜|发生了什么|怎么回事)/.test(message)) return false;
  if (/(?:天气|气温|股价|汇率|编程|代码|文件|项目|帮我写)/.test(message)) return false;
  if (!/(?:什么|怎么|如何|原因|详情|情况|进展|影响|报道|说下|介绍|经过|发生)/.test(message)) return false;
  try { validatePublicSearchQuery(message); return true; } catch { return false; }
}

/** A short correction can refer to the immediately preceding public-news question. */
export function newsQueryForTurn(message: string, previousUserMessages: string[],
  hasAttachments: boolean): string | null {
  if (isPublicNewsQuestion(message, hasAttachments)) return message;
  const isCorrection = (value: string) => value.length <= 100
    && /(?:不是|不对|说错|搞错|指的是|我说的是|20\d{2}年|联网|搜索|查一下|重新查)/.test(value);
  if (hasAttachments || !isCorrection(message)) return null;
  const corrections = [message];
  for (const previous of previousUserMessages.slice(0, 4)) {
    if (isPublicNewsQuestion(previous, false)) {
      const year = corrections.map(value => /\b20\d{2}\b/.exec(value)?.[0]).find(Boolean);
      const query = `${previous}${year ? ` ${year}` : ''}`;
      try { return validatePublicSearchQuery(query); } catch { return null; }
    }
    if (!isCorrection(previous)) return null;
    corrections.push(previous);
  }
  return null;
}

/** Parse the small RSS response into evidence; headlines alone do not verify article-body claims. */
export function parseNewsRss(body: string): NewsArticle[] {
  const articles: NewsArticle[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const item = match[1] ?? '';
    const title = cleanXml(tag(item, 'title'), 240);
    const link = cleanXml(tag(item, 'link'), 2048);
    const publisher = cleanXml(tag(item, 'source'), 100);
    const date = cleanXml(tag(item, 'pubDate'), 100);
    if (!title || !link) continue;
    try {
      const url = new URL(link);
      if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) continue;
      if (seen.has(url.toString())) continue;
      seen.add(url.toString());
      const parsedDate = Date.parse(date);
      articles.push({ title, url: url.toString(), publisher,
        ...(Number.isFinite(parsedDate) ? { publishedAt: new Date(parsedDate).toISOString() } : {}) });
      if (articles.length >= 8) break;
    } catch { /* Ignore malformed feed entries. */ }
  }
  return articles;
}

function tag(xml: string, name: string): string {
  return new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(xml)?.[1] ?? '';
}

function cleanXml(value: string, maxLength: number): string {
  return value.replace(/^<!\[CDATA\[|\]\]>$/g, '')
    .replace(/&#(\d+);|&#x([0-9a-f]+);|&(amp|lt|gt|quot|apos);/gi, (_, decimal: string, hex: string, named: string) => {
      if (decimal || hex) {
        const code = Number.parseInt(decimal || hex, decimal ? 10 : 16);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      }
      return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[named.toLowerCase()] ?? '';
    })
    .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}
