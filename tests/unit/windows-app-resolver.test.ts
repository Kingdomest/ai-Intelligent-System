import { describe, expect, it } from 'vitest';
import { resolveWindowsApplication } from '../../src/runtime/windows-app-resolver.js';

describe('Windows app resolver', () => {
  const defaults = {
    platform: 'win32', exists: (_path: string) => true,
    appPaths: async (_name: string) => [] as string[], shortcuts: async (_name: string) => [] as Array<{ name: string; target: string }>,
    pathCandidates: async (_name: string) => [] as string[],
  };

  it('resolves two application names through the same adapter interface', async () => {
    const adapter = { ...defaults, appPaths: async (name: string) => name === '网易云音乐'
      ? ['C:\\Apps\\cloudmusic.exe'] : name === '百度网盘' ? ['C:\\Apps\\BaiduNetdisk.exe'] : [] };
    expect(await resolveWindowsApplication('网易云音乐', adapter)).toEqual({
      status: 'resolved', executable: 'C:\\Apps\\cloudmusic.exe', processName: 'cloudmusic',
    });
    expect(await resolveWindowsApplication('百度网盘', adapter)).toEqual({
      status: 'resolved', executable: 'C:\\Apps\\BaiduNetdisk.exe', processName: 'BaiduNetdisk',
    });
  });

  it('asks for a choice when the name matches multiple different executables', async () => {
    const adapter = { ...defaults, shortcuts: async () => [
      { name: '音乐 A', target: 'C:\\Apps\\music-a.exe' },
      { name: '音乐 B', target: 'D:\\Apps\\music-b.exe' },
    ] };
    expect((await resolveWindowsApplication('音乐', adapter)).status).toBe('needs_user_input');
  });

  it('prefers an exact application shortcut and ignores uninstall and repair shortcuts', async () => {
    const adapter = { ...defaults, appPaths: async () => ['C:\\Apps\\UnInstall.exe'], shortcuts: async () => [
      { name: '卸载网易云音乐', target: 'C:\\Apps\\UnInstall.exe' },
      { name: '网易云音乐', target: 'C:\\Apps\\cloudmusic.exe' },
      { name: '修复网易云音乐', target: 'C:\\Apps\\Repair.exe' },
    ] };
    expect(await resolveWindowsApplication('网易云音乐', adapter)).toEqual({
      status: 'resolved', executable: 'C:\\Apps\\cloudmusic.exe', processName: 'cloudmusic',
    });
  });

  it('does not treat a management shortcut with a suffix label as the application', async () => {
    const adapter = { ...defaults, shortcuts: async () => [
      { name: '网易云音乐卸载', target: 'C:\\Apps\\UnInstall.exe' },
    ] };
    expect((await resolveWindowsApplication('网易云音乐', adapter)).status).toBe('needs_user_input');
  });

  it('blocks unsupported platforms and asks for a path when nothing matches', async () => {
    expect((await resolveWindowsApplication('音乐', { ...defaults, platform: 'linux' })).status).toBe('blocked');
    expect((await resolveWindowsApplication('音乐', defaults)).status).toBe('needs_user_input');
  });
});
