import { useEffect, useRef, useState } from 'react';
import { summarizeTestEvents } from './test-summary.js';
import { TestSummaryCard } from './TestSummaryCard.js';
import { ProcessApprovalDetails } from './ProcessApprovalDetails.js';
import { CorrectionStatus, type PublicCorrection } from './CorrectionStatus.js';
import { pollTaskUntilTerminal } from './task-polling.js';
import { isSlideDraft, shouldAttachPreviousPresentation } from './presentation-source.js';
import { Sidebar } from './components/Sidebar.js';
import { MemoryGauge } from './components/MemoryGauge.js';
import { CompactionDivider } from './components/CompactionDivider.js';
import { AnswerSources, sourcesFromTaskEvents } from './AnswerSources.js';
import { compactSession, createSession, fetchLegacyTasks, fetchSession, fetchSessionMessages,
  fetchSessions, fetchSessionLogs, type LegacyTaskSummary, type SessionMessageRow, type SessionSummary } from './session-api.js';
import { shouldSubmitComposerOnEnter } from './composer-keyboard.js';
import { sendTaskNotice } from './task-notification.js';
import { TrajectoryView } from './TrajectoryView.js';
import { SessionLogView } from './SessionLogView.js';
import { AgentActivity } from './AgentActivity.js';
import { sessionSwitchReset } from './session-switch.js';

type EventItem = { type: string; payload: Record<string, unknown>; createdAt?: string };
type PermissionMode = 'request' | 'auto' | 'full';
type PendingPermission = {
  requestId: string;
  risk: 'low' | 'medium' | 'high';
  operation: { permission: string; action: string; target: string; reason: string;
    arguments?: { command?: string; executable?: string; args?: string[]; cwd?: string | null } };
};
type TaskPayload = {
  task: {
    id: string;
    status: string;
    message: string;
    permissionMode: PermissionMode;
    sessionId?: string;
    pendingPermission?: PendingPermission;
    result?: string;
    correction: PublicCorrection;
    metrics: { retryCount: number; generatedCapabilityCount: number; reusedCapabilityCount: number };
    createdAt?: string;
    updatedAt?: string;
  };
  events: EventItem[];
};

const permissionOptions: Array<{ value: PermissionMode; label: string; description: string }> = [
  { value: 'request', label: '请求批准', description: '当前只有只读权限；写入、联网、位置和进程操作会逐项询问。' },
  { value: 'auto', label: '帮我批准', description: '项目目录内低风险新建可自动执行；覆盖、删除、项目外及外部操作会询问。' },
  { value: 'full', label: '完全访问权限', description: '本任务可访问任意本地路径和互联网，也可以启动进程；无需逐项审批。' },
];

const terminalStatuses = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED']);
const failedStatuses = new Set(['FAILED', 'BLOCKED', 'CANCELLED']);
const statusLabels: Record<string, string> = {
  INTAKE: '正在接收任务',
  BUDGET_CHECK: '正在检查上下文预算',
  CONTEXT_COMPACTING: '正在压缩上下文',
  CAPABILITY_ANALYSIS: '正在分析能力缺口',
  CAPABILITY_BUILDING: '正在生成并测试新工具',
  IMPLEMENTING_FILES: '实施智能体正在逐文件生成内容',
  TEST_PLANNING: '测试智能体正在设计用例',
  TESTING_SANDBOX: '正在执行隔离测试',
  TESTING_LIVE: '正在验证本机实际结果',
  TEST_REVIEW: '测试智能体正在判读证据',
  PLAN_READY: '任务计划已准备',
  EXECUTING: '实施智能体正在执行',
  EVALUATING: '评估智能体正在检查结果',
  RETRYING: '正在根据评估结果重试',
  NEEDS_USER_INPUT: '等待你补充信息',
  WAITING_FOR_APPROVAL: '等待你的授权',
  COMPLETED: '任务已完成',
  FAILED: '任务执行失败',
  BLOCKED: '任务已阻塞，关键条件未验证',
  CANCELLED: '任务已取消',
};

const suggestions = [
  '统计上传文件里有多少行数据',
  '查一下深圳现在的天气',
  '最近的人工智能新闻发生了什么？附上来源',
  '帮我写一份 6 页的季度汇报 PPT',
];

const particleValue = (index: number, salt: number): number => {
  const value = Math.sin(index * 127.1 + salt * 311.7) * 43_758.5453;
  return value - Math.floor(value);
};

const techParticles = Array.from({ length: 76 }, (_, index) => {
  const orb = index % 13 === 0;
  return {
    id: index,
    kind: orb ? 'is-orb' : index % 4 === 0 ? 'is-blue' : 'is-fine',
    left: `${8 + particleValue(index, 1) * 90}%`,
    top: `${3 + particleValue(index, 2) * 94}%`,
    size: orb ? 8 + particleValue(index, 3) * 7 : index % 4 === 0
      ? 3 + particleValue(index, 3) * 3 : 1.5 + particleValue(index, 3) * 2,
    duration: `${15 + particleValue(index, 4) * 24}s`,
    delay: `-${particleValue(index, 5) * 38}s`,
  };
});

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [legacyTasks, setLegacyTasks] = useState<LegacyTaskSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<SessionSummary | null>(null);
  const [legacyView, setLegacyView] = useState<string | null>(null);
  const [messages, setMessages] = useState<SessionMessageRow[]>([]);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeView, setActiveView] = useState<'chat' | 'trajectory' | 'logs'>('chat');
  const [logFailureCount, setLogFailureCount] = useState(0);
  const [compacting, setCompacting] = useState(false);
  const [toast, setToast] = useState('');
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => localStorage.getItem('jarvis.notificationsEnabled') === 'true');
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | 'unsupported'>(
    () => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);

  const [input, setInput] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [task, setTask] = useState<TaskPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [supplement, setSupplement] = useState('');
  const [supplementError, setSupplementError] = useState('');
  const [supplementSubmitting, setSupplementSubmitting] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => readPermissionMode());
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [approvalMessage, setApprovalMessage] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [pollGeneration, setPollGeneration] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const permissionMenu = useRef<HTMLDivElement>(null);
  const firstPermissionOption = useRef<HTMLButtonElement>(null);
  const messagesRef = useRef<SessionMessageRow[]>([]);
  const activeSessionIdRef = useRef<string | null>(null);
  const completedTaskId = useRef<string | null>(null);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);
  useEffect(() => {
    if (!activeSessionId || activeView !== 'chat') return;
    const frame = window.requestAnimationFrame(() => composerInput.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [activeSessionId, activeView]);
  const draftProgress = task?.events.filter(event => event.type === 'draft.progress').at(-1)?.payload;

  useEffect(() => {
    let active = true;
    setLogFailureCount(0);
    const scope = activeSessionId ? { sessionId: activeSessionId } : legacyView ? { taskId: legacyView } : null;
    if (!scope) return () => { active = false; };
    void fetchSessionLogs(scope).then(log => {
      if (active) setLogFailureCount(log.summary.errors + log.summary.warnings);
    }).catch(() => {
      // The log view shows the transport error when the user opens it.
    });
    return () => { active = false; };
  }, [activeSessionId, legacyView, task?.task.status]);

  useEffect(() => {
    if (!focusTaskId) return;
    const target = Array.from(document.querySelectorAll<HTMLElement>('.message.assistant[data-task-id]'))
      .find(element => element.dataset.taskId === focusTaskId);
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFocusTaskId(null);
  }, [messages, focusTaskId]);

  useEffect(() => {
    void bootstrap();
  }, []);

  async function bootstrap() {
    const savedTaskId = localStorage.getItem('jarvis.activeTaskId');
    let resumeTask: TaskPayload | null = null;
    if (savedTaskId) {
      try {
        const response = await fetch(`/api/tasks/${savedTaskId}`);
        if (response.ok) {
          resumeTask = await response.json() as TaskPayload;
        } else if (response.status === 404) {
          localStorage.removeItem('jarvis.activeTaskId');
        }
      } catch {
        setConnectionError('暂时无法恢复上次的任务，请检查服务连接。');
      }
    }
    if (resumeTask?.task.sessionId) {
      await openSession(resumeTask.task.sessionId, resumeTask);
    } else if (resumeTask) {
      openLegacyTask(resumeTask.task.id, resumeTask);
    } else {
      const savedSessionId = localStorage.getItem('jarvis.activeSessionId');
      if (savedSessionId) await openSession(savedSessionId);
    }
    await refreshSessionViews();
  }

  async function refreshSessionViews() {
    try {
      const [sessionPage, legacyPage] = await Promise.all([fetchSessions(), fetchLegacyTasks()]);
      setSessions(sessionPage.sessions);
      setLegacyTasks(legacyPage.tasks);
      const current = activeSessionIdRef.current;
      if (current) {
        const fresh = sessionPage.sessions.find(item => item.id === current)
          ?? await fetchSession(current).then(payload => payload.session).catch(() => null);
        if (fresh) setActiveSession(fresh);
      }
    } catch {
      // Sidebar refresh failures surface through the next explicit action.
    }
  }

  async function openSession(sessionId: string, resumeTask?: TaskPayload) {
    const reset = sessionSwitchReset();
    setActiveSessionId(sessionId);
    activeSessionIdRef.current = sessionId;
    setLegacyView(null);
    setTask(reset.task);
    setBusy(reset.busy);
    setSupplement(reset.supplement);
    setSupplementError('');
    setSupplementSubmitting(reset.supplementSubmitting);
    setApprovalMessage('');
    localStorage.setItem('jarvis.activeSessionId', sessionId);
    try {
      const [detail, page] = await Promise.all([fetchSession(sessionId), fetchSessionMessages(sessionId)]);
      setActiveSession(detail.session);
      setMessages(page.messages);
      setHasMoreMessages(page.hasMore);
      setConnectionError('');
      setApprovalMessage('');
      if (resumeTask) {
        adoptTask(resumeTask);
        return;
      }
      const savedTaskId = localStorage.getItem('jarvis.activeTaskId');
      if (savedTaskId) {
        const response = await fetch(`/api/tasks/${savedTaskId}`);
        if (response.ok) {
          const saved = await response.json() as TaskPayload;
          if (saved.task.sessionId === sessionId && !terminalStatuses.has(saved.task.status)) {
            setTask(saved);
            setBusy(true);
            setPollGeneration(current => current + 1);
            return;
          }
        }
      }
      setTask(null);
      setBusy(false);
    } catch {
      setConnectionError('会话加载失败，请检查连接后重试。');
    }
  }

  function adoptTask(payload: TaskPayload) {
    setTask(payload);
    const terminal = terminalStatuses.has(payload.task.status);
    setBusy(!terminal);
    completedTaskId.current = terminal ? payload.task.id : null;
    if (terminal) localStorage.removeItem('jarvis.activeTaskId');
    else localStorage.setItem('jarvis.activeTaskId', payload.task.id);
  }

  function openLegacyTask(taskId: string, payload?: TaskPayload) {
    void (async () => {
      try {
        const detail = payload ?? await loadTask(taskId);
        setActiveSessionId(null);
        activeSessionIdRef.current = null;
        setActiveSession(null);
        setLegacyView(taskId);
        localStorage.removeItem('jarvis.activeSessionId');
        const rows: SessionMessageRow[] = [
          { seq: -2, role: 'user', content: detail.task.message, status: 'final',
            createdAt: detail.task.createdAt ?? new Date().toISOString(), taskId: detail.task.id },
        ];
        if (detail.task.result || terminalStatuses.has(detail.task.status)) {
          rows.push({ seq: -1, role: 'assistant',
            content: detail.task.result ?? statusLabels[detail.task.status] ?? '任务结束',
            status: 'final', createdAt: detail.task.updatedAt ?? new Date().toISOString(), taskId: detail.task.id,
            sources: detail.task.status === 'COMPLETED' ? sourcesFromTaskEvents(detail.events) : [] });
        }
        setMessages(rows);
        setHasMoreMessages(false);
        setApprovalMessage('');
        setTask(terminalStatuses.has(detail.task.status) ? null : detail);
        setBusy(!terminalStatuses.has(detail.task.status));
      } catch {
        setConnectionError('暂时无法打开该历史任务。');
      }
    })();
  }

  async function loadOlderMessages() {
    const sessionId = activeSessionIdRef.current;
    const oldest = messagesRef.current[0];
    if (!sessionId || !oldest || oldest.seq <= 0) return;
    try {
      const page = await fetchSessionMessages(sessionId, oldest.seq);
      setMessages(current => [...page.messages, ...current]);
      setHasMoreMessages(page.hasMore);
    } catch {
      setConnectionError('加载更早消息失败，请检查连接。');
    }
  }

  async function handleCompact() {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId || compacting) return;
    setCompacting(true);
    try {
      const outcome = await compactSession(sessionId);
      if (outcome.compacted) {
        const freed = Math.max(0, Math.round((outcome.freedTokens ?? 0) / 100) / 10);
        setToast(`已压缩历史消息，释放约 ${freed}k tokens 记忆空间。`);
        if (outcome.session) setActiveSession(outcome.session);
      } else if (outcome.reason === 'insufficient-history') {
        setToast('当前会话历史还不多，暂无需压缩。');
      } else {
        setToast('本次未能压缩，请稍后重试。');
      }
      await refreshMessages();
      await refreshSessionViews();
    } catch (error) {
      setToast(error instanceof Error ? error.message : '压缩失败，请稍后重试。');
    } finally {
      setCompacting(false);
      window.setTimeout(() => setToast(''), 4_000);
    }
  }

  function handleRenameActiveSession() {
    const session = activeSession;
    if (!session) return;
    const title = window.prompt('重命名会话', session.title);
    if (title === null || !title.trim() || title.trim() === session.title) return;
    void (async () => {
      try {
        const renamed = await fetch(`/api/sessions/${session.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: title.trim() }),
        }).then(response => response.json() as Promise<{ session: SessionSummary }>);
        setActiveSession(renamed.session);
        await refreshSessionViews();
      } catch {
        setToast('重命名失败，请稍后重试。');
      }
    })();
  }

  useEffect(() => {
    if (!permissionMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !permissionMenu.current?.contains(event.target)) setPermissionMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPermissionMenuOpen(false);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const options = permissionMenu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
        if (!options?.length) return;
        event.preventDefault();
        const current = Array.from(options).indexOf(document.activeElement as HTMLButtonElement);
        const offset = event.key === 'ArrowDown' ? 1 : -1;
        options[(current + offset + options.length) % options.length]?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [permissionMenuOpen]);

  useEffect(() => {
    if (!task || terminalStatuses.has(task.task.status)) return;
    const controller = new AbortController();
    void pollTaskUntilTerminal(
      () => loadTask(task.task.id),
      (snapshot) => terminalStatuses.has(snapshot.task.status),
      applyTaskSnapshot,
      () => { setConnectionError('任务查询连接中断。已暂停自动查询，点击重新连接可继续。'); setBusy(false); },
      controller.signal,
    );
    return () => controller.abort();
  }, [task?.task.id, pollGeneration]);

  async function loadTask(taskId: string): Promise<TaskPayload> {
    const response = await fetch(`/api/tasks/${taskId}`);
    if (!response.ok) throw new Error(`Task query failed with HTTP ${response.status}`);
    return response.json() as Promise<TaskPayload>;
  }

  function applyTaskSnapshot(next: TaskPayload) {
    setTask(next);
    setConnectionError('');
    if (terminalStatuses.has(next.task.status)) {
      if (completedTaskId.current !== next.task.id) {
        completedTaskId.current = next.task.id;
        if (notificationsEnabled) {
          sendTaskNotice(next.task, () => {
            window.focus();
            setFocusTaskId(next.task.id);
            if (next.task.sessionId) void openSession(next.task.sessionId, next);
            else openLegacyTask(next.task.id, next);
          });
        }
      }
      if (next.task.status === 'COMPLETED' && isSlideDraft(next.task.result)) {
        localStorage.setItem('jarvis.lastPresentationTaskId', next.task.id);
      }
      setBusy(false);
      if (localStorage.getItem('jarvis.activeTaskId') === next.task.id) localStorage.removeItem('jarvis.activeTaskId');
      void refreshAfterTerminal(next.task.id);
    }
  }

  async function refreshAfterTerminal(taskId: string) {
    // The session layer records the assistant message right after the loop settles.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await refreshMessages();
      if (messagesRef.current.some(row => row.taskId === taskId && row.role === 'assistant')) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await refreshSessionViews();
  }

  async function refreshMessages() {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    try {
      const page = await fetchSessionMessages(sessionId);
      setMessages(page.messages);
      setHasMoreMessages(page.hasMore);
    } catch {
      // The polling connection banner covers transport failures while busy.
    }
  }

  async function refreshTask(taskId: string) {
    try {
      applyTaskSnapshot(await loadTask(taskId));
    } catch {
      setConnectionError('暂时无法查询任务状态。请重新连接。');
      setBusy(false);
    }
  }

  async function stopTask() {
    if (!task || terminalStatuses.has(task.task.status) || stopping) return;
    const taskId = task.task.id;
    setStopping(true);
    try {
      const response = await fetch(`/api/tasks/${taskId}/cancel`, { method: 'POST' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error ?? '停止任务失败');
      }
      await refreshTask(taskId);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : '停止任务失败，请重试。');
    } finally {
      setStopping(false);
    }
  }

  async function submitTask(event: React.FormEvent) {
    event.preventDefault();
    if (busy || (!input.trim() && files.length === 0)) return;

    const message = input.trim() || '请分析我上传的文件';
    const form = new FormData();
    form.append('message', message);
    files.forEach((file) => form.append('file', file));
    form.append('permissionMode', permissionMode);
    const previousPresentationId = localStorage.getItem('jarvis.lastPresentationTaskId');
    if (previousPresentationId && shouldAttachPreviousPresentation(message, files.length > 0)) {
      form.append('sourceTaskId', previousPresentationId);
    }

    let sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      try {
        const created = await createSession();
        sessionId = created.session.id;
        setActiveSessionId(sessionId);
        activeSessionIdRef.current = sessionId;
        setActiveSession(created.session);
        setLegacyView(null);
        setMessages([]);
        localStorage.setItem('jarvis.activeSessionId', sessionId);
      } catch {
        setConnectionError('创建会话失败，请检查连接后重试。');
        return;
      }
    }
    form.append('sessionId', sessionId);

    setMessages(current => [...current, {
      seq: Date.now(), role: 'user', content: message, status: 'final', createdAt: new Date().toISOString(),
    }]);
    setInput('');
    setFiles([]);
    setApprovalMessage('');
    setBusy(true);

    try {
      const response = await fetch('/api/tasks', { method: 'POST', body: form });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error ?? '任务提交失败');
      }
      const created = await response.json() as { taskId: string };
      localStorage.setItem('jarvis.activeTaskId', created.taskId);
      setLegacyView(null);
      await refreshMessages();
      await refreshSessionViews();
      await refreshTask(created.taskId);
    } catch (error) {
      setBusy(false);
      setMessages(current => [...current, {
        seq: Date.now() + 1, role: 'assistant', status: 'final',
        content: error instanceof Error && error.message !== '任务提交失败' ? error.message : '任务提交失败，请稍后重试。',
        createdAt: new Date().toISOString(),
      }]);
      setConnectionError('任务提交连接失败。请检查服务后重试。');
    }
  }

  async function submitSupplement(event: React.FormEvent) {
    event.preventDefault();
    if (!task || supplementSubmitting) return;
    if (!supplement.trim()) { setSupplementError('请选择一个选项，或输入具体答案。'); return; }
    setSupplementSubmitting(true);
    setSupplementError('');
    try {
      const response = await fetch(`/api/tasks/${task.task.id}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: { answer: supplement.trim() } }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        if (response.status === 422) { setSupplementError(payload.error ?? '请补充更具体的信息。'); return; }
        throw new Error(payload.error ?? '补充信息提交失败');
      }
      setSupplement('');
      setSupplementError('');
      setBusy(true);
      await refreshTask(task.task.id);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : '补充信息提交失败，请检查连接后重试。');
      setBusy(false);
    } finally {
      setSupplementSubmitting(false);
    }
  }

  function selectPermissionMode(mode: PermissionMode) {
    setPermissionMode(mode);
    localStorage.setItem('jarvis.permissionMode', mode);
    setPermissionMenuOpen(false);
  }

  async function toggleNotifications() {
    if (notificationsEnabled && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      setNotificationsEnabled(false);
      localStorage.setItem('jarvis.notificationsEnabled', 'false');
      setToast('已关闭任务系统通知。');
      return;
    }
    if (typeof Notification === 'undefined') {
      setNotificationPermission('unsupported');
      setToast('当前浏览器不支持系统通知，请在 Edge 或 Chrome 中打开贾维斯。');
      return;
    }
    try {
      const permission = Notification.permission === 'default'
        ? await Notification.requestPermission() : Notification.permission;
      setNotificationPermission(permission);
      if (permission !== 'granted') {
        setToast(permission === 'denied' ? '通知已被浏览器拒绝，请在浏览器站点权限中开启。' : '未开启系统通知。');
        return;
      }
      new Notification('贾维斯 · 通知已开启', { body: '任务完成或失败时会在这里提醒你。', tag: 'jarvis-notification-enabled' });
      setNotificationsEnabled(true);
      localStorage.setItem('jarvis.notificationsEnabled', 'true');
      setToast('系统通知已开启；页面保持打开时，任务结束会提醒你。');
    } catch {
      setToast('当前浏览器未能显示系统通知，请检查浏览器及 Windows 通知设置。');
    }
  }

  async function resolvePermission(approved: boolean) {
    const pending = task?.task.pendingPermission;
    if (!task || !pending || approvalSubmitting) return;
    setApprovalSubmitting(true);
    setApprovalMessage('正在提交决定…');
    try {
      const response = await fetch(`/api/tasks/${task.task.id}/approval`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: pending.requestId, approved }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) {
        setApprovalMessage(payload.error ?? '该审批请求已失效，请检查任务状态。');
        await refreshTask(task.task.id);
        return;
      }
      setApprovalMessage(approved ? '已批准这次操作，贾维斯正在继续。' : '已拒绝；该操作不会执行。');
      await refreshTask(task.task.id);
    } catch {
      setApprovalMessage('暂时无法提交决定。可以刷新任务确认当前状态后重试。');
    } finally {
      setApprovalSubmitting(false);
    }
  }

  const testSummary = task ? summarizeTestEvents(task.events) : null;
  const newsSearchStarted = task?.events.some(event => event.type === 'step.started'
    && event.payload.stepId === 'search-news') ?? false;
  const newsSearchDone = task?.events.some(event => event.type === 'step.completed'
    && event.payload.stepId === 'search-news') ?? false;
  const activeSources = task && !terminalStatuses.has(task.task.status)
    ? sourcesFromTaskEvents(task.events) : [];
  const newsApprovalPending = task?.task.status === 'WAITING_FOR_APPROVAL'
    && task.task.pendingPermission?.operation.target.startsWith('https://news.google.com/rss/search?');
  const inputRequest = [...(task?.events ?? [])].reverse().find((event) => event.type === 'task.needs_user_input')?.payload.request as {
    question?: string; options?: Array<{ label: string; value: string; description?: string }>;
  } | undefined;
  const showWelcome = !activeSessionId && !legacyView && messages.length === 0;

  return (
    <main className="app-shell">
      <div className="sky" aria-hidden="true">
        <span className="sky-cloud sky-cloud-a" />
        <span className="sky-cloud sky-cloud-b" />
        <span className="sky-horizon" />
        <span className="sky-tech-glow" />
        <span className="sky-tech-grid" />
        <span className="sky-tech-grain" />
        <span className="sky-tech-orbit sky-tech-orbit-a" />
        <span className="sky-tech-orbit sky-tech-orbit-b" />
        <span className="sky-particles">
          {techParticles.map(particle => <span key={particle.id} className={`sky-particle ${particle.kind}`}
            style={{ left: particle.left, top: particle.top, width: particle.size, height: particle.size,
              animationDuration: particle.duration, animationDelay: particle.delay }} />)}
        </span>
      </div>
      <Sidebar
        sessions={sessions}
        legacyTasks={legacyTasks}
        activeSessionId={activeSessionId}
        activeTaskSessionId={task && !terminalStatuses.has(task.task.status) ? task.task.sessionId ?? null : null}
        open={legacyView}
        onOpenSession={(sessionId) => void openSession(sessionId)}
        onOpenLegacyTask={(taskId) => openLegacyTask(taskId)}
        onChanged={() => refreshSessionViews()}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(current => !current)}
      />
      <section className={`chat-surface ${messages.length || !showWelcome ? 'has-messages' : 'is-empty'}`} aria-label="Jarvis chat">
        <header className="app-header">
          <div className="header-title">
            {activeSession ? (
              <button type="button" className="session-title-edit" onClick={handleRenameActiveSession}
                title="点击重命名会话">
                <strong>{activeSession.title}</strong>
                <span aria-hidden="true">✎</span>
              </button>
            ) : legacyView ? (
              <strong className="session-title-edit is-static">历史任务</strong>
            ) : (
              <div className="brand-lockup">
                <span className="brand-mark" aria-hidden="true">J</span>
                <span className="brand-name">贾维斯 <small>JARVIS</small></span>
              </div>
            )}
            <span className="header-note">多智能体工作台</span>
          </div>
          <div className="header-actions">
            <button type="button" className={`logs-toggle ${activeView === 'logs' ? 'is-active' : ''}`}
              aria-pressed={activeView === 'logs'} aria-label="打开智能体日志"
              title={activeSessionId || legacyView ? '查看智能体错误、警告和调用上下文' : '创建或打开会话后查看日志'}
              disabled={!activeSessionId && !legacyView}
              onClick={() => setActiveView(current => current === 'logs' ? 'chat' : 'logs')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 4.5h14v15H5z" /><path d="M8.5 8h7M8.5 12h7M8.5 16h4" />
              </svg>
              <span>日志</span>
              {logFailureCount > 0 ? <b className="logs-badge" aria-label={`${logFailureCount} 条异常`}>{logFailureCount > 99 ? '99+' : logFailureCount}</b> : null}
            </button>
            <button type="button" className={`trajectory-toggle ${activeView === 'trajectory' ? 'is-active' : ''}`}
              aria-pressed={activeView === 'trajectory'} onClick={() => setActiveView(current => current === 'trajectory' ? 'chat' : 'trajectory')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 18h16M5 14l4-4 3 2 6-7 2 2" /><circle cx="5" cy="14" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="18" cy="5" r="1" /></svg>
              {activeView === 'trajectory' ? '返回聊天' : '轨迹'}
            </button>
            {activeSession ? (
              <MemoryGauge
                used={activeSession.memoryTokens}
                budget={activeSession.memoryBudget}
                compacting={compacting}
                onCompact={() => void handleCompact()}
                disabled={busy}
              />
            ) : null}
            <button type="button" className={`notification-button ${notificationsEnabled && notificationPermission === 'granted' ? 'is-on' : ''}`}
              aria-pressed={notificationsEnabled && notificationPermission === 'granted'}
              aria-label={notificationsEnabled && notificationPermission === 'granted' ? '关闭任务系统通知' : '开启任务系统通知'}
              title={notificationPermission === 'unsupported' ? '当前浏览器不支持系统通知' : notificationPermission === 'denied'
                ? '浏览器已拒绝通知，请在站点权限中开启' : '页面打开时提醒任务完成、失败或阻塞'}
              onClick={() => void toggleNotifications()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
              </svg>
              <span>{notificationPermission === 'unsupported' ? '通知需 Edge/Chrome'
                : notificationsEnabled && notificationPermission === 'granted' ? '通知已开启' : '开启通知'}</span>
            </button>
          </div>
        </header>

        {activeView === 'trajectory' ? (
          <TrajectoryView sessionId={activeSessionId} taskId={legacyView} />
        ) : activeView === 'logs' ? (
          <SessionLogView sessionId={activeSessionId} taskId={legacyView} sessions={sessions}
            onSelectSession={(sessionId) => void openSession(sessionId)} />
        ) : showWelcome ? (
          <div className="empty-state">
            <div className="orb" aria-hidden="true">J</div>
            <span className="eyebrow">你的智能工作空间</span>
            <h1>有什么需要我帮你完成？</h1>
            <p>描述目标，贾维斯会协调智能体完成任务。左侧选择会话可以继续之前的对话。</p>
            <div className="suggestion-chips">
              {suggestions.map(suggestion => (
                <button key={suggestion} type="button" onClick={() => setInput(suggestion)}>{suggestion}</button>
              ))}
            </div>
          </div>
        ) : (
          <div className="message-list" aria-live="polite">
            {hasMoreMessages ? (
              <button type="button" className="load-older" onClick={() => void loadOlderMessages()}>加载更早消息</button>
            ) : null}
            {messages.map(row => row.role === 'compaction' ? (
              <CompactionDivider key={`compaction-${row.seq}`} content={row.content} createdAt={row.createdAt} />
            ) : (
              <article className={`message ${row.role}`} key={row.seq} data-task-id={row.taskId}>
                <div className={`message-bubble ${row.taskStatus && failedStatuses.has(row.taskStatus) ? 'is-failed' : ''}`}>
                  {row.role === 'assistant' && row.sources?.length ? <AnswerSources sources={row.sources} /> : null}
                  <div className="message-text">{row.content}</div>
                </div>
              </article>
            ))}
            {task && !terminalStatuses.has(task.task.status) && !connectionError ? (
              <article className="agent-status">
                <span className="status-dot" />
                <div>
                  <strong>{newsApprovalPending ? '等待授权联网搜索'
                    : newsSearchStarted ? newsSearchDone ? '正在根据搜索结果核对回答' : '正在搜索网页'
                      : statusLabels[task.task.status] ?? task.task.status}</strong>
                  {typeof draftProgress?.completed === 'number' && typeof draftProgress.total === 'number'
                    ? <small>长篇文案已生成 {draftProgress.completed}/{draftProgress.total} 段，正在继续校验</small>
                    : null}
                  <AgentActivity events={task.events} />
                  {activeSources.length > 0 ? <AnswerSources sources={activeSources} /> : null}
                </div>
              </article>
            ) : null}
            {task?.task.correction ? <CorrectionStatus correction={task.task.correction} /> : null}
            {task && testSummary ? <TestSummaryCard summary={testSummary} /> : null}
            {task?.task.status === 'WAITING_FOR_APPROVAL' && task.task.pendingPermission ? (
              <section className="approval-card" aria-labelledby="approval-title" aria-live="polite">
                <div className="approval-heading">
                  <span className="approval-icon" aria-hidden="true">⚑</span>
                  <div>
                    <strong id="approval-title">需要你批准一项操作</strong>
                    <small>{permissionLabel(task.task.pendingPermission.operation.permission)} · 风险：{riskLabel(task.task.pendingPermission.risk)}</small>
                  </div>
                </div>
                <dl className="approval-details">
                  <div><dt>操作</dt><dd>{actionLabel(task.task.pendingPermission.operation.action)}</dd></div>
                  <div><dt>目标</dt><dd className="approval-target">{task.task.pendingPermission.operation.target}</dd></div>
                  {task.task.pendingPermission.operation.permission === 'process' ? (
                    <ProcessApprovalDetails
                      command={task.task.pendingPermission.operation.arguments?.executable
                        ?? task.task.pendingPermission.operation.arguments?.command ?? task.task.pendingPermission.operation.target}
                      args={task.task.pendingPermission.operation.arguments?.args ?? []}
                      cwd={task.task.pendingPermission.operation.arguments?.cwd}
                      launch={task.task.pendingPermission.operation.action === 'launch'}
                    />
                  ) : null}
                  <div><dt>原因</dt><dd>{task.task.pendingPermission.operation.reason}</dd></div>
                </dl>
                <div className="approval-actions">
                  <button type="button" className="approval-deny" disabled={approvalSubmitting} onClick={() => void resolvePermission(false)}>拒绝</button>
                  <button type="button" className="approval-allow" disabled={approvalSubmitting} onClick={() => void resolvePermission(true)}>允许这次</button>
                </div>
                {approvalMessage ? <p className="approval-feedback" role="status">{approvalMessage}</p> : null}
              </section>
            ) : null}
          </div>
        )}

        {toast ? <div className="toast" role="status">{toast}</div> : null}

        {connectionError ? (
          <div className="connection-warning" role="alert">
            <span>{connectionError}</span>
            <button type="button" onClick={() => {
              setConnectionError('');
              if (task && !terminalStatuses.has(task.task.status)) {
                setBusy(true);
                setPollGeneration((current) => current + 1);
              } else {
                void bootstrap();
              }
            }}>重新连接</button>
          </div>
        ) : null}

        {activeView === 'chat' && task?.task.status === 'NEEDS_USER_INPUT' ? (
          <form className="follow-up-card" onSubmit={submitSupplement}>
            <strong>{inputRequest?.question ?? '请补充执行任务所需的信息'}</strong>
            {inputRequest?.options?.length ? (
              <div className="input-candidates" aria-label="可选答案">
                {inputRequest.options.map((option) => (
                  <button type="button" key={option.value} className={supplement === option.value ? 'selected' : ''}
                    aria-pressed={supplement === option.value} disabled={supplementSubmitting}
                    onClick={() => { setSupplement(option.value); setSupplementError(''); }}>
                    <span>{option.label}</span>{option.description ? <small>{option.description}</small> : null}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="follow-up-row">
              <input value={supplement} onChange={(event) => { setSupplement(event.target.value); setSupplementError(''); }}
                placeholder="也可以直接输入你的答案" disabled={supplementSubmitting} aria-invalid={Boolean(supplementError)} />
              <button type="submit" className="send-button" disabled={supplementSubmitting}>{supplementSubmitting ? '正在继续…' : '发送'}</button>
            </div>
            {supplementError ? <p className="follow-up-error" role="alert">{supplementError}</p> : null}
          </form>
        ) : null}

        {activeView === 'chat' ? <form className="composer" onSubmit={submitTask}>
          {files.length ? <div className="file-chips">{files.map((file) => <span key={file.name}>{file.name}<button type="button" aria-label={`移除 ${file.name}`} onClick={() => setFiles((current) => current.filter((item) => item !== file))}>×</button></span>)}</div> : null}
          <textarea
            ref={composerInput}
            aria-label="消息"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (!shouldSubmitComposerOnEnter({
                key: event.key,
                shiftKey: event.shiftKey,
                ctrlKey: event.ctrlKey,
                altKey: event.altKey,
                metaKey: event.metaKey,
                isComposing: event.nativeEvent.isComposing,
                keyCode: event.nativeEvent.keyCode,
              })) return;
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
            placeholder="输入你的需求"
            rows={3}
            disabled={busy}
          />
          <div className="composer-actions">
            <input ref={fileInput} className="visually-hidden" type="file" multiple accept=".txt,.md,.json,.csv,text/plain,text/markdown,application/json,text/csv" onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
            <button type="button" className="secondary-button" onClick={() => fileInput.current?.click()} disabled={busy}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m20 11.5-7.9 7.9a5 5 0 0 1-7.1-7.1l8.6-8.6a3.5 3.5 0 0 1 5 5L9.7 17.6a2 2 0 0 1-2.8-2.8l7.5-7.5" /></svg>
              添加文件
            </button>
            <div className="permission-menu-wrap" ref={permissionMenu}>
              <button
                type="button"
                className={`permission-button permission-${permissionMode}`}
                aria-haspopup="menu"
                aria-expanded={permissionMenuOpen}
                aria-label={`权限设置：${permissionOptions.find((option) => option.value === permissionMode)?.label}`}
                onClick={() => setPermissionMenuOpen((open) => !open)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' && !permissionMenuOpen) {
                    event.preventDefault();
                    setPermissionMenuOpen(true);
                    window.setTimeout(() => firstPermissionOption.current?.focus(), 0);
                  }
                }}
                disabled={busy}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3 4.5 6v5.4c0 4.4 2.6 7.8 7.5 9.6 4.9-1.8 7.5-5.2 7.5-9.6V6L12 3Z" /><path d="m9.5 11.9 1.7 1.7 3.5-3.7" /></svg>
                {permissionOptions.find((option) => option.value === permissionMode)?.label}
                <span className="permission-caret" aria-hidden="true">⌄</span>
              </button>
              {permissionMenuOpen ? (
                <div className="permission-menu" role="menu" aria-label="选择任务权限">
                  {permissionOptions.map((option, index) => (
                    <button
                      key={option.value}
                      ref={index === 0 ? firstPermissionOption : undefined}
                      type="button"
                      role="menuitemradio"
                      aria-checked={permissionMode === option.value}
                      className={`permission-option ${permissionMode === option.value ? 'selected' : ''}`}
                      onClick={() => selectPermissionMode(option.value)}
                    >
                      <span className="permission-option-top"><strong>{option.label}</strong>{permissionMode === option.value ? <span aria-hidden="true">✓</span> : null}</span>
                      <span>{option.description}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {task && !terminalStatuses.has(task.task.status) ? (
              <button type="button" className="stop-button" aria-label="停止当前任务" disabled={stopping}
                onClick={() => void stopTask()}>{stopping ? '正在停止…' : '停止'}</button>
            ) : null}
            <button type="submit" className="send-button" aria-label="发送" disabled={busy}>{busy ? '…' : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-5 5 5-5 5 5" /></svg>}</button>
          </div>
        </form> : null}
      </section>
    </main>
  );
}

function readPermissionMode(): PermissionMode {
  const saved = localStorage.getItem('jarvis.permissionMode');
  return saved === 'auto' || saved === 'full' || saved === 'request' ? saved : 'request';
}

function permissionLabel(permission: string): string {
  return ({
    'filesystem.read': '读取文件', 'filesystem.write': '写入文件', network: '网络访问',
    process: '启动进程', location: '获取位置',
  } as Record<string, string>)[permission] ?? permission;
}

function actionLabel(action: string): string {
  return ({ mkdir: '创建目录', create_directory: '创建目录', writeText: '写入文件', write_text: '写入文件',
    readText: '读取文件', read_text: '读取文件', remove: '删除文件', request: '发送网络请求', run: '执行短命令', launch: '启动应用', current: '获取设备位置' } as Record<string, string>)[action] ?? action;
}

function riskLabel(risk: PendingPermission['risk']): string {
  return ({ low: '低', medium: '中', high: '高' })[risk];
}
