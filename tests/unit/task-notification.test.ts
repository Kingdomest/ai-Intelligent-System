import { describe, expect, it, vi } from 'vitest';
import { buildTaskNotice, sendTaskNotice } from '../../web/src/task-notification.js';

describe('task completion notifications', () => {
  it('summarizes success without exposing the full task response', () => {
    expect(buildTaskNotice({ id: '1', status: 'COMPLETED', result: `完成\n${'内容'.repeat(120)}` })).toEqual({
      title: '贾维斯 · 任务已完成',
      body: expect.stringMatching(/^完成 内容.{0,}/),
      tag: 'jarvis-task-1',
    });
    expect(buildTaskNotice({ id: '1', status: 'COMPLETED', result: '长'.repeat(200) })?.body.length).toBeLessThanOrEqual(121);
  });

  it('distinguishes failed and blocked tasks, and ignores nonterminal states', () => {
    expect(buildTaskNotice({ id: '2', status: 'FAILED', result: '模型超时' })?.title).toBe('贾维斯 · 任务执行失败');
    expect(buildTaskNotice({ id: '3', status: 'BLOCKED', result: '需要授权' })?.title).toBe('贾维斯 · 任务已阻塞');
    expect(buildTaskNotice({ id: '4', status: 'EXECUTING' })).toBeNull();
  });

  it('only creates an OS notification after permission and returns to the task on click', () => {
    const created: Array<{ title: string; options: NotificationOptions; onclick: (() => void) | null; close: ReturnType<typeof vi.fn> }> = [];
    class FakeNotification {
      static permission: NotificationPermission = 'default';
      onclick: (() => void) | null = null;
      close = vi.fn();
      constructor(public title: string, public options: NotificationOptions) {
        created.push(this);
      }
    }
    const open = vi.fn();
    const task = { id: '5', status: 'COMPLETED', result: '完成' };
    expect(sendTaskNotice(task, open, FakeNotification as unknown as typeof Notification)).toBe(false);
    expect(created).toHaveLength(0);
    FakeNotification.permission = 'granted';
    expect(sendTaskNotice(task, open, FakeNotification as unknown as typeof Notification)).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]?.options.tag).toBe('jarvis-task-5');
    created[0]?.onclick?.();
    expect(open).toHaveBeenCalledOnce();
    expect(created[0]?.close).toHaveBeenCalledOnce();
  });
});
