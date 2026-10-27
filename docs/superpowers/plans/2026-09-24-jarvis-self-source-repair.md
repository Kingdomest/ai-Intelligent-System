# Jarvis Self-Source Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the observed PPT and follow-up failures and add a reusable, approval-gated source-repair workflow that never reports success without deployed, live revalidation.

**Architecture:** Keep model output declarative. The trusted runtime validates plans, runs built-in presentation rendering behind the existing permission broker, and links follow-up requests to persisted parent tasks. A separate repair coordinator owns candidate copies, fixed-command tests, hash-bound approvals, supervised deployment, rollback, and original-task revalidation.

**Tech Stack:** Node.js 24, TypeScript, Fastify, SQLite, React, Vitest, Ollama, PptxGenJS.

**Spec:** `docs/superpowers/specs/2026-09-24-jarvis-self-source-repair-design.md`

## Global Constraints

- Every formal source patch and every service restart receives separate explicit approval, including full-access mode.
- Candidate dynamic tests without verified OS isolation require their own explicit approval.
- No model-generated shell, PowerShell, or test script is executed.
- At most 5 complete correction rounds per user task; unknown/non-idempotent host effects are not replayed automatically.
- `REPAIRED` requires live execution against the original authorized target; dry-run or controlled-only tests are insufficient.
- The checkout has no Git metadata; never assume git reset or initialize Git as a workaround.

## Review Focus

- Object-valued `filesystem.write_text.content` must fail before any host operation, while valid typed wrappers normalize before final validation (Task 1).
- A user-specified target path and a second different presentation path must both work without hardcoded names (Task 2).
- Follow-up requests must not allow arbitrary unrelated task-ID references or leak attachment contents (Task 3).
- Approval denied or stale patch hash must never apply or activate candidate code (Task 5).
- A completed but non-idempotent operation must not be silently replayed during repair revalidation (Task 6).

---

### Task 1: Planner input and safe answer correction

**Files:** `tests/unit/agent-runner.test.ts`, `tests/unit/planner-contract.test.ts`, `tests/integration/agent-loop.test.ts`; `src/agents/agent-runner.ts`, `src/agents/planner-contract.ts`, `src/runtime/agent-loop.ts`.

**Interfaces:** `normalizePlannerOutput(raw: unknown): unknown` is invoked by the model gateway before planner Zod validation only; `safeToReplayTask(taskId: string): boolean` derives from operation-journal states.

- [ ] Add a test with a valid `{type:'string',value:'hello'}` wrapper and an invalid object in `filesystem.write_text.content`; prove one normalizes and the other never reaches host execution.
- [ ] Run `npm test -- --run tests/unit/agent-runner.test.ts tests/unit/planner-contract.test.ts`; expect new tests to fail against the current pre-validation implementation.
- [ ] Add a narrowly scoped pre-validator normalization hook to `ModelGateway.complete` or a planner-specific raw-completion path; preserve malformed-type errors and retain the existing one-correction retry.
- [ ] Add a regression test for zero journal operations plus a failed final-answer evaluation; expect a corrective pass, not `BLOCKED` for unsafe replay.
- [ ] Derive replay safety from the journal and verified checkpoint rather than `false`; run focused tests and `npm test -- --run` to green.

### Task 2: Reusable real presentation capability

**Files:** `tests/unit/presentation-renderer.test.ts`, `tests/unit/builtin-catalog.test.ts`, `tests/unit/host-operations.test.ts`, `tests/unit/test-executor.test.ts`; `src/presentations/render.ts`, `src/agents/planner-contract.ts`, `src/agents/agent-runner.ts`, `src/capabilities/builtin-catalog.ts`, `src/capabilities/sandbox-runner.ts`, `src/permissions/operation-protocol.ts`, `src/permissions/host-operations.ts`, `src/runtime/test-executor.ts`, `src/agents/test-agent.ts`, `src/capabilities/policy-validator.ts`, `package.json`.

**Interfaces:** `presentation.create` takes `{path:string, slides:Array<{title:string, bullets:string[]}>}` with bounded counts/lengths; `host.presentation.create({path,slides})` emits a `filesystem.write` operation `createPresentation`; renderer returns `{path,bytesWritten,slideCount}`.

- [ ] Write tests for two different targets and topics, missing input, denied permission, simulated host failure, and a ZIP/OOXML read of the actual output.
- [ ] Run focused tests; expect missing capability/renderer failures.
- [ ] Add the built-in, sandbox bridge, broker-side renderer, strict path policy, no-overwrite/atomic output, and live file verification; use PptxGenJS from its official API with a pinned installed version.
- [ ] Teach planner routing that “内容随意” supplies content discretion, and make `presentation.create` the default PPT operation.
- [ ] Run focused tests, full suite, typecheck, and build to green.

### Task 3: Parent-task context and repair-intent routing

**Files:** `tests/unit/sqlite-store.test.ts`, `tests/integration/api.test.ts`, `tests/integration/agent-loop.test.ts`, `web/src/App.tsx`; `src/domain/contracts.ts`, `src/storage/sqlite-store.ts`, `src/api/routes.ts`, `src/runtime/agent-loop.ts`, `src/agents/agent-runner.ts`.

**Interfaces:** `CreateTaskInput.parentTaskId?: string`; a persisted `parent_task_id` column; bounded `ParentTaskSummary` containing request/status/error/test/operation evidence but no attachments or secrets.

- [ ] Write a failing test: a follow-up referencing a failed task receives its safe summary; an unknown parent ID is rejected; unrelated supplied IDs cannot be accepted through model output.
- [ ] Run focused tests to see expected failures.
- [ ] Persist parent link, include it in multipart/API submission and UI, validate same local session/loopback origin for repair actions, and pass summary to planner/repair classifier.
- [ ] Confirm ordinary “为什么失败” is a read-only explanation, while explicit “修复源码” enters a RepairJob.
- [ ] Run focused and full suite.

### Task 4: Repair-job contracts and candidate verification

**Files:** `tests/unit/repair-job.test.ts`, `tests/unit/repair-candidate.test.ts`; `src/repair/contracts.ts`, `src/repair/candidate.ts`, `src/repair/coordinator.ts`, `src/storage/sqlite-store.ts`, `src/domain/contracts.ts`.

**Interfaces:** `RepairJob` has persisted `status`, `sourceTaskId`, `requestTaskId`, `candidateHash`, `baselineHash`, round counts, redacted test summaries; candidate patch is structured file replacements constrained to source allowlist, never commands.

- [ ] Write tests for state transitions, five-round budget, malicious paths, duplicate patch targets, baseline-hash conflict, and test-command allowlist.
- [ ] Run tests to verify red.
- [ ] Implement schema, SQLite persistence, immutable candidate copy and hash-bound proposal, fixed-command test runner with time/output limits, and red-before-green evidence.
- [ ] Require separate candidate-test approval when OS isolation is unavailable; blocked tests never masquerade as passing.
- [ ] Run focused/full tests, typecheck, build.

### Task 5: Patch, restart, rollback approvals and supervised deployment

**Files:** `tests/integration/repair-deployment.test.ts`, `tests/integration/api.test.ts`; `src/repair/deployment.ts`, `src/repair/supervisor-protocol.ts`, `src/api/routes.ts`, `src/server.ts`, `web/src/App.tsx`, `web/src/styles.css`.

**Interfaces:** approval records bind to `{jobId,kind,candidateHash}` where `kind` is `candidate_test|patch_apply|service_restart`; supervisor receives a versioned deployment request and reports health/rollback; unmanaged `tsx watch` returns `BLOCKED` rather than being killed.

- [ ] Write tests for each approval refusal, stale hash, concurrent file edit, unmanaged dev server, failed health check and authorized rollback.
- [ ] Run tests to red.
- [ ] Add two-phase deployment API/UI and a trusted external supervisor entrypoint; keep old snapshot/build until live revalidation.
- [ ] Run focused/full tests, typecheck, build; do not restart the user's current service during implementation.

### Task 6: Original-task live revalidation and end-to-end acceptance

**Files:** `tests/integration/repair-revalidation.test.ts`, `tests/integration/agent-loop.test.ts`, `tests/integration/api.test.ts`; `src/repair/coordinator.ts`, `src/runtime/agent-loop.ts`, `src/runtime/task-service.ts`, `src/api/routes.ts`, `web/src/App.tsx`.

**Interfaces:** `revalidate(jobId)` returns `REPAIRED` only when the original request has a new live, approved, test/evaluator-verified outcome; otherwise `BLOCKED`/`FAILED`/`ROLLED_BACK` with a redacted reason.

- [ ] Write tests for zero-operation replay, verified read reuse, unsafe write/launch blocked, controlled-only test not sufficient, and successful original-target completion.
- [ ] Run tests to red.
- [ ] Integrate repair coordinator and original-task revalidation; expose durable progress and final result in API/UI.
- [ ] Run all tests, typecheck, build, plus a permission-controlled local PPTX end-to-end test. Record unrun Windows-only or service-restart acceptance explicitly.

## Execution note

The user explicitly said “实现” after reviewing the written design, and had selected Native for this product work earlier. Proceed in this implementation session without another plan-approval round. This non-Git checkout cannot use worktree/commit helpers; record test evidence here and do not initialize Git.
