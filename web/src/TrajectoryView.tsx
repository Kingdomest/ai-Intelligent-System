import { useEffect, useMemo, useState } from 'react';
import { fetchTrajectory, type TrajectoryEntry, type TrajectorySummary } from './session-api.js';
import { countLogFailures, logEntryMessage, logEntrySeverity, type LogSeverity } from './logging.js';

const eventNames: Record<string, string> = {
  'agent.activity': 'Agent 执行状态',
  'task.status': '任务状态', 'task.completed': '任务完成', 'task.failed': '任务失败',
  'task.blocked': '任务阻塞', 'task.cancelled': '任务取消', 'step.completed': '步骤完成',
  'step.started': '步骤开始', 'step.paused': '步骤暂停', 'step.failed': '步骤失败',
  'step.verified': '步骤验证', 'test.report': '测试报告', 'context.compacted': '上下文压缩',
  'capability.activated': '工具启用', 'capability.reused': '工具复用',
  'capability.published': '工具发布', 'capability.temporary_registered': '临时工具已就绪',
  'correction.round_started': '开始纠错',
  'correction.round_finished': '结束纠错', 'task.permission_requested': '请求授权',
  'task.permission_approved': '授权通过', 'task.permission_denied': '授权拒绝',
  'task.needs_user_input': '等待补充信息', 'task.operation_completed': '工具执行完成',
  'task.permission_resolved': '授权结果',
  'research.searched': '网络资料搜索',
  'answer.sources': '回答引用来源',
};

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function formatJson(value: string | null): string {
  if (!value) return '—';
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

function entrySummary(entry: TrajectoryEntry): string {
  if (entry.kind === 'model') {
    const model = entry.model;
    if (model?.status === 'running') return '模型正在生成响应';
    if (model?.status === 'cancelled') return '模型调用已停止';
    if (model?.status === 'failed' || model?.status === 'interrupted') return model.error ?? '模型调用失败';
    return `${model?.modelName || model?.request?.model || '模型'} · ${model?.durationMs ?? 0} ms · 输入 ${model?.inputTokens ?? '—'} / 输出 ${model?.outputTokens ?? '—'} tokens`;
  }
  if (entry.kind === 'operation') {
    const operation = entry.operation;
    return `${operation?.state ?? '未知'} · ${operation?.target ?? ''}${operation?.errorCode ? ` · ${operation.errorCode}` : ''}`;
  }
  const payload = entry.payload ?? {};
  if (entry.type === 'agent.activity') return `${payload.role ?? 'Agent'} · ${payload.status ?? '未知'}${typeof payload.durationMs === 'number' ? ` · ${payload.durationMs} ms` : ''}`;
  if (entry.type === 'research.searched') return `找到 ${typeof payload.sourceCount === 'number' ? payload.sourceCount : 0} 条来源`;
  if (entry.type === 'answer.sources') return `记录 ${Array.isArray(payload.sources) ? payload.sources.length : 0} 条来源`;
  return [payload.status, payload.stepId, payload.capability, payload.name, payload.failureCode, payload.reason,
    typeof payload.durationMs === 'number' ? `${payload.durationMs} ms` : null]
    .filter(value => typeof value === 'string').join(' · ') || entry.type;
}

const emptySummary: TrajectorySummary = { events: 0, modelCalls: 0, failedModels: 0, operations: 0,
  failedOperations: 0, inputTokens: 0, outputTokens: 0, modelDurationMs: 0 };
type Filter = 'all' | 'model' | 'operation' | 'event' | 'failure';
const filters: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: '全部' }, { value: 'model', label: '模型' },
  { value: 'operation', label: '工具操作' }, { value: 'event', label: '任务事件' },
  { value: 'failure', label: '异常' },
];

const severityLabels: Record<LogSeverity, string> = { error: '错误', warning: '警告', info: '信息' };

function isFailure(entry: TrajectoryEntry): boolean {
  return logEntrySeverity(entry) !== 'info';
}

type TrajectoryViewProps = {
  sessionId: string | null;
  taskId: string | null;
  mode?: 'trajectory' | 'logs';
  onSummary?: (summary: TrajectorySummary, entries?: TrajectoryEntry[]) => void;
};

export function TrajectoryView({ sessionId, taskId, mode = 'trajectory', onSummary }: TrajectoryViewProps) {
  const [entries, setEntries] = useState<TrajectoryEntry[]>([]);
  const [summary, setSummary] = useState<TrajectorySummary>(emptySummary);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>(mode === 'logs' ? 'failure' : 'all');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const scopeKey = sessionId ? `session:${sessionId}` : taskId ? `task:${taskId}` : '';
  const scope = sessionId ? { sessionId } : { taskId: taskId ?? undefined };
  const isLogs = mode === 'logs';

  useEffect(() => {
    let active = true;
    setEntries([]);
    setSummary(emptySummary);
    setSelectedId(null);
    setCopied(false);
    setFilter(isLogs ? 'failure' : 'all');
    setLoading(true);
    setError('');
    if (!scopeKey) { setLoading(false); return; }
    const refresh = async () => {
      try {
        const page = await fetchTrajectory(scope, 0, 100);
        if (!active) return;
        setSummary(page.summary);
        onSummary?.(page.summary, page.entries);
        setEntries(current => {
          const seen = new Set(page.entries.map(item => item.id));
          return [...page.entries, ...current.filter(item => !seen.has(item.id))]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
        });
        setError('');
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : '轨迹加载失败');
      } finally {
        if (active) setLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [scopeKey, isLogs, onSummary]);

  async function loadOlder() {
    try {
      const page = await fetchTrajectory(scope, entries.length, 100);
      setSummary(page.summary);
      onSummary?.(page.summary, page.entries);
      setEntries(current => {
        const seen = new Set(current.map(item => item.id));
        return [...current, ...page.entries.filter(item => !seen.has(item.id))];
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '更早轨迹加载失败');
    }
  }

  const shown = useMemo(() => entries.filter(entry => {
    if (filter !== 'all' && (filter === 'failure' ? !isFailure(entry) : entry.kind !== filter)) return false;
    const text = `${entry.type} ${entrySummary(entry)} ${logEntryMessage(entry)} ${entry.kind === 'model'
      ? `${entry.model?.status} ${entry.model?.user} ${entry.model?.system}` : ''}`;
    return text.toLowerCase().includes(query.trim().toLowerCase());
  }), [entries, query, filter]);
  const selected = entries.find(entry => entry.id === selectedId) ?? null;
  const hasMore = entries.length < summary.events + summary.modelCalls + summary.operations;
  const loadedFailures = entries.filter(isFailure).length;
  const failureCount = Math.max(countLogFailures(summary), loadedFailures);

  async function copySelectedLog() {
    if (!selected || typeof navigator === 'undefined' || !navigator.clipboard) return;
    await navigator.clipboard.writeText(JSON.stringify(selected, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  }

  return <section className={`trajectory-view ${isLogs ? 'is-logs' : ''}`} aria-label={isLogs ? '智能体日志' : 'AI 调用轨迹'}>
    <div className="trajectory-heading">
      <div><span className="trajectory-eyebrow">{isLogs ? 'AGENT LOGS' : 'AI TRACE'}</span><h1>{isLogs ? '智能体日志' : '调用轨迹'}</h1>
        <p>{isLogs ? '集中查看错误、警告和执行上下文，帮助定位智能体失败原因。' : '按时间查看任务步骤、模型请求与工具操作。点击记录可检查详情。'}</p></div>
      {isLogs ? <div className="trajectory-stats"><span><strong>{failureCount}</strong> 条异常</span>
        <span><strong>{summary.modelCalls + summary.operations}</strong> 次调用</span>
        <span><strong>{entries.length}</strong> 条已加载</span></div>
        : <div className="trajectory-stats"><span><strong>{summary.modelCalls}</strong> 次模型调用</span>
          <span><strong>{summary.operations}</strong> 次工具操作</span>
          <span><strong>{summary.failedModels + summary.failedOperations}</strong> 次调用异常</span>
          <span><strong>{summary.inputTokens.toLocaleString()}</strong> 输入 tokens</span>
          <span><strong>{summary.outputTokens.toLocaleString()}</strong> 输出 tokens</span></div>}
    </div>
    <div className="trajectory-toolbar">
      <input type="search" aria-label={isLogs ? '搜索智能体日志' : '搜索轨迹'} placeholder={isLogs ? '搜索错误消息、阶段或请求 ID' : '搜索阶段或调用角色'} value={query}
        onChange={event => setQuery(event.target.value)} />
      <div className="trajectory-filters" aria-label={isLogs ? '日志筛选' : '轨迹筛选'}>{filters.map(item =>
        <button key={item.value} type="button" aria-pressed={filter === item.value}
          onClick={() => setFilter(item.value)}>{item.label}</button>)}</div>
      <span>已加载 {entries.length} / {summary.events + summary.modelCalls + summary.operations} 条 · 当前显示 {shown.length} 条</span>
    </div>
    {error ? <div className="trajectory-error" role="alert">{error}</div> : null}
    <div className="trajectory-body">
      <div className="trajectory-list" aria-label={isLogs ? '智能体日志记录' : '轨迹记录'}>
        {loading && entries.length === 0 ? <p className="trajectory-empty">正在加载{isLogs ? '日志' : '轨迹'}…</p> : null}
        {!loading && shown.length === 0 ? <p className="trajectory-empty">暂无匹配的{isLogs ? '日志' : '轨迹'}记录。新任务产生调用后会显示在这里。</p> : null}
        {shown.map(entry => <button type="button" key={entry.id}
          className={`trajectory-row ${selectedId === entry.id ? 'is-selected' : ''} ${isLogs ? `is-${logEntrySeverity(entry)}` : ''}`}
          onClick={() => setSelectedId(entry.id)}>
          {isLogs ? <span className={`trajectory-severity is-${logEntrySeverity(entry)}`}>{severityLabels[logEntrySeverity(entry)]}</span>
            : <span className={`trajectory-kind is-${entry.kind}`}>{entry.kind === 'model' ? 'AI' : entry.kind === 'operation' ? '工具' : '事件'}</span>}
          <span className="trajectory-row-main"><strong>{entry.kind === 'model' ? entry.type : eventNames[entry.type] ?? entry.type}</strong>
            <small>{isLogs ? logEntryMessage(entry) : entrySummary(entry)}</small></span>
          <time dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time>
        </button>)}
        {hasMore ? <button type="button" className="trajectory-more" onClick={() => void loadOlder()}>加载更早轨迹</button> : null}
      </div>
      <aside className="trajectory-inspector" aria-label={isLogs ? '日志详情' : '轨迹详情'}>
        {selected ? <>
          <div className="trajectory-inspector-title"><span>{selected.kind === 'model' ? '模型调用' : selected.kind === 'operation' ? '工具操作' : '任务事件'}</span>
            <button type="button" onClick={() => setSelectedId(null)} aria-label="关闭轨迹详情">×</button></div>
          <h2>{selected.kind === 'model' ? selected.type : eventNames[selected.type] ?? selected.type}</h2>
          {isLogs ? <div className={`log-callout is-${logEntrySeverity(selected)}`}>
            <strong>{severityLabels[logEntrySeverity(selected)]}</strong>
            <p>{logEntryMessage(selected)}</p>
          </div> : null}
          {isLogs ? <button type="button" className="log-copy-button" onClick={() => void copySelectedLog()}>
            {copied ? '已复制日志 JSON' : '复制日志 JSON'}
          </button> : null}
          <dl className="trajectory-meta"><div><dt>时间</dt><dd>{formatTime(selected.createdAt)}</dd></div>
            <div><dt>关联任务</dt><dd>{selected.taskId ?? '会话级模型调用'}</dd></div>
            {selected.model ? <><div><dt>模型</dt><dd>{selected.model.modelName || '未记录'}</dd></div>
              <div><dt>状态</dt><dd>{selected.model.status}</dd></div>
              <div><dt>耗时</dt><dd>{selected.model.durationMs === null ? '进行中' : `${selected.model.durationMs} ms`}</dd></div>
              <div><dt>Token</dt><dd>输入 {selected.model.inputTokens ?? '—'} · 输出 {selected.model.outputTokens ?? '—'}</dd></div>
              {selected.model.finishedAt ? <div><dt>完成时间</dt><dd>{formatTime(selected.model.finishedAt)}</dd></div> : null}
              {selected.model.requestId ? <div><dt>请求 ID</dt><dd>{selected.model.requestId}</dd></div> : null}</> : null}
            {selected.operation ? <><div><dt>状态</dt><dd>{selected.operation.state}</dd></div>
              <div><dt>权限</dt><dd>{selected.operation.permission}</dd></div>
              <div><dt>操作</dt><dd>{selected.operation.action}</dd></div>
              <div><dt>目标</dt><dd>{selected.operation.target}</dd></div>
              <div><dt>更新时间</dt><dd>{formatTime(selected.operation.updatedAt)}</dd></div>
              <div><dt>历时</dt><dd>{selected.operation.durationMs} ms（含授权等待）</dd></div>
              {selected.operation.requestId ? <div><dt>授权 ID</dt><dd>{selected.operation.requestId}</dd></div> : null}
              {selected.operation.errorCode ? <div><dt>错误码</dt><dd>{selected.operation.errorCode}</dd></div> : null}</> : null}</dl>
          {selected.model ? <div className="trajectory-details">
            {selected.model.request ? <details open><summary>请求配置与校验 Schema</summary><pre>{JSON.stringify(selected.model.request, null, 2)}</pre></details> : null}
            <details><summary>System 提示词</summary><pre>{selected.model.system}</pre></details>
            <details open><summary>User 输入</summary><pre>{selected.model.user}</pre></details>
            {selected.model.error ? <details open><summary>错误</summary><pre>{selected.model.error}</pre></details> : null}
            {selected.model.errorDetails ? <details open><summary>错误详情</summary><pre>{JSON.stringify(selected.model.errorDetails, null, 2)}</pre></details> : null}
            {selected.model.rawResponse ? <details open={!!selected.model.error}><summary>提供方原始响应</summary><pre>{selected.model.rawResponse}</pre></details> : null}
            <details open><summary>模型输出</summary><pre>{formatJson(selected.model.response)}</pre></details>
          </div> : selected.operation ? <div className="trajectory-details"><h3>执行结果</h3>
            <pre>{selected.operation.success === null ? '尚无执行结果' : selected.operation.success ? '成功' : '失败'}</pre>
            <p className="trajectory-detail-note">操作参数与原始结果可能含敏感数据，因此仅展示执行状态和错误码。</p>
          </div> : <div className="trajectory-details"><h3>事件数据</h3>
            <pre>{JSON.stringify(selected.payload ?? {}, null, 2)}</pre></div>}
        </> : <p className="trajectory-empty">选择左侧一条记录查看请求配置、输入输出、耗时与执行状态。</p>}
      </aside>
    </div>
  </section>;
}
