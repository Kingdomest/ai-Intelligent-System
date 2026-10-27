import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writePresentation } from '../../src/presentations/render.js';

it('never replaces an existing presentation even when the user chose full access', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-ppt-no-overwrite-'));
  const destination = join(directory, 'existing.pptx');
  writeFileSync(destination, 'original user bytes');
  try {
    await expect(writePresentation(destination, { path: destination,
      slides: [{ title: 'New slide', bullets: ['new content'] }] })).rejects.toThrow();
    expect(readFileSync(destination, 'utf8')).toBe('original user bytes');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
