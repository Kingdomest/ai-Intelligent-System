import { createHash, randomUUID } from 'node:crypto';
import { link, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import pptxgen from 'pptxgenjs';
import { z } from 'zod';

export const presentationSlideSchema = z.strictObject({
  title: z.string().trim().min(1).max(140),
  bullets: z.array(z.string().trim().min(1).max(240)).max(8),
});

export const presentationInputSchema = z.strictObject({
  path: z.string().trim().min(1).max(4096).refine(value => path.extname(value).toLowerCase() === '.pptx',
    'Presentation target must have a .pptx extension.'),
  slides: z.array(presentationSlideSchema).min(1).max(20),
});

export type PresentationInput = z.infer<typeof presentationInputSchema>;

export async function renderPresentation(input: PresentationInput): Promise<Buffer> {
  const validated = presentationInputSchema.parse(input);
  const Presentation = pptxgen as unknown as new () => {
    layout: string; author: string; subject: string; title: string;
    addSlide(): { background: { color: string }; addText(text: string, options: Record<string, unknown>): void };
    write(options: { outputType: 'nodebuffer'; compression: boolean }): Promise<Uint8Array>;
  };
  const deck = new Presentation();
  deck.layout = 'LAYOUT_WIDE';
  deck.author = 'Jarvis';
  deck.subject = 'Generated presentation';
  deck.title = validated.slides[0]!.title;
  for (const [index, content] of validated.slides.entries()) {
    const slide = deck.addSlide();
    slide.background = { color: 'F7F9FC' };
    slide.addText(content.title, { x: 0.75, y: 0.7, w: 11.8, h: 0.8, fontFace: 'Aptos Display',
      fontSize: 30, bold: true, color: '12335A', margin: 0 });
    for (const [bulletIndex, bullet] of content.bullets.entries()) {
      slide.addText(bullet, { x: 1.05, y: 2.0 + bulletIndex * 0.56, w: 10.9, h: 0.45,
        fontFace: 'Aptos', fontSize: 19, color: '24364B', margin: 0, bullet: { indent: 22 }, paraSpaceAfterPt: 10 });
    }
    slide.addText(`${index + 1} / ${validated.slides.length}`, { x: 11.6, y: 7.0, w: 0.9, h: 0.25,
      fontFace: 'Aptos', fontSize: 10, color: '7B8CA0', margin: 0, align: 'right' });
  }
  const bytes = Buffer.from(await deck.write({ outputType: 'nodebuffer', compression: true }));
  if (bytes.length > 10_000_000) throw new Error('Rendered presentation exceeds the configured size limit.');
  return bytes;
}

export async function writePresentation(pathname: string, input: PresentationInput): Promise<{
  path: string; bytesWritten: number; slideCount: number; sha256: string;
}> {
  const validated = presentationInputSchema.parse({ ...input, path: pathname });
  const bytes = await renderPresentation(validated);
  const temporaryPath = path.join(path.dirname(pathname), `.${path.basename(pathname)}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, bytes, { flag: 'wx' });
  try {
    // Publish the fully written deck without replacing an existing user file.
    await link(temporaryPath, pathname);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return { path: pathname, bytesWritten: bytes.length, slideCount: validated.slides.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function verifyPresentationFile(pathname: string, input: PresentationInput, sha256?: string): Promise<boolean> {
  try {
    const validated = presentationInputSchema.parse(input);
    const metadata = await stat(pathname);
    if (!metadata.isFile() || metadata.size < 1000 || metadata.size > 10_000_000) return false;
    const bytes = await readFile(pathname);
    if (sha256 && createHash('sha256').update(bytes).digest('hex') !== sha256) return false;
    const archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
    if (!archive.file('[Content_Types].xml') || !archive.file('ppt/presentation.xml')) return false;
    const slideEntries = Object.keys(archive.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    if (slideEntries.length !== validated.slides.length) return false;
    for (const [index, slide] of validated.slides.entries()) {
      const entry = archive.file(`ppt/slides/slide${index + 1}.xml`);
      if (!entry) return false;
      const xml = await entry.async('string');
      const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(match => decodeXml(match[1] ?? ''));
      if (!texts.includes(slide.title) || slide.bullets.some(bullet => !texts.includes(bullet))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function decodeXml(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  } as Record<string, string>)[entity] ?? entity);
}
