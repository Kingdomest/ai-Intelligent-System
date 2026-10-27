import { describe, expect, it } from 'vitest';
import { isSlideDraft, shouldAttachPreviousPresentation } from '../../web/src/presentation-source.js';

describe('presentation source linkage', () => {
  it('recognizes a completed slide draft', () => {
    expect(isSlideDraft('**第1页｜封面** - 核心内容：测试')).toBe(true);
    expect(isSlideDraft('任务未完成：评估不可用')).toBe(false);
  });

  it('links only an explicit follow-up that has no new source content', () => {
    expect(shouldAttachPreviousPresentation('把刚才这份PPT生成文件放桌面', false)).toBe(true);
    expect(shouldAttachPreviousPresentation('生成一份关于测试的PPT', false)).toBe(false);
    expect(shouldAttachPreviousPresentation('这份PPT第1页｜新内容', false)).toBe(false);
    expect(shouldAttachPreviousPresentation('把刚才这份PPT生成文件', true)).toBe(false);
  });
});
