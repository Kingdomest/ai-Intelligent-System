import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from '../../web/src/App.js';

afterEach(() => vi.unstubAllGlobals());

describe('Jarvis chat layout', () => {
  it('keeps the product identity and primary composer visible on the welcome screen', () => {
    vi.stubGlobal('localStorage', { getItem: () => null });

    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).toMatch(/<header[^>]*class="app-header"/);
    expect(markup).toContain('贾维斯');
    expect(markup).toContain('aria-label="消息"');
    expect(markup).toContain('权限设置：请求批准');
    expect(markup).toContain('aria-label="打开智能体日志"');
  });
});
