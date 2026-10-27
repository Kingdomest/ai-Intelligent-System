import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export interface ResolverAdapters {
  platform: string;
  exists(path: string): boolean;
  appPaths(name: string): Promise<string[]>;
  shortcuts(name: string): Promise<Array<{ name: string; target: string }>>;
  pathCandidates(name: string): Promise<string[]>;
}

export type ApplicationResolution =
  | { status: 'resolved'; executable: string; processName: string }
  | { status: 'needs_user_input'; candidates: string[]; reason: string }
  | { status: 'blocked'; reason: string };

export async function resolveWindowsApplication(name: string, adapters: ResolverAdapters = nativeAdapters): Promise<ApplicationResolution> {
  if (adapters.platform !== 'win32') return { status: 'blocked', reason: 'Windows interactive desktop is unavailable.' };
  const requested = name.trim();
  if (!requested || requested.length > 240) return { status: 'needs_user_input', candidates: [], reason: 'Provide an application name or executable path.' };
  const explicit = path.win32.isAbsolute(requested) ? [requested] : [];
  const sources: [string[], string[], Array<{ name: string; target: string }>] = explicit.length ? [explicit, [], []] : await Promise.all([
    adapters.appPaths(requested).catch(() => []),
    adapters.pathCandidates(requested).catch(() => []),
    adapters.shortcuts(requested).catch(() => []),
  ]);
  const [appPaths, pathCandidates, shortcuts] = sources;
  const usableShortcuts = shortcuts.filter((shortcut) => !isManagementShortcut(shortcut.name)
    && !/^(?:uninst|uninstall|repair)(?:all|er)?\.exe$/i.test(path.win32.basename(shortcut.target)));
  const exactShortcuts = usableShortcuts.filter((shortcut) => shortcut.name.toLocaleLowerCase() === requested.toLocaleLowerCase());
  const selectedShortcuts = exactShortcuts.length > 0 ? exactShortcuts : usableShortcuts;
  const candidatePaths = exactShortcuts.length > 0 ? exactShortcuts.map((shortcut) => shortcut.target)
    : [...appPaths, ...pathCandidates, ...selectedShortcuts.map((shortcut) => shortcut.target)];
  const candidates = [...new Map(candidatePaths
    .filter((candidate) => path.win32.extname(candidate).toLowerCase() === '.exe'
    && adapters.exists(candidate)).map((candidate) => [path.win32.normalize(candidate).toLowerCase(), path.win32.normalize(candidate)])).values()];
  if (candidates.length === 0) return { status: 'needs_user_input', candidates: [], reason: 'Application not found. Provide its exact executable path.' };
  if (candidates.length > 1) return { status: 'needs_user_input', candidates, reason: 'Several applications matched. Choose the exact executable.' };
  const executable = candidates[0]!;
  return { status: 'resolved', executable, processName: path.win32.basename(executable, '.exe') };
}

function isManagementShortcut(name: string): boolean {
  return /卸载|修复|^(?:更新|update)(?:\s|[-_:：]|$)|\b(?:uninstall|remove|repair)\b/i.test(name.trim());
}

const shortcutScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$name = $env:JARVIS_RESOLVE_APP
$roots = @([Environment]::GetFolderPath('CommonStartMenu'), [Environment]::GetFolderPath('StartMenu')) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$shell = New-Object -ComObject WScript.Shell
$matches = @()
foreach ($root in $roots) {
  foreach ($shortcut in (Get-ChildItem -LiteralPath $root -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue)) {
    if ($shortcut.BaseName -ieq $name -or $shortcut.BaseName.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $target = $shell.CreateShortcut($shortcut.FullName).TargetPath
      if ($target -and $target.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase)) {
        $matches += @{ name = $shortcut.BaseName; target = $target }
      }
    }
  }
}
ConvertTo-Json -InputObject @($matches) -Compress
`;

const nativeAdapters: ResolverAdapters = {
  platform: process.platform,
  exists: existsSync,
  appPaths: async (name) => {
    if (/[\\/:*?"<>|]/.test(name)) return [];
    const executableName = name.toLowerCase().endsWith('.exe') ? name : `${name}.exe`;
    const roots = [
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',
      'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',
    ];
    const paths: string[] = [];
    for (const root of roots) {
      try {
        const { stdout } = await execFileAsync('reg.exe', ['query', `${root}\\${executableName}`, '/ve'],
          { windowsHide: true, timeout: 2000, maxBuffer: 8192 });
        const match = stdout.match(/REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/i);
        if (match?.[1]) paths.push(match[1].trim());
      } catch { /* The registry key is optional. */ }
    }
    return paths;
  },
  shortcuts: async (name) => {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', shortcutScript],
      { windowsHide: true, timeout: 5000, maxBuffer: 32768, encoding: 'utf8', env: { ...process.env, JARVIS_RESOLVE_APP: name } });
    const parsed: unknown = JSON.parse(stdout.trim());
    return Array.isArray(parsed) ? parsed.filter((item): item is { name: string; target: string } =>
      typeof item === 'object' && item !== null && typeof item.name === 'string' && typeof item.target === 'string') : [];
  },
  pathCandidates: async (name) => {
    if (/[\\/:*?"<>|]/.test(name)) return [];
    const executableName = name.toLowerCase().endsWith('.exe') ? name : `${name}.exe`;
    return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
      .map((directory) => path.win32.join(directory, executableName));
  },
};
