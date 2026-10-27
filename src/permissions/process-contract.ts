import path from 'node:path';

export function isShellGuiLaunch(command: string, args: string[]): boolean {
  const executable = path.win32.basename(command).toLowerCase();
  if (executable === 'cmd.exe' || executable === 'cmd') {
    const verb = args[0]?.toLowerCase();
    return (verb === '/c' || verb === '/k') && /^\s*start(?:\s|$)/i.test(args.slice(1).join(' '));
  }
  if (['powershell.exe', 'powershell', 'pwsh.exe', 'pwsh'].includes(executable)) {
    return /\bStart-Process\b/i.test(args.join(' '));
  }
  return false;
}
