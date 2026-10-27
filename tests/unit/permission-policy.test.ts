import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PermissionContext, PermissionMode, PermissionOperation } from '../../src/domain/contracts.js';
import { PermissionPolicy } from '../../src/permissions/policy.js';

const temporaryDirectories: string[] = [];

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-policy-'));
  temporaryDirectories.push(directory);
  return directory;
}

function operation(overrides: Partial<PermissionOperation> = {}): PermissionOperation {
  return {
    operationId: 'operation-1',
    permission: 'filesystem.read',
    action: 'read',
    target: '',
    reason: 'Needed to complete the task.',
    arguments: {},
    ...overrides,
  };
}

function context(root: string, overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    workspaceRoot: root,
    containsTaskData: false,
    targetExists: false,
    destructive: false,
    external: false,
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('PermissionPolicy', () => {
  const policy = new PermissionPolicy();

  it.each([
    ['workspace read in request', 'request', (root: string) => operation({ target: join(root, 'notes.txt') }), {}, 'allow'],
    ['outside read in request', 'request', () => operation({ target: 'C:\\external\\secret.txt' }), {}, 'require_approval'],
    ['any write in request', 'request', (root: string) => operation({ permission: 'filesystem.write', action: 'mkdir', target: join(root, 'new') }), {}, 'require_approval'],
    ['new in-workspace directory in auto', 'auto', (root: string) => operation({ permission: 'filesystem.write', action: 'mkdir', target: join(root, 'new') }), {}, 'allow'],
    ['overwrite in auto', 'auto', (root: string) => operation({ permission: 'filesystem.write', action: 'write', target: join(root, 'existing.txt') }), { targetExists: true, destructive: true }, 'require_approval'],
    ['delete in auto', 'auto', (root: string) => operation({ permission: 'filesystem.write', action: 'remove', target: join(root, 'old.txt') }), { targetExists: true, destructive: true }, 'require_approval'],
    ['outside write in auto', 'auto', () => operation({ permission: 'filesystem.write', action: 'mkdir', target: 'C:\\outside\\new' }), {}, 'require_approval'],
    ['network request carrying task data in auto', 'auto', () => operation({ permission: 'network', action: 'request', target: 'https://example.test/upload', arguments: { method: 'POST' } }), { external: true, containsTaskData: true }, 'require_approval'],
    ['private network target in auto', 'auto', () => operation({ permission: 'network', action: 'request', target: 'http://127.0.0.1:3000', arguments: { method: 'GET' } }), { external: true }, 'require_approval'],
    ['public GET without user data in auto', 'auto', () => operation({ permission: 'network', action: 'request', target: 'https://example.test/public', arguments: { method: 'GET' } }), { external: true }, 'allow'],
    ['public GET containing a query payload in auto', 'auto', () => operation({ permission: 'network', action: 'request', target: 'https://example.test/search?q=task-data', arguments: { method: 'GET' } }), { external: true }, 'require_approval'],
    ['process launch in auto', 'auto', () => operation({ permission: 'process', action: 'run', target: 'node.exe' }), {}, 'require_approval'],
    ['GUI launch in full', 'full', () => operation({ permission: 'process', action: 'launch', target: 'C:\\Apps\\cloudmusic.exe' }), {}, 'allow'],
    ['location lookup in auto', 'auto', () => operation({ permission: 'location', action: 'current', target: 'device location' }), {}, 'require_approval'],
    ['all supported operations in full', 'full', () => operation({ permission: 'process', action: 'run', target: 'node.exe' }), {}, 'allow'],
    ['unknown operation fails closed', 'auto', () => operation({ action: 'mystery' }), {}, 'require_approval'],
  ] as Array<[string, PermissionMode, (root: string) => PermissionOperation, Partial<PermissionContext>, string]>)('%s', (name, mode, makeOperation, contextOverrides, expected) => {
    const root = workspace();
    expect(policy.decide(mode, makeOperation(root), context(root, contextOverrides))).toBe(expected);
  });

  it('normalizes Windows drive, UNC, traversal, mixed separators, and case-insensitive paths', () => {
    const root = 'C:\\Jarvis\\Project';
    const check = (target: string) => policy.decide('request', operation({ target }), context(root));
    expect(check('c:/jarvis/project/sub/file.txt')).toBe('allow');
    expect(check('C:\\Jarvis\\Project\\..\\secret.txt')).toBe('require_approval');
    expect(check('C:/Jarvis/Project/../../Windows/system.ini')).toBe('require_approval');
    expect(check('\\\\server\\share\\secret.txt')).toBe('require_approval');
    expect(policy.decide('auto', operation({ permission: 'filesystem.write', action: 'mkdir', target: 'C:/Jarvis/Project/new' }), context(root))).toBe('allow');
  });

  it('treats a symlink inside the workspace that resolves outside as outside', () => {
    const root = workspace();
    const outside = workspace();
    const link = join(root, 'linked-out');
    try {
      symlinkSync(outside, link, 'junction');
    } catch {
      // Junctions are available on supported Windows developer environments; skip if host policy disallows them.
      return;
    }
    const result = policy.decide('request', operation({ target: resolve(link, 'secret.txt') }), context(root));
    expect(result).toBe('require_approval');
  });

  it('resolves a dangling symlink inside the workspace before checking containment', () => {
    const root = workspace();
    const outside = workspace();
    const link = join(root, 'dangling-out');
    try {
      symlinkSync(join(outside, 'not-created-yet'), link, 'file');
    } catch {
      // Windows may disallow symlink creation when Developer Mode or privileges are unavailable.
      return;
    }
    expect(policy.decide('request', operation({ target: link }), context(root))).toBe('require_approval');
  });
});
