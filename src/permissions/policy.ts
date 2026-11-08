import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import type { PermissionContext, PermissionMode, PermissionOperation } from '../domain/contracts.js';

export type PermissionDecision = 'allow' | 'require_approval' | 'deny';

const supportedActions: Record<PermissionOperation['permission'], Set<string>> = {
  'filesystem.read': new Set(['read', 'readtext', 'read_text']),
  'filesystem.write': new Set(['write', 'writetext', 'write_text', 'mkdir', 'createdirectory', 'create_directory', 'remove', 'delete', 'createpresentation']),
  network: new Set(['request']),
  process: new Set(['run', 'launch']),
  location: new Set(['current']),
  mcp: new Set(['call']),
};

export class PermissionPolicy {
  decide(mode: PermissionMode, operation: PermissionOperation, context: PermissionContext): PermissionDecision {
    const permission = operation.permission;
    const action = normalizeAction(operation.action);
    if (!supportedActions[permission]?.has(action)) return 'require_approval';
    if (mode === 'full') return 'allow';

    if (permission === 'filesystem.read') {
      const target = operation.target || stringArg(operation, 'path');
      return target && isPathInsideWorkspace(target, context.workspaceRoot) ? 'allow' : 'require_approval';
    }

    if (mode === 'request') return 'require_approval';

    if (permission === 'filesystem.write') {
      const target = operation.target || stringArg(operation, 'path');
      const inside = target && isPathInsideWorkspace(target, context.workspaceRoot);
      const createsNewTarget = ['mkdir', 'createdirectory', 'create_directory'].includes(action)
        || (['write', 'writetext', 'write_text', 'createpresentation'].includes(action) && !context.targetExists);
      return inside && createsNewTarget && !context.destructive ? 'allow' : 'require_approval';
    }

    if (permission === 'network') {
      const method = stringArg(operation, 'method').toUpperCase();
      return method === 'GET' && !context.containsTaskData && isPublicHttpsTarget(operation.target)
        ? 'allow'
        : 'require_approval';
    }

    return 'require_approval';
  }
}

export function isPathInsideWorkspace(candidatePath: string, workspaceRoot: string): boolean {
  if (!candidatePath.trim() || !workspaceRoot.trim()) return false;
  const candidateIsWindowsAbsolute = isWindowsAbsolute(candidatePath);
  const rootIsWindowsAbsolute = isWindowsAbsolute(workspaceRoot);
  if (candidateIsWindowsAbsolute && !rootIsWindowsAbsolute) return false;
  if (rootIsWindowsAbsolute && path.isAbsolute(candidatePath) && !candidateIsWindowsAbsolute) return false;
  const windowsPath = candidateIsWindowsAbsolute || rootIsWindowsAbsolute;
  if (windowsPath && process.platform !== 'win32') {
    return isLexicallyInside(candidatePath, workspaceRoot, path.win32);
  }
  const api = windowsPath ? path.win32 : path;
  if (windowsPath) {
    const rootVolume = path.win32.parse(path.win32.resolve(workspaceRoot)).root.toLowerCase();
    const targetAbsolute = path.win32.isAbsolute(candidatePath)
      ? path.win32.resolve(candidatePath)
      : path.win32.resolve(workspaceRoot, candidatePath);
    const targetVolume = path.win32.parse(targetAbsolute).root.toLowerCase();
    if (rootVolume !== targetVolume) return false;
  }
  if (!existsSync(workspaceRoot)) return isLexicallyInside(candidatePath, workspaceRoot, api);
  const root = canonicalizePath(workspaceRoot, workspaceRoot, api);
  const target = canonicalizePath(candidatePath, workspaceRoot, api);
  return isRelativeInside(root, target, api);
}

export function canonicalizeFilesystemPath(candidatePath: string, workspaceRoot: string): string {
  if (!candidatePath.trim() || !workspaceRoot.trim()) throw new Error('Filesystem operation requires an explicit path.');
  const windowsPath = isWindowsAbsolute(candidatePath) || isWindowsAbsolute(workspaceRoot);
  if (windowsPath && process.platform !== 'win32') {
    return path.win32.isAbsolute(candidatePath)
      ? path.win32.normalize(candidatePath)
      : path.win32.resolve(workspaceRoot, candidatePath);
  }
  const api = windowsPath ? path.win32 : path;
  if (windowsPath) {
    const absolute = api.isAbsolute(candidatePath) ? api.resolve(candidatePath) : api.resolve(workspaceRoot, candidatePath);
    if (path.win32.parse(absolute).root.toLowerCase() !== path.win32.parse(path.win32.resolve(workspaceRoot)).root.toLowerCase()) {
      return absolute;
    }
  }
  return canonicalizePath(candidatePath, workspaceRoot, api);
}

function canonicalizePath(
  candidatePath: string,
  workspaceRoot: string,
  api: typeof path | typeof path.win32,
  visitedSymlinks = new Set<string>(),
): string {
  const absolute = api.isAbsolute(candidatePath)
    ? api.normalize(candidatePath)
    : api.resolve(workspaceRoot, candidatePath);
  let cursor = absolute;
  const suffix: string[] = [];
  let resolvedAncestor = '';
  while (!resolvedAncestor) {
    try {
      resolvedAncestor = realpathSync.native(cursor);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      try {
        if (lstatSync(cursor).isSymbolicLink()) {
          if (visitedSymlinks.has(cursor)) throw new Error('Symlink cycle detected while resolving the target path.');
          visitedSymlinks.add(cursor);
          const linkTarget = readlinkSync(cursor);
          const resolvedLink = api.isAbsolute(linkTarget) ? linkTarget : api.resolve(api.dirname(cursor), linkTarget);
          return canonicalizePath(api.join(resolvedLink, ...suffix), workspaceRoot, api, visitedSymlinks);
        }
      } catch (linkError) {
        if (!isMissingPathError(linkError)) throw linkError;
      }
      const parent = api.dirname(cursor);
      if (parent === cursor) {
        resolvedAncestor = cursor;
        break;
      }
      suffix.unshift(api.basename(cursor));
      cursor = parent;
    }
  }
  return api.normalize(api.join(resolvedAncestor, ...suffix));
}

function isMissingPathError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function isLexicallyInside(candidatePath: string, workspaceRoot: string, api: typeof path | typeof path.win32): boolean {
  const root = api.resolve(workspaceRoot);
  const target = api.isAbsolute(candidatePath) ? api.resolve(candidatePath) : api.resolve(root, candidatePath);
  return isRelativeInside(root, target, api);
}

function isRelativeInside(root: string, target: string, api: typeof path | typeof path.win32): boolean {
  const relative = api.relative(root, target).replaceAll('\\', '/');
  const comparable = api === path.win32 ? relative.toLowerCase() : relative;
  return comparable === '' || (comparable !== '..' && !comparable.startsWith('../') && !api.isAbsolute(relative));
}

function isWindowsAbsolute(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function normalizeAction(value: string): string {
  return value.replace(/[-\s]/g, '').toLowerCase();
}

function stringArg(operation: PermissionOperation, key: string): string {
  const value = operation.arguments[key];
  return typeof value === 'string' ? value : '';
}

function isPublicHttpsTarget(target: string): boolean {
  try {
    const url = new URL(target);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    if (url.port && url.port !== '443') return false;
    if (url.search || url.hash) return false;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return false;
    if (isIP(hostname)) return false;
    return hostname.includes('.') && !hostname.startsWith('127.') && !hostname.startsWith('10.');
  } catch {
    return false;
  }
}
