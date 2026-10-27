import { describe, expect, it } from 'vitest';
import { WindowsDesktopObserver } from '../../src/runtime/windows-desktop-observer.js';

describe('Windows desktop observer', () => {
  it.each([
    [{ running: false, visible: false, foreground: false }, 'PROCESS_NOT_RUNNING'],
    [{ running: true, visible: false, foreground: false }, 'WINDOW_NOT_VISIBLE'],
    [{ running: true, visible: true, foreground: false }, 'NOT_FOREGROUND'],
  ] as const)('reports an unmet desktop condition', async (snapshot, code) => {
    const observer = new WindowsDesktopObserver(async () => snapshot, 'win32', 0);
    const result = await observer.observe('cloudmusic', true);
    expect(result.status).toBe('failed');
    expect(result.codes).toContain(code);
  });

  it('passes only when process, visible window and foreground all match', async () => {
    const observer = new WindowsDesktopObserver(async () => ({ running: true, visible: true, foreground: true }), 'win32');
    expect(await observer.observe('cloudmusic', true)).toMatchObject({ status: 'passed', codes: [] });
  });

  it('accepts a Unicode executable basename as an exact application identity', async () => {
    const observer = new WindowsDesktopObserver(async () => ({ running: true, visible: true, foreground: true }), 'win32');
    expect((await observer.observe('网易云音乐', true)).status).toBe('passed');
    expect((await observer.observe('Baidu Netdisk', true)).status).toBe('passed');
  });

  it('waits for a newly launched GUI window to become visible and foreground', async () => {
    const snapshots = [
      { running: true, visible: false, foreground: false },
      { running: true, visible: true, foreground: false },
      { running: true, visible: true, foreground: true },
    ];
    let probes = 0;
    const observer = new WindowsDesktopObserver(async () => snapshots[probes++]!, 'win32', 100, 1);
    expect(await observer.observe('cloudmusic', true)).toMatchObject({ status: 'passed', codes: [] });
    expect(probes).toBe(3);
  });

  it('blocks unsupported environments, missing approval and ambiguous identity', async () => {
    const observer = new WindowsDesktopObserver(async () => ({ running: true, visible: true, foreground: true }), 'win32');
    expect((await observer.observe('cloudmusic', false)).status).toBe('blocked');
    expect((await observer.observe('cmd.exe /c dangerous', true)).status).toBe('blocked');
    expect((await new WindowsDesktopObserver(async () => null, 'linux').observe('cloudmusic', true)).status).toBe('blocked');
  });
});
