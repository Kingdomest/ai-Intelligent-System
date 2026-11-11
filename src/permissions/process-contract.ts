import path from 'node:path';

export function hasBoundedProcessArgs(args: unknown, launch = false): args is string[] {
  return Array.isArray(args) && args.length <= (launch ? 20 : 100)
    && args.every(item => typeof item === 'string' && item.length <= (launch ? 500 : 16_000))
    && args.reduce<number>((total, item) => total + item.length, 0) <= (launch ? 2_000 : 24_000);
}

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
