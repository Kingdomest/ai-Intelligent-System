import type { AgentRunner, PlannerDecision, ResponseInput } from '../agents/agent-runner.js';
import type { TestAgent, TestReport } from '../agents/test-agent.js';
import { CapabilityRegistry } from '../capabilities/registry.js';
import { getBuiltin } from '../capabilities/builtin-catalog.js';
import { SandboxRunner } from '../capabilities/sandbox-runner.js';
import { ToolFactory } from '../capabilities/tool-factory.js';
import type { ExecutionCheckpoint, PermissionOperation, StepBinding, TaskEvent, TaskRun } from '../domain/contracts.js';
import type { CorrectionFailure } from '../domain/contracts.js';
import { ApprovalRequiredError, CapabilityUnavailableError, HostOperationError, OperationUncertainError, PermissionBroker, PermissionDeniedError } from '../permissions/permission-broker.js';
import type { HostCallResult } from '../permissions/operation-protocol.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BudgetManager } from './budget-manager.js';
import { AdaptiveScheduler } from './scheduler.js';
import { SqliteStore } from '../storage/sqlite-store.js';
import { reportForEvent, summarize, TestExecutor } from './test-executor.js';
import { WindowsDesktopObserver } from './windows-desktop-observer.js';
import { resolveWindowsApplication, type ApplicationResolution } from './windows-app-resolver.js';
import { deriveGenericityFixtures, verifyGenericity } from '../capabilities/genericity-gate.js';
import { beginCorrection, MAX_CORRECTION_ROUNDS } from './correction-round.js';
import { classifyCorrectionFailure, routeCorrection, sanitizeCorrectionFailure } from './correction-router.js';
import { publicTaskEvent } from './event-projection.js';
import { sanitizeAnswerSources } from './answer-sources.js';
import { isNewsSearchUrl, parseNewsRss } from '../research/news-rss.js';
import type { SessionMemorySnapshot } from '../domain/contracts.js';
import { validateStepInput } from '../agents/planner-contract.js';

export type AgentServices = Pick<AgentRunner, 'runPlanner' | 'runEvaluator' | 'runImplementer'>
  & Partial<Pick<AgentRunner, 'runResponder' | 'runCorrection' | 'runDraftCorrection' | 'runFileImplementer' | 'runStepRepair'>>;

/** Loads the bounded per-session memory that is injected into planner and responder prompts. */
export interface SessionMemoryPort {
  loadSnapshot(sessionId: string): SessionMemorySnapshot | null;
}

export interface AgentLoopDependencies {
  store: SqliteStore;
  agents: AgentServices;
  tester: Pick<TestAgent, 'generate' | 'review' | 'reviewAnswer'>;
  testExecutor: TestExecutor;
  desktopObserver: WindowsDesktopObserver;
  factory: ToolFactory;
  registry: CapabilityRegistry;
  sandbox: SandboxRunner;
  budget: BudgetManager;
  scheduler: AdaptiveScheduler;
  maxRetries: number;
  maxSteps: number;
  permissionBroker?: PermissionBroker;
  workspaceRoot?: string;
  desktopDirectory?: string;
  sessionMemory?: SessionMemoryPort;
  appResolver?: (name: string) => Promise<ApplicationResolution>;
}

type CapabilityOutcome =
  | { state: 'ready'; bindings: StepBinding[] }
  | { state: 'waiting' }
  | { state: 'stopped' }
  | { state: 'blocked'; message: string }
  | { state: 'failed'; message: string };

function isConfirmedDryRunContractFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^(?:Dry-run host operation validation failed:|Generated tool rejected by policy:)/i.test(message);
}

export class AgentLoop {
  constructor(private readonly dependencies: AgentLoopDependencies) {
    this.dependencies.registry.installBuiltins();
    this.dependencies.permissionBroker?.useCapabilityLookup((name, version, taskId) =>
      this.dependencies.registry.getVersion(name, version, taskId));
  }

  async run(taskId: string): Promise<TaskRun> {
    const task = this.dependencies.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (isTerminal(task.status) || task.status === 'WAITING_FOR_APPROVAL') return task;

    try {
      let currentInput: { message: string; attachments: Array<{ filename: string; content?: string }> } = {
        message: task.message,
        attachments: task.attachments.map((attachment) => ({ filename: attachment.filename, content: attachment.content ?? '' })),
      };
      const sessionMemory = task.sessionId
        ? this.dependencies.sessionMemory?.loadSnapshot(task.sessionId) ?? undefined
        : undefined;
      // The UI can display the complete trajectory, but the planner previously
      // received none of it. Keep a small redacted failure projection in the
      // same-session context so a repair request can investigate autonomously.
      const diagnosticContext = task.sessionId
        ? this.dependencies.store.getLatestDiagnosticContext(task.sessionId, task.id) ?? undefined
        : undefined;
      let planner: PlannerDecision;
      let stepBindings: StepBinding[];
      const workspaceRoot = this.dependencies.workspaceRoot ?? process.cwd();
      const desktopDirectory = this.dependencies.desktopDirectory ?? `${workspaceRoot}/Desktop`;
      let runtimeInput = createRuntimeInput(currentInput, workspaceRoot, desktopDirectory);
      const completedSteps = new Set<string>();
      const stepResults = [...(task.executionCheckpoint?.stepResults ?? [])];
      let lastOutput: unknown = stepResults.at(-1)?.output ?? null;
      let executedSteps = 0;

      if (task.executionCheckpoint) {
        const checkpoint = task.executionCheckpoint;
        if (!isPlannerDecision(checkpoint.planner)) return this.fail(task, '审批恢复失败：任务计划检查点无效，请重新提交任务。');
        planner = checkpoint.planner;
        if (checkpoint.stepBindings?.length === planner.steps.length
          && planner.steps.every((step) => checkpoint.stepBindings?.some((binding) => binding.stepId === step.id))) {
          stepBindings = checkpoint.stepBindings;
        } else if (planner.steps.length === 1 && checkpoint.capabilityName && checkpoint.capabilityVersion) {
          stepBindings = [{ stepId: planner.steps[0]!.id,
            capabilityKey: planner.steps[0]!.capabilityKey ?? checkpoint.capabilityName,
            capabilityId: checkpoint.capabilityName, version: checkpoint.capabilityVersion }];
        } else {
          return this.block(task, '历史检查点无法无歧义地绑定每个步骤，请重新提交任务。');
        }
        checkpoint.completedStepIds.forEach((stepId) => completedSteps.add(stepId));
      } else {
        this.setStatus(task, 'BUDGET_CHECK');
        const initialBudget = this.dependencies.budget.check(currentInput);
        if (!initialBudget.fits) {
          this.setStatus(task, 'CONTEXT_COMPACTING');
          currentInput = this.dependencies.budget.compact(currentInput);
          task.message = currentInput.message;
          task.attachments = task.attachments.map((attachment, index) => ({
            ...attachment,
            content: currentInput.attachments[index]?.content,
          }));
          runtimeInput = createRuntimeInput(currentInput, workspaceRoot, desktopDirectory);
          this.event(task, 'context.compacted', { estimatedInputTokens: this.dependencies.budget.check(currentInput).estimatedInputTokens });
          if (!this.dependencies.budget.check(currentInput).fits) return this.fail(task, '上下文仍然超出预算，无法安全执行。');
        }

        planner = await this.dependencies.agents.runPlanner({
          taskId: task.id,
          message: currentInput.message,
          attachments: currentInput.attachments.map((attachment) => ({ filename: attachment.filename, content: attachment.content ?? '' })),
          workspaceRoot,
          desktopDirectory,
          sessionMemory,
          diagnosticContext,
          permissionMode: task.permissionMode,
          onResearch: sources => this.event(task, 'research.searched', {
            sourceCount: sources.length, sources: sanitizeAnswerSources(sources) }),
          onDraftProgress: (completed, total) => this.event(task, 'draft.progress', { completed, total }),
        });
        task.acceptanceCriteria = planner.acceptanceCriteria;
        this.save(task);

        if (planner.status === 'answer') {
          return await this.completeAnswer(task, planner, [], planner.answer);
        }

        if (planner.status === 'needs_user_input') {
          this.setStatus(task, 'NEEDS_USER_INPUT');
          this.event(task, 'task.needs_user_input', { request: planner.inputRequest ?? null });
          return task;
        }

        for (const step of planner.steps) {
          if (step.capabilityKey !== 'process.launch') continue;
          const name = step.input?.applicationName;
          if (typeof name !== 'string' || !name.trim()) return this.fail(task, `步骤 ${step.id} 缺少应用名称。`);
          const resolution = await (this.dependencies.appResolver ?? resolveWindowsApplication)(name);
          if (resolution.status === 'blocked') return this.block(task, resolution.reason);
          if (resolution.status === 'needs_user_input') {
            this.setStatus(task, 'NEEDS_USER_INPUT');
            this.event(task, 'task.needs_user_input', { request: {
              taskId: task.id, question: resolution.reason,
              requiredFields: [{ name: 'executable', reason: 'Provide an exact executable path or choose a candidate.', sensitive: false }],
              resumeToken: randomUUID(), candidates: resolution.candidates,
            } });
            return task;
          }
          step.input = { ...step.input, executable: resolution.executable, applicationId: resolution.processName };
        }

        if (planner.requiredCapabilities.length === 0 && planner.steps.every((step) => !step.capabilityKey)) {
          if (planner.steps.length === 0) {
            task.result = '任务已完成：当前需求无需执行工具。';
            this.setStatus(task, 'COMPLETED');
            this.event(task, 'task.completed', { reason: 'no-work-required' });
            return task;
          }
          return this.fail(task, '任务计划需要执行步骤，但没有声明所需能力。');
        }
        if (planner.steps.length === 0) return this.block(task, '计划声明了宿主能力，但没有真实执行步骤，无法验证任务结果。');

        if (!await this.implementPlannedFiles(task, planner)) return this.dependencies.store.getTask(task.id) ?? task;

        this.setStatus(task, 'CAPABILITY_ANALYSIS');
        const capabilityOutcome = await this.ensureCapabilities(task, planner, runtimeInput);
        if (capabilityOutcome.state === 'waiting') return task;
        if (capabilityOutcome.state === 'stopped') return task;
        if (capabilityOutcome.state === 'blocked') return this.block(task, capabilityOutcome.message);
        if (capabilityOutcome.state === 'failed') return this.fail(task, capabilityOutcome.message);
        stepBindings = capabilityOutcome.bindings;
      }

      if (planner.steps.some((step) => step.capabilityKey === 'filesystem.read_text')
        && !this.dependencies.agents.runResponder) {
        return this.block(task, '文件读取后缺少回答 Agent，无法可靠生成总结；任务未继续执行。');
      }

      this.setStatus(task, 'PLAN_READY');
      while (executedSteps < this.dependencies.maxSteps) {
        const nextStep = this.dependencies.scheduler.nextReadyStep(planner, completedSteps);
        if (!nextStep) break;
        executedSteps += 1;
        const checkpoint = task.executionCheckpoint;
        const binding = stepBindings.find((item) => item.stepId === nextStep.id);
        if (!binding) return this.block(task, `步骤 ${nextStep.id} 缺少已验证能力绑定。`);
        const capability = this.dependencies.registry.getVersion(binding.capabilityId, binding.version, task.id);
        if (!capability) return this.block(task, `临时能力 ${binding.capabilityId} 已失效，请重新提交任务。`);
        task.currentStepId = nextStep.id;
        task.executionCheckpoint = {
          planner,
          capabilityName: capability.id,
          capabilityVersion: capability.version,
          stepBindings,
          completedStepIds: [...completedSteps],
          stepResults,
          currentStepId: nextStep.id,
          operationSequence: checkpoint?.currentStepId === nextStep.id ? checkpoint.operationSequence : 0,
        };
        this.setStatus(task, 'EXECUTING');
        const stepStarted = Date.now();
        this.event(task, 'step.started', { stepId: nextStep.id, capability: capability.id, version: capability.version });
        let result;
        try {
          result = await this.executeStep(
            task,
            capability.id,
            capability.version,
            withExecutionInput(runtimeInput, nextStep.input),
            planner,
            capability.manifest.permissions,
          );
        } catch (error) {
          const waitingForApproval = error instanceof ApprovalRequiredError || errorCode(error) === 'APPROVAL_REQUIRED';
          this.event(task, waitingForApproval ? 'step.paused' : 'step.failed', { stepId: nextStep.id,
            capability: capability.id, version: capability.version, durationMs: Date.now() - stepStarted,
            failureCode: waitingForApproval ? undefined : errorCode(error) });
          throw error;
        }
        if (!result.completed) {
          this.event(task, 'step.paused', { stepId: nextStep.id, capability: capability.id,
            version: capability.version, durationMs: Date.now() - stepStarted });
          return this.dependencies.store.getTask(task.id) ?? task;
        }
        lastOutput = result.output;
        stepResults.push({ stepId: nextStep.id, output: result.output, observedAt: new Date().toISOString() });
        completedSteps.add(nextStep.id);
        if (capability.status === 'canary') {
          this.dependencies.registry.promote(capability.id, capability.version, task.id);
          this.event(task, 'capability.activated', { name: capability.manifest.name, version: capability.version });
        }
        task.executionCheckpoint.completedStepIds = [...completedSteps];
        this.save(task);
        this.event(task, 'step.completed', { stepId: nextStep.id, capability: capability.id,
          version: capability.version, durationMs: Date.now() - stepStarted });
      }

      if (executedSteps >= this.dependencies.maxSteps) return this.fail(task, '任务超过最大步骤数，已停止循环。');
      if (planner.steps.length > 0 && completedSteps.size !== planner.steps.length) {
        return this.fail(task, '任务存在未完成的依赖步骤，已停止循环。');
      }

      if (this.dependencies.agents.runResponder && planner.steps.some(step => needsGroundedResponse(step.capabilityKey))) {
        if (stepResults.length !== planner.steps.length) return this.block(task, '缺少已完成步骤的结果，无法据此生成可靠回答。');
        const results = stepResults.map(result => {
          const step = planner.steps.find(item => item.id === result.stepId);
          if (step?.capabilityKey === 'network.request' && typeof step.input?.url === 'string'
            && isNewsSearchUrl(step.input.url)) {
            const response = result.output && typeof result.output === 'object'
              ? result.output as Record<string, unknown> : {};
            const articles = response.ok === true && typeof response.body === 'string'
              ? parseNewsRss(response.body) : [];
            if (articles.length > 0) this.event(task, 'research.searched', {
              sourceCount: articles.length,
              sources: sanitizeAnswerSources(articles.map(article => ({ title: article.title, url: article.url }))),
            });
            return { ...result, output: { status: response.status, ok: response.ok, articles } };
          }
          return { ...result, sourceUrl: step?.capabilityKey === 'network.request' && typeof step.input?.url === 'string'
            ? publicSourceUrl(step.input.url) : undefined };
        });
        if (planner.steps.some(step => step.capabilityKey === 'network.request'
          && typeof step.input?.url === 'string' && isNewsSearchUrl(step.input.url))
          && !results.some(result => result.output && typeof result.output === 'object'
            && Array.isArray((result.output as { articles?: unknown }).articles)
            && (result.output as { articles: unknown[] }).articles.length > 0)) {
          return this.block(task, '新闻检索未返回可核对的文章，暂时无法可靠回答。');
        }
        return await this.completeAnswer(task, planner, results);
      } else {
        task.result = formatResult(lastOutput);
      }
      this.finishActiveRound(task);
      task.executionCheckpoint = undefined;
      this.setStatus(task, 'COMPLETED');
      this.event(task, 'task.completed', {});
      return task;
    } catch (error) {
      if (error instanceof ApprovalRequiredError || errorCode(error) === 'APPROVAL_REQUIRED') return this.dependencies.store.getTask(taskId) ?? task;
      if (error instanceof PermissionDeniedError || errorCode(error) === 'PERMISSION_DENIED') {
        task.result = `任务已停止：${error instanceof Error ? error.message : '权限被拒绝。'}`;
        task.executionCheckpoint = undefined;
        this.setStatus(task, 'CANCELLED');
        this.event(task, 'task.cancelled', { reason: 'permission-denied' });
        return task;
      }
      if (error instanceof OperationUncertainError || errorCode(error) === 'OPERATION_UNKNOWN') {
        return this.block(task, error instanceof Error ? error.message : '操作状态无法确认，未重放以避免重复副作用。');
      }
      return this.fail(task, error instanceof Error ? error.message : '任务执行失败。');
    } finally {
      if (isTerminal(task.status)) this.dependencies.registry.releaseTask(task.id);
    }
  }

  private async implementPlannedFiles(task: TaskRun, planner: PlannerDecision): Promise<boolean> {
    const files = planner.steps.flatMap(step => {
      const input = step.input;
      if (step.capabilityKey !== 'filesystem.write_text' || !input || typeof input.path !== 'string'
        || !input.generation || typeof input.generation !== 'object') return [];
      return [{ path: input.path, instruction: String((input.generation as { instruction: string }).instruction) }];
    });
    if (!files.length) return true;
    const agents = this.dependencies.agents;
    if (!agents.runFileImplementer) {
      this.block(task, '计划需要逐文件生成源码，但文件实施 Agent 不可用；未执行任何文件写入。');
      return false;
    }
    this.setStatus(task, 'IMPLEMENTING_FILES');
    const previousFiles: Array<{ path: string; content: string }> = [];
    for (const step of planner.steps) {
      const plannedInput = step.input;
      const generation = step.capabilityKey === 'filesystem.write_text' ? plannedInput?.generation : undefined;
      if (!generation || typeof generation !== 'object') continue;
      if (typeof plannedInput?.path !== 'string') {
        this.fail(task, `步骤 ${step.id} 缺少文件路径，未执行文件写入。`);
        return false;
      }
      const path = plannedInput.path;
      const instruction = String((generation as { instruction: string }).instruction);
      let feedback: string | undefined;
      let previousFailure: string | undefined;
      for (;;) {
        try {
          // Keep AgentRunner as the method receiver: extracting the method
          // loses `this.gateway` in production, despite stateless test doubles passing.
          const content = await agents.runFileImplementer({ taskId: task.id, message: task.message, path, instruction,
            files, previousFiles: previousFiles.map(file => ({ path: file.path, content: file.content.slice(0, 4_000) })),
            feedback, permissionMode: task.permissionMode,
            onResearch: sources => this.event(task, 'research.searched', {
              sourceCount: sources.length, sources: sanitizeAnswerSources(sources) }) });
          if (!content.trim()) throw new Error('文件实施 Agent 返回了空内容。');
          step.input = { path, content };
          previousFiles.push({ path, content });
          this.event(task, 'file.implemented', { stepId: step.id });
          break;
        } catch (error) {
          feedback = error instanceof Error ? error.message : String(error);
          if (error instanceof TypeError) {
            this.block(task, `文件实施 Agent 出现程序或连接异常，重复生成文件无法修复：${feedback}`);
            return false;
          }
          const fingerprint = `${error instanceof Error ? error.name : 'Error'}:${feedback}`;
          if (fingerprint === previousFailure) {
            this.block(task, `文件实施 Agent 连续返回相同错误，已停止无进展重试：${feedback}`);
            return false;
          }
          previousFailure = fingerprint;
          const started = await this.beginCorrectiveRound(task, {
            stage: 'execution', code: 'FILE_IMPLEMENTATION_FAILED', reason: feedback, stepId: step.id,
          }, 'plan_or_input', { confirmedToolDefect: false, safeToReplay: true }, 'revise_plan_or_input');
          if (!started) return false;
          this.setStatus(task, 'IMPLEMENTING_FILES');
        }
      }
    }
    return true;
  }

  private loadSessionMemory(task: TaskRun): SessionMemorySnapshot | undefined {
    return task.sessionId ? this.dependencies.sessionMemory?.loadSnapshot(task.sessionId) ?? undefined : undefined;
  }

  private async completeAnswer(task: TaskRun, planner: PlannerDecision,
    results: Array<{ stepId: string; sourceUrl?: string; output: unknown; observedAt: string }>, initialAnswer?: string): Promise<TaskRun> {
    let answer = initialAnswer;
    const sessionMemory = this.loadSessionMemory(task);
    const isDraftAnswer = planner.intent === 'draft presentation copy';
    if (answer === undefined) {
      try {
        const resumedAnswerFailure = task.correctionState.currentRound?.target === 'answer'
          ? task.correctionState.failures.at(-1) : undefined;
        answer = await this.dependencies.agents.runResponder!({ taskId: task.id,
          message: task.message, acceptanceCriteria: planner.acceptanceCriteria, results,
          feedback: resumedAnswerFailure, sessionMemory });
      } catch {
        return this.block(task, '回答 Agent 当前不可用，已验证的步骤结果仍保留。');
      }
    }
    // Conversational answers involve no tool calls and no external facts, so the
    // review and evaluation gates have no evidence to add — the planner contract
    // already guarantees a non-empty reply. Return the model's answer directly.
    if (planner.status === 'answer' && planner.steps.length === 0 && !isDraftAnswer) {
      task.result = answer;
      task.executionCheckpoint = undefined;
      this.finishActiveRound(task);
      this.setStatus(task, 'COMPLETED');
      this.event(task, 'task.completed', { reason: 'answer-direct' });
      return task;
    }
    for (;;) {
      this.setStatus(task, 'TEST_REVIEW');
      const round = task.correctionState.currentRound;
      if (round) {
        round.phase = 'test';
        this.save(task);
      }
      let review: Awaited<ReturnType<TestAgent['reviewAnswer']>>;
      try {
        review = await this.dependencies.tester.reviewAnswer(task.id, { answer,
          criteria: planner.acceptanceCriteria, verifiedStepIds: results.map(item => item.stepId),
          requiredStepIds: planner.steps.map(item => item.id), isCasualChat: planner.casual === true });
      } catch {
        return this.block(task, '测试 Agent 无法验证回答，任务未继续执行。');
      }
      this.event(task, 'test.report', { mode: 'answer_review',
        passed: review.verdict === 'pass' ? 1 : 0, failed: review.verdict === 'fail' ? 1 : 0,
        blocked: review.verdict === 'blocked' ? 1 : 0,
        reason: review.verdict === 'pass' ? null : review.reason.slice(0, 120) });
      if (review.verdict === 'blocked') return this.block(task, `回答测试证据不足：${review.reason}`);
      this.setStatus(task, 'EVALUATING');
      if (round) {
        round.phase = 'evaluate';
        this.save(task);
      }
      let evaluation: Awaited<ReturnType<AgentRunner['runEvaluator']>>;
      try {
        evaluation = await this.dependencies.agents.runEvaluator({
          taskId: task.id, target: planner.status === 'answer' ? 'answer' : 'task-answer', phase: 'execution',
          output: planner.status === 'answer'
            ? { message: task.message, answer, toolResults: [] }
            : { message: task.message, answer, results },
          acceptanceCriteria: planner.acceptanceCriteria,
          isCasualChat: planner.casual === true,
        });
      } catch (error) {
        if (errorCode(error) === 'EVALUATOR_OUTPUT_INVALID') {
          const reason = sanitizeCorrectionFailure({ stage: 'answer', code: 'EVALUATOR_OUTPUT_INVALID',
            reason: error instanceof Error ? error.message : '评估输出不符合契约' }).reason;
          return this.block(task, `评估 Agent 输出格式未通过校验：${reason}；本轮不计数，已验证的结果仍保留。`);
        }
        return this.block(task, '评估 Agent 当前不可用；本轮不计数，已验证的结果仍保留。');
      }
      const passed = review.verdict === 'pass' && answer.trim() && evaluation.status === 'pass';
      const rawFailure: CorrectionFailure = {
        stage: review.verdict === 'fail' ? 'test' : 'answer',
        code: review.verdict === 'fail' ? 'ANSWER_TEST_FAILED' : evaluation.failures[0]?.code ?? 'ANSWER_EVALUATION_FAILED',
        reason: review.verdict === 'fail' ? review.reason
          : evaluation.failures.map(item => item.message).filter(Boolean).join('；') || '评估未提供可执行的错误信息',
      };
      const failure = sanitizeCorrectionFailure(rawFailure);
      if (round) {
        const updated = this.dependencies.store.finishCorrectionRound(task.id, round.id, passed ? undefined : failure);
        Object.assign(task, updated);
      }
      if (passed) {
        task.result = answer;
        task.executionCheckpoint = undefined;
        const sources = sanitizeAnswerSources(results.flatMap(result => {
          const response = result.output && typeof result.output === 'object'
            ? result.output as { articles?: unknown } : {};
          return [
            ...(result.sourceUrl ? [{ title: '', url: result.sourceUrl }] : []),
            ...(Array.isArray(response.articles) ? response.articles.map(article => {
              const item = article && typeof article === 'object' ? article as Record<string, unknown> : {};
              return { title: item.title, url: item.url };
            }) : []),
          ];
        }));
        if (sources.length) this.event(task, 'answer.sources', { sources });
        this.setStatus(task, 'COMPLETED');
        this.event(task, 'task.completed', { reason: 'answer' });
        return task;
      }
      if (!round) {
        task.correctionState.failures = [...task.correctionState.failures, failure].slice(-6);
        this.save(task);
      }
      if (task.correctionState.roundsUsed >= Math.min(MAX_CORRECTION_ROUNDS, this.dependencies.maxRetries)) {
        const attempted = task.correctionState.failures.map(item => item.code).join(' → ');
        return this.fail(task, `最终回答经过 ${task.correctionState.roundsUsed} 个完整纠正回合仍未通过。最后失败原因：${failure.reason}。尝试摘要：${attempted}。`);
      }
      if (isDraftAnswer ? !this.dependencies.agents.runDraftCorrection : !this.dependencies.agents.runResponder) {
        return this.fail(task, `回答评估未通过：${failure.reason}；缺少对应的回答纠正能力。`);
      }
      let proposed: Awaited<ReturnType<NonNullable<AgentServices['runCorrection']>>>;
      try {
        proposed = this.dependencies.agents.runCorrection
          ? await this.dependencies.agents.runCorrection({ taskId: task.id, request: task.message,
            failure, safeToReplay: false })
          : { action: 'revise_answer', reason: failure.reason };
      } catch {
        return this.block(task, `主 Agent 当前无法决定回答修正方向：${failure.reason}`);
      }
      const decision = routeCorrection(proposed, { confirmedToolDefect: false, safeToReplay: false });
      if (decision.action !== 'revise_answer') return this.block(task, `无法安全修正回答：${decision.reason}`);
      task.correctionState = beginCorrection(task.correctionState, 'answer', randomUUID());
      this.setStatus(task, 'RETRYING');
      this.event(task, 'correction.round_started', { ordinal: task.correctionState.currentRound!.ordinal, target: 'answer' });
      task.correctionState.currentRound!.phase = 'implement';
      this.save(task);
      try {
        const correctionInput: ResponseInput = { taskId: task.id, message: task.message,
          acceptanceCriteria: planner.acceptanceCriteria, results, feedback: failure, previousAnswer: answer,
          sessionMemory };
        answer = isDraftAnswer
          ? await this.dependencies.agents.runDraftCorrection!(correctionInput)
          : await this.dependencies.agents.runResponder!(correctionInput);
      } catch (error) {
        const reason = sanitizeCorrectionFailure({ stage: 'answer', code: 'ANSWER_CORRECTION_UNAVAILABLE',
          reason: error instanceof Error ? error.message : '未知错误' }).reason;
        return this.block(task, `回答纠正当前不可用：${reason}；本轮未计数。`);
      }
    }
  }

  private async ensureCapabilities(task: TaskRun, planner: PlannerDecision, runtimeInput: Record<string, unknown>): Promise<CapabilityOutcome> {
    const bindings: StepBinding[] = [];
    for (const step of planner.steps) {
      const key = step.capabilityKey ?? (planner.requiredCapabilities.length === 1 ? planner.requiredCapabilities[0]!.name : '');
      if (!key) return { state: 'failed', message: `步骤 ${step.id} 没有明确能力键，无法安全绑定工具。` };
      const required = planner.requiredCapabilities.find((item) => item.name === key)
        ?? { name: key, purpose: step.description, riskLevel: 'medium' as const };
      const executionInput = step.input ?? {};
      const legacy = !step.capabilityKey;
      const existing = [this.dependencies.registry.findUsableByKey(key, task.id),
        ...(legacy ? [this.dependencies.registry.findUsableByIntent(planner.intent, task.id), this.dependencies.registry.getUsable(required.name, task.id)] : [])]
        .find((capability) => capability
          && (capability.status === 'active' || capability.manifest.provenance.sourceTaskId === task.id
            || capability.manifest.provenance.sourceTaskId === 'builtin'
            || capability.manifest.provenance.migratedFromActive)) ?? null;
      let previousToolFailure: string | undefined;
      if (existing) {
        let dryRunFailure: unknown;
        try {
          await this.dependencies.sandbox.run(existing.code, withExecutionInput(runtimeInput, executionInput), { mode: 'dry-run' });
        } catch (error) {
          dryRunFailure = error;
        }
        if (!dryRunFailure) {
          try {
            await this.verifySandbox(task, existing.id, existing.code, existing.manifest.permissions,
              withExecutionInput(runtimeInput, executionInput), planner.acceptanceCriteria);
          } catch {
            return { state: 'blocked', message: `已保存能力 ${existing.id}@${existing.version} 的测试未完成；不能据此判定工具有缺陷。` };
          }
          bindings.push({ stepId: step.id, capabilityKey: key, capabilityId: existing.id, version: existing.version });
          task.metrics.reusedCapabilityCount += 1;
          this.event(task, 'capability.reused', { name: existing.manifest.name, version: existing.version });
          continue;
        }
        previousToolFailure = `Previously saved capability ${existing.id}@${existing.version} failed the current dry-run contract: ${dryRunFailure instanceof Error ? dryRunFailure.message : String(dryRunFailure)}`;
        if (existing.manifest.provenance.sourceTaskId === 'builtin') {
          return { state: 'failed', message: previousToolFailure };
        }
        if (!isConfirmedDryRunContractFailure(dryRunFailure)) {
          return { state: 'blocked', message: `能力 ${existing.id}@${existing.version} 的本次输入执行失败，但未证实是工具契约缺陷；旧版本保持不变。` };
        }
        const approved = await this.beginCorrectiveRound(task, {
          stage: 'tool', code: 'TOOL_DRY_RUN_FAILED', reason: previousToolFailure,
          stepId: step.id, capabilityId: existing.id, version: existing.version,
        }, 'generated_tool', {
          sourceTaskId: existing.manifest.provenance.sourceTaskId,
          confirmedToolDefect: true, safeToReplay: true,
        }, 'rebuild_generated_tool');
        if (!approved) return { state: 'stopped' };
        this.dependencies.registry.deprecate(existing.id, existing.version, task.id);
        this.event(task, 'capability.quarantined', { name: existing.manifest.name, version: existing.version, reason: 'confirmed dry-run bridge or policy contract failure' });
      }

      if (!legacy && !key.startsWith('dynamic.')) {
        return { state: 'failed', message: `内置能力 ${key} 不可用，不能改由模型生成未经验证的替代工具。` };
      }

      this.setStatus(task, 'CAPABILITY_BUILDING');
      let published = false;
      let latestFailure = previousToolFailure ?? '没有通过能力评估的候选工具。';
      for (;;) {
        try {
          const candidate = await this.dependencies.factory.build({
            taskId: task.id,
            intent: required.purpose,
            name: required.name,
            capabilityKey: key.startsWith('dynamic.') ? key : undefined,
            taskContext: {
              message: String(runtimeInput.message ?? ''),
              attachments: runtimeInput.attachments as Array<{ filename: string; content: string }>,
              workspaceRoot: String(runtimeInput.workspaceRoot ?? ''),
              desktopDirectory: String(runtimeInput.desktopDirectory ?? ''),
              executionInput,
            },
            feedback: task.correctionState.currentRound ? latestFailure : previousToolFailure,
            permissionMode: task.permissionMode,
            onResearch: sources => this.event(task, 'research.searched', {
              sourceCount: sources.length, sources: sanitizeAnswerSources(sources) }),
          });
          const toolTest = await this.dependencies.sandbox.run(candidate.code, withExecutionInput(runtimeInput, executionInput), { mode: 'dry-run' });
          if (key.startsWith('dynamic.')) {
            const fixtures = deriveGenericityFixtures(withExecutionInput(runtimeInput, executionInput));
            if (!fixtures) throw new Error('Cannot derive two distinct legal inputs for genericity testing.');
            const genericity = await verifyGenericity(candidate, fixtures, this.dependencies.sandbox);
            if (!genericity.passed) throw new Error(`Cross-input genericity test failed: ${genericity.reason}`);
          }
          await this.verifySandbox(task, candidate.name, candidate.code, candidate.permissions,
            withExecutionInput(runtimeInput, executionInput), planner.acceptanceCriteria);
          const evaluation = await this.dependencies.agents.runEvaluator({
            taskId: task.id,
            target: candidate.name,
            phase: 'tool',
            output: toolTest.output,
            acceptanceCriteria: ['generated tool executes in the dry-run sandbox'],
          });
          if (evaluation.status === 'pass') {
            this.dependencies.registry.registerTemporary(candidate, evaluation, task.id);
            bindings.push({ stepId: step.id, capabilityKey: key, capabilityId: candidate.id, version: candidate.version });
            task.metrics.generatedCapabilityCount += 1;
            this.event(task, 'capability.temporary_registered', { name: candidate.name, version: candidate.version });
            published = true;
            break;
          }
          if (evaluation.status === 'wait_approval') {
            return { state: 'blocked', message: '能力评估要求审批，但未关联到具体宿主操作，已拒绝模糊审批请求。' };
          }
          latestFailure = evaluation.failures.map((failure) => failure.message).filter(Boolean).join('；') || `候选评分 ${evaluation.score} 未达到通过标准。`;
          const retry = await this.beginCorrectiveRound(task, { stage: 'tool',
            code: evaluation.failures[0]?.code ?? 'TOOL_EVALUATION_FAILED', reason: latestFailure,
            capabilityId: candidate.id, version: candidate.version }, 'generated_tool',
          { sourceTaskId: task.id, confirmedToolDefect: true, safeToReplay: true }, 'rebuild_generated_tool');
          if (!retry) return { state: 'stopped' };
        } catch (error) {
          latestFailure = error instanceof Error ? error.message : String(error);
          const retry = await this.beginCorrectiveRound(task, { stage: 'tool', code: 'CAPABILITY_ERROR',
            reason: latestFailure }, 'generated_tool',
          { sourceTaskId: task.id, confirmedToolDefect: true, safeToReplay: true }, 'rebuild_generated_tool');
          if (!retry) return { state: 'stopped' };
        }
      }
      if (!published) return { state: 'failed', message: `能力 ${required.name} 未通过评估：${latestFailure}` };
    }
    return { state: 'ready', bindings };
  }

  private async verifySandbox(task: TaskRun, name: string, code: string, permissions: import('../domain/contracts.js').CapabilityPermission[],
    input: Record<string, unknown>, acceptanceCriteria: string[]): Promise<void> {
    this.setStatus(task, 'TEST_PLANNING');
    const plan = await this.dependencies.tester.generate(task.id, { name, permissions, executionInput: input, acceptanceCriteria });
    this.setStatus(task, 'TESTING_SANDBOX');
    const report = await this.dependencies.testExecutor.runSandbox(code, plan, input);
    this.report(task, report);
    this.setStatus(task, 'TEST_REVIEW');
    const review = await this.dependencies.tester.review(task.id, report, {
      maintainedNetwork: isMaintainedNetwork(name, code, permissions),
      maintainedFilesystemRead: isMaintainedFilesystemRead(name, code, permissions),
      maintainedPresentation: isMaintainedPresentation(name, code, permissions),
      maintainedBuiltin: isMaintainedBuiltin(name, code),
    });
    if (review.verdict !== 'pass') throw new Error(`Sandbox tests ${review.verdict}: ${report.reason ?? 'test agent rejected evidence'}`);
  }

  private async executeStep(
    task: TaskRun,
    capabilityName: string,
    capabilityVersion: string,
    input: unknown,
    planner: PlannerDecision,
    permissions: import('../domain/contracts.js').CapabilityPermission[],
  ): Promise<{ completed: boolean; output?: unknown }> {
    let latestFailure = '执行未通过评估。';
    let cachedHostOutcome: { inputSignature: string; output: unknown; report: TestReport } | undefined;
    for (;;) {
      try {
        let verifiedMaintainedOperation = false;
        const checkpoint = task.executionCheckpoint;
        const inputSignature = JSON.stringify(input);
        const reuseVerifiedHostOutcome = permissions.length > 0 && cachedHostOutcome?.inputSignature === inputSignature;
        const output = reuseVerifiedHostOutcome ? cachedHostOutcome!.output : await this.dependencies.registry.callTool(capabilityName, input, {
          taskId: task.id,
          mode: task.permissionMode,
          workspaceRoot: this.dependencies.workspaceRoot ?? process.cwd(),
          stepId: task.currentStepId ?? 'unknown',
          operationSequence: checkpoint?.operationSequence ?? 0,
          capabilityVersion,
          hostCall: async (call, context) => {
            if (!this.dependencies.permissionBroker) {
              return { callId: call.callId, ok: false, error: { code: 'HOST_BROKER_UNAVAILABLE', message: 'Permission broker is not configured.' } };
            }
            const permissionOperation: PermissionOperation = {
              operationId: `${task.id}:${context.stepId}:${capabilityVersion}:${context.operationSequence}`,
              permission: call.permission,
              action: call.action,
              target: call.target,
              reason: call.reason,
              arguments: call.arguments,
            };
            try {
              const value = await this.dependencies.permissionBroker.handle(task.id, permissionOperation, context);
              return { callId: call.callId, ok: true, value };
            } catch (error) {
              return {
                callId: call.callId,
                ok: false,
                error: { code: errorCode(error), message: error instanceof Error ? error.message : String(error) },
              };
            }
          },
        });
        if (permissions.length > 0) {
          this.setStatus(task, 'TEST_PLANNING');
          let plan: Awaited<ReturnType<TestAgent['generate']>>;
          try {
            plan = await this.dependencies.tester.generate(task.id, {
              name: capabilityName, permissions, executionInput: input as Record<string, unknown>, acceptanceCriteria: planner.acceptanceCriteria,
            });
          } catch {
            this.report(task, summarize([{ id: 'test-plan', mode: 'live_observation', status: 'blocked',
              codes: ['TEST_PLAN_UNAVAILABLE'], evidence: [] }], 'live_observation'));
            this.block(task, '测试 Agent 无法生成真实验证计划；宿主操作不会重放。');
            return { completed: false };
          }
          this.setStatus(task, 'TESTING_LIVE');
          const report = reuseVerifiedHostOutcome ? cachedHostOutcome!.report
            : await this.dependencies.testExecutor.runLive(this.dependencies.store, task.id,
            task.currentStepId ?? 'unknown', capabilityVersion, permissions, plan, this.dependencies.desktopObserver,
            typeof (input as Record<string, unknown>).applicationId === 'string'
              ? (input as Record<string, string>).applicationId
              : typeof (input as Record<string, unknown>).appId === 'string'
                ? (input as Record<string, string>).appId
                : undefined,
            typeof (input as Record<string, unknown>).path === 'string'
              ? (input as Record<string, string>).path : undefined,
            checkpoint?.operationSequence ?? 0);
          this.report(task, report);
          this.setStatus(task, 'TEST_REVIEW');
          const capability = this.dependencies.registry.getVersion(capabilityName, capabilityVersion, task.id);
          const maintainedNetwork = capability?.manifest.provenance.sourceTaskId === 'builtin'
            && isMaintainedNetwork(capabilityName, capability.code, permissions);
          const maintainedFilesystemRead = capability?.manifest.provenance.sourceTaskId === 'builtin'
            && isMaintainedFilesystemRead(capabilityName, capability.code, permissions);
          const maintainedPresentation = capability?.manifest.provenance.sourceTaskId === 'builtin'
            && isMaintainedPresentation(capabilityName, capability.code, permissions);
          const maintainedBuiltin = capability?.manifest.provenance.sourceTaskId === 'builtin'
            && isMaintainedBuiltin(capabilityName, capability.code);
          let review: Awaited<ReturnType<TestAgent['review']>>;
          try {
            review = await this.dependencies.tester.review(task.id, report,
              { maintainedNetwork, maintainedFilesystemRead, maintainedPresentation, maintainedBuiltin });
          } catch {
            this.report(task, summarize([{ id: 'test-review', mode: 'live_observation', status: 'blocked',
              codes: ['TEST_REVIEW_UNAVAILABLE'], evidence: [] }], 'live_observation'));
            this.block(task, '测试 Agent 无法判读真实验证证据；宿主操作不会重放。');
            return { completed: false };
          }
          if (review.verdict === 'blocked') {
            this.block(task, `真实测试无法验证：${report.reason ?? '关键条件缺少证据。'}`);
            return { completed: false };
          }
          if (review.verdict === 'fail') {
            latestFailure = `真实测试失败：${report.reason ?? '测试 Agent 拒绝证据。'}`;
            if (!this.safeToRetry(task, capabilityVersion)) {
              this.block(task, `${latestFailure} 已执行的宿主操作不能安全自动重放。`);
              return { completed: false };
            }
            const revised = await this.reviseStep(task, planner, input, capabilityName, capabilityVersion,
              { stage: 'test', code: 'LIVE_TEST_FAILED', reason: latestFailure,
                stepId: task.currentStepId, capabilityId: capabilityName, version: capabilityVersion });
            if (!revised) return { completed: false };
            input = revised;
            continue;
          }
          cachedHostOutcome = { inputSignature, output, report };
          // For maintained host operations, the authorized journal and live
          // postcondition are stronger evidence than a second model's guess
          // from a return flag such as created:false. Generated capabilities
          // still require the independent execution evaluator below.
          verifiedMaintainedOperation = maintainedBuiltin && report.passed > 0
            && report.failed === 0 && report.blocked === 0;
          const response = output && typeof output === 'object' ? output as Record<string, unknown> : null;
          if (verifiedMaintainedOperation && this.dependencies.agents.runResponder
            && ((maintainedNetwork && response?.ok === true && typeof response.status === 'number'
              && response.status >= 200 && response.status < 300)
              || (maintainedFilesystemRead && typeof response?.content === 'string')
              || (maintainedPresentation && typeof response?.path === 'string'
                && typeof response?.slideCount === 'number' && typeof response?.sha256 === 'string'))) {
            // The user-facing answer has an independent final evaluation.
            return { completed: true, output };
          }
        }
        this.setStatus(task, 'EVALUATING');
        let evaluation: Awaited<ReturnType<AgentRunner['runEvaluator']>>;
        try {
          evaluation = await this.dependencies.agents.runEvaluator({
          taskId: task.id,
          target: capabilityName,
          phase: 'execution',
          output,
          verification: cachedHostOutcome?.report ? { mode: cachedHostOutcome.report.mode,
            passed: cachedHostOutcome.report.passed, failed: cachedHostOutcome.report.failed,
            blocked: cachedHostOutcome.report.blocked,
            codes: cachedHostOutcome.report.cases.flatMap(item => item.codes) } : undefined,
          acceptanceCriteria: this.dependencies.agents.runResponder && planner.steps.some(step => needsGroundedResponse(step.capabilityKey))
            ? [`Complete the operation: ${planner.steps.find(step => step.id === task.currentStepId)?.description ?? capabilityName}`,
              'The tool returned usable data for this step. The final user-facing answer is composed and evaluated after all steps.']
            : planner.steps.length > 1
              ? [`Complete this step: ${planner.steps.find(step => step.id === task.currentStepId)?.description ?? capabilityName}`]
              : planner.acceptanceCriteria,
          });
        } catch (error) {
          if (!verifiedMaintainedOperation) throw error;
          this.event(task, 'step.verified', { stepId: task.currentStepId, source: 'live_postcondition',
            evaluator: 'unavailable' });
          return { completed: true, output };
        }
        if (evaluation.status === 'pass') {
          return { completed: true, output };
        }
        if (verifiedMaintainedOperation && evaluation.status !== 'wait_approval') {
          // The evaluator only receives the operation's return object, not an
          // independent host observation. It cannot negate a passed live
          // postcondition or demand that later steps already be complete.
          this.event(task, 'step.verified', { stepId: task.currentStepId, source: 'live_postcondition',
            evaluator: 'conflicted', failureCode: evaluation.failures[0]?.code ?? 'EVALUATION_CONFLICT' });
          return { completed: true, output };
        }
        if (evaluation.status === 'wait_approval') {
          latestFailure = '评估器请求了审批，但没有具体宿主操作可授权。';
          this.block(task, latestFailure);
          return { completed: false };
        }
        latestFailure = evaluation.failures.map((failure) => failure.message).filter(Boolean).join('；') || `评估评分 ${evaluation.score} 未达到通过标准。`;
        if (!this.safeToRetry(task, capabilityVersion)) {
          this.block(task, `评估未通过：${latestFailure} 已执行的宿主操作不能安全自动重放。`);
          return { completed: false };
        }
        const revised = await this.reviseStep(task, planner, input, capabilityName, capabilityVersion,
          { stage: 'execution', code: evaluation.failures[0]?.code ?? 'STEP_EVALUATION_FAILED',
            reason: latestFailure, stepId: task.currentStepId, capabilityId: capabilityName, version: capabilityVersion });
        if (!revised) return { completed: false };
        input = revised;
      } catch (error) {
        const code = errorCode(error);
        if (code === 'APPROVAL_REQUIRED') return { completed: false };
        if (code === 'OPERATION_UNKNOWN') {
          this.block(task, error instanceof Error ? error.message : '操作状态无法确认，未重放。');
          return { completed: false };
        }
        if (!this.safeToRetry(task, capabilityVersion)) {
          this.block(task, '宿主操作结果未通过验证，自动重放可能产生重复副作用。');
          return { completed: false };
        }
        latestFailure = error instanceof Error ? error.message : String(error);
        const revised = await this.reviseStep(task, planner, input, capabilityName, capabilityVersion,
          { stage: 'execution', code: error instanceof HostOperationError ? error.code : 'EXECUTION_ERROR',
            reason: latestFailure, stepId: task.currentStepId, capabilityId: capabilityName, version: capabilityVersion });
        if (!revised) return { completed: false };
        input = revised;
      }
    }
  }

  private async reviseStep(task: TaskRun, planner: PlannerDecision, input: unknown,
    capabilityName: string, capabilityVersion: string, failure: CorrectionFailure): Promise<Record<string, unknown> | null> {
    const capability = this.dependencies.registry.getVersion(capabilityName, capabilityVersion, task.id);
    const started = await this.beginCorrectiveRound(task, failure, 'plan_or_input', {
      sourceTaskId: capability?.manifest.provenance.sourceTaskId,
      confirmedToolDefect: false, safeToReplay: this.safeToRetry(task, capabilityVersion),
    }, 'revise_plan_or_input');
    if (!started) return null;
    const stepId = task.currentStepId ?? '';
    const oldStep = planner.steps.find(item => item.id === stepId);
    if (!oldStep || !oldStep.input) {
      this.block(task, `纠错时找不到已绑定的步骤 ${stepId}，未重放宿主操作。`);
      return null;
    }
    let repairedInput: Record<string, unknown>;
    try {
      if (this.dependencies.agents.runStepRepair) {
        if (!oldStep.capabilityKey) throw new Error('步骤缺少能力绑定，无法进行局部修复。');
        const changes = await this.dependencies.agents.runStepRepair({ taskId: task.id, message: task.message,
          step: { id: oldStep.id, capabilityKey: oldStep.capabilityKey,
            description: oldStep.description, input: oldStep.input },
          failure: sanitizeCorrectionFailure(failure),
          workspaceRoot: this.dependencies.workspaceRoot ?? process.cwd(),
          desktopDirectory: this.dependencies.desktopDirectory ?? `${this.dependencies.workspaceRoot ?? process.cwd()}/Desktop`,
          completedStepIds: task.executionCheckpoint?.completedStepIds ?? [] });
        if (Object.keys(changes).some(key => ['__proto__', 'constructor', 'prototype', 'message',
          'attachments', 'workspaceRoot', 'desktopDirectory', 'capabilityKey'].includes(key))) {
          throw new Error('步骤补丁包含不允许修改的字段。');
        }
        repairedInput = validateStepInput(oldStep.capabilityKey, { ...oldStep.input, ...changes });
        if (isDeepStrictEqual(repairedInput, oldStep.input)) {
          this.block(task, `步骤 ${stepId} 的纠错没有改变参数，不能重复执行同一操作。原错误：${failure.reason}`);
          return null;
        }
      } else {
        // Compatibility for embedded AgentServices implementations that have
        // not yet adopted bounded step repair. Production AgentRunner has it.
        const revised = await this.dependencies.agents.runPlanner({ taskId: task.id, message: task.message,
          attachments: task.attachments.map(item => ({ filename: item.filename, content: item.content ?? '' })),
          workspaceRoot: this.dependencies.workspaceRoot ?? process.cwd(),
          desktopDirectory: this.dependencies.desktopDirectory ?? `${this.dependencies.workspaceRoot ?? process.cwd()}/Desktop`,
          feedback: sanitizeCorrectionFailure(failure), sessionMemory: this.loadSessionMemory(task) });
        const newStep = revised.steps.find(item => item.id === stepId);
        if (revised.status !== 'ready' || !newStep || oldStep.capabilityKey !== newStep.capabilityKey) {
          this.block(task, `修正后的计划没有保留步骤 ${stepId} 及其能力绑定，已停止以避免误用工具。`);
          return null;
        }
        if (!newStep.input) throw new Error('修正步骤缺少输入参数。');
        repairedInput = newStep.input;
      }
      if (oldStep.capabilityKey === 'process.launch'
        && repairedInput.applicationName !== oldStep.input.applicationName) {
        const resolution = await (this.dependencies.appResolver ?? resolveWindowsApplication)(String(repairedInput.applicationName));
        if (resolution.status !== 'resolved') {
          this.block(task, `修正后的应用名称无法安全解析：${resolution.reason}`);
          return null;
        }
        repairedInput = { ...repairedInput, executable: resolution.executable, applicationId: resolution.processName };
      }
    } catch (error) {
      this.block(task, `步骤纠错失败，未重放宿主操作：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    oldStep.input = repairedInput;
    if (task.executionCheckpoint) {
      task.executionCheckpoint.planner = planner;
      const usedSequences = this.dependencies.store.listStepOperations(task.id, stepId, capabilityVersion)
        .map(record => Number(record.operationId.split(':').at(-1)))
        .filter(Number.isInteger);
      task.executionCheckpoint.operationSequence = Math.max(task.executionCheckpoint.operationSequence,
        ...usedSequences.map(sequence => sequence + 1));
    }
    this.save(task);
    return withExecutionInput(input as Record<string, unknown>, repairedInput);
  }

  private safeToRetry(task: TaskRun, version: string): boolean {
    const operations = this.dependencies.store.listStepOperations(task.id, task.currentStepId ?? 'unknown', version);
    const capability = this.dependencies.registry.getVersion(task.executionCheckpoint?.capabilityName ?? '', version, task.id);
    if (!capability || (capability.manifest.permissions.length > 0 && operations.length === 0)) return false;
    return operations.every((record) => record.state === 'completed'
      && (record.operation.permission === 'filesystem.read'
        || (record.operation.permission === 'filesystem.write' && record.operation.action === 'mkdir')));
  }

  private finishActiveRound(task: TaskRun, failure?: CorrectionFailure): void {
    const round = task.correctionState.currentRound;
    if (round) {
      Object.assign(task, this.dependencies.store.finishCorrectionRound(task.id, round.id, failure));
    } else if (failure) {
      task.correctionState.failures = [...task.correctionState.failures, failure].slice(-6);
      this.save(task);
    }
  }

  private async beginCorrectiveRound(task: TaskRun, rawFailure: CorrectionFailure,
    target: 'answer' | 'plan_or_input' | 'generated_tool',
    evidence: { sourceTaskId?: string; confirmedToolDefect: boolean; safeToReplay: boolean },
    expectedAction: 'revise_answer' | 'revise_plan_or_input' | 'rebuild_generated_tool'): Promise<boolean> {
    const failure = sanitizeCorrectionFailure(rawFailure);
    this.finishActiveRound(task, failure);
    const category = classifyCorrectionFailure(failure);
    if (category === 'model_timeout') {
      this.block(task, `模型阶段超时；已保留已验证步骤，未把超时当作工具缺陷或重放宿主操作。${failure.reason}`);
      return false;
    }
    if (task.correctionState.roundsUsed >= Math.min(MAX_CORRECTION_ROUNDS, this.dependencies.maxRetries)) {
      const attempts = task.correctionState.failures.map(item => item.code).join(' → ');
      this.fail(task, `整个任务的 5 个完整纠正回合已用尽。最后失败原因：${failure.reason}。尝试摘要：${attempts}。`);
      return false;
    }
    let proposed: Awaited<ReturnType<NonNullable<AgentServices['runCorrection']>>>;
    try {
      proposed = this.dependencies.agents.runCorrection
        ? await this.dependencies.agents.runCorrection({ taskId: task.id, request: task.message,
          failure, safeToReplay: evidence.safeToReplay,
          existingCapability: evidence.sourceTaskId ? { id: failure.capabilityId ?? '',
            version: failure.version ?? '', sourceTaskId: evidence.sourceTaskId } : undefined })
        : { action: expectedAction, reason: failure.reason };
    } catch {
      this.block(task, `主 Agent 无法根据错误决定修正方向：${failure.reason}`);
      return false;
    }
    const decision = routeCorrection(proposed, evidence);
    if (decision.action !== expectedAction) {
      this.block(task, `无法安全继续纠正：${decision.reason}`);
      return false;
    }
    task.correctionState = beginCorrection(task.correctionState, target, randomUUID());
    this.setStatus(task, 'RETRYING');
    this.event(task, 'correction.round_started', {
      ordinal: task.correctionState.currentRound!.ordinal, target,
      failureCode: failure.code, category,
    });
    task.correctionState.currentRound!.phase = 'implement';
    this.save(task);
    return true;
  }

  private report(task: TaskRun, report: TestReport): void {
    this.event(task, 'test.report', reportForEvent(report));
  }

  private block(task: TaskRun, message: string): TaskRun {
    task.result = `任务已阻塞：${message}`;
    this.setStatus(task, 'BLOCKED');
    this.event(task, 'task.blocked', { reason: message });
    return task;
  }

  private setStatus(task: TaskRun, status: TaskRun['status']): void {
    task.status = status;
    this.save(task);
    this.event(task, 'task.status', { status });
  }

  private event(task: TaskRun, type: string, payload: Record<string, unknown>): void {
    this.dependencies.store.appendEvent(task.id, publicTaskEvent({ type, payload }));
  }

  private save(task: TaskRun): void {
    task.updatedAt = new Date().toISOString();
    this.dependencies.store.saveTask(task);
  }

  private fail(task: TaskRun, message: string): TaskRun {
    task.result = `任务未完成：${message}`;
    task.executionCheckpoint = undefined;
    this.setStatus(task, 'FAILED');
    this.event(task, 'task.failed', { message });
    return task;
  }
}

export class TaskService {
  constructor(
    private readonly store: SqliteStore,
    private readonly loop: AgentLoop,
    private readonly permissionBroker?: PermissionBroker,
    private readonly sessionTurns?: { onTaskTerminal(task: TaskRun): Promise<void> },
  ) {}

  async createAndWait(input: Parameters<SqliteStore['createTask']>[0]): Promise<TaskRun> {
    const task = this.store.createTask(this.withPresentationSource(input));
    return this.runAndRecord(task.id);
  }

  createAndStart(input: Parameters<SqliteStore['createTask']>[0]): TaskRun {
    const task = this.store.createTask(this.withPresentationSource(input));
    void this.runAndRecord(task.id);
    return task;
  }

  /** Runs the loop and, once terminal, hands the finished task to the session layer. */
  private async runAndRecord(taskId: string): Promise<TaskRun> {
    const task = await this.loop.run(taskId);
    if (this.sessionTurns) {
      try {
        await this.sessionTurns.onTaskTerminal(task);
      } catch {
        // A session bookkeeping failure must never fail the task itself.
      }
    }
    return task;
  }

  private withPresentationSource(input: Parameters<SqliteStore['createTask']>[0]): Parameters<SqliteStore['createTask']>[0] {
    if (!input.sourceTaskId) return input;
    if (!/(?:pptx?|powerpoint|演示文稿|幻灯片)/i.test(input.message)) {
      throw new Error('A source task may only be referenced by a presentation request.');
    }
    const source = this.store.getTask(input.sourceTaskId);
    if (!source || source.status !== 'COMPLETED' || !source.result || source.result.length > 200_000) {
      throw new Error('The source task must be completed and have a usable result.');
    }
    const content = source.result;
    return { ...input, attachments: [...input.attachments, {
      id: randomUUID(), filename: 'previous-presentation.md', mimeType: 'text/markdown',
      size: Buffer.byteLength(content, 'utf8'), content,
    }] };
  }

  async resumeWithInput(taskId: string, values: Record<string, unknown>): Promise<TaskRun> {
    const task = this.store.getTask(taskId);
    if (!task || task.status !== 'NEEDS_USER_INPUT') throw new Error('Task is not waiting for user input.');
    task.message = `${task.message}\n用户补充信息：${JSON.stringify(values)}`;
    task.status = 'INTAKE';
    this.store.saveTask(task);
    this.store.appendEvent(task.id, { type: 'task.input_received', payload: { fields: Object.keys(values) } });
    return this.runAndRecord(taskId);
  }

  async resolveApproval(taskId: string, requestId: string, approved: boolean): Promise<TaskRun> {
    if (!this.permissionBroker) throw new Error('Approval flow is not enabled.');
    const hadPendingRequest = this.store.getTask(taskId)?.pendingPermission?.requestId === requestId;
    try {
      await this.permissionBroker.resolve(taskId, requestId, approved);
    } catch (error) {
      if (!(error instanceof CapabilityUnavailableError)) throw error;
      const interrupted = this.store.getTask(taskId);
      if (!interrupted) throw error;
      interrupted.status = 'BLOCKED';
      interrupted.result = '任务已阻塞：服务重启后临时工具不再可用，请重新提交任务。';
      interrupted.executionCheckpoint = undefined;
      interrupted.updatedAt = new Date().toISOString();
      this.store.saveTask(interrupted);
      this.store.appendEvent(taskId, { type: 'task.blocked', payload: { reason: 'temporary capability unavailable' } });
      return interrupted;
    }
    const task = this.store.getTask(taskId);
    if (!task) throw new Error('Task not found.');
    if (!approved || !hadPendingRequest || isTerminal(task.status)) return task;
    if (task.status !== 'PLAN_READY') throw new Error('Approval was recorded, but the task checkpoint is not ready to resume.');
    return this.runAndRecord(taskId);
  }

  async resumeAfterRestart(): Promise<number> {
    const recoverable = new Set(this.store.listRecoverableTaskIds());
    let resumed = 0;
    for (const taskId of this.store.listInterruptedTaskIds()) {
      const task = this.store.getTask(taskId);
      if (!task) continue;
      if (recoverable.has(taskId)) {
        const checkpoint = task.executionCheckpoint;
        const currentVerified = checkpoint?.completedStepIds.includes(checkpoint.currentStepId) ?? false;
        const currentOperation = checkpoint && this.store.getOperation(taskId,
          `${taskId}:${checkpoint.currentStepId}:${checkpoint.capabilityVersion}:${checkpoint.operationSequence}`);
        const capability = checkpoint && this.store.getCapabilityVersion(checkpoint.capabilityName, checkpoint.capabilityVersion);
        const readOnly = capability?.manifest.permissions.length === 1 && capability.manifest.permissions[0] === 'filesystem.read';
        if (capability?.manifest.provenance.sourceTaskId === 'builtin'
          && (currentVerified || currentOperation?.state === 'completed' || readOnly)) {
          await this.runAndRecord(taskId);
          resumed += 1;
          continue;
        }
      }
      task.status = 'BLOCKED';
      task.result = '任务已阻塞：服务重启时任务仍在处理中，且没有可安全续验的操作检查点。没有自动重放；请重新提交任务。';
      task.updatedAt = new Date().toISOString();
      this.store.saveTask(task);
      this.store.appendEvent(taskId, { type: 'task.blocked', payload: { reason: 'interrupted without a safe checkpoint' } });
    }
    return resumed;
  }
}

function isPlannerDecision(value: unknown): value is PlannerDecision {
  return !!value && typeof value === 'object'
    && 'intent' in value && 'steps' in value && Array.isArray((value as { steps?: unknown }).steps)
    && 'requiredCapabilities' in value && Array.isArray((value as { requiredCapabilities?: unknown }).requiredCapabilities);
}

function createRuntimeInput(
  taskInput: { message: string; attachments: Array<{ filename: string; content?: string }> },
  workspaceRoot: string,
  desktopDirectory: string,
): Record<string, unknown> {
  return {
    message: taskInput.message,
    content: taskInput.attachments[0]?.content ?? '',
    attachments: taskInput.attachments.map((attachment) => ({
      filename: attachment.filename,
      content: attachment.content ?? '',
    })),
    workspaceRoot,
    desktopDirectory,
  };
}

function withExecutionInput(runtimeInput: Record<string, unknown>, executionInput?: Record<string, unknown>): Record<string, unknown> {
  const directPath = typeof executionInput?.path === 'string' && executionInput.path.trim()
    ? executionInput.path
    : undefined;
  const operation = executionInput?.operation;
  const nestedOperationPath = operation && typeof operation === 'object' && !Array.isArray(operation)
    && typeof (operation as Record<string, unknown>).path === 'string'
    && ((operation as Record<string, unknown>).path as string).trim()
    ? (operation as Record<string, unknown>).path as string
    : undefined;
  return {
    ...runtimeInput,
    ...executionInput,
    ...((directPath ?? nestedOperationPath) ? { path: directPath ?? nestedOperationPath } : {}),
    message: runtimeInput.message,
    attachments: runtimeInput.attachments,
    workspaceRoot: runtimeInput.workspaceRoot,
    desktopDirectory: runtimeInput.desktopDirectory,
  };
}

function isTerminal(status: TaskRun['status']): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED' || status === 'BLOCKED';
}

function isMaintainedNetwork(name: string, code: string, permissions: import('../domain/contracts.js').CapabilityPermission[]): boolean {
  return name === 'network.request' && code === getBuiltin('network.request')?.code
    && permissions.length === 1 && permissions[0] === 'network';
}

function isMaintainedFilesystemRead(name: string, code: string,
  permissions: import('../domain/contracts.js').CapabilityPermission[]): boolean {
  return name === 'filesystem.read_text' && code === getBuiltin('filesystem.read_text')?.code
    && permissions.length === 1 && permissions[0] === 'filesystem.read';
}

function isMaintainedPresentation(name: string, code: string,
  permissions: import('../domain/contracts.js').CapabilityPermission[]): boolean {
  return name === 'presentation.create' && code === getBuiltin('presentation.create')?.code
    && permissions.length === 1 && permissions[0] === 'filesystem.write';
}

/** Any built-in whose code still matches the maintained catalog: its sandbox plan is deterministic, not model-generated. */
function isMaintainedBuiltin(name: string, code: string): boolean {
  const builtin = getBuiltin(name);
  return builtin !== null && builtin.code === code;
}

function needsGroundedResponse(capabilityKey: string | undefined): boolean {
  return capabilityKey === 'network.request' || capabilityKey === 'filesystem.read_text'
    || capabilityKey === 'presentation.create';
}

function publicSourceUrl(value: string): string {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/key|token|secret|password|signature|authorization/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

function formatResult(output: unknown): string {
  if (output && typeof output === 'object' && 'count' in output) return `任务已完成：统计结果为 ${(output as { count: unknown }).count}`;
  if (output && typeof output === 'object' && 'path' in output && typeof (output as { path?: unknown }).path === 'string') {
    const value = output as { path: string; created?: boolean; removed?: boolean; bytesWritten?: number };
    if (value.created) return `任务已完成：已创建目录 ${value.path}`;
    if (value.removed) return `任务已完成：已删除 ${value.path}`;
    if (typeof value.bytesWritten === 'number') return `任务已完成：已写入 ${value.bytesWritten} 字节到 ${value.path}`;
  }
  return `任务已完成：${JSON.stringify(output)}`;
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
}
