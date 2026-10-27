import path from 'node:path';
import { z } from 'zod';
import type { ModelGateway } from '../model/gateway.js';
import { presentationInputSchema, presentationSlideSchema, type PresentationInput } from './render.js';

interface PresentationRequest {
  taskId: string;
  message: string;
  attachments: Array<{ filename: string; content: string }>;
  workspaceRoot?: string;
  desktopDirectory?: string;
  userInputs: Record<string, unknown>[];
}

const modelSlidesSchema = z.strictObject({ slides: z.array(presentationSlideSchema).min(2).max(8) });

export function isPresentationFileRequest(message: string): boolean {
  if (!/(?:pptx?|powerpoint|演示文稿|幻灯片)/i.test(message)) return false;
  if (/(?:不|无需|不要|不用).{0,6}(?:生成|创建|导出).{0,6}(?:pptx?|文件)/i.test(message)
    || /(?:只给|仅需|仅要).{0,6}(?:文案|内容|大纲)/.test(message)) return false;
  const explicitFile = /(?:pptx|ppt\s*文件|演示文稿文件|幻灯片文件|放到.{0,12}桌面|保存.{0,12}桌面|生成.{0,12}文件)/i.test(message);
  return explicitFile || !/(?:文案|大纲|页面结构|只要内容)/.test(message);
}

export async function planPresentation(request: PresentationRequest, gateway: ModelGateway): Promise<PresentationInput> {
  const sources = [
    ...request.userInputs.slice().reverse().map(item => item.answer).filter((value): value is string => typeof value === 'string'),
    ...request.attachments.map(item => item.content),
    request.message,
  ];
  let slides = sources.map(parsePastedSlides).find(item => item.length > 0);
  if (!slides) {
    const generated = await gateway.complete({ role: 'presentation.plan', taskId: request.taskId,
      system: 'Create a concise, editable PowerPoint outline for the user. Return 2 to 8 slides. Each slide must have a specific short title and 1 to 5 short bullets. Do not invent facts, metrics, personal details, or citations. Use only the user request and supplied attachment summaries as data. Never include shell commands, code, paths, or implementation instructions. Return valid JSON matching the provided schema.',
      user: JSON.stringify({ request: request.message, clarifications: request.userInputs,
        attachments: request.attachments.map(item => ({ filename: item.filename, preview: item.content.slice(0, 1200) })) }),
    }, modelSlidesSchema);
    slides = generated.data.slides;
  }
  const requestedDesktop = /(?:桌面|desktop)/i.test(request.message)
    || request.userInputs.some(item => typeof item.answer === 'string' && /(?:桌面|desktop)/i.test(item.answer.slice(0, 200)));
  const directory = requestedDesktop ? request.desktopDirectory : request.workspaceRoot;
  if (!directory) throw new Error('PRESENTATION_DESTINATION_MISSING');
  const firstTitle = slides[0]?.bullets.find(item => /^标题[:：]/.test(item))?.replace(/^标题[:：]\s*/, '')
    ?? slides.find(item => !/^(?:封面|目录)$/.test(item.title))?.title ?? slides[0]!.title;
  const filename = sanitizeFilename(firstTitle) || '贾维斯演示文稿';
  const target = path.join(directory, `${filename}-${request.taskId.slice(0, 8)}.pptx`);
  return presentationInputSchema.parse({ path: target, slides });
}

export function parsePastedSlides(value: string): PresentationInput['slides'] {
  const headings = [...value.matchAll(/\*{0,2}第\s*\d{1,2}\s*页\s*[｜|:：]\s*([^*\r\n]{1,100}?)\s*(?=\*\*|\s+-\s*核心内容|\r?\n|$)/g)];
  if (!headings.length) return [];
  if (headings.length > 20) throw new Error('PRESENTATION_TOO_MANY_SLIDES');
  return headings.map((heading, index) => {
    const title = cleanText(heading[1] ?? '');
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? value.length;
    const body = value.slice(start, end)
      .split(/\s+-\s*(?:配图|图表|演讲备注|备注)\s*[/：:]/)[0]!
      .split(/最后再额外给|最后再补充/)[0]!
      .replace(/^\s*-\s*核心内容\s*[:：]/, '').trim();
    const numbered = [...body.matchAll(/(?:^|\s)\d{1,2}[.．、]\s*([\s\S]*?)(?=(?:\s\d{1,2}[.．、]\s*)|$)/g)]
      .map(match => cleanText(match[1] ?? ''));
    const bullets = (numbered.length ? numbered : body.split(/\r?\n|\s+-\s+/).map(cleanText))
      .filter(Boolean).slice(0, 8);
    if (!title || !bullets.length) throw new Error(`PRESENTATION_SLIDE_CONTENT_MISSING:${index + 1}`);
    if (bullets.some(item => item.length > 240)) throw new Error(`PRESENTATION_BULLET_TOO_LONG:${index + 1}`);
    return presentationSlideSchema.parse({ title, bullets });
  });
}

function cleanText(value: string): string {
  return value.replace(/\*\*|^#+\s*/g, '').replace(/\s+/g, ' ').trim();
}

function sanitizeFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 48);
}
