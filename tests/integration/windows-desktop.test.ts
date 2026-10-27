import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WindowsDesktopObserver } from '../../src/runtime/windows-desktop-observer.js';

const enabled = process.platform === 'win32' && process.env.JARVIS_DESKTOP_INTEGRATION === '1';

describe.skipIf(!enabled)('controlled Windows desktop integration', () => {
  it('observes a dedicated test process, visible window, and foreground window', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-desktop-'));
    const executable = join(directory, 'JarvisDesktopProbe.exe');
    const compile = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public static class Program {
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
  [STAThread] public static void Main() {
    Application.EnableVisualStyles();
    using (var form = new Form()) {
      form.Text = "Jarvis controlled desktop probe";
      form.Width = 320; form.Height = 120;
      form.Shown += (sender, args) => { form.Activate(); SetForegroundWindow(form.Handle); };
      Application.Run(form);
    }
  }
}
'@ -ReferencedAssemblies 'System.Windows.Forms' -OutputAssembly $env:JARVIS_TEST_OUTPUT -OutputType WindowsApplication
`;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', compile], {
        timeout: 15_000, windowsHide: true, env: { ...process.env, JARVIS_TEST_OUTPUT: executable },
      });
      child = spawn(executable, [], { windowsHide: false, stdio: 'ignore' });
      const observer = new WindowsDesktopObserver();
      let result = await observer.observe('JarvisDesktopProbe', true);
      for (let attempt = 0; attempt < 20 && result.status !== 'passed'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        result = await observer.observe('JarvisDesktopProbe', true);
      }
      expect(result).toEqual({ status: 'passed', codes: [] });
    } finally {
      if (child && child.exitCode === null && !child.killed) {
        child.kill();
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 2_000);
          child!.once('exit', () => { clearTimeout(timeout); resolve(undefined); });
        });
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
