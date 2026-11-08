import { useEffect, useRef, useState } from 'react';
import { fetchTaskFlow, reviewActionLabels, stepStatusLabels, type TaskFlow, type TaskFlowStep } from './task-flow.js';

const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED']);
const taskLabels: Record<string, string> = { COMPLETED: '任务已完成', FAILED: '任务失败', BLOCKED: '任务已阻塞',
  CANCELLED: '任务已取消', NEEDS_USER_INPUT: '等待补充信息', WAITING_FOR_APPROVAL: '等待授权',
  PLAN_READY: '计划已生成', EXECUTING: '执行中', RETRYING: '调整后重试中' };

export function TaskFlowSummary({ flow, onOpen }: { flow: TaskFlow | null; onOpen: () => void }) {
  if (!flow) return null;
  const active = flow.steps.find(step => step.id === flow.activeStepId);
  const owner = flow.workers.find(worker => worker.id === active?.ownerAgentId);
  return <div className="task-flow-summary" aria-live="polite">
    <div className="task-flow-summary-copy">
      <strong>{active ? `${owner?.name ?? '任务子 Agent'} 正在执行` : flow.steps.length ? '任务执行进度' : '主 Agent 正在分析任务'}</strong>
      <small>{active ? active.description || active.id : flow.steps.length
        ? `已完成 ${flow.progress.completed}/${flow.progress.total} 个步骤` : '正在拆解需求与分配子任务'}</small>
    </div>
    {flow.progress.total > 0 ? <div className="task-flow-mini-progress" role="progressbar"
      aria-label="步骤完成进度" aria-valuemin={0} aria-valuemax={flow.progress.total}
      aria-valuenow={flow.progress.completed}><span style={{ width: `${flow.progress.completed / flow.progress.total * 100}%` }} /></div> : null}
    <button type="button" onClick={onOpen}>查看流程图</button>
  </div>;
}

export function TaskFlowDrawer({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [flow, setFlow] = useState<TaskFlow | null>(null);
  const [error, setError] = useState('');
  const closeButton = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onCloseRef.current(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    let timer: number | undefined;
    setFlow(null);
    setError('');
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const next = await fetchTaskFlow(taskId, controller.signal);
        if (!disposed) { setFlow(next); setError(''); }
        if (!disposed && !terminal.has(next.taskStatus)) timer = window.setTimeout(load, 1800);
      } catch (cause) {
        if (disposed || controller?.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : '流程查询失败');
        timer = window.setTimeout(load, 4000);
      }
    };
    void load();
    return () => { disposed = true; controller?.abort(); window.clearTimeout(timer); };
  }, [taskId]);

  const names = new Map([...(flow?.rootAgent ? [[flow.rootAgent.id, flow.rootAgent.name] as const] : []),
    ...(flow?.workers.map(worker => [worker.id, worker.name] as const) ?? [])]);
  const recentExchanges = flow?.exchanges.filter(item => item.kind !== 'assignment').slice(-12).reverse() ?? [];
  return <div className="task-flow-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="task-flow-drawer" role="dialog" aria-modal="true" aria-label="任务执行流程图">
      <header className="task-flow-header">
        <div><span className="task-flow-eyebrow">LIVE TASK MAP</span><h2>任务执行流程图</h2>
          <p>查看主 Agent 的分派、子 Agent 执行与计划调整</p></div>
        <button ref={closeButton} type="button" className="task-flow-close" onClick={onClose} aria-label="关闭任务流程图">×</button>
      </header>
      {error ? <p className="task-flow-error" role="alert">{error}</p> : null}
      {!flow ? <p className="task-flow-empty">正在读取任务流程…</p> : <div className="task-flow-content">
        <section className="task-flow-intent" aria-label="用户目标与验收标准">
          <span className="task-flow-section-label">用户目标</span><p>{flow.goal}</p>
          {flow.acceptanceCriteria.length > 0 ? <details><summary>验收标准 · {flow.acceptanceCriteria.length} 项</summary>
            <ul>{flow.acceptanceCriteria.map((item, index) => <li key={index}>{item}</li>)}</ul></details> : null}
        </section>
        <section className="task-flow-progress" aria-label="任务进度">
          <span className={`task-flow-task-state is-${flow.taskStatus.toLowerCase()}`}>{taskLabels[flow.taskStatus] ?? '任务进行中'}</span>
          <div><strong>{flow.progress.completed}/{flow.progress.total}</strong><span>步骤已完成</span></div>
          <div><strong>{flow.workers.length}</strong><span>任务子 Agent</span></div>
          <div><strong>{flow.progress.revisionCount}</strong><span>计划调整</span></div>
          <div className="task-flow-progress-track" role="progressbar" aria-label="步骤完成进度"
            aria-valuemin={0} aria-valuemax={flow.progress.total} aria-valuenow={flow.progress.completed}>
            <span style={{ width: `${flow.progress.total ? flow.progress.completed / flow.progress.total * 100 : 0}%` }} />
          </div>
        </section>
        <section className="task-flow-graph" aria-label="主任务与子任务流程">
          <div className="task-flow-root"><span className="task-flow-node-icon">J</span><div>
            <small>主任务 · 规划 / 分派 / 复盘</small><strong>{flow.rootAgent?.name ?? 'Jarvis 主 Agent'}</strong>
            <span>{flow.steps.length ? `已派发 ${flow.steps.length} 个步骤`
              : terminal.has(flow.taskStatus) ? '该任务没有子 Agent 分派记录' : '正在规划任务'}</span>
          </div></div>
          {flow.workers.length ? <div className="task-flow-branches">
            {flow.workers.map(worker => {
              const steps = flow.steps.filter(step => step.ownerAgentId === worker.id);
              return <div className="task-flow-worker" key={worker.id}>
                <div className="task-flow-worker-heading"><span className={`task-flow-worker-dot ${steps.some(step => step.status === 'running') ? 'is-running' : ''}`} />
                  <div><strong>{worker.name}</strong><small>{steps.length} 个步骤 · {steps.some(step => step.status === 'running') ? '执行中'
                    : steps.some(step => step.status === 'blocked') ? '已阻塞'
                      : steps.some(step => step.status === 'failed') ? '失败'
                        : steps.length && steps.every(step => step.status === 'completed') ? '已完成' : '等待执行'}</small></div>
                </div>
                <div className="task-flow-worker-steps">{steps.length ? steps.map(step => <StepCard key={step.id} step={step} />)
                  : <p className="task-flow-no-steps">当前计划未分配步骤</p>}</div>
              </div>;
            })}
          </div> : <p className="task-flow-empty">{terminal.has(flow.taskStatus)
            ? '该任务没有子 Agent 执行记录。' : '主 Agent 正在拆解任务，子 Agent 尚未分配。'}</p>}
          {flow.steps.some(step => step.dependsOn.length) ? <div className="task-flow-links" aria-label="步骤依赖关系">
            <span className="task-flow-section-label">步骤依赖</span>
            {flow.steps.flatMap(step => step.dependsOn.map(source => <div key={`${source}-${step.id}`}>
              <span>{source}</span><b aria-hidden="true">→</b><span>{step.id}</span>
              <small>{flow.workers.find(worker => worker.id === step.ownerAgentId)?.name ?? '任务子 Agent'} 接收结果</small>
            </div>))}
          </div> : null}
        </section>
        {flow.modelRoles.length ? <section className="task-flow-roles" aria-label="专业 Agent 状态">
          <span className="task-flow-section-label">专业 Agent 状态</span>
          <div>{flow.modelRoles.map(agent => <span key={agent.id} className={`task-flow-role is-${agent.status}`}>
            <i aria-hidden="true" />{agent.name}<small>{agentStatusLabel(agent.status)}</small>
          </span>)}</div>
        </section> : null}
        {flow.replacedSteps.length ? <details className="task-flow-history"><summary>已调整的旧步骤 · {flow.replacedSteps.length}</summary>
          <div>{flow.replacedSteps.map(step => <StepCard key={step.id} step={step} />)}</div></details> : null}
        {recentExchanges.length ? <section className="task-flow-exchanges"><span className="task-flow-section-label">最近协作通信</span>
          <ol>{recentExchanges.map((item, index) => <li key={`${item.createdAt}-${index}`}>
            <span>{names.get(item.fromAgentId) ?? 'Agent'} → {names.get(item.toAgentId) ?? 'Agent'}</span>
            <strong>{exchangeLabel(item.kind, item.dependencyStepId)}</strong><small>{item.stepId}</small>
          </li>)}</ol></section> : null}
        {flow.reviews.length ? <section className="task-flow-reviews"><span className="task-flow-section-label">主 Agent 复盘记录</span>
          <ol>{[...flow.reviews].reverse().map((item, index) => <li key={`${item.stepId}-${index}`}>
            <strong>{item.stepId}</strong><span>{reviewActionLabels[item.action]}</span></li>)}</ol></section> : null}
      </div>}
    </aside>
  </div>;
}

function StepCard({ step }: { step: TaskFlowStep }) {
  return <article className={`task-flow-step is-${step.status}`} aria-label={`${step.id}，${stepStatusLabels[step.status]}`}>
    <div><span className="task-flow-step-id">{step.id}</span><span className="task-flow-step-state">{stepStatusLabels[step.status]}</span></div>
    <p>{step.description || '执行分派步骤'}</p>
    {step.dependsOn.length ? <small className="task-flow-dependencies">等待 {step.dependsOn.join('、')} 的结果</small> : null}
    {step.reviewAction ? <small className="task-flow-review">{reviewActionLabels[step.reviewAction]}</small> : null}
  </article>;
}

function exchangeLabel(kind: TaskFlow['exchanges'][number]['kind'], dependencyStepId?: string): string {
  return ({ assignment: '分派任务', request: `请求步骤 ${dependencyStepId ?? ''} 的结果`,
    response: `返回步骤 ${dependencyStepId ?? ''} 的结果`, result: '提交执行结果', review: '反馈复盘结论' })[kind];
}

function agentStatusLabel(status: string): string {
  return ({ queued: '待命', running: '执行中', waiting: '等待中', paused: '已暂停',
    completed: '已完成', failed: '失败', cancelled: '已取消' } as Record<string, string>)[status] ?? status;
}
