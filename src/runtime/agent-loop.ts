import type { AgentRunner, PlannerDecision, PlannerInput, ResponseInput, StepReviewInput } from '../agents/agent-runner.js';
import type { TestAgent, TestPlan, TestReport } from '../agents/test-agent.js';
import { CapabilityRegistry } from '../capabilities/registry.js';
import { getBuiltin } from '../capabilities/builtin-catalog.js';
import { SandboxRunner } from '../capabilities/sandbox-runner.js';
import { ToolFactory } from '../capabilities/tool-factory.js';
import type { ExecutionCheckpoint, PermissionOperation, StepBinding, StepVerificationEvidence, TaskEvent, TaskRun } from '../domain/contracts.js';
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
import { parsePlannerDecision, validateStepInput } from '../agents/planner-contract.js';
import { ANSWER_RESULT_BUDGET, compactVerifiedResult } from '../agents/step-review-context.js';
import type { DelegationOptions, TaskCollaborationRuntime } from './task-collaboration.js';
import type { ToolDiscovery, ToolOption } from '../capabilities/tool-discovery.js';
import { inspectGitDestination, routineGitClone } from './git-clone-contract.js';
import { renderTaskResult, toolResultContent } from './task-result.js';

export type AgentServices = Pick<AgentRunner, 'runPlanner' | 'runEvaluator' | 'runImplementer'>
  & Partial<Pick<AgentRunner, 'runResponder' | 'runCorrection' | 'runDraftCorrection' | 'runFileImplementer' | 'runStepRepair' | 'runPlannerReview' | 'runToolSearch' | 'runToolSelection'>>;

class StepReviewRequiredError extends Error {
  constructor(readonly failure: CorrectionFailure, readonly safeToReplay: boolean,
    readonly output?: unknown) {
    super(failure.reason);
  }
}

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
  toolDiscovery?: ToolDiscovery;
  sandbox: SandboxRunner;
  budget: BudgetManager;
  scheduler: AdaptiveScheduler;
  collaboration?: TaskCollaborationRuntime;
  maxRetries: number;
  maxSteps: number;
  permissionBroker?: PermissionBroker;
  workspaceRoot?: string;
  desktopDirectory?: string;
  sessionMemory?: SessionMemoryPort;
  appResolver?: (name: string) => Promise<ApplicationResolution>;
  cancelModelTask?: (taskId: string) => void;
  clearModelCancellation?: (taskId: string) => void;
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
  private readonly cancellationRequested = new Set<string>();
  private readonly runningTasks = new Set<string>();
  constructor(private readonly dependencies: AgentLoopDependencies) {
    this.dependencies.registry.installBuiltins();
    this.dependencies.permissionBroker?.useCapabilityLookup((name, version, taskId) =>
      this.dependencies.registry.getVersion(name, version, taskId));
  }

  requestCancellation(taskId: string): boolean {
    if (!this.runningTasks.has(taskId)) return false;
    this.cancellationRequested.add(taskId);
    this.dependencies.cancelModelTask?.(taskId);
    return true;
  }

  private throwIfCancelled(task: TaskRun): void {
    if (this.cancellationRequested.has(task.id)) throw new Error('TASK_CANCELLED_BY_USER');
  }

  async run(taskId: string): Promise<TaskRun> {
    const task = this.dependencies.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (isTerminal(task.status) || task.status === 'WAITING_FOR_APPROVAL') return task;
    this.runningTasks.add(taskId);

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
          clarification: latestClarification(this.dependencies.store, task.id),
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
            task.result = renderTaskResult('COMPLETED', { summary: '当前需求无需执行工具。' });
            this.setStatus(task, 'COMPLETED');
            this.event(task, 'task.completed', { reason: 'no-work-required' });
            return task;
          }
          return this.fail(task, '任务计划需要执行步骤，但没有声明所需能力。');
        }
        if (planner.steps.length === 0) return this.block(task, '计划声明了宿主能力，但没有真实执行步骤，无法验证任务结果。');

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

      const dispatched = this.dependencies.collaboration?.ensurePlan(task.id, planner.steps, stepResults,
        this.delegationOptions(task.id, planner, stepBindings));
      if (dispatched) this.event(task, 'team.dispatched', {
        workerCount: dispatched.workerCount, assignedSteps: planner.steps.length,
        planVersion: dispatched.planVersion, stepIds: planner.steps.map(step => step.id) });
      this.setStatus(task, 'PLAN_READY');
      while (executedSteps < this.dependencies.maxSteps || task.executionCheckpoint?.pendingReview) {
        const pending = task.executionCheckpoint?.pendingReview;
        if (pending) {
          const attemptedStep = planner.steps.find(step => step.id === pending.stepId);
          if (!attemptedStep || !this.dependencies.agents.runPlannerReview
            || (pending.outcome === 'failure' && !pending.failure)) {
            return this.block(task, '待复盘步骤的计划或失败证据不完整，已停止继续执行。');
          }
          const reviewInput: StepReviewInput = {
            taskId: task.id, message: task.message, plan: planner,
            step: { id: attemptedStep.id, capabilityKey: attemptedStep.capabilityKey ?? '',
              description: attemptedStep.description, input: attemptedStep.input ?? {} },
            completedStepIds: [...completedSteps], results: stepResults,
            previousFailures: task.correctionState.failures.map(sanitizeCorrectionFailure),
            outcome: pending.outcome === 'failure'
              ? { status: 'failure', failure: sanitizeCorrectionFailure(pending.failure!), output: pending.output }
              : { status: 'success', output: pending.output ?? stepResults.find(result => result.stepId === pending.stepId)?.output },
            verification: pending.verification,
            safeToReplay: pending.safeToReplay, workspaceRoot, desktopDirectory,
          };
          let decision: Awaited<ReturnType<NonNullable<AgentServices['runPlannerReview']>>>;
          try {
            decision = await this.dependencies.agents.runPlannerReview(reviewInput);
          } catch (error) {
            if (pending.failure) this.finishActiveRound(task, pending.failure);
            return this.block(task, `规划 Agent 无法复盘步骤 ${pending.stepId} 的结果：${error instanceof Error ? error.message : String(error)}`);
          }
          this.event(task, 'plan.reviewed', { stepId: pending.stepId, outcome: pending.outcome,
            action: decision.action });
          this.dependencies.collaboration?.reviewStep(task.id, planner.steps, pending.stepId, decision.action);
          if (decision.action === 'block') {
            if (pending.failure) this.finishActiveRound(task, pending.failure);
            return this.block(task, decision.reason);
          }
          if (decision.action === 'continue') {
            if (pending.failure) {
              this.finishActiveRound(task, pending.failure);
              return this.block(task, '规划 Agent 不能在失败步骤未解决时继续原计划。');
            }
            this.finishActiveRound(task);
            task.executionCheckpoint!.pendingReview = undefined;
            this.save(task);
            continue;
          }
          if (decision.action !== 'replan') return this.block(task, '规划 Agent 返回了未知决策。');
          if (pending.failure) {
            this.finishActiveRound(task, pending.failure);
            if (task.correctionState.roundsUsed >= Math.min(MAX_CORRECTION_ROUNDS, this.dependencies.maxRetries)) {
              return this.fail(task, `全局重规划已达到 ${task.correctionState.roundsUsed} 轮上限：${pending.failure.reason}`);
            }
            task.correctionState = beginCorrection(task.correctionState, 'plan_or_input', randomUUID());
            task.correctionState.currentRound!.phase = 'implement';
            this.setStatus(task, 'RETRYING');
            this.event(task, 'correction.round_started', { ordinal: task.correctionState.currentRound!.ordinal,
              target: 'plan_or_input', failureCode: pending.failure.code });
          } else {
            this.finishActiveRound(task);
          }
          const adopted = await this.adoptReviewedPlan(task, planner, decision.plan, attemptedStep,
            completedSteps, stepBindings, runtimeInput, pending.safeToReplay);
          if (!adopted) return this.dependencies.store.getTask(task.id) ?? task;
          planner = adopted.planner;
          stepBindings = adopted.bindings;
          const reassigned = this.dependencies.collaboration?.ensurePlan(task.id, planner.steps, stepResults,
            this.delegationOptions(task.id, planner, stepBindings));
          if (reassigned) this.event(task, 'team.dispatched', {
            workerCount: reassigned.workerCount, assignedSteps: planner.steps.length,
            planVersion: reassigned.planVersion, stepIds: planner.steps.map(step => step.id) });
          continue;
        }
        const nextStep = this.dependencies.scheduler.nextReadyStep(planner, completedSteps);
        if (!nextStep) break;
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
        const peerResults = this.dependencies.collaboration?.beginStep(task.id, planner.steps, nextStep.id, stepResults) ?? {};
        if (nextStep.capabilityKey === 'filesystem.write_text' && nextStep.input?.generation
          && !await this.implementPlannedFiles(task, planner, completedSteps, stepResults, nextStep.id)) {
          if (task.executionCheckpoint.pendingReview) {
            this.dependencies.collaboration?.failStep(task.id, planner.steps, nextStep.id, 'FILE_IMPLEMENTATION_FAILED');
          }
          if (task.executionCheckpoint.pendingReview) continue;
          return this.dependencies.store.getTask(task.id) ?? task;
        }
        executedSteps += 1;
        this.setStatus(task, 'EXECUTING');
        const stepStarted = Date.now();
        this.event(task, 'step.started', { stepId: nextStep.id, capability: capability.id, version: capability.version });
        let result: { completed: boolean; output?: unknown; verification?: StepVerificationEvidence } | undefined;
        let reviewFailure: StepReviewRequiredError | undefined;
        try {
          result = await this.executeStep(
            task,
            capability.id,
            capability.version,
            withExecutionInput({ ...runtimeInput, peerResults }, nextStep.input),
            planner,
            capability.manifest.permissions,
          );
        } catch (error) {
          if (error instanceof StepReviewRequiredError) reviewFailure = error;
          const waitingForApproval = error instanceof ApprovalRequiredError || errorCode(error) === 'APPROVAL_REQUIRED';
          if (reviewFailure) {
            task.executionCheckpoint.pendingReview = { stepId: nextStep.id, outcome: 'failure',
              output: reviewFailure.output, failure: reviewFailure.failure,
              safeToReplay: reviewFailure.safeToReplay };
            this.save(task);
          }
          this.event(task, waitingForApproval ? 'step.paused' : 'step.failed', { stepId: nextStep.id,
            capability: capability.id, version: capability.version, durationMs: Date.now() - stepStarted,
            failureCode: waitingForApproval ? undefined : reviewFailure?.failure.code ?? errorCode(error) });
          if (!waitingForApproval) this.dependencies.collaboration?.failStep(task.id, planner.steps,
            nextStep.id, reviewFailure?.failure.code ?? errorCode(error));
          if (!reviewFailure) throw error;
        }
        if (!reviewFailure && !result?.completed) {
          this.event(task, 'step.paused', { stepId: nextStep.id, capability: capability.id,
            version: capability.version, durationMs: Date.now() - stepStarted });
          return this.dependencies.store.getTask(task.id) ?? task;
        }
        this.throwIfCancelled(task);
        if (!reviewFailure) {
          const observation = { stepId: nextStep.id, output: result!.output, observedAt: new Date().toISOString() };
          this.dependencies.collaboration?.completeStep(task.id, planner.steps, observation);
          lastOutput = result!.output;
          stepResults.push(observation);
          completedSteps.add(nextStep.id);
          if (capability.status === 'canary') {
            this.dependencies.registry.promote(capability.id, capability.version, task.id);
            this.event(task, 'capability.activated', { name: capability.manifest.name, version: capability.version });
          }
          task.executionCheckpoint.completedStepIds = [...completedSteps];
          task.executionCheckpoint.stepResults = stepResults;
          if (this.dependencies.agents.runPlannerReview) {
            task.executionCheckpoint.pendingReview = { stepId: nextStep.id, outcome: 'success',
              verification: result!.verification, safeToReplay: true };
          }
          this.save(task);
          this.event(task, 'step.completed', { stepId: nextStep.id, capability: capability.id,
            version: capability.version, durationMs: Date.now() - stepStarted });
        }
        if (task.executionCheckpoint.pendingReview) continue;
      }

      if (executedSteps >= this.dependencies.maxSteps && completedSteps.size !== planner.steps.length) {
        return this.fail(task, '任务达到最大步骤数，已停止循环。');
      }
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
          return { ...result, output: compactVerifiedResult(result.output, ANSWER_RESULT_BUDGET),
            sourceUrl: step?.capabilityKey === 'network.request' && typeof step.input?.url === 'string'
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
        const checkouts = planner.steps.filter(step => step.capabilityKey === 'process.run')
          .map(step => routineGitClone(step.input ?? {})).filter((item): item is NonNullable<typeof item> => item !== null);
        const existingSource = lastOutput && typeof lastOutput === 'object'
          ? lastOutput as { alreadyPresent?: unknown; source?: unknown } : {};
        const checkoutSummary = checkouts.length === 1 && existingSource.alreadyPresent === true
          ? existingSource.source === 'github-source-archive'
            ? `目标目录 ${checkouts[0]!.directory} 已有该仓库源码归档；未重复克隆，目录不含 Git 历史。`
            : `目标目录 ${checkouts[0]!.directory} 已有对应的 Git 仓库；未重复克隆。`
          : checkouts.length === 1
            ? `已将仓库拉取到 ${checkouts[0]!.directory}。`
          : undefined;
        task.result = renderTaskResult('COMPLETED', checkoutSummary
          ? { summary: checkoutSummary } : toolResultContent(lastOutput));
      }
      this.finishActiveRound(task);
      task.executionCheckpoint = undefined;
      this.setStatus(task, 'COMPLETED');
      this.event(task, 'task.completed', {});
      return task;
    } catch (error) {
      if (this.cancellationRequested.has(taskId)) {
        task.result = renderTaskResult('CANCELLED', { summary: '任务已停止，可发送新的任务。' });
        task.executionCheckpoint = undefined;
        task.pendingPermission = undefined;
        task.status = 'CANCELLED';
        task.updatedAt = new Date().toISOString();
        this.dependencies.store.saveTask(task);
        this.dependencies.store.appendEvent(taskId, { type: 'task.cancelled', payload: { reason: 'user-requested' } });
        return task;
      }
      if (error instanceof ApprovalRequiredError || errorCode(error) === 'APPROVAL_REQUIRED') return this.dependencies.store.getTask(taskId) ?? task;
      if (error instanceof PermissionDeniedError || errorCode(error) === 'PERMISSION_DENIED') {
        task.result = renderTaskResult('CANCELLED', { summary: error instanceof Error ? error.message : '权限被拒绝。' });
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
      this.cancellationRequested.delete(taskId);
      this.runningTasks.delete(taskId);
      this.dependencies.clearModelCancellation?.(taskId);
      if (isTerminal(task.status)) this.dependencies.registry.releaseTask(task.id);
    }
  }

  private async adoptReviewedPlan(task: TaskRun, previous: PlannerDecision, proposed: PlannerDecision,
    attemptedStep: PlannerDecision['steps'][number], completed: Set<string>, existingBindings: StepBinding[],
    runtimeInput: Record<string, unknown>, safeToReplay: boolean): Promise<{ planner: PlannerDecision; bindings: StepBinding[] } | null> {
    for (const stepId of completed) {
      const before = previous.steps.find(step => step.id === stepId);
      const after = proposed.steps.find(step => step.id === stepId);
      if (!before || !after || !isDeepStrictEqual(planStepSemantics(before), planStepSemantics(after))) {
        this.block(task, `全局重规划修改了已验证步骤 ${stepId}，已拒绝新计划。`);
        return null;
      }
    }
    let planner: PlannerDecision;
    try {
      const normalized = { ...proposed, steps: proposed.steps.map(step => {
        if (!completed.has(step.id) || step.capabilityKey !== 'process.launch') return step;
        const { executable, applicationId, ...plannedInput } = step.input ?? {};
        return { ...step, input: plannedInput };
      }) };
      const validated = parsePlannerDecision(normalized);
      planner = { ...proposed, ...validated,
        steps: validated.steps.map(step => completed.has(step.id)
          ? previous.steps.find(item => item.id === step.id)! : step) };
    } catch (error) {
      this.block(task, `全局重规划未通过计划校验：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (planner.status !== 'ready' || planner.steps.length > this.dependencies.maxSteps) {
      this.block(task, '全局重规划没有提供可执行且在步骤预算内的计划。');
      return null;
    }
    const repeated = planner.steps.some(step => !completed.has(step.id)
      && step.capabilityKey === attemptedStep.capabilityKey
      && isDeepStrictEqual(step.input, attemptedStep.input));
    if (repeated) {
      const failure = task.executionCheckpoint?.pendingReview?.failure;
      const cause = failure ? ` 原错误：${sanitizeCorrectionFailure(failure).reason}` : '';
      this.block(task, `全局重规划仍会重复步骤 ${attemptedStep.id} 的同一操作，已拒绝新计划。${cause}`);
      return null;
    }
    if (!safeToReplay) {
      const ready = planner.steps.filter(step => !completed.has(step.id)
        && step.dependsOn.every(id => completed.has(id)));
      const remaining = planner.steps.filter(step => !completed.has(step.id));
      if (!ready.length || remaining.some(step => !isReadOnlyDiagnostic(step.capabilityKey ?? '', step.input ?? {}))) {
        this.block(task, '上一步宿主操作的效果尚不确定；新计划只能包含只读诊断。观察诊断结果后才能再次规划写入或启动。');
        return null;
      }
    }
    for (const step of planner.steps) {
      if (completed.has(step.id) || step.capabilityKey !== 'process.launch') continue;
      const resolution = await (this.dependencies.appResolver ?? resolveWindowsApplication)(String(step.input?.applicationName ?? ''));
      if (resolution.status !== 'resolved') {
        this.block(task, `新计划中的应用无法安全解析：${resolution.reason}`);
        return null;
      }
      step.input = { ...step.input, executable: resolution.executable, applicationId: resolution.processName };
    }
    const capabilities = await this.ensureCapabilities(task, planner, runtimeInput, completed, existingBindings);
    if (capabilities.state !== 'ready') {
      if (capabilities.state === 'failed') this.fail(task, capabilities.message);
      else if (capabilities.state === 'blocked') this.block(task, capabilities.message);
      return null;
    }
    task.acceptanceCriteria = [...new Set([...task.acceptanceCriteria, ...planner.acceptanceCriteria])];
    planner.acceptanceCriteria = task.acceptanceCriteria;
    if (task.executionCheckpoint) {
      task.executionCheckpoint.planner = planner;
      task.executionCheckpoint.stepBindings = capabilities.bindings;
      task.executionCheckpoint.completedStepIds = [...completed];
      task.executionCheckpoint.pendingReview = undefined;
    }
    this.save(task);
    this.event(task, 'plan.revised', { stepId: attemptedStep.id, remaining: planner.steps.length - completed.size });
    return { planner, bindings: capabilities.bindings };
  }

  private async implementPlannedFiles(task: TaskRun, planner: PlannerDecision, completed: Set<string>,
    results: Array<{ stepId: string; output: unknown; observedAt: string }>, onlyStepId: string): Promise<boolean> {
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
    const previousFiles: Array<{ path: string; content: string }> = planner.steps.flatMap(step =>
      completed.has(step.id) && step.capabilityKey === 'filesystem.write_text'
        && typeof step.input?.path === 'string' && typeof step.input?.content === 'string'
        ? [{ path: step.input.path, content: step.input.content }] : []);
    for (const step of planner.steps) {
      if (completed.has(step.id) || step.id !== onlyStepId) continue;
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
            verifiedResults: results.slice(-5).map(result => {
              const sourceStep = planner.steps.find(item => item.id === result.stepId);
              return { stepId: result.stepId, observedAt: result.observedAt,
                sourceUrl: sourceStep?.capabilityKey === 'network.request' && typeof sourceStep.input?.url === 'string'
                  ? publicSourceUrl(sourceStep.input.url) : undefined,
                output: compactVerifiedResult(result.output, 5_000) };
            }),
            feedback, permissionMode: task.permissionMode,
            onResearch: sources => this.event(task, 'research.searched', {
              sourceCount: sources.length, sources: sanitizeAnswerSources(sources) }) });
          if (!content.trim()) throw new Error('文件实施 Agent 返回了空内容。');
          step.assignmentInput ??= plannedInput;
          step.input = { path, content };
          previousFiles.push({ path, content });
          this.event(task, 'file.implemented', { stepId: step.id });
          break;
        } catch (error) {
          feedback = error instanceof Error ? error.message : String(error);
          if (agents.runPlannerReview && task.executionCheckpoint) {
            task.executionCheckpoint.pendingReview = { stepId: step.id, outcome: 'failure',
              failure: { stage: 'execution', code: 'FILE_IMPLEMENTATION_FAILED', reason: feedback, stepId: step.id },
              safeToReplay: true };
            this.save(task);
            this.event(task, 'step.failed', { stepId: step.id, failureCode: 'FILE_IMPLEMENTATION_FAILED' });
            return false;
          }
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
      } catch (error) {
        const reason = sanitizeCorrectionFailure({ stage: 'answer', code: 'ANSWER_UNAVAILABLE',
          reason: error instanceof Error ? error.message : '回答 Agent 当前不可用' }).reason;
        return this.block(task, `回答 Agent 未能生成结果：${reason}；已验证的步骤结果仍保留。`);
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
    // A single verified read-only lookup has already been reviewed by the planner.
    // Routine questions need an answer, not another tester/evaluator round trip.
    if (isRoutineLookupAnswer(task.message, planner, results)) {
      if (!answer?.trim()) return this.block(task, '回答 Agent 未给出有效回答，已验证的查询结果仍保留。');
      task.result = answer;
      task.executionCheckpoint = undefined;
      this.finishActiveRound(task);
      this.emitAnswerSources(task, results);
      this.setStatus(task, 'COMPLETED');
      this.event(task, 'task.completed', { reason: 'answer-routine-lookup' });
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
        this.emitAnswerSources(task, results);
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
            failure, safeToReplay: false, scope: 'answer' })
          : { action: 'revise_answer', reason: failure.reason };
      } catch {
        return this.block(task, `主 Agent 当前无法决定回答修正方向：${failure.reason}`);
      }
      const decision = routeCorrection(proposed, { confirmedToolDefect: false, safeToReplay: false });
      if (decision.action !== 'revise_answer') return this.block(task,
        `最终回答仍缺少足够证据或需要补充信息：${failure.reason}。${decision.reason}`);
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

  private emitAnswerSources(task: TaskRun,
    results: Array<{ stepId: string; sourceUrl?: string; output: unknown; observedAt: string }>): void {
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
  }

  private async selectStepTool(task: TaskRun, planner: PlannerDecision, step: PlannerDecision['steps'][number]): Promise<void> {
    const key = step.capabilityKey ?? '';
    if (!key.startsWith('dynamic.') || !this.dependencies.toolDiscovery
      || this.dependencies.registry.findUsableByKey(key, task.id)) return;
    const required = planner.requiredCapabilities.find(item => item.name === key);
    const purpose = required?.purpose ?? step.description;
    const workerRole = this.dependencies.collaboration?.assignedWorkerRole(task.id, planner.steps, step.id);
    let queries = [purpose, step.description];
    if (this.dependencies.agents.runToolSearch) {
      try {
        queries = await this.dependencies.agents.runToolSearch({ taskId: task.id,
          description: step.description, purpose, capabilityKey: key, workerRole });
      } catch { /* The step description still supplies a bounded local search. */ }
    }
    const found = await Promise.all(queries.slice(0, 3).map(query =>
      this.dependencies.toolDiscovery!.search(query.slice(0, 500), 8).catch(() => [])));
    const candidates = [...new Map(found.flat().filter(item => item.id !== 'builtin:process.launch')
      .map(item => [item.id, item])).values()]
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0)).slice(0, 8);
    this.event(task, 'tool.searched', { stepId: step.id, candidateCount: candidates.length,
      workerRole, queryCount: queries.length });
    if (!candidates.length || !this.dependencies.agents.runToolSelection) {
      this.event(task, 'tool.selected', { stepId: step.id, choice: 'create', workerRole });
      return;
    }
    try {
      const decision = await this.dependencies.agents.runToolSelection({ taskId: task.id,
        description: step.description, purpose, capabilityKey: key, workerRole,
        stepInput: step.input ?? {}, candidates });
      if (decision.action === 'create') {
        this.event(task, 'tool.selected', { stepId: step.id, choice: 'create', workerRole });
        return;
      }
      const selected = candidates.find(item => item.id === decision.toolId);
      if (!selected || !decision.arguments) throw new Error('Selected tool or arguments are unavailable.');
      const selectedInput = this.toolInput(selected, decision.arguments);
      step.capabilityKey = selected.source === 'builtin' ? selected.name : 'mcp.call';
      step.input = selectedInput;
      if (selected.source === 'mcp') (step as typeof step & { mcpInputSchema?: unknown }).mcpInputSchema = selected.inputSchema;
      this.event(task, 'tool.selected', { stepId: step.id, choice: selected.source,
        tool: selected.name, server: selected.server, workerRole });
    } catch {
      this.event(task, 'tool.selected', { stepId: step.id, choice: 'create', workerRole,
        reason: 'selection-unavailable' });
    }
  }

  private toolInput(option: ToolOption, args: Record<string, unknown>): Record<string, unknown> {
    if (JSON.stringify(args).length > 20_000) throw new Error('Tool arguments exceed the selection limit.');
    if (option.source === 'builtin') return validateStepInput(option.name, args);
    if (!option.server) throw new Error('MCP tool has no server.');
    const schema = option.inputSchema && typeof option.inputSchema === 'object'
      ? option.inputSchema as { required?: unknown; properties?: Record<string, { type?: unknown }> } : {};
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof name === 'string' && !(name in args)) throw new Error(`MCP tool argument is missing: ${name}`);
    }
    for (const [name, value] of Object.entries(args)) {
      const type = schema.properties?.[name]?.type;
      if (typeof type === 'string' && type !== 'null' && (type === 'array' ? !Array.isArray(value)
        : type === 'object' ? !value || typeof value !== 'object' || Array.isArray(value)
          : typeof value !== type)) throw new Error(`MCP tool argument has wrong type: ${name}`);
    }
    return { server: option.server, tool: option.name, dynamicArgs: args };
  }

  private delegationOptions(taskId: string, planner: PlannerDecision, bindings: StepBinding[]): DelegationOptions {
    const schemas: NonNullable<DelegationOptions['schemas']> = {};
    for (const binding of bindings) {
      const step = planner.steps.find(item => item.id === binding.stepId);
      if (step) (step as typeof step & { assignmentCapabilityKey?: string }).assignmentCapabilityKey = binding.capabilityKey;
      const capability = this.dependencies.registry.getVersion(binding.capabilityId, binding.version, taskId);
      if (!capability) continue;
      schemas[binding.stepId] = { version: binding.version,
        inputSchema: capability.manifest.inputSchema, outputSchema: capability.manifest.outputSchema };
    }
    return { acceptanceCriteria: planner.acceptanceCriteria, schemas };
  }

  private async ensureCapabilities(task: TaskRun, planner: PlannerDecision, runtimeInput: Record<string, unknown>,
    completed = new Set<string>(), existingBindings: StepBinding[] = []): Promise<CapabilityOutcome> {
    const unbound = planner.steps.find(step => !step.capabilityKey && planner.requiredCapabilities.length !== 1);
    if (unbound) return { state: 'failed', message: `步骤 ${unbound.id} 没有明确能力键，无法安全绑定工具。` };
    const bindings: StepBinding[] = [];
    for (const step of planner.steps) {
      if (completed.has(step.id)) {
        const binding = existingBindings.find(item => item.stepId === step.id);
        if (!binding) return { state: 'blocked', message: `已验证步骤 ${step.id} 缺少原能力绑定。` };
        bindings.push(binding);
        continue;
      }
      await this.selectStepTool(task, planner, step);
      const key = step.capabilityKey ?? (planner.requiredCapabilities.length === 1 ? planner.requiredCapabilities[0]!.name : '');
      if (!key) return { state: 'failed', message: `步骤 ${step.id} 没有明确能力键，无法安全绑定工具。` };
      const required = planner.requiredCapabilities.find((item) => item.name === key)
        ?? { name: key, purpose: step.description, riskLevel: 'medium' as const };
      // A generated file receives its content after upstream observations. The
      // capability dry-run validates the host contract without pre-generating it.
      const executionInput = step.capabilityKey === 'filesystem.write_text' && step.input?.generation
        ? { path: step.input.path, content: '' } : step.input ?? {};
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
            if (!isRoutineHostBuiltin(key, existing.code, executionInput)) {
              await this.verifySandbox(task, existing.id, existing.code, existing.manifest.permissions,
                withExecutionInput(runtimeInput, executionInput), planner.acceptanceCriteria,
                existing.manifest.inputSchema, existing.manifest.outputSchema);
            }
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
            workerRole: this.dependencies.collaboration?.assignedWorkerRole(task.id, planner.steps, step.id),
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
            withExecutionInput(runtimeInput, executionInput), planner.acceptanceCriteria,
            candidate.inputSchema, candidate.outputSchema);
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
    input: Record<string, unknown>, acceptanceCriteria: string[], inputSchema?: unknown, outputSchema?: unknown): Promise<void> {
    this.setStatus(task, 'TEST_PLANNING');
    const plan = await this.dependencies.tester.generate(task.id, {
      name, permissions, executionInput: input, acceptanceCriteria, inputSchema, outputSchema,
    });
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
  ): Promise<{ completed: boolean; output?: unknown; verification?: StepVerificationEvidence }> {
    let latestFailure = '执行未通过评估。';
    let cachedHostOutcome: { inputSignature: string; output: unknown; report: TestReport } | undefined;
    const verifiedResult = (output: unknown) => ({ completed: true, output,
      verification: cachedHostOutcome ? compactStepVerification(cachedHostOutcome.report) : undefined });
    for (;;) {
      let rejectedBeforeExecution = false;
      try {
        let verifiedMaintainedOperation = false;
        const checkpoint = task.executionCheckpoint;
        const inputSignature = JSON.stringify(input);
        const reuseVerifiedHostOutcome = permissions.length > 0 && cachedHostOutcome?.inputSignature === inputSignature;
        if (capabilityName === 'process.run' && input && typeof input === 'object' && !Array.isArray(input)) {
          const destination = await inspectGitDestination(input as Record<string, unknown>);
          if (destination?.status === 'matching') {
            if (destination.source === 'github-source-archive'
              && /(?:完整历史|全部提交|完整仓库历史|full history|all commits|git clone)/i.test(task.message)) {
              throw new StepReviewRequiredError({ stage: 'execution', code: 'GIT_HISTORY_REQUIRED',
                reason: '目标目录已有源码归档，但没有 Git 历史；不会将归档冒充为完整克隆。',
                stepId: task.currentStepId, capabilityId: capabilityName, version: capabilityVersion },
              false, { directory: destination.directory, source: destination.source });
            }
            const output = { repositoryUrl: destination.remote, path: destination.directory,
              alreadyPresent: true, source: destination.source, gitHistory: destination.source === 'git' };
            this.event(task, 'step.verified', { stepId: task.currentStepId, source: 'existing_repository' });
            return { completed: true, output, verification: { mode: 'live_observation', passed: 1,
              failed: 0, blocked: 0, checks: [{ id: 'existing-repository', status: 'passed',
                codes: ['EXISTING_SOURCE_CONFIRMED'] }] } };
          }
          if (destination?.status === 'conflict') {
            throw new StepReviewRequiredError({ stage: 'execution', code: 'DESTINATION_NOT_EMPTY',
              reason: `目标目录 ${destination.directory} 已有其他内容；不会自动清空或覆盖。`,
              stepId: task.currentStepId, capabilityId: capabilityName, version: capabilityVersion },
            false, { directory: destination.directory, entries: destination.entries });
          }
        }
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
              // This evidence comes from the broker, not a generated tool's error.
              // A rejected single-call builtin with no journal entry never ran.
              rejectedBeforeExecution = capabilityName === 'process.run'
                && error instanceof HostOperationError && error.code === 'INVALID_PROCESS_ARGUMENTS'
                && this.dependencies.store.listStepOperations(task.id, context.stepId, capabilityVersion).length === 0;
              return {
                callId: call.callId,
                ok: false,
                error: { code: errorCode(error), message: error instanceof Error ? error.message : String(error) },
              };
            }
          },
        });
        const boundCapability = this.dependencies.registry.getVersion(capabilityName, capabilityVersion, task.id);
        if (boundCapability?.manifest.provenance.sourceTaskId === 'builtin'
          && isRoutineHostBuiltin(capabilityName, boundCapability.code,
            input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {})) {
          const applicationId = (input as Record<string, unknown>).applicationId;
          const launch = capabilityName === 'process.launch';
          if (launch && (typeof applicationId !== 'string' || !applicationId.trim())) {
            throw new StepReviewRequiredError({ stage: 'execution', code: 'APPLICATION_ID_MISSING',
              reason: '启动步骤缺少可观察的应用标识。', stepId: task.currentStepId }, false, output);
          }
          const observationPlan: Pick<TestPlan, 'cases'> = { cases: launch ? [{ id: 'desktop', mode: 'live_observation',
            assertions: [
              { type: 'process_running', applicationId: applicationId as string },
              { type: 'window_visible', applicationId: applicationId as string },
              { type: 'foreground_window', applicationId: applicationId as string },
            ] }] : [] };
          const expectedTarget = capabilityName === 'filesystem.read_text'
            ? (input as Record<string, unknown>).path : undefined;
          const report = await this.dependencies.testExecutor.runLive(this.dependencies.store, task.id,
            task.currentStepId ?? 'unknown', capabilityVersion, permissions, observationPlan,
            this.dependencies.desktopObserver, launch ? applicationId as string : undefined,
            typeof expectedTarget === 'string' ? expectedTarget : undefined, checkpoint?.operationSequence ?? 0);
          if (report.failed || report.blocked || report.passed === 0
            || launch && !report.cases.some(item => item.id === 'desktop' && item.status === 'passed')) {
            const reason = report.cases.flatMap(item => item.codes).join(', ') || '宿主操作状态无法确认';
            if (this.dependencies.agents.runPlannerReview) {
              throw new StepReviewRequiredError({ stage: 'execution', code: launch
                ? 'DESKTOP_VERIFICATION_FAILED' : 'HOST_VERIFICATION_FAILED', reason,
              stepId: task.currentStepId, capabilityId: capabilityName, version: capabilityVersion },
              this.safeToRetry(task, capabilityVersion), output);
            }
            this.block(task, `操作后的状态核验未通过：${reason}`);
            return { completed: false };
          }
          cachedHostOutcome = { inputSignature, output, report };
          this.event(task, 'step.verified', { stepId: task.currentStepId, source: 'live_postcondition' });
          return verifiedResult(output);
        }
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
            if (this.dependencies.agents.runPlannerReview) {
              throw new StepReviewRequiredError({ stage: 'test', code: 'LIVE_TEST_BLOCKED',
                reason: report.reason ?? '真实测试缺少关键证据', stepId: task.currentStepId,
                capabilityId: capabilityName, version: capabilityVersion }, false, output);
            }
            this.block(task, `真实测试无法验证：${report.reason ?? '关键条件缺少证据。'}`);
            return { completed: false };
          }
          if (review.verdict === 'fail') {
            latestFailure = `真实测试失败：${report.reason ?? '测试 Agent 拒绝证据。'}`;
            if (this.dependencies.agents.runPlannerReview) {
              throw new StepReviewRequiredError({ stage: 'test', code: 'LIVE_TEST_FAILED', reason: latestFailure,
                stepId: task.currentStepId, capabilityId: capabilityName, version: capabilityVersion },
              this.safeToRetry(task, capabilityVersion), output);
            }
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
            return verifiedResult(output);
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
          return verifiedResult(output);
        }
        if (evaluation.status === 'pass') {
          return verifiedResult(output);
        }
        if (verifiedMaintainedOperation && evaluation.status !== 'wait_approval') {
          // The evaluator only receives the operation's return object, not an
          // independent host observation. It cannot negate a passed live
          // postcondition or demand that later steps already be complete.
          this.event(task, 'step.verified', { stepId: task.currentStepId, source: 'live_postcondition',
            evaluator: 'conflicted', failureCode: evaluation.failures[0]?.code ?? 'EVALUATION_CONFLICT' });
          return verifiedResult(output);
        }
        if (evaluation.status === 'wait_approval') {
          latestFailure = '评估器请求了审批，但没有具体宿主操作可授权。';
          if (this.dependencies.agents.runPlannerReview) {
            throw new StepReviewRequiredError({ stage: 'execution', code: 'EVALUATOR_WAIT_APPROVAL',
              reason: latestFailure, stepId: task.currentStepId,
              capabilityId: capabilityName, version: capabilityVersion },
            this.safeToRetry(task, capabilityVersion), output);
          }
          this.block(task, latestFailure);
          return { completed: false };
        }
        latestFailure = evaluation.failures.map((failure) => failure.message).filter(Boolean).join('；') || `评估评分 ${evaluation.score} 未达到通过标准。`;
        if (this.dependencies.agents.runPlannerReview) {
          throw new StepReviewRequiredError({ stage: 'execution',
            code: evaluation.failures[0]?.code ?? 'STEP_EVALUATION_FAILED', reason: latestFailure,
            stepId: task.currentStepId, capabilityId: capabilityName, version: capabilityVersion },
          this.safeToRetry(task, capabilityVersion), output);
        }
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
        if (error instanceof StepReviewRequiredError) throw error;
        const code = errorCode(error);
        if (code === 'APPROVAL_REQUIRED') return { completed: false };
        if (code === 'OPERATION_UNKNOWN') {
          if (this.dependencies.agents.runPlannerReview) {
            throw new StepReviewRequiredError({ stage: 'execution', code: 'OPERATION_UNKNOWN',
              reason: error instanceof Error ? error.message : '操作状态无法确认',
              stepId: task.currentStepId, capabilityId: capabilityName, version: capabilityVersion }, false);
          }
          this.block(task, error instanceof Error ? error.message : '操作状态无法确认，未重放。');
          return { completed: false };
        }
        latestFailure = error instanceof Error ? error.message : String(error);
        if (this.dependencies.agents.runPlannerReview) {
          throw new StepReviewRequiredError({ stage: 'execution',
            code,
            reason: latestFailure, stepId: task.currentStepId,
            capabilityId: capabilityName, version: capabilityVersion }, rejectedBeforeExecution || this.safeToRetry(task, capabilityVersion));
        }
        if (!rejectedBeforeExecution && !this.safeToRetry(task, capabilityVersion)) {
          this.block(task, '宿主操作结果未通过验证，自动重放可能产生重复副作用。');
          return { completed: false };
        }
        const revised = await this.reviseStep(task, planner, input, capabilityName, capabilityVersion,
          { stage: 'execution', code,
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
    this.throwIfCancelled(task);
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
    task.result = renderTaskResult('BLOCKED', { summary: message });
    this.setStatus(task, 'BLOCKED');
    this.event(task, 'task.blocked', { reason: message });
    return task;
  }

  private setStatus(task: TaskRun, status: TaskRun['status']): void {
    this.throwIfCancelled(task);
    task.status = status;
    this.save(task);
    this.event(task, 'task.status', { status });
  }

  private event(task: TaskRun, type: string, payload: Record<string, unknown>): void {
    this.throwIfCancelled(task);
    this.dependencies.store.appendEvent(task.id, publicTaskEvent({ type, payload }));
  }

  private save(task: TaskRun): void {
    this.throwIfCancelled(task);
    task.updatedAt = new Date().toISOString();
    this.dependencies.store.saveTask(task);
  }

  private fail(task: TaskRun, message: string): TaskRun {
    task.result = renderTaskResult('FAILED', { summary: message });
    task.executionCheckpoint = undefined;
    this.setStatus(task, 'FAILED');
    this.event(task, 'task.failed', { message });
    return task;
  }
}

export class ClarificationInputError extends Error {
  readonly code = 'INVALID_CLARIFICATION';
}

export class TaskService {
  private readonly activeRuns = new Map<string, Promise<TaskRun>>();
  constructor(
    private readonly store: SqliteStore,
    private readonly loop: AgentLoop,
    private readonly permissionBroker?: PermissionBroker,
    private readonly sessionTurns?: { onTaskTerminal(task: TaskRun): Promise<void> },
    private readonly roleAgents?: { onTaskSettled(task: TaskRun): void },
  ) {}

  async createAndWait(input: Parameters<SqliteStore['createTask']>[0]): Promise<TaskRun> {
    const task = this.store.createTask(this.withPresentationSource(input));
    return this.runAndRecord(task.id);
  }

  createAndStart(input: Parameters<SqliteStore['createTask']>[0]): TaskRun {
    const task = this.store.createTask(this.withPresentationSource(input));
    void this.runAndRecord(task.id).catch(error => {
      // The HTTP request has already returned. Keep the rejection observed so
      // a storage failure does not become an unhandled process rejection.
      console.error('Background task could not be recorded:', error instanceof Error ? error.name : 'UnknownError');
    });
    return task;
  }

  /** Runs the loop and, once terminal, hands the finished task to the session layer. */
  private runAndRecord(taskId: string): Promise<TaskRun> {
    const existing = this.activeRuns.get(taskId);
    if (existing) return existing;
    const work = this.performRunAndRecord(taskId);
    this.activeRuns.set(taskId, work);
    void work.then(() => this.activeRuns.delete(taskId), () => this.activeRuns.delete(taskId));
    return work;
  }

  private async performRunAndRecord(taskId: string): Promise<TaskRun> {
    let task: TaskRun;
    try {
      task = await this.loop.run(taskId);
    } catch {
      const interrupted = this.store.getTask(taskId);
      if (!interrupted || isTerminal(interrupted.status)) throw new Error('Task execution ended unexpectedly.');
      interrupted.status = 'FAILED';
      interrupted.result = '任务未完成：运行时出现未处理异常。请查看任务轨迹后重试。';
      interrupted.executionCheckpoint = undefined;
      interrupted.updatedAt = new Date().toISOString();
      this.store.saveTask(interrupted);
      this.store.appendEvent(taskId, { type: 'task.failed', payload: { failureCode: 'UNHANDLED_RUNTIME_ERROR' } });
      task = interrupted;
    }
    try { this.roleAgents?.onTaskSettled(task); }
    catch { /* Agent identity bookkeeping must not alter the task result. */ }
    if (this.sessionTurns) {
      try {
        await this.sessionTurns.onTaskTerminal(task);
      } catch {
        // A session bookkeeping failure must never fail the task itself.
      }
    }
    return task;
  }

  async cancelTask(taskId: string): Promise<TaskRun> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error('Task not found.');
    if (isTerminal(task.status)) return task;
    const active = this.activeRuns.get(taskId);
    if (active && this.loop.requestCancellation(taskId)) {
      const settled = await active;
      if (isTerminal(settled.status)) return settled;
    }
    const waitingTask = this.store.getTask(taskId);
    if (!waitingTask) throw new Error('Task not found.');
    if (isTerminal(waitingTask.status)) return waitingTask;
    // Waiting for input or approval has no running loop to interrupt.
    if (waitingTask.status !== 'NEEDS_USER_INPUT' && waitingTask.status !== 'WAITING_FOR_APPROVAL') {
      throw new Error('Task is not running in this process; refresh its status before stopping.');
    }
    waitingTask.status = 'CANCELLED';
    waitingTask.result = '任务已停止，可发送新的任务。';
    waitingTask.executionCheckpoint = undefined;
    waitingTask.pendingPermission = undefined;
    waitingTask.updatedAt = new Date().toISOString();
    this.store.saveTask(waitingTask);
    this.store.appendEvent(taskId, { type: 'task.cancelled', payload: { reason: 'user-requested' } });
    try { this.roleAgents?.onTaskSettled(waitingTask); }
    catch { /* Agent identity bookkeeping must not alter cancellation. */ }
    try { await this.sessionTurns?.onTaskTerminal(waitingTask); }
    catch { /* A session bookkeeping failure must not undo cancellation. */ }
    return waitingTask;
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
    const latestQuestion = [...this.store.listEvents(taskId)].reverse().find(event => event.type === 'task.needs_user_input');
    const rawRequest = latestQuestion?.payload.request;
    const request = rawRequest && typeof rawRequest === 'object' ? rawRequest as Record<string, unknown> : {};
    const answerValue = values.answer ?? (Object.keys(values).length === 1 ? Object.values(values)[0] : undefined);
    if (typeof answerValue !== 'string' || !answerValue.trim()) {
      throw new ClarificationInputError('请先选择一个选项，或输入具体答案。');
    }
    const answer = answerValue.trim();
    if (answer.length > 1_000) throw new ClarificationInputError('补充内容过长，请用 1000 字以内说明。');
    if (/^(?:不知道|不清楚|随便|无|没有|\?|？|n\/a)$/i.test(answer)) {
      throw new ClarificationInputError('这个回答还不能确定执行所需的信息，请选择上方选项或输入具体内容。');
    }
    const fields = Array.isArray(request.requiredFields) ? request.requiredFields as Array<{ name?: unknown }> : [];
    const fieldNames = fields.map(field => typeof field?.name === 'string' ? field.name.toLowerCase() : '');
    const choices = Array.isArray(request.options) ? request.options as Array<{ value?: unknown }> : [];
    const candidates = Array.isArray(request.candidates) ? request.candidates : [];
    const selected = choices.some(choice => choice?.value === answer) || candidates.includes(answer);
    if (!selected && fieldNames.some(name => name === 'city' || name.includes('city'))
      && /(?:省|自治区|全国|国家|整个中国|全省)$/.test(answer)) {
      throw new ClarificationInputError('还需要具体城市，请选择一个城市或输入城市名称。');
    }
    if (!selected && fieldNames.includes('executable') && !/^[A-Za-z]:[\\/][^\r\n]+\.exe$/i.test(answer)) {
      throw new ClarificationInputError('请输入完整的 Windows .exe 路径，或选择上方找到的应用。');
    }
    task.message = `${task.message}\n用户补充信息：${JSON.stringify({ answer })}`;
    task.status = 'INTAKE';
    this.store.saveTask(task);
    this.store.appendEvent(task.id, { type: 'task.input_received', payload: { fields: ['answer'] } });
    return this.runAndRecord(taskId);
  }

  async resolveApproval(taskId: string, requestId: string, approved: boolean): Promise<TaskRun> {
    if (!this.permissionBroker) throw new Error('Approval flow is not enabled.');
    if (this.store.getTask(taskId)?.status === 'CANCELLED') throw new Error('Task was cancelled.');
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
        const pureBuiltin = capability?.manifest.provenance.sourceTaskId === 'builtin'
          && capability.manifest.permissions.length === 0;
        if (checkpoint?.pendingReview || capability?.manifest.provenance.sourceTaskId === 'builtin'
          && (currentVerified || currentOperation?.state === 'completed' || readOnly || pureBuiltin)) {
          await this.runAndRecord(taskId);
          resumed += 1;
          continue;
        }
      }
      task.status = 'BLOCKED';
      task.result = renderTaskResult('BLOCKED', { summary: '服务重启时任务仍在处理中，且没有可安全续验的操作检查点。没有自动重放；请重新提交任务。' });
      task.updatedAt = new Date().toISOString();
      this.store.saveTask(task);
      this.store.appendEvent(taskId, { type: 'task.blocked', payload: { reason: 'interrupted without a safe checkpoint' } });
    }
    return resumed;
  }
}

function isReadOnlyDiagnostic(capabilityKey: string, input: Record<string, unknown>): boolean {
  if (capabilityKey === 'filesystem.read_text' || capabilityKey === 'location.current'
    || capabilityKey === 'text.count_lines' || capabilityKey === 'text.replace'
    || capabilityKey === 'json.format') return true;
  return capabilityKey === 'network.request' && (input.method === 'GET' || input.method === 'HEAD');
}

function isPlannerDecision(value: unknown): value is PlannerDecision {
  return !!value && typeof value === 'object'
    && 'intent' in value && 'steps' in value && Array.isArray((value as { steps?: unknown }).steps)
    && 'requiredCapabilities' in value && Array.isArray((value as { requiredCapabilities?: unknown }).requiredCapabilities);
}

function latestClarification(store: SqliteStore, taskId: string): PlannerInput['clarification'] {
  const event = [...store.listEvents(taskId)].reverse().find(item => item.type === 'task.needs_user_input');
  const raw = event?.payload.request;
  if (!raw || typeof raw !== 'object') return undefined;
  const request = raw as Record<string, unknown>;
  if (typeof request.question !== 'string') return undefined;
  return { question: request.question,
    requiredFields: Array.isArray(request.requiredFields)
      ? request.requiredFields as NonNullable<PlannerInput['clarification']>['requiredFields'] : [],
    options: Array.isArray(request.options)
      ? request.options as NonNullable<PlannerInput['clarification']>['options'] : undefined };
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
    ...(runtimeInput.peerResults !== undefined ? { peerResults: runtimeInput.peerResults } : {}),
  };
}

function isTerminal(status: TaskRun['status']): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED' || status === 'BLOCKED';
}

function planStepSemantics(step: PlannerDecision['steps'][number]): Record<string, unknown> {
  const { assignmentCapabilityKey: _assignmentCapabilityKey, mcpInputSchema: _mcpInputSchema, ...semantic } = step as
    typeof step & { assignmentCapabilityKey?: string; mcpInputSchema?: unknown };
  return semantic;
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

function isRoutineHostBuiltin(name: string, code: string, input: Record<string, unknown>): boolean {
  return (['process.launch', 'network.request', 'filesystem.read_text', 'location.current'].includes(name)
      || name === 'process.run' && routineGitClone(input) !== null)
    && (name !== 'network.request' || isReadOnlyDiagnostic(name, input))
    && isMaintainedBuiltin(name, code);
}

function isRoutineLookupAnswer(message: string, planner: PlannerDecision,
  results: Array<{ stepId: string; sourceUrl?: string; output: unknown; observedAt: string }>): boolean {
  if (planner.status !== 'ready' || planner.steps.length !== 1 || results.length !== 1) return false;
  const step = planner.steps[0]!;
  if (results[0]?.stepId !== step.id || !step.capabilityKey
    || !['network.request', 'location.current'].includes(step.capabilityKey)
    || !isReadOnlyDiagnostic(step.capabilityKey, step.input ?? {})) return false;
  if (/(调研|研究|报告|分析|审查|评估|比较|对比|详细|深入|严谨|高质量|research|report|analy[sz]e|review|evaluat|compar)/i.test(message)) return false;
  const output = results[0]?.output;
  return !(output && typeof output === 'object' && 'articles' in output);
}

function needsGroundedResponse(capabilityKey: string | undefined): boolean {
  return capabilityKey === 'network.request' || capabilityKey === 'filesystem.read_text'
    || capabilityKey === 'presentation.create' || capabilityKey === 'mcp.call' || capabilityKey === 'process.run';
}

function publicSourceUrl(value: string): string {
  return sanitizeAnswerSources([{ url: value }])[0]?.url ?? '';
}

function compactStepVerification(report: TestReport): StepVerificationEvidence {
  return { mode: report.mode, passed: report.passed, failed: report.failed, blocked: report.blocked,
    checks: report.cases.slice(0, 10).map(item => ({ id: item.id, status: item.status,
      codes: item.codes.slice(0, 8) })) };
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
}
