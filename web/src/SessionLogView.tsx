import { useEffect, useMemo, useState } from 'react';
import { fetchSessionLogs, type SessionLogDocument, type SessionLogLine, type SessionSummary } from './session-api.js';

type LogFilter = 'all' | 'ERROR' | 'WARN' | 'INFO';

const emptySummary = { total: 0, info: 0, warnings: 0, errors: 0 };

export type SessionLogViewProps = {
  sessionId: string | null;
  taskId: string | null;
  sessions: SessionSummary[];
  onSelectSession: (sessionId: string) => void;
};

function levelLabel(level: SessionLogLine['level']): string {
  return level === 'ERROR' ? '错误' : level === 'WARN' ? '警告' : '信息';
}

function dateLabel(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export function SessionLogView({ sessionId, taskId, sessions, onSelectSession }: SessionLogViewProps) {
  const [logDocument, setLogDocument] = useState<SessionLogDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LogFilter>('all');
  const [copied, setCopied] = useState(false);
  const scopeKey = sessionId ? `session:${sessionId}` : taskId ? `task:${taskId}` : '';
  const scope = sessionId ? { sessionId } : { taskId: taskId ?? undefined };

  useEffect(() => {
    let active = true;
    setLogDocument(null);
    setLoading(true);
    setError('');
    setQuery('');
    setFilter('all');
    if (!scopeKey) { setLoading(false); return; }
    const refresh = async () => {
      try {
        const next = await fetchSessionLogs(scope);
        if (!active) return;
        setLogDocument(next);
        setError('');
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : '文本日志加载失败');
      } finally {
        if (active) setLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [scopeKey]);

  const visibleLines = useMemo(() => {
    if (!logDocument) return [];
    const normalized = query.trim().toLowerCase();
    return logDocument.lines.filter(line => (filter === 'all' || line.level === filter)
      && (!normalized || line.text.toLowerCase().includes(normalized)));
  }, [logDocument, filter, query]);

  const displayText = useMemo(() => {
    if (!logDocument) return '';
    const header = logDocument.text.split('\n').slice(0, 5).join('\n');
    return `${header}\n${visibleLines.map(line => line.text).join('\n')}`;
  }, [logDocument, visibleLines]);

  async function copyLog() {
    if (!displayText || typeof navigator === 'undefined' || !navigator.clipboard) return;
    await navigator.clipboard.writeText(displayText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  }

  function downloadLog() {
    if (!displayText || typeof window === 'undefined') return;
    const blob = new Blob([displayText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `jarvis-${logDocument?.scopeType}-${logDocument?.scopeId}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const selectedValue = sessionId ?? (taskId ? `task:${taskId}` : '');
  const summary = logDocument?.summary ?? emptySummary;

  return <section className="session-log-view" aria-label="会话文本日志">
    <div className="session-log-heading">
      <div><span className="session-log-eyebrow">SESSION TEXT LOG</span><h1>会话文本日志</h1>
        <p>每个会话独立生成一份可复制、可下载的文本日志，按时间保留智能体排查上下文。</p></div>
      <div className="session-log-actions">
        <button type="button" onClick={() => void copyLog()} disabled={!logDocument || !visibleLines.length}>{copied ? '已复制' : '复制日志'}</button>
        <button type="button" onClick={downloadLog} disabled={!logDocument || !visibleLines.length}>下载日志</button>
      </div>
    </div>
    <div className="session-log-toolbar">
      <label>选择会话
        <select aria-label="选择会话" value={selectedValue} onChange={event => {
          const next = event.target.value;
          if (next && !next.startsWith('task:')) onSelectSession(next);
        }}>
          {!selectedValue ? <option value="" disabled>请选择会话</option> : null}
          {taskId && !sessionId ? <option value={`task:${taskId}`}>当前历史任务 · {taskId.slice(0, 8)}</option> : null}
          {sessions.map(session => <option key={session.id} value={session.id}>{session.title}</option>)}
        </select>
      </label>
      <input type="search" aria-label="搜索文本日志" placeholder="搜索错误、请求 ID、工具或任务" value={query}
        onChange={event => setQuery(event.target.value)} />
      <div className="session-log-filters" aria-label="日志级别筛选">
        {(['all', 'ERROR', 'WARN', 'INFO'] as LogFilter[]).map(item => <button key={item} type="button"
          aria-pressed={filter === item} onClick={() => setFilter(item)}>{item === 'all' ? '全部' : levelLabel(item)}</button>)}
      </div>
    </div>
    <div className="session-log-summary"><span><strong>{summary.total}</strong> 条日志</span>
      <span className="is-error"><strong>{summary.errors}</strong> 错误</span>
      <span className="is-warn"><strong>{summary.warnings}</strong> 警告</span>
      {logDocument ? <span>生成于 {dateLabel(logDocument.generatedAt)}</span> : null}
    </div>
    {error ? <div className="session-log-error" role="alert">{error}</div> : null}
    {!scopeKey ? <div className="session-log-empty">请先选择一个会话，再查看该会话的文本日志。</div> : null}
    {loading ? <div className="session-log-empty">正在加载会话日志…</div> : null}
    {!loading && logDocument && visibleLines.length === 0 ? <div className="session-log-empty">当前筛选条件没有匹配的日志。</div> : null}
    {logDocument && visibleLines.length ? <div className="session-log-paper" aria-label="文本日志内容">
      <pre>{displayText}</pre>
    </div> : null}
  </section>;
}
