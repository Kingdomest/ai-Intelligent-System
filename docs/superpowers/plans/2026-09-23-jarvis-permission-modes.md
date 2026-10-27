# Jarvis Permission Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in the selected Native workflow.

**Goal:** Add task-scoped Request Approval, Help Me Approve, and Full Access modes with real backend enforcement, safe host operations, one-shot approval/resume, and a matching chat UI.

**Architecture:** Persist a permission mode, checkpoint, pending approval, and idempotent host-operation journal on each task. Generated tools use a typed host bridge; a Permission Broker classifies each concrete action, executes it through host adapters, or pauses the Agent Loop until an exact one-shot decision arrives. A permission selector and approval card expose that state in the chat.

**Tech Stack:** Node.js 24+, TypeScript, Fastify, `node:sqlite`, Zod, Vitest, React, Vite, plain CSS, Windows filesystem/network/process APIs.

**Spec:** `docs/superpowers/specs/2026-09-23-jarvis-permission-modes-design.md`

## Global Constraints

- Permission mode is task-scoped; omitted mode defaults to `request`; the UI remembers the last choice locally.
- If a local path is omitted, the current Jarvis project directory is the default root for `request` and `auto` modes.
- An approval authorizes only the exact pending operation; a denial must produce zero side effects.
- `request` allows workspace/attachment reads and asks before writes or external effects.
- `auto` allows non-destructive new file/directory creation inside the workspace; it asks for destructive, outside-workspace, external-data, process, location, and uncertain operations.
- `full` skips per-operation prompts for supported capabilities and runs with the permissions of the Windows account hosting Jarvis.
- Candidate evaluation uses a dry-run host bridge; only passing candidates can be registered; real operations run through the Permission Broker.
- Existing SQLite tasks and capabilities remain readable after schema migration.
- A pending operation is never replayed automatically after a restart; execution must be resumed from a persisted checkpoint and operation journal.
- Do not store model hidden reasoning, credentials, or full sensitive payloads in permission events.
- The workspace has no Git repository; omit Git commit steps and preserve existing user files.

## Review Focus

- Windows drive, UNC, traversal, and symlink paths must not escape the workspace in `request` or `auto`; cover in Task 2.
- Duplicate approval submissions and step retries must not repeat a side effect; cover in Tasks 1 and 4.
- A server restart with a pending request must keep the approval visible and resume only after a matching user decision; cover in Task 4.
- Network requests that include task or local-file content must not be silently auto-approved; cover in Task 2.
- A pre-feature SQLite database must migrate without losing tasks, events, or capabilities; cover in Task 1.

---

### Task 1: Permission Contracts and Durable Task State

**Files:**
- Modify: `src/domain/contracts.ts`
- Modify: `src/storage/sqlite-store.ts`
- Modify: `src/api/routes.ts`
- Test: `tests/unit/sqlite-store.test.ts`
- Test: `tests/integration/api.test.ts`

**Interfaces:**
- Produces `PermissionMode = 'request' | 'auto' | 'full'`.
- Produces `PermissionOperation` with `operationId`, `permission`, `action`, `target`, `reason`, and bounded `arguments`.
- Produces `PendingPermissionRequest` with a request ID, operation, risk label, creation time, and task ID.
- Produces `ExecutionCheckpoint = { planner: unknown; capabilityName: string; capabilityVersion: string; completedStepIds: string[]; currentStepId: string; operationSequence: number }`.
- `TaskRun` stores `permissionMode`, optional `pendingPermission`, and optional `executionCheckpoint`.
- `SqliteStore` persists pending/resolved operations with a unique `(task_id, operation_id)` key and supports idempotent decision lookup.
- Task creation accepts an optional validated `permissionMode`; missing values become `request`.

- [ ] **Step 1: Write a migration regression test**

Create a legacy SQLite fixture using the current task/event/capability schema, insert one task and one active capability, then open it with `SqliteStore`. Assert the task still loads with mode `request`, no pending approval, and the original capability remains active.

Run: `npm test -- --run tests/unit/sqlite-store.test.ts`

Expected: FAIL because `permissionMode` and approval journal fields are absent.

- [ ] **Step 2: Add permission and checkpoint contracts**

```ts
export type PermissionMode = 'request' | 'auto' | 'full';

export interface PermissionOperation {
  operationId: string;
  permission: CapabilityManifest['permissions'][number];
  action: string;
  target: string;
  reason: string;
  arguments: Record<string, unknown>;
}

export interface PendingPermissionRequest {
  requestId: string;
  taskId: string;
  operation: PermissionOperation;
  risk: 'low' | 'medium' | 'high';
  createdAt: string;
}
```

Extend `CreateTaskInput` and `TaskRun`. Add a checkpoint containing the persisted planner decision, current capability name/version, completed step IDs, and current step ID so a resumed task has a stable execution point.

- [ ] **Step 3: Implement backward-compatible SQLite migration and journal methods**

Add `permission_mode TEXT NOT NULL DEFAULT 'request'`, `pending_permission_json`, and `execution_checkpoint_json` to existing tasks. Add an operation journal table with task ID, operation ID, request ID, state (`pending`, `approved`, `denied`, `completed`, `unknown`), serialized operation, optional result, and timestamps. Run `PRAGMA table_info(tasks)` and add only missing columns; create the journal table with `IF NOT EXISTS`.

Expose store methods to save/read a pending request, record a decision once, look up completed operation results, and mark an in-flight operation `unknown` after restart rather than replaying it.

- [ ] **Step 4: Add task API mode parsing and migration assertions**

Reject unknown permission modes with HTTP 400; parse omitted mode as `request`; return the stored mode and pending request from `GET /api/tasks/:taskId`. Extend the legacy fixture assertions to verify task/event/capability data is unchanged and mode defaults correctly.

Run: `npm test -- --run tests/unit/sqlite-store.test.ts tests/integration/api.test.ts`

Expected: PASS, including legacy migration and invalid mode cases.

---

### Task 2: Deterministic Permission Policy

**Files:**
- Create: `src/permissions/policy.ts`
- Create: `tests/unit/permission-policy.test.ts`
- Modify: `src/domain/contracts.ts`

**Interfaces:**
- `PermissionPolicy.decide(mode: PermissionMode, operation: PermissionOperation, context: PermissionContext): 'allow' | 'require_approval' | 'deny'`.
- `PermissionContext = { workspaceRoot: string; containsTaskData: boolean; targetExists: boolean; destructive: boolean; external: boolean }`.
- Path containment uses normalized absolute paths and resolves existing symlink ancestors before classifying.

- [ ] **Step 1: Write table-driven policy tests**

Cover: workspace read in `request` allows; outside-workspace read asks; any write in `request` asks; new directory inside the project in `auto` allows; overwrite/delete/outside path/network with task data/process/location in `auto` asks; all supported operations in `full` allow; unknown operations fail closed outside `full`.

Include Windows drive-letter, UNC, `..` traversal, mixed separators, case-insensitive comparison, and symlink escape cases.

Run: `npm test -- --run tests/unit/permission-policy.test.ts`

Expected: FAIL because no PermissionPolicy exists.

- [ ] **Step 2: Implement canonical path and risk classification**

Resolve the candidate path against the workspace root, canonicalize case/separators, resolve the nearest existing ancestor with `realpath`, then verify containment using `path.relative`. Treat overwrite, delete, outside-workspace, process, location, unknown permission, and user-data network transfer as approval-required in `auto`.

In `auto`, allow only public `GET` requests with no task or local-file payload. Require approval for other HTTP methods, non-public/local targets, and requests carrying task data.

The agent may return a risk explanation, but the result cannot downgrade a deterministic hard-boundary decision.

- [ ] **Step 3: Run the policy tests and refine boundaries**

Run: `npm test -- --run tests/unit/permission-policy.test.ts`

Expected: PASS for every mode and path boundary; no unknown action is silently allowed outside `full`.

---

### Task 3: Host Operation Bridge and Dry-Run Sandbox

**Files:**
- Create: `src/permissions/host-operations.ts`
- Create: `src/permissions/operation-protocol.ts`
- Modify: `src/capabilities/sandbox-runner.ts`
- Modify: `src/capabilities/policy-validator.ts`
- Modify: `src/capabilities/tool-factory.ts`
- Modify: `src/agents/agent-runner.ts`
- Create: `tests/unit/host-operations.test.ts`
- Create: `tests/unit/sandbox-runner.test.ts`

**Interfaces:**
- `HostExecutionContext = { taskId: string; mode: PermissionMode; workspaceRoot: string; capabilityPermissions: CapabilityManifest['permissions']; stepId: string; operationSequence: number; dryRun: boolean }`.
- `HostOperationExecutor.execute(operation: HostCall, context: HostExecutionContext): Promise<HostCallResult>` handles only typed, declared operations.
- `CapabilityHost` exposes `fs.readText(path: string)`, `fs.writeText(path: string, content: string)`, `fs.mkdir(path: string)`, `fs.remove(path: string)`, `network.request(request: { url: string; method: string; headers?: Record<string, string>; body?: string })`, `process.run(request: { command: string; args: string[]; cwd?: string })`, and `location.current()`; each method sends an operation message to the host.
- `SandboxRunner.run(code: string, input: unknown, options: { mode: 'dry-run' | 'live'; hostCall: (call: HostCall) => Promise<HostCallResult> }): Promise<SandboxResult>` injects the bridge into `run(input, host)`; dry-run uses fake adapters and never touches host resources.
- `location.current` returns an explicit unsupported result when no adapter exists.

- [ ] **Step 1: Write host adapter tests**

Test a dry-run directory create without a real directory, live create inside a temporary root, safe text read/write, an outside-root rejection in restricted mode, an HTTP call routed to a fake fetch adapter, a process call routed to a fake process adapter, and an unsupported location result.

Run: `npm test -- --run tests/unit/host-operations.test.ts tests/unit/sandbox-runner.test.ts`

Expected: FAIL because host operations and bridge protocol do not exist.

- [ ] **Step 2: Add the typed host-operation protocol**

```ts
export interface HostCall {
  callId: string;
  permission: 'filesystem.read' | 'filesystem.write' | 'network' | 'location' | 'process';
  action: string;
  target: string;
  reason: string;
  arguments: Record<string, unknown>;
}

export interface HostCallResult {
  callId: string;
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string };
}
```

Implement a child-process IPC protocol with request/response IDs. The trusted runner owns IPC; generated modules receive only the frozen `CapabilityHost` methods. Keep stdout result parsing separate from IPC messages.

- [ ] **Step 3: Implement host adapters and dry-run adapters**

Implement filesystem operations using `node:fs/promises`, outbound requests using `fetch`, and process execution using `spawn` with explicit arguments, working directory, timeout, and bounded output. Route each operation through the permission callback before the adapter runs. Keep location explicitly unsupported when no provider exists.

Dry-run adapters record proposed effects and return realistic structured results without performing them.

- [ ] **Step 4: Update implementer contract and static policy**

Update the implementer prompt/schema so generated code declares only the permissions it uses and calls the injected host bridge. Continue rejecting `import`, `require`, direct `fetch`, `process`, child-process APIs, and direct filesystem APIs in generated code. The runtime bridge, rather than unrestricted imports, is the only route to host effects.

- [ ] **Step 5: Run host bridge and capability tests**

Run: `npm test -- --run tests/unit/host-operations.test.ts tests/unit/sandbox-runner.test.ts tests/unit/policy-validator.test.ts`

Expected: PASS; candidate evaluation causes no real file/network/process effects.

---

### Task 4: Permission Broker, Approval Pause, and Checkpoint Resume

**Files:**
- Create: `src/permissions/permission-broker.ts`
- Modify: `src/runtime/agent-loop.ts`
- Modify: `src/runtime/task-service.ts`
- Modify: `src/storage/sqlite-store.ts`
- Create: `tests/unit/permission-broker.test.ts`
- Modify: `tests/integration/agent-loop.test.ts`

**Interfaces:**
- `PermissionBroker.handle(taskId: string, operation: PermissionOperation, context: HostExecutionContext): Promise<unknown>` performs, caches, pauses, or rejects the exact operation.
- `PermissionBroker.resolve(taskId: string, requestId: string, approved: boolean): Promise<void>` is idempotent and resolves only the matching pending request.
- `TaskService.resolveApproval(taskId: string, requestId: string, approved: boolean): Promise<TaskRun>` delegates to the broker and resumes the checkpointed Agent Loop.
- `PermissionDeniedError` distinguishes denial from execution/evaluation failure.

- [ ] **Step 1: Write Agent Loop pause/resume tests**

Use a real temporary SQLite store and fake host adapters. Assert that a write in `request` enters `WAITING_FOR_APPROVAL` before the adapter is called; approval invokes it once and finishes the task; denial invokes it zero times; a repeated approval request does not invoke it twice; and a prior concrete capability error is not overwritten with “没有可用能力”.

Run: `npm test -- --run tests/unit/permission-broker.test.ts tests/integration/agent-loop.test.ts`

Expected: FAIL because the broker is not connected to task execution.

- [ ] **Step 2: Implement mode decision and durable wait state**

For `allow`, execute the host operation and persist its result. For `require_approval`, persist the exact request and checkpoint, append `task.permission_requested`, set `WAITING_FOR_APPROVAL`, and await the request's deferred result. For denial, never invoke the adapter and set a clear cancelled/denied result.

- [ ] **Step 3: Implement one-shot approval and operation idempotency**

Match both task ID and request ID. Derive a stable operation ID from `taskId + stepId + capabilityVersion + operationSequence`, excluding retry count so a resumed or retried step reuses completed results. Record the decision transactionally before execution. Return the stored result for completed operation IDs; reject stale/mismatched decisions. If restart finds an operation stuck in `executing`, mark it `unknown`, do not replay it, and require explicit recovery handling.

- [ ] **Step 4: Persist planner/step checkpoint and resume after restart**

Save the planner output, active capability version, completed steps, current step, and operation sequence before execution. On explicit approval after restart, restore the checkpoint and rerun the current step with stable operation IDs; the broker returns cached results for completed earlier operations and waits/executes only the pending operation.

- [ ] **Step 5: Preserve actionable task failures**

Change `ensureCapabilities` to return a typed outcome (`ready`, `waiting`, or `failed`) rather than calling `fail()` and then returning `null`. Preserve the exact evaluator, policy, sandbox, or host error in the task result.

- [ ] **Step 6: Run permission and Agent Loop regression tests**

Run: `npm test -- --run tests/unit/permission-broker.test.ts tests/integration/agent-loop.test.ts`

Expected: PASS, including restart checkpoint, retry idempotency, approve, deny, and concrete failure reporting.

---

### Task 5: Approval API and Persistent Task Events

**Files:**
- Modify: `src/api/routes.ts`
- Modify: `src/runtime/dependencies.ts`
- Modify: `src/api/app.ts`
- Modify: `tests/integration/api.test.ts`

**Interfaces:**
- `POST /api/tasks` accepts `{ message, attachments?, permissionMode? }` and returns the task mode.
- `GET /api/tasks/:taskId` returns `task.permissionMode`, `task.pendingPermission`, current status, and permission events.
- `POST /api/tasks/:taskId/approval` accepts `{ requestId, approved }` and returns the resolved task status.

- [ ] **Step 1: Write approval route tests**

Verify create-task mode persistence; a pending request appears in task GET; exact approval returns 202 and resumes; denial resolves without calling the host adapter; invalid request ID returns 409; a repeated approval response is idempotent; and the existing disabled-approval 409 test is replaced with enabled runtime behavior.

Run: `npm test -- --run tests/integration/api.test.ts`

Expected: FAIL because runtime dependencies do not provide approval resolution.

- [ ] **Step 2: Wire broker resolution and structured API responses**

Register `taskService.resolveApproval` in runtime services. Validate task/request pairing and decision body with Zod. Return a stable current task status and a useful conflict message for stale, duplicate, or terminal requests.

- [ ] **Step 3: Verify API behavior**

Run: `npm test -- --run tests/integration/api.test.ts`

Expected: PASS with no unhandled errors for approval or denial.

---

### Task 6: Permission Selector and Chat Approval Card

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- `PermissionMode` in the UI is `request | auto | full`.
- Browser-local preference is stored under `jarvis.permissionMode`.
- New task form data includes `permissionMode`.
- Task polling renders the persisted pending permission request.
- Approval buttons send `{ requestId, approved: true|false }` to the existing approval route.

- [ ] **Step 1: Implement the composer permission menu**

Place the selector between “添加文件” and send. Add the three Chinese labels and descriptions from the spec. Initialize from local storage with `request` fallback; save changes locally; include the choice in every multipart submission.

- [ ] **Step 2: Implement the approval card**

When status is `WAITING_FOR_APPROVAL`, show action, target, reason, risk/permission, “允许这次”, and “拒绝”. Disable both choices after submission, refresh the task, and display the resumed or denied result. Keep the ordinary task composer disabled while a permission decision is pending for that task.

- [ ] **Step 3: Add accessible behavior and responsive styling**

Support keyboard focus, menu dismissal with Escape/outside click, descriptive button labels, and narrow screens. The `full` mode description must clearly state it can access arbitrary local paths and the internet and may launch processes.

- [ ] **Step 4: Build the frontend**

Run: `npm run build`

Expected: Vite emits the production assets and TypeScript has no errors.

---

### Task 7: End-to-End Permission Scenarios and Final Verification

**Files:**
- Modify: `tests/integration/agent-loop.test.ts`
- Modify: `tests/integration/api.test.ts`
- Modify: `.superpowers/sdd/2026-09-22-jarvis-mvp/progress.md`

**Interfaces:**
- A multipart task can select a permission mode and receive a persisted approval card state.
- Approval and denial produce auditable events and one operation-journal entry.
- Existing read-only tool reuse remains unchanged.

- [ ] **Step 1: Add end-to-end directory scenarios with a temporary workspace**

Cover: `request` asks before creating `hm`; approve creates the directory under the selected/current workspace and reports its resolved path; deny leaves no directory; `auto` creates a new workspace directory without asking; `auto` asks before overwriting/outside-workspace writes; `full` performs a supported outside-workspace write without a prompt; and candidate dry-run never creates a real directory.

- [ ] **Step 2: Add resume, retry, and legacy migration scenarios**

Cover pending approval reload, server restart checkpoint restore, repeated approval submission, failed capability explanation preservation, and migration of an existing task database.

- [ ] **Step 3: Run the required suite and static checks**

Run: `npm test -- --run`

Expected: all existing and new unit/integration tests pass.

Run: `npm run typecheck`

Expected: exit code 0.

Run: `npm run build`

Expected: exit code 0 with generated frontend assets.

- [ ] **Step 4: Smoke the running app in the browser**

Submit three small tasks: one `request` task and approve its folder creation, one `auto` in-workspace folder creation, and one `full` mode task. Confirm the selector sits beside upload, pending approval survives a page refresh, denied actions leave no file, and completed results name the actual target.

- [ ] **Step 5: Record completion evidence**

Update the SDD progress ledger with files changed, final task state transitions, test/build/typecheck output, and any host capability deliberately left unsupported (for example, location when no adapter exists). Do not claim an unsupported capability worked.
