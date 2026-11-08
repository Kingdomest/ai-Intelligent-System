import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectGitDestination } from '../../src/runtime/git-clone-contract.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

describe('Git clone destination', () => {
  it('recognizes a verified archive and rejects unrelated existing files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jarvis-checkout-'));
    directories.push(root);
    const directory = join(root, 'code');
    mkdirSync(directory);
    const remote = 'https://github.com/deepseek-ai/deepseek-harness.git';
    const input = { command: 'git', args: ['clone', '--depth', '1', remote, '.'], cwd: directory };
    expect(await inspectGitDestination(input)).toEqual({ status: 'empty' });
    writeFileSync(join(directory, 'other.txt'), 'unrelated content');
    expect(await inspectGitDestination(input)).toMatchObject({ status: 'conflict' });
    const readme = '# DeepSeek Harness';
    const pkg = '{"name":"@deepseek-ai/dsh-root"}';
    writeFileSync(join(directory, 'README.md'), readme);
    writeFileSync(join(directory, 'package.json'), pkg);
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    writeFileSync(join(directory, '.jarvis-source.json'), JSON.stringify({ schemaVersion: 1,
      kind: 'github-source-archive', repositoryUrl: remote.replace(/\.git$/, ''),
      readmeSha256: hash(readme), packageSha256: hash(pkg) }));
    expect(await inspectGitDestination(input)).toMatchObject({ status: 'matching', source: 'github-source-archive' });
    writeFileSync(join(directory, 'README.md'), 'Changed');
    expect(await inspectGitDestination(input)).toMatchObject({ status: 'conflict' });
  });
});
