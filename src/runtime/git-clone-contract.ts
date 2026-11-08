import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';

/** A narrowly recognized checkout command for the routine host path. */
export function routineGitClone(input: Record<string, unknown>): { remote: string; directory: string } | null {
  const command = input.command;
  const args = input.args;
  const cwd = input.cwd;
  if (typeof command !== 'string' || !/(?:^|[\\/])git(?:\.exe)?$/i.test(command)
    || typeof cwd !== 'string' || !(path.isAbsolute(cwd) || path.win32.isAbsolute(cwd))
    || !Array.isArray(args) || !args.every(item => typeof item === 'string')) return null;
  const exact = args.length === 3 && args[0] === 'clone' && args[2] === '.';
  const shallow = args.length === 5 && args[0] === 'clone' && args[1] === '--depth'
    && args[2] === '1' && args[4] === '.';
  if (!exact && !shallow) return null;
  const remote = args[exact ? 1 : 3] as string;
  try {
    const url = new URL(remote);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
  } catch { return null; }
  return { remote, directory: cwd };
}

export type GitDestination =
  | { status: 'empty' }
  | { status: 'matching'; source: 'git' | 'github-source-archive'; directory: string; remote: string }
  | { status: 'conflict'; directory: string; entries: string[] };

/** Observe an existing destination without changing or deleting its contents. */
export async function inspectGitDestination(input: Record<string, unknown>): Promise<GitDestination | null> {
  const clone = routineGitClone(input);
  if (!clone) return null;
  let entries: string[];
  try { entries = await readdir(clone.directory); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { status: 'empty' };
    return { status: 'conflict', directory: clone.directory, entries: [] };
  }
  if (!entries.length) return { status: 'empty' };
  const conflict = (): GitDestination => ({ status: 'conflict', directory: clone.directory,
    entries: entries.slice(0, 12) });
  if (entries.includes('.git')) {
    try {
      const config = await readFile(path.join(clone.directory, '.git', 'config'), 'utf8');
      const origin = config.match(/\[remote "origin"\]([^\[]*)/i)?.[1]
        ?.match(/^\s*url\s*=\s*(.+)\s*$/m)?.[1]?.trim();
      await stat(path.join(clone.directory, '.git', 'HEAD'));
      if (sameRepository(origin, clone.remote) && entries.some(name => name !== '.git')) {
        return { status: 'matching', source: 'git', directory: clone.directory, remote: clone.remote };
      }
    } catch { /* An incomplete checkout is a conflict, never a success. */ }
    return conflict();
  }
  if (entries.includes('.jarvis-source.json')) {
    try {
      const markerPath = path.join(clone.directory, '.jarvis-source.json');
      if ((await stat(markerPath)).size > 4_096) return conflict();
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
      if (marker.schemaVersion !== 1 || marker.kind !== 'github-source-archive'
        || typeof marker.repositoryUrl !== 'string' || !sameRepository(marker.repositoryUrl, clone.remote)) return conflict();
      for (const [file, expected] of [['README.md', marker.readmeSha256], ['package.json', marker.packageSha256]] as const) {
        if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) return conflict();
        const actual = createHash('sha256').update(await readFile(path.join(clone.directory, file))).digest('hex');
        if (actual !== expected.toLowerCase()) return conflict();
      }
      return { status: 'matching', source: 'github-source-archive', directory: clone.directory, remote: clone.remote };
    } catch { return conflict(); }
  }
  return conflict();
}

function sameRepository(left: string | undefined, right: string): boolean {
  const normalized = (value: string) => value.trim().replace(/\.git\/?$/i, '').replace(/\/$/, '').toLowerCase();
  return typeof left === 'string' && normalized(left) === normalized(right);
}
