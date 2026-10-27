import { z } from 'zod';
import type { ModelGateway } from '../model/gateway.js';

const pageSchema = z.object({
  number: z.number().int().min(1).max(20),
  title: z.string().trim().min(2).max(80),
  bullets: z.array(z.string().trim().min(4).max(180)).min(3).max(5),
  visualSuggestion: z.string().trim().min(2).max(120),
  speakerNotes: z.string().trim().min(4).max(150),
});
type Page = z.infer<typeof pageSchema>;
const numericClaim = /\d+(?:\.\d+)?(?:\s*[:：]\s*\d+(?:\.\d+)?)?(?:\s*[%％+])?(?:\s*(?:万|千|百)?(?:人|用户|元|个|项|次|单|位|倍|天|小时|月|年|家|页|字))?/g;
const chineseClaim = /(?:百分之)?[一二两三四五六七八九十百千万零]+(?:余|多)?(?:%|％|人|用户|元|个|项|次|单|位|倍|家)/g;

export function maskUnsupportedNumbers(text: string, brief: string, additionalAllowed: string[] = []): string {
  const allowedDigits = new Set(brief.match(numericClaim) ?? []);
  additionalAllowed.forEach(value => allowedDigits.add(value));
  const allowedChinese = new Set(brief.match(chineseClaim) ?? []);
  return text.replace(numericClaim, match => allowedDigits.has(match) ? match : '【待补充真实数据】')
    .replace(chineseClaim, match => allowedChinese.has(match) ? match : '【待补充真实数据】');
}

export function longPresentationDraftPageCount(message: string): number | null {
  if (!/(?:ppt|powerpoint|演示文稿|幻灯片)/i.test(message)
    || !/(?:文案|页面结构|逐字稿|演讲稿)/.test(message)) return null;
  const explicit = message.match(/(?:共|一共|总计|总共)\s*(\d{1,2})\s*页/);
  const outlined = [...message.matchAll(/第\s*(\d{1,2})\s*页/g)]
    .map(match => Number(match[1]));
  const count = explicit ? Number(explicit[1]) : Math.max(0, ...outlined);
  return count >= 6 && count <= 20 ? count : null;
}

export function allowsIllustrativeMetrics(message: string): boolean {
  return /(?:数据|指标|业绩).{0,10}(?:可以|允许|可).{0,10}(?:合理)?(?:虚构|编造|模拟)|(?:示例|模拟)数据/.test(message);
}

export async function draftLongPresentation(
  brief: string,
  taskId: string,
  gateway: ModelGateway,
  onProgress?: (completed: number, total: number) => void,
  feedback?: string,
): Promise<{ answer: string; pageCount: number }> {
  const pageCount = longPresentationDraftPageCount(brief);
  if (!pageCount) throw new Error('Long presentation request lacks a supported page count.');
  const illustrativeMetrics = allowsIllustrativeMetrics(brief);
  const needsSpeech = /(?:逐字稿|演讲稿)/.test(brief);
  const total = Math.ceil(pageCount / 3) + Number(needsSpeech);
  const pages: Page[] = [];
  let completed = 0;
  for (let first = 1; first <= pageCount; first += 3) {
    const pageNumbers = Array.from({ length: Math.min(3, pageCount - first + 1) }, (_, index) => first + index);
    const schema = z.object({ pages: z.array(pageSchema).length(pageNumbers.length) });
    const response = await gateway.complete({ role: 'presentation.draft_pages', taskId, maxOutputTokens: 2304,
      system: 'Write exactly the requested numbered pages of a Chinese presentation draft. Each page needs a clear title, 3-5 substantial but concise bullets, one visual/chart suggestion, and speaker notes within 100 Chinese characters. Follow the user-specified page structure and facts. '
        + (illustrativeMetrics
          ? 'The user explicitly permits plausible fictional sample metrics. Use internally consistent example figures, reuse priorExampleMetrics for repeated KPIs, and never claim they were verified. The final answer will carry a visible sample-data disclaimer. '
          : 'Do not invent achievements, metrics, dates, or citations; mark unknown results as 【待补充真实数据】. ')
        + 'Do not write other pages, a speech, code, or a file. Return only the specified JSON.',
      user: JSON.stringify({ brief, pageNumbers, previousPageTitles: pages.map(page => page.title),
        priorExampleMetrics: illustrativeMetrics ? pages.flatMap(page => page.bullets)
          .filter(bullet => /\d/.test(bullet)).slice(-12) : undefined,
        correctionFeedback: feedback }),
    }, schema);
    if (response.data.pages.some((page, index) => page.number !== pageNumbers[index])) {
      throw new Error(`Draft model returned the wrong page numbers for pages ${pageNumbers.join(', ')}.`);
    }
    pages.push(...response.data.pages.map(page => ({ ...page,
      title: illustrativeMetrics ? page.title : maskUnsupportedNumbers(page.title, brief, [String(page.number)]),
      bullets: illustrativeMetrics ? page.bullets : page.bullets.map(bullet => maskUnsupportedNumbers(bullet, brief)),
      visualSuggestion: illustrativeMetrics ? page.visualSuggestion : maskUnsupportedNumbers(page.visualSuggestion, brief),
      speakerNotes: illustrativeMetrics ? page.speakerNotes : maskUnsupportedNumbers(page.speakerNotes, brief),
    })));
    onProgress?.(++completed, total);
  }

  let speech: string | undefined;
  if (needsSpeech) {
    const response = await gateway.complete({ role: 'presentation.draft_speech', taskId, maxOutputTokens: 2304,
      system: 'Write a natural Chinese presentation speech of approximately 800-1000 Chinese characters, following the supplied page summaries. Use only facts already supplied by the user or drafted pages. '
        + (illustrativeMetrics
          ? 'The user allows fictional sample data. Reuse the exact same sample metrics from the page summaries; do not introduce contradictory figures and never describe sample data as verified real-world results. '
          : 'Do not invent numerical achievements, metrics, dates, or citations. ')
        + 'Return only JSON with the speech field, no page copy.',
      user: JSON.stringify({ brief, pages: pages.map(page => ({ number: page.number, title: page.title, bullets: page.bullets })),
        correctionFeedback: feedback }),
    }, z.object({ speech: z.string().trim().min(600).max(1200) }));
    speech = illustrativeMetrics ? response.data.speech : maskUnsupportedNumbers(response.data.speech, brief);
    onProgress?.(++completed, total);
  }

  const answer = pages.map(page => [
    `第${page.number}页｜${page.title}`,
    '- 核心内容：',
    ...page.bullets.map((bullet, index) => `  ${index + 1}. ${bullet}`),
    `- 配图/图表建议：${page.visualSuggestion}`,
    `- 演讲备注：${page.speakerNotes}`,
  ].join('\n')).join('\n\n');
  const completedAnswer = speech ? `${answer}\n\n述职演讲逐字稿\n${speech}` : answer;
  return { pageCount, answer: illustrativeMetrics
    ? `说明：文中未由你提供的业绩数字均为模拟示例，用于文案与版式参考；正式汇报前请替换为核实后的真实数据。\n\n${completedAnswer}`
    : completedAnswer.includes('【待补充真实数据】')
    ? `说明：你未提供部分实际业绩指标，相关位置已标为【待补充真实数据】，请核实后填写。\n\n${completedAnswer}`
    : completedAnswer };
}
