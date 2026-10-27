import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createSession, deleteSession, renameSession, setSessionPinned,
  type LegacyTaskSummary, type SessionSummary } from '../session-api.js';

const RUNNING_STATUSES = new Set(['INTAKE', 'BUDGET_CHECK', 'CONTEXT_COMPACTING', 'CONTEXT_READY',
  'CAPABILITY_ANALYSIS', 'CAPABILITY_BUILDING', 'TEST_PLANNING', 'TESTING_SANDBOX', 'TESTING_LIVE',
  'TEST_REVIEW', 'PLAN_READY', 'EXECUTING', 'EVALUATING', 'RETRYING']);

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 172_800_000) return '昨天';
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function memoryRatio(session: SessionSummary): number {
  return session.memoryBudget > 0 ? Math.min(1, session.memoryTokens / session.memoryBudget) : 0;
}

type GroupKey = 'pinned' | 'today' | 'week' | 'earlier';

const groupLabels: Record<GroupKey, string> = { pinned: '置顶', today: '今天', week: '近 7 天', earlier: '更早' };

function groupOf(session: SessionSummary): GroupKey {
  const age = Date.now() - new Date(session.updatedAt).getTime();
  if (age < 86_400_000) return 'today';
  if (age < 7 * 86_400_000) return 'week';
  return 'earlier';
}

export function Sidebar({ sessions, legacyTasks, activeSessionId, activeTaskSessionId, open,
  onOpenSession, onOpenLegacyTask, onChanged, collapsed, onToggle }: {
  sessions: SessionSummary[];
  legacyTasks: LegacyTaskSummary[];
  activeSessionId: string | null;
  activeTaskSessionId: string | null;
  open: string | null;
  onOpenSession: (sessionId: string) => void;
  onOpenLegacyTask: (taskId: string) => void;
  onChanged: () => void | Promise<void>;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [pinningId, setPinningId] = useState<string | null>(null);
  const [pinError, setPinError] = useState('');
  const [menuSessionId, setMenuSessionId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  const menuSession = sessions.find(session => session.id === menuSessionId);

  useEffect(() => {
    if (!menuSessionId) return;
    const close = () => setMenuSessionId(null);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !menuTriggerRef.current?.contains(target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
        menuTriggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menuSessionId]);

  function toggleMenu(sessionId: string, trigger: HTMLButtonElement) {
    if (menuSessionId === sessionId) {
      setMenuSessionId(null);
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const width = 164;
    const height = 132;
    setMenuPosition({
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
      top: rect.bottom + height + 8 <= window.innerHeight ? rect.bottom + 5 : Math.max(8, rect.top - height - 5),
    });
    menuTriggerRef.current = trigger;
    setMenuSessionId(sessionId);
  }

  const groups = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    const visible = sessions.filter(session => !keyword
      || session.title.toLowerCase().includes(keyword)
      || (session.preview ?? '').toLowerCase().includes(keyword));
    const grouped: Record<GroupKey, SessionSummary[]> = { pinned: [], today: [], week: [], earlier: [] };
    for (const session of visible) grouped[session.pinnedAt ? 'pinned' : groupOf(session)].push(session);
    return grouped;
  }, [sessions, search]);

  const matchedLegacy = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (keyword) return [];
    return legacyTasks.slice(0, 8);
  }, [legacyTasks, search]);

  async function handleNewSession() {
    if (creating) return;
    setCreating(true);
    try {
      const created = await createSession();
      onChanged();
      onOpenSession(created.session.id);
    } finally {
      setCreating(false);
    }
  }

  async function handleRename(session: SessionSummary) {
    setMenuSessionId(null);
    const title = window.prompt('重命名会话', session.title);
    if (title === null || !title.trim() || title.trim() === session.title) return;
    await renameSession(session.id, title.trim());
    onChanged();
  }

  async function handleDelete(session: SessionSummary) {
    setMenuSessionId(null);
    if (!window.confirm(`删除会话「${session.title}」？\n聊天记录将被删除，任务与产物文件会保留。`)) return;
    await deleteSession(session.id);
    onChanged();
  }

  async function handlePin(session: SessionSummary) {
    if (pinningId) return;
    setMenuSessionId(null);
    setPinningId(session.id);
    setPinError('');
    try {
      await setSessionPinned(session.id, !session.pinnedAt);
      await onChanged();
    } catch (error) {
      setPinError(error instanceof Error ? error.message : '更新置顶状态失败');
    } finally {
      setPinningId(null);
    }
  }

  return (
    <aside className={`sidebar ${collapsed ? 'is-collapsed' : ''}`} aria-label="会话列表">
      <div className="sidebar-brand">
        <span className="brand-mark" aria-hidden="true">J</span>
        {!collapsed ? <span className="brand-name">贾维斯 <small>JARVIS</small></span> : null}
      </div>
      <button type="button" className="new-session-button" disabled={creating} onClick={() => void handleNewSession()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        {!collapsed ? (creating ? '正在创建…' : '新会话') : null}
      </button>
      {!collapsed ? (
        <div className="sidebar-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input value={search} onChange={event => { setSearch(event.target.value); setMenuSessionId(null); }} placeholder="搜索会话" aria-label="搜索会话" />
        </div>
      ) : null}
      {pinError && !collapsed ? <p className="sidebar-action-error" role="alert">{pinError}</p> : null}
      <nav className="session-groups">
        {(['pinned', 'today', 'week', 'earlier'] as GroupKey[]).map(key => groups[key].length ? (
          <section key={key} className={`session-group ${key === 'pinned' ? 'is-pinned-group' : ''}`}>
            {!collapsed ? <h2>{groupLabels[key]}</h2> : null}
            {groups[key].map(session => (
              <div key={session.id}
                className={`session-item ${session.pinnedAt ? 'is-pinned' : ''} ${session.id === activeSessionId ? 'is-active' : ''} ${session.id === open ? 'is-open' : ''}`}>
                <button type="button" className="session-item-main"
                  title={session.preview ?? session.title}
                  onClick={() => { setMenuSessionId(null); onOpenSession(session.id); }}>
                  <span className={`session-dot ${session.id === activeTaskSessionId ? 'is-running' : ''}`} aria-hidden="true" />
                  {!collapsed ? (
                    <span className="session-item-text">
                      <span className="session-item-title-row"><span className="session-item-title">{session.title}</span>
                        {session.pinnedAt ? <svg className="session-pin-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label="已置顶">
                          <path d="M8 3h8l-1 5 3 3v2H6v-2l3-3-1-5ZM12 13v8" /></svg> : null}</span>
                      <span className="session-item-meta">
                        {relativeTime(session.updatedAt)} · {session.messageCount} 条
                      </span>
                      <span className={`session-memory-bar ${memoryRatio(session) > 0.8 ? 'is-high' : memoryRatio(session) > 0.6 ? 'is-warm' : ''}`}>
                        <span style={{ width: `${Math.round(memoryRatio(session) * 100)}%` }} />
                      </span>
                    </span>
                  ) : null}
                </button>
                {!collapsed ? (
                  <button type="button" className="session-more-button"
                    aria-label={`更多操作：${session.title}`} aria-haspopup="menu"
                    aria-expanded={menuSessionId === session.id} aria-controls={menuSessionId === session.id ? 'session-actions-menu' : undefined}
                    onClick={event => toggleMenu(session.id, event.currentTarget)} title="更多操作">
                    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <circle cx="5" cy="12" r="1.65" /><circle cx="12" cy="12" r="1.65" /><circle cx="19" cy="12" r="1.65" />
                    </svg>
                  </button>
                ) : null}
              </div>
            ))}
          </section>
        ) : null)}
        {matchedLegacy.length ? (
          <section className="session-group">
            {!collapsed ? <h2>未分组历史任务</h2> : null}
            {matchedLegacy.map(task => (
              <button key={task.id} type="button"
                className={`session-item session-item-legacy ${task.id === open ? 'is-open' : ''}`}
                onClick={() => onOpenLegacyTask(task.id)}>
                <span className={`session-dot ${RUNNING_STATUSES.has(task.status) ? 'is-running' : ''}`} aria-hidden="true" />
                {!collapsed ? (
                  <span className="session-item-text">
                    <span className="session-item-title">{task.message}</span>
                    <span className="session-item-meta">{relativeTime(task.updatedAt)}</span>
                  </span>
                ) : null}
              </button>
            ))}
          </section>
        ) : null}
        {!groups.pinned.length && !groups.today.length && !groups.week.length && !groups.earlier.length && !matchedLegacy.length ? (
          !collapsed ? <p className="sidebar-empty">没有匹配的会话</p> : null
        ) : null}
      </nav>
      {menuSession && !collapsed ? createPortal(
        <div id="session-actions-menu" ref={menuRef} className="session-actions-menu" role="menu"
          aria-label={`${menuSession.title} 的操作`} style={menuPosition}
          onKeyDown={event => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'));
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
          }}>
          <button type="button" role="menuitem" disabled={pinningId === menuSession.id}
            onClick={() => void handlePin(menuSession)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 3.5h8l-1 5 3 3V13H6v-1.5l3-3-1-5ZM12 13v7.5" />
            </svg>
            <span>{menuSession.pinnedAt ? '取消置顶' : '置顶'}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => void handleRename(menuSession)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m4 20 4.2-.9L19 8.3a2.1 2.1 0 0 0-3-3L5.2 16.1 4 20Z" /><path d="m14.5 6.8 2.8 2.8" />
            </svg>
            <span>重命名</span>
          </button>
          <div className="session-menu-divider" role="separator" />
          <button type="button" role="menuitem" className="is-danger" onClick={() => void handleDelete(menuSession)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4.5 7h15M9 7V4.5h6V7m-8.5 0 .8 12.5h9.4L17.5 7M10 10.5v6M14 10.5v6" />
            </svg>
            <span>删除</span>
          </button>
        </div>, document.body,
      ) : null}
      <button type="button" className="sidebar-collapse" onClick={() => { setMenuSessionId(null); onToggle(); }}
        aria-label={collapsed ? '展开侧边栏' : '折叠侧边栏'}>
        {collapsed ? '»' : '«'}
      </button>
    </aside>
  );
}
