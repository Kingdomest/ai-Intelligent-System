# Jarvis Evaluation Correction Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a whole user task share at most five complete correction rounds, with concrete evaluator feedback, selective generated-tool replacement, independent testing, and no unsafe host-operation replay.

**Architecture:** Introduce a persisted task-level correction ledger and a bounded correction router. Refactor the existing `AgentLoop` so tool preparation, step execution, and answer composition return structured outcomes to one orchestrator; a round ends only after child work, test-agent verdict, and evaluator verdict. Reuse verified outputs and exact capability versions; host effects remain behind the existing permission broker and operation journal.

**Tech Stack:** Node.js >=24, TypeScript, Zod, `node:sqlite`, Vitest, React/Vite.

**Spec:** `docs/superpowers/specs/2026-09-24-jarvis-evaluation-correction-loop-design.md`

## Global Constraints

- First execution is not a correction retry; at most **5** complete correction rounds are shared by the entire user task.
- A completed round is main-agent dispatch → child-agent work → test-agent test/review → evaluator verdict. Multiple agent calls, steps, and test cases within it count once.
- Retain existing permission modes, host bridge, sandbox, Canary activation, and task API; do not execute model-generated test scripts.
- Deprecate only a **confirmed faulty generated capability version**; keep its code and history. Never let the model replace a maintained builtin.
- Never automatically replay an uncertain or non-idempotent host operation. Permission denial or missing essential input pauses/stops without a hidden retry.
- Use existing SQLite tables; a new `tasks` column is acceptable, a new table is not. Persist only redacted failure summaries, not file bodies, secrets, or full command output.
- This workspace currently has no `.git` metadata. Do not initialize a repository or claim commits; if Git is supplied later, commit each independently verified task.

## Review Focus

1. A final-answer evaluator rejection after a verified file read must rewrite from cached results, not read the file a second time. Pin in Task 3.
2. A model saying “the tool is broken” without a reproducible contract failure must not deprecate that tool. Pin in Tasks 2 and 5.
3. Restart during a correction round must neither debit the round twice nor replay an uncertain process/write operation. Pin in Tasks 1 and 6.
4. A failed or blocked deterministic test cannot be changed to pass by either the test agent or evaluator. Pin in Tasks 3 and 5.
5. Multiple failed steps in one task must not each get a separate five-round budget. Pin in Task 4.

## File map and interfaces

| File | Responsibility |
| --- | --- |
| `src/domain/contracts.ts` | Define `CorrectionState`, `CorrectionFailure`, `CorrectionTarget` on `TaskRun`; keep `metrics.retryCount` as compatibility mirror of completed corrective rounds. |
| `src/storage/sqlite-store.ts` | Migrate `tasks.correction_state_json`, save/load ledger, and atomically finish a round plus append its redacted event. |
| `src/runtime/correction-round.ts` (new) | Pure budget/state transitions: start/resume/finish, capped at five, idempotent by round ID. |
| `src/runtime/correction-router.ts` (new) | Deterministic safety/attribution guard over a structured main-agent recommendation. |
| `src/agents/agent-runner.ts` | Add structured `runCorrection` decision and bounded feedback to planner, implementer, and responder. |
| `src/agents/test-agent.ts` | Add a declarative answer-coverage check and review; no generated scripts. |
| `src/runtime/agent-loop.ts` | Replace local retry loops with task-level correction orchestration; preserve checkpoints/results and exact version bindings. |
| `src/capabilities/registry.ts` | Confirm version-specific deprecation and reject builtin replacement; keep Canary path. |
| `src/runtime/task-service.ts` / `src/api/routes.ts` | Resume safely and expose public correction progress without internal checkpoints. |
| `web/src/CorrectionStatus.tsx` (new), `web/src/App.tsx`, `web/src/styles.css` | Render the public round projection, correction target, and concrete terminal summary. |
| `tests/unit/*`, `tests/integration/*` | Contract, migration, security, end-to-end, API, and UI regression tests. |

`CorrectionFailure` is a **sanitized** `{ stage, code, reason, stepId?, capabilityId?, version? }`; `CorrectionTarget` is `answer | plan_or_input | generated_tool`. `CorrectionState` is `{ roundsUsed, finishedRoundIds, currentRound?, failures }`, with `finishedRoundIds` bounded to five for idempotency. `currentRound` carries `{ id, ordinal, target, phase }`, where `phase` is `dispatch | implement | test | evaluate`. Persist the original plan/results separately in `ExecutionCheckpoint`; do not persist raw model feedback there. Define `CorrectionDecision` in `src/runtime/correction-router.ts` as `{ action: 'revise_answer' | 'revise_plan_or_input' | 'rebuild_generated_tool' | 'ask_user' | 'block'; reason: string }`; `AgentServices.runCorrection(input)` returns this type. The router may downgrade an unsafe choice to `block`, never upgrade a failed deterministic check to pass. Extend `AgentLoopDependencies.tester` with `reviewAnswer` in Task 3.

---

### Task 1: Persist an idempotent task-level round ledger

**Files:** Modify `src/domain/contracts.ts`, `src/storage/sqlite-store.ts`; create `src/runtime/correction-round.ts`; test `tests/unit/sqlite-store.test.ts`, new `tests/unit/correction-round.test.ts`.

**Interfaces:** `beginCorrection(state: CorrectionState, target: CorrectionTarget, id: string): CorrectionState`; `finishCorrection(state: CorrectionState, id: string, failure?: CorrectionFailure): CorrectionState`; `SqliteStore.finishCorrectionRound(taskId: string, roundId: string, failure?: CorrectionFailure): TaskRun`. `beginCorrection` resumes an existing round ID and rejects starting a sixth; `finishCorrection` increments exactly once only after evaluation and is transactional with a `correction.round_finished` event.

- [ ] **Step 1: Write failing state and migration tests.** Add tests asserting `beginCorrection({roundsUsed:0,finishedRoundIds:[],failures:[]}, 'answer','r1')` has ordinal 1 but still `roundsUsed=0`; `finishCorrection` gives 1; repeated finish stays 1; a sixth start throws; reopening an old SQLite DB yields the zero-round state without losing task/event/capability rows. Include a persisted in-progress round and a second store reopening it.

```ts
const started = beginCorrection({ roundsUsed: 0, finishedRoundIds: [], failures: [] }, 'answer', 'r1');
expect(started).toMatchObject({ roundsUsed: 0, currentRound: { id: 'r1', ordinal: 1 } });
const done = finishCorrection(started, 'r1');
expect(finishCorrection(done, 'r1').roundsUsed).toBe(1);
expect(() => beginCorrection({ roundsUsed: 5, finishedRoundIds: ['r1','r2','r3','r4','r5'], failures: [] }, 'answer', 'r6')).toThrow();
```

- [ ] **Step 2: Run red tests.** `npm test -- --run tests/unit/correction-round.test.ts tests/unit/sqlite-store.test.ts`; expect missing types/functions and migration assertions to fail.
- [ ] **Step 3: Implement the minimal state machine and storage column.** Add the exact interfaces from the file map, a `correction_state_json TEXT` migration beside `migrateTaskPermissionColumns`, serialization in `saveTask`/`taskFromRow`, and a transaction that reads the current row, verifies `currentRound.id`, increments once, updates the row, then appends only `{roundId, ordinal, target, failureCode}`. Keep `metrics.retryCount` synchronized with `roundsUsed`; do not count starts.

```ts
export type CorrectionTarget = 'answer' | 'plan_or_input' | 'generated_tool';
export interface CorrectionFailure {
  stage: 'plan' | 'tool' | 'execution' | 'test' | 'answer';
  code: string; reason: string; stepId?: string; capabilityId?: string; version?: string;
}
export interface CorrectionState {
  roundsUsed: number;
  finishedRoundIds: string[];
  currentRound?: { id: string; ordinal: number; target: CorrectionTarget;
    phase: 'dispatch' | 'implement' | 'test' | 'evaluate' };
  failures: CorrectionFailure[];
}
// In migration: ALTER TABLE tasks ADD COLUMN correction_state_json TEXT
// In taskFromRow: correctionState: row.correction_state_json
//   ? JSON.parse(row.correction_state_json) : { roundsUsed: 0, finishedRoundIds: [], failures: [] }
```

- [ ] **Step 4: Verify.** Run the two focused test files and `npm run typecheck`; expect pass. If Git later becomes available, commit this deliverable before Task 2.

### Task 2: Produce bounded, actionable feedback and a main-agent correction decision

**Files:** Modify `src/agents/agent-runner.ts`; create `src/runtime/correction-router.ts`; test new `tests/unit/correction-router.test.ts`, `tests/unit/agent-runner.test.ts`.

**Interfaces:** `AgentRunner.runCorrection(input: {taskId:string; request:string; failure:CorrectionFailure; existingCapability?:{id:string;version:string;sourceTaskId:string}; safeToReplay:boolean}): Promise<CorrectionDecision>`; optional `feedback?: CorrectionFailure` on `PlannerInput`, `ResponseInput`, and `ImplementerInput`. `routeCorrection(decision, evidence): CorrectionDecision` enforces provenance, verified defect, retry safety, and permission boundaries.

- [ ] **Step 1: Write failing tests.** Feed evaluator failure `{code:'ANSWER_MISMATCH',message:'The summary omits the third section'}` and assert it reaches the responder; feed a model `rebuild_generated_tool` choice for an unproven/builtin capability and assert the router returns `block` or `revise_plan_or_input` without deprecation. Test an explicit `TOOL_CONTRACT_MISMATCH` on a generated version permits rebuilding. Reject unknown actions and excessive feedback with the Zod schema.

```ts
expect(routeCorrection({ action: 'rebuild_generated_tool', reason: 'suspected' },
  { sourceTaskId: 'builtin', confirmedToolDefect: false, safeToReplay: true }).action)
  .not.toBe('rebuild_generated_tool');
expect(routeCorrection({ action: 'rebuild_generated_tool', reason: 'contract mismatch' },
  { sourceTaskId: 'task-1', confirmedToolDefect: true, safeToReplay: true }).action)
  .toBe('rebuild_generated_tool');
```

- [ ] **Step 2: Run red tests.** `npm test -- --run tests/unit/correction-router.test.ts tests/unit/agent-runner.test.ts`; expect missing method/router assertions to fail.
- [ ] **Step 3: Add a strict decision schema and guarded route.** Keep model output to action and a short reason; normalize evaluator failures into a bounded, redacted `CorrectionFailure` (code allowlist/length caps, credential/path/body redaction, no raw output bodies). The model may propose a route but `routeCorrection` checks `sourceTaskId !== 'builtin'`, confirmed contract evidence, and `safeToReplay`. Include prior answer and verified result references when invoking the responder; untrusted tool content remains data.

```ts
export const correctionDecisionSchema = z.strictObject({
  action: z.enum(['revise_answer', 'revise_plan_or_input', 'rebuild_generated_tool', 'ask_user', 'block']),
  reason: z.string().trim().min(1).max(300),
});
export type CorrectionDecision = z.infer<typeof correctionDecisionSchema>;
// Guard replay only for actions that would repeat a host operation; revising an
// answer from cached verified results remains allowed even when replay is unsafe.
// Guard rebuild next: require generated provenance AND confirmed deterministic defect.
```

- [ ] **Step 4: Verify.** Run focused tests and `npm run typecheck`; expect pass.

### Task 3: Make answer-only correction a full tested/evaluated round

**Files:** Modify `src/agents/test-agent.ts`, `src/runtime/agent-loop.ts`; test `tests/unit/test-agent.test.ts`, `tests/integration/agent-loop.test.ts`.

**Interfaces:** `TestAgent.reviewAnswer(taskId:string, input:{answer:string; criteria:string[]; verifiedStepIds:string[]; requiredStepIds:string[]}):Promise<{verdict:'pass'|'fail'|'blocked';reason:string}>`. It must fail an empty answer or missing required result, block if evidence is unavailable, and may veto but not override a deterministic failure. `AgentLoop` uses `runResponder` with `feedback` and cached step results, then `reviewAnswer`, then `runEvaluator`.

- [ ] **Step 1: Write failing tests.** In `agent-loop.test.ts`, simulate one verified file read, first answer rejected with a concrete reason, second answer accepted; assert one host read, zero new tools, `roundsUsed=1`, and one test-agent review per answer. Add direct-answer rejection repaired using responder without fabricating tool evidence. Add a persistent evaluator rejection that ends after exactly five *complete* correction rounds with final reason and attempt summary. Add test-agent assertions that empty answer, missing required step, or blocked evidence cannot pass.

```ts
expect(task.status).toBe('COMPLETED');
expect(task.correctionState.roundsUsed).toBe(1);
expect(store.listStepOperations(task.id, 'read-document', '1.0.0')).toHaveLength(1);
expect(task.metrics.generatedCapabilityCount).toBe(0);
expect(responder).toHaveBeenCalledTimes(2);
expect(responder.mock.calls[1]?.[0].feedback?.reason).toContain('third section');
```

- [ ] **Step 2: Run red tests.** `npm test -- --run tests/unit/test-agent.test.ts tests/integration/agent-loop.test.ts`; expect the first-answer correction assertions to fail on current one-shot behavior.
- [ ] **Step 3: Implement answer correction.** Preserve `executionCheckpoint.stepResults` until answer evaluation passes. On failed answer evaluation, sanitize/store the failure, ask the router for `revise_answer`, begin/resume a round, invoke responder with feedback and the same verified results, run `reviewAnswer`, then evaluator. Call `finishCorrectionRound` only after that verdict. The no-tool `planner.status==='answer'` path uses the same flow, with `toolResults=[]`; no fabricated observation is permitted.

```ts
const answerTest = await tester.reviewAnswer(task.id, {
  answer, criteria: planner.acceptanceCriteria,
  verifiedStepIds: stepResults.map(item => item.stepId),
  requiredStepIds: planner.steps.map(item => item.id),
});
if (answerTest.verdict !== 'pass') return { state: answerTest.verdict, reason: answerTest.reason };
const evaluation = await agents.runEvaluator({ taskId: task.id, target: 'task-answer',
  phase: 'execution', output: { message: task.message, answer, results: stepResults },
  acceptanceCriteria: planner.acceptanceCriteria });
```

- [ ] **Step 4: Verify.** Focused tests plus `npm run typecheck` pass. Inspect `store.listStepOperations` count in the new regression test rather than relying on mock call count alone.

### Task 4: Replace per-step/per-tool retry loops with one task-level correction path

**Files:** Modify `src/runtime/agent-loop.ts`, `src/capabilities/tool-factory.ts` only if feedback forwarding needs adjustment; test `tests/integration/agent-loop.test.ts`, `tests/unit/tool-factory.test.ts`.

**Interfaces:** Internal `prepareCapability`, `executeStepOnce`, and `evaluateRound` return a discriminated result: `passed`, `failed(CorrectionFailure)`, `waiting`, or `blocked`; no local `for(retry <= maxRetries)` loop remains in `ensureCapabilities` or `executeStep`. `AgentLoopDependencies.maxRetries` becomes the task-level round cap, clamped to five for existing callers.

- [ ] **Step 1: Write failing integration tests.** Two failing steps must consume one shared round per whole rerun, not ten independent retries. A malformed generated candidate must send its exact policy/test error to the implementer on the next complete round; `metrics.retryCount` stays zero until that round's test/evaluator conclusion. A step evaluation failure must change the next step input/plan before execution, not replay identical arguments. Confirm independent completed steps are retained.

```ts
expect(failedTask.correctionState.roundsUsed).toBe(5);
expect(store.listEvents(failedTask.id).filter(e => e.type === 'correction.round_finished')).toHaveLength(5);
expect(store.listEvents(failedTask.id).filter(e => e.type === 'step.completed' && e.payload.stepId === 'unaffected'))
  .toHaveLength(1);
expect(implementerFeedback[0]?.reason).toMatch(/contract|policy|test/i);
```

- [ ] **Step 2: Run red tests.** `npm test -- --run tests/integration/agent-loop.test.ts tests/unit/tool-factory.test.ts`; expect retry-count and feedback assertions to fail.
- [ ] **Step 3: Refactor the orchestration.** One outer loop owns `roundsUsed`; the first pass prepares capabilities and executes ready steps. A failure is classified and passed to `runCorrection`; the next round invokes the affected planner/implementer, runs sandbox/live tests, and calls evaluator once at task level after step-level evidence. Preserve unaffected `completedStepIds`, results, and exact bindings; invalidate downstream steps if upstream evidence changed. Remove `retryCounts['capability:*']` and `retryCounts['execution:*']` as budgets; retain only backwards-compatible diagnostic values if existing clients need them.

```ts
type PhaseOutcome<T> = { state: 'passed'; value: T }
  | { state: 'failed'; failure: CorrectionFailure }
  | { state: 'waiting' }
  | { state: 'blocked'; reason: string };
// Each outer pass uses the same task-level ledger. A failed PhaseOutcome is routed once;
// beginCorrection creates or resumes one round, and finishCorrectionRound runs only
// after the corrective child work, test review, and evaluator verdict all exist.
```

- [ ] **Step 4: Verify.** Focused tests and `npm run typecheck` pass; search `src/runtime/agent-loop.ts` for local retry loops and confirm none can grant a second five-attempt budget.

### Task 5: Deprecate and rebuild only a confirmed defective generated version

**Files:** Modify `src/runtime/agent-loop.ts`, `src/capabilities/registry.ts`, `src/storage/sqlite-store.ts` only if version lookup needs hardening; test `tests/integration/agent-loop.test.ts`, `tests/unit/capability-registry.test.ts`.

**Interfaces:** `CapabilityRegistry.deprecate(id, version)` already exists; the correction router must authorize it only for a generated version with deterministic defect evidence. The new candidate keeps the same stable capability key and uses a fresh version; after sandbox/genericity/test/evaluator success it becomes active only under existing pure-computation rule or Canary until current-task live validation succeeds.

- [ ] **Step 1: Write failing tests.** Seed a faulty generated active tool with a reproducible contract mismatch; assert old `id@version` becomes `deprecated`, is absent from usable search, code/history still exist, and a new version gets feedback and passes the full gates. Test a mere evaluator suspicion and a builtin read failure: neither deprecates or regenerates. Test a failed new candidate: old defective version never silently reactivates. Test a `test.report` with `failed>0`/`blocked>0`: evaluator pass cannot publish or promote.

```ts
expect(store.getCapabilityVersion('dynamic.text.parse', '1.0.0')?.status).toBe('deprecated');
expect(store.getCapabilityVersion('dynamic.text.parse', '1.0.0')?.code).toBe(originalCode);
expect(registry.findUsableByKey('dynamic.text.parse')?.version).toBe('1.0.1');
expect(store.listEvents(task.id).some(e => e.type === 'capability.quarantined')).toBe(true);
```

- [ ] **Step 2: Run red tests.** `npm test -- --run tests/integration/agent-loop.test.ts tests/unit/capability-registry.test.ts`; expect lifecycle assertions to fail.
- [ ] **Step 3: Implement guarded lifecycle.** After router authorization, deprecate the *bound* version, clear only affected bindings/results, pass sanitized evidence to `ToolFactory.build`, and reject same-version republish. Keep builtin identity/provenance checks before any deprecation. Use existing `verifyGenericity`, `verifySandbox`, live report, and `registry.promote`; do not weaken policy or permission checks.

```ts
if (decision.action === 'rebuild_generated_tool') {
  if (bound.manifest.provenance.sourceTaskId === 'builtin' || !confirmedToolDefect) {
    return { state: 'blocked', reason: 'Tool replacement has no verified generated-tool defect.' };
  }
  registry.deprecate(bound.id, bound.version);
  // Build a fresh version for bound.manifest.capabilityKey; never mutate the old row.
}
```

- [ ] **Step 4: Verify.** Run focused tests and `npm run typecheck`; expect pass.

### Task 6: Preserve host-operation safety across correction and restart

**Files:** Modify `src/runtime/agent-loop.ts`, `src/storage/sqlite-store.ts`, `src/runtime/task-service.ts`; test `tests/integration/agent-loop.test.ts`, `tests/unit/sqlite-store.test.ts`.

**Interfaces:** `safeToRetry(task, version)` must be used before any corrected step can issue a second host call. `TaskService.resumeAfterRestart` resumes only a round with a safe checkpoint and a known completed/read-only operation; `unknown`/`executing` non-idempotent effects become `BLOCKED` with the ledger retained.

- [ ] **Step 1: Write failing tests.** Start a process once then force evaluator failure; assert no second launch in `full` mode and `BLOCKED` explains uncertainty. Test write/overwrite and unknown journal states likewise. For an approved read, restart mid-correction and assert the same round ID/ordinal, one operation, one final debit, and no new permission prompt. Refused approval produces no host operation. Test `NEEDS_USER_INPUT` resume preserves budget and does not create a new round merely for the reply.

```ts
expect(launchSpy).toHaveBeenCalledTimes(1);
expect(task.status).toBe('BLOCKED');
expect(task.correctionState.currentRound?.id).toBe(roundId);
expect(reopenedTask.correctionState.roundsUsed).toBe(1);
expect(reopenedTask.metrics.retryCount).toBe(1);
```

- [ ] **Step 2: Run red tests.** `npm test -- --run tests/integration/agent-loop.test.ts tests/unit/sqlite-store.test.ts`; expect resume and replay assertions to fail.
- [ ] **Step 3: Implement conservative recovery.** Treat anything other than a confirmed safe, reentrant operation as non-replayable. Query `operation_journal` before resuming an interrupted step; if a host-capable step reached execution but its journal record is missing, block rather than assume no side effect. Reuse confirmed results/checkpoints, otherwise block with an explicit reason. Do not erase `correctionState` when waiting/blocked. Make approval/input resumption reuse `currentRound.id` and prevent a second debit.

```ts
const operations = store.listStepOperations(task.id, stepId, bound.version);
const safe = operations.length > 0 && operations.every(record => record.state === 'completed'
  && (record.operation.permission === 'filesystem.read'
    || (record.operation.permission === 'filesystem.write' && record.operation.action === 'mkdir')));
if (!safe) return block(task, '操作状态不确定或副作用不可安全重放；本轮已保留。');
// Even a safe read prefers the persisted verified stepResult; only re-read if absent.
```

- [ ] **Step 4: Verify.** Focused tests plus `npm run typecheck` pass.

### Task 7: Surface accurate progress and final reasons through API and chat

**Files:** Modify `src/api/routes.ts`, `web/src/App.tsx`, `web/src/styles.css`; create `web/src/CorrectionStatus.tsx`; test `tests/integration/api.test.ts`, new `tests/unit/correction-status.test.ts`, `tests/unit/test-report-redaction.test.ts`.

**Interfaces:** `GET /api/tasks/:id` includes public `{correction:{roundsUsed,maxRounds:5,currentOrdinal?,target?,phase?,lastFailure?:{code,reason}}}` while omitting raw checkpoint, attachments' content, model reasoning, and full command output. UI reads this projection; the final task result includes concrete last failure and bounded attempt summary.

- [ ] **Step 1: Write failing tests.** API test checks in-progress and restored terminal correction fields, plus absence of secret/file body from events. UI test checks “第 1/5 轮纠正” only after the first corrective round starts (while `roundsUsed` remains zero), corrected target and test status, and terminal failed/blocked reason. A task with no corrections must not show a retry banner.

```ts
expect(response.json().task.correction).toMatchObject({
  roundsUsed: 0, maxRounds: 5, currentOrdinal: 1, target: 'answer',
});
expect(JSON.stringify(response.json().events)).not.toContain('PRIVATE_FILE_BODY');
const markup = renderToStaticMarkup(createElement(CorrectionStatus, { correction: response.json().task.correction }));
expect(markup).toContain('第 1/5 轮纠正');
```

- [ ] **Step 2: Run red tests.** `npm test -- --run tests/integration/api.test.ts tests/unit/correction-status.test.ts tests/unit/test-report-redaction.test.ts`; expect missing projection/display assertions to fail.
- [ ] **Step 3: Implement projection and presentation.** Build a small server-side projection from `correctionState`; replace `latestRetry`/`metrics.retryCount` display as the source of truth. Continue to render existing `TestSummaryCard`. Keep `task.failed` and `correction.round_finished` payloads redacted and bounded; restoration must show the same final conclusion.

```ts
const correction = {
  roundsUsed: task.correctionState.roundsUsed,
  maxRounds: 5,
  currentOrdinal: task.correctionState.currentRound?.ordinal,
  target: task.correctionState.currentRound?.target,
  phase: task.correctionState.currentRound?.phase,
  lastFailure: task.correctionState.failures.at(-1),
};
// Send a public projection only; do not expose currentRound.id or executionCheckpoint.
```

- [ ] **Step 4: Verify.** Focused tests, `npm run typecheck`, and `npm run build` pass.

### Task 8: Whole-system regression and release gate

**Files:** Modify only tests or documentation needed to close observed failures; no new product surface. Test `tests/integration/mvp-flow.test.ts`, `tests/integration/agent-loop.test.ts`, `tests/integration/api.test.ts`, all `tests/unit/*`.

**Interfaces:** No new runtime interface. The regression suite is the release gate for the earlier user reports: missing path, generated tool mismatch, file-summary false failure, process launch without duplicate side effects, and permission denial.

- [ ] **Step 1: Add/extend end-to-end fixtures.** Cover one successful task without corrections, an answer-only correction after reading a real temp file, five exhausted whole rounds, generic generated-tool replacement, approval denial, and blocked process replay. Assertions include task status, round count, operation journal count, capability statuses, events, and user-visible reason.

```ts
expect(success.correctionState.roundsUsed).toBe(0);
expect(exhausted.correctionState.roundsUsed).toBe(5);
expect(exhausted.result).toMatch(/失败原因|未满足|评估/);
expect(denied.status).toBe('CANCELLED');
expect(store.listStepOperations(blocked.id, 'launch-1', '1.0.0')).toHaveLength(1);
```

- [ ] **Step 2: Run the complete suite.** `npm test -- --run`; expected all tests pass. Fix product code only for concrete failing assertions, preserving the constraints above.
- [ ] **Step 3: Run static and production checks.** `npm run typecheck` and `npm run build`; expected exit code 0. On Windows, run the existing controlled `tests/integration/windows-desktop.test.ts` opt-in procedure if its prerequisites are present; do not launch a user's real app merely as a test.
- [ ] **Step 4: Review the change list and hand off.** Verify no SQLite file or local secret is included, no raw outputs in events, and no new model-command execution path. Record any Windows live-acceptance limitation explicitly. If the workspace gains Git metadata, commit the verified work in logical chunks; otherwise report the changed files and validation results without claiming a commit.
