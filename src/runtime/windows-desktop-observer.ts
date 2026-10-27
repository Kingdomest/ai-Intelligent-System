import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

export type DesktopSnapshot = { running: boolean; visible: boolean; foreground: boolean };
export type DesktopObservation = { status: 'passed' | 'failed' | 'blocked'; codes: string[] };
export type DesktopProbe = (applicationId: string) => Promise<DesktopSnapshot | null>;

const execFileAsync = promisify(execFile);

// This is a fixed read-only probe. The application identifier is passed as environment data, never interpolated into code.
const observationScript = `
$ErrorActionPreference = 'Stop'
if (-not [Environment]::UserInteractive) { throw 'NO_INTERACTIVE_DESKTOP' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JarvisWindowProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
}
'@
$items = @(Get-Process -Name $env:JARVIS_OBSERVE_APP -ErrorAction SilentlyContinue)
$visible = @($items | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and [JarvisWindowProbe]::IsWindowVisible($_.MainWindowHandle) })
$front = [JarvisWindowProbe]::GetForegroundWindow()
@{ running = ($items.Count -gt 0); visible = ($visible.Count -gt 0); foreground = (@($visible | Where-Object { $_.MainWindowHandle -eq $front }).Count -gt 0) } | ConvertTo-Json -Compress
`;

async function nativeProbe(applicationId: string): Promise<DesktopSnapshot | null> {
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', observationScript], {
      windowsHide: true, timeout: 5_000, maxBuffer: 8_192,
      env: { ...process.env, JARVIS_OBSERVE_APP: applicationId.replace(/\.exe$/i, '') },
    });
    const value: unknown = JSON.parse(stdout.trim());
    if (!value || typeof value !== 'object') return null;
    const snapshot = value as Record<string, unknown>;
    if (typeof snapshot.running !== 'boolean' || typeof snapshot.visible !== 'boolean' || typeof snapshot.foreground !== 'boolean') return null;
    return snapshot as DesktopSnapshot;
  } catch {
    return null;
  }
}

export class WindowsDesktopObserver {
  constructor(
    private readonly probe: DesktopProbe = nativeProbe,
    private readonly platform = process.platform,
    private readonly maxWaitMs = 8_000,
    private readonly pollIntervalMs = 250,
  ) {}

  async observe(applicationId: string, authorized: boolean): Promise<DesktopObservation> {
    if (!authorized) return { status: 'blocked', codes: ['PROCESS_PERMISSION_NOT_GRANTED'] };
    if (this.platform !== 'win32') return { status: 'blocked', codes: ['WINDOWS_DESKTOP_UNAVAILABLE'] };
    if (!/^[\p{L}\p{N}_ .()+-]{1,120}$/u.test(applicationId)
      || /^(cmd|powershell|pwsh|conhost|explorer)(\.exe)?$/i.test(applicationId)) {
      return { status: 'blocked', codes: ['AMBIGUOUS_APPLICATION_ID'] };
    }
    const deadline = Date.now() + Math.max(0, this.maxWaitMs);
    for (;;) {
      const snapshot = await this.probe(applicationId);
      if (!snapshot) return { status: 'blocked', codes: ['DESKTOP_OBSERVATION_UNAVAILABLE'] };
      const codes = !snapshot.running ? ['PROCESS_NOT_RUNNING']
        : !snapshot.visible ? ['WINDOW_NOT_VISIBLE']
          : !snapshot.foreground ? ['NOT_FOREGROUND'] : [];
      if (codes.length === 0) return { status: 'passed', codes: [] };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: 'failed', codes };
      await delay(Math.min(Math.max(1, this.pollIntervalMs), remaining));
    }
  }
}
