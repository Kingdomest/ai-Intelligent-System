import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProcessApprovalDetails } from '../../web/src/ProcessApprovalDetails.js';

describe('process approval details', () => {
  it('shows the resolved executable rather than a shell command for app launch', () => {
    const html = renderToStaticMarkup(createElement(ProcessApprovalDetails, {
      command: 'C:\\Apps\\BaiduNetdisk.exe', args: ['--foreground'], cwd: 'D:/project', launch: true,
    }));
    expect(html).toContain('应用程序');
    expect(html).toContain('BaiduNetdisk.exe');
    expect(html).toContain('--foreground');
  });

  it('shows command arguments and working directory before an approval decision', () => {
    const html = renderToStaticMarkup(createElement(ProcessApprovalDetails, {
      command: 'cmd.exe', args: ['/c', 'start', 'cloudmusic'], cwd: 'D:/project',
    }));
    expect(html).toContain('cmd.exe');
    expect(html).toContain('/c');
    expect(html).toContain('cloudmusic');
    expect(html).toContain('D:/project');
  });
});
