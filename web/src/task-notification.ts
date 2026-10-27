type TaskNoticeInput = { id: string; status: string; result?: string; message?: string };

export function buildTaskNotice(task: TaskNoticeInput): { title: string; body: string; tag: string } | null {
  const title = task.status === 'COMPLETED' ? '贾维斯 · 任务已完成'
    : task.status === 'FAILED' ? '贾维斯 · 任务执行失败'
      : task.status === 'BLOCKED' ? '贾维斯 · 任务已阻塞' : null;
  if (!title) return null;
  const summary = (task.result || task.message || '点击查看任务详情').replace(/\s+/g, ' ').trim();
  return {
    title,
    body: summary.length > 120 ? `${summary.slice(0, 120)}…` : summary,
    tag: `jarvis-task-${task.id}`,
  };
}

export function sendTaskNotice(
  task: TaskNoticeInput,
  onClick: () => void,
  api: typeof Notification | undefined = globalThis.Notification,
): boolean {
  const notice = buildTaskNotice(task);
  if (!notice || !api || api.permission !== 'granted') return false;
  try {
    const notification = new api(notice.title, { body: notice.body, tag: notice.tag });
    notification.onclick = () => {
      notification.close();
      onClick();
    };
    return true;
  } catch {
    // Some embedded browsers expose Notification but cannot display it.
    return false;
  }
}
