# Jarvis MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable Jarvis MVP that accepts a chat request and files, uses a bounded Harness Agent Loop, generates a low-risk local read-only tool when capability is missing, evaluates and persists that tool, reuses it on later requests, and exits the loop automatically with a validated user result.

**Architecture:** A TypeScript/Node.js service owns the deterministic task state machine, budgets, retry limits, persistence, tool registry, sandbox runner, and MCP-compatible function adapter. Logical planner, evaluator, and implementer agents call one model gateway; the MVP includes an offline deterministic provider for tests/demo and an OpenAI-compatible provider for real model calls. A small React/Vite chat client polls task events and renders status, attachments, approvals, and results.

**Tech Stack:** Node.js 24+, TypeScript, Fastify, `node:sqlite`, Zod, Vitest, React, Vite, plain CSS. Generated tools are TypeScript/Node modules executed in a separate child process with a low-risk static policy for the MVP.

**Spec:** `docs/superpowers/specs/2026-09-22-jarvis-design.md`

## Global Constraints

- Local-first: task metadata and generated capability artifacts are stored under the application data directory; no cloud persistence is required.
- The MVP supports one model gateway with `MODEL_MODE=mock` by default and an OpenAI-compatible HTTP provider when configured.
- Only low-risk, local, read-only generated tools are auto-published in the MVP; high-risk permissions are rejected until the approval flow is implemented.
- A loop node gets one initial attempt plus at most 5 corrective retries; the task also has max steps, max duration, and token/cost budgets.
- Harness, not the model, decides whether a step retries, pauses, fails, or completes.
- No raw model hidden chain-of-thought is stored or displayed; only structured decisions, evidence, errors, and tool outputs are persisted.
- Generated tool code must pass static policy validation before execution and must run in an isolated child process with a temporary working directory.
- Personal memory is not implemented in this MVP; capability artifacts and task data remain separate.

## Review Focus

- A model claiming completion must not terminate the loop unless all acceptance criteria and pending-work checks pass; test in Task 5.
- Retry exhaustion must stop with an actionable failure and never spin indefinitely; test in Task 5.
- Generated code containing imports, process access, network APIs, or writes must be rejected before execution; test in Task 4.
- A generated capability must be versioned and reused instead of regenerated for an equivalent request; test in Task 4 and Task 5.
- Missing input and file upload failures must become recoverable task states rather than unhandled exceptions; test in Task 6.

## File Map

Create the following focused units:

- `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`: project scripts, compiler/test configuration, and local runtime settings.
- `src/domain/contracts.ts`: shared task, event, agent, tool, budget, and decision types.
- `src/storage/sqlite-store.ts`: schema and persistence for tasks, events, capabilities, and artifacts.
- `src/model/gateway.ts`, `src/model/mock-provider.ts`, `src/model/openai-compatible-provider.ts`: model boundary and providers.
- `src/agents/agent-runner.ts`: role prompts and structured model calls.
- `src/capabilities/manifest.ts`, `src/capabilities/registry.ts`, `src/capabilities/policy-validator.ts`, `src/capabilities/sandbox-runner.ts`, `src/capabilities/tool-factory.ts`: generated capability lifecycle and MCP-compatible invocation.
- `src/runtime/budget-manager.ts`, `src/runtime/scheduler.ts`, `src/runtime/agent-loop.ts`, `src/runtime/task-service.ts`: deterministic orchestration.
- `src/api/app.ts`, `src/api/routes.ts`, `src/server.ts`: HTTP API and static serving.
- `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/styles.css`, `web/vite.config.ts`, `web/tsconfig.json`: single-page chat UI.
- `tests/unit/*.test.ts`, `tests/integration/*.test.ts`: unit and end-to-end coverage for the MVP behavior.

### Task 1: Scaffold the TypeScript service and web client

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/api/app.ts`
- Create: `src/server.ts`
- Create: `web/index.html`
- Create: `web/src/main.tsx`
- Create: `web/src/App.tsx`
- Create: `web/src/styles.css`
- Create: `web/vite.config.ts`
- Create: `web/tsconfig.json`
- Test: `tests/unit/app.test.ts`

**Interfaces:**
- Produces `buildApp(deps?: AppDependencies): FastifyInstance`, a testable Fastify app with `GET /api/health` returning `{ "status": "ok" }`.
- Produces npm scripts `dev`, `dev:web`, `build`, `test`, `test:watch`, and `typecheck`.

- [ ] **Step 1: Write the failing health-route test**

```ts
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app';

describe('health route', () => {
  it('returns ok without starting a network listener', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- --run tests/unit/app.test.ts`

Expected: FAIL because the package and `buildApp` do not exist yet.

- [ ] **Step 3: Add the minimal project configuration and health app**

Use Fastify and TypeScript. `src/api/app.ts` must create the Fastify instance, register the health route, and return the instance without calling `listen`. `src/server.ts` must call `buildApp()` and listen on `HOST`/`PORT` only when run as the entrypoint.

Use this script contract:

```json
{
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "dev:web": "vite --config web/vite.config.ts",
    "build": "tsc -p tsconfig.json && vite build --config web/vite.config.ts",
    "test": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

Install runtime dependencies `fastify`, `@fastify/cors`, `@fastify/multipart`, `@fastify/static`, and `zod`; install dev dependencies `typescript`, `tsx`, `vitest`, `vite`, `@vitejs/plugin-react`, `react`, `react-dom`, `@types/node`, `@types/react`, and `@types/react-dom`.

- [ ] **Step 4: Add the minimal web shell and run the checks**

Render a centered Jarvis title, message list placeholder, multiline input, attachment button, and send button. Keep all styling in `web/src/styles.css`; do not add a second page or router.

Run: `npm test -- --run tests/unit/app.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

### Task 2: Define domain contracts and SQLite persistence

**Files:**
- Create: `src/domain/contracts.ts`
- Create: `src/storage/sqlite-store.ts`
- Test: `tests/unit/sqlite-store.test.ts`

**Interfaces:**
- `TaskStore.createTask(input: CreateTaskInput): TaskRun`
- `TaskStore.getTask(taskId: string): TaskRun | null`
- `TaskStore.saveTask(task: TaskRun): void`
- `TaskStore.appendEvent(taskId: string, event: TaskEvent): void`
- `TaskStore.listEvents(taskId: string): TaskEvent[]`
- `CapabilityStore.saveCapability(capability: CapabilityRecord): void`
- `CapabilityStore.findByIntent(intent: string): CapabilityRecord | null`
- `CapabilityStore.getActive(capabilityId: string): CapabilityRecord | null`

- [ ] **Step 1: Write failing persistence tests**

Cover task creation, event append/read, capability version persistence, lookup by normalized intent, and reopening the same SQLite file without losing records.

```ts
it('persists a task and events across store instances', () => {
  const first = createTestStore();
  const task = first.createTask({ message: 'count lines', attachments: [] });
  first.appendEvent(task.id, { type: 'task.created', payload: { message: 'count lines' } });

  const second = createTestStore(first.filename);
  expect(second.getTask(task.id)?.status).toBe('INTAKE');
  expect(second.listEvents(task.id)).toHaveLength(1);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npm test -- --run tests/unit/sqlite-store.test.ts`

Expected: FAIL because the contracts and store are not implemented.

- [ ] **Step 3: Implement contracts and schema**

Define `TaskStatus`, `TaskRun`, `TaskEvent`, `Attachment`, `BudgetSnapshot`, `CapabilityManifest`, `CapabilityRecord`, `EvaluationRecord`, `StepDecision`, `UserInputRequest`, and `CreateTaskInput`. Use JSON columns stored as text. Create tables `tasks`, `task_events`, `capabilities`, and `capability_artifacts` on store construction.

Use `node:sqlite` `DatabaseSync`; make the store accept a filename so tests can use a temporary file. Generate IDs with `crypto.randomUUID()`. Store timestamps as ISO strings.

- [ ] **Step 4: Implement normalized capability lookup**

Normalize intent by lowercasing, trimming, collapsing whitespace, and sorting a small set of extracted keywords. Store the normalized intent on each capability record. `findByIntent` must return the newest `active` matching record and must never return a `draft`, `rejected`, or `rollback` record.

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm test -- --run tests/unit/sqlite-store.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

### Task 3: Add the model gateway and three logical agent roles

**Files:**
- Create: `src/model/gateway.ts`
- Create: `src/model/mock-provider.ts`
- Create: `src/model/openai-compatible-provider.ts`
- Create: `src/agents/agent-runner.ts`
- Test: `tests/unit/model-gateway.test.ts`
- Test: `tests/unit/agent-runner.test.ts`

**Interfaces:**
- `ModelProvider.complete<T>(request: ModelRequest, schema: ZodSchema<T>): Promise<T>`
- `ModelGateway.complete<T>(request: ModelRequest, schema: ZodSchema<T>): Promise<T>`
- `AgentRunner.runPlanner(input: PlannerInput): Promise<PlannerDecision>`
- `AgentRunner.runEvaluator(input: EvaluationInput): Promise<EvaluationRecord>`
- `AgentRunner.runImplementer(input: ImplementerInput): Promise<ImplementerResult>`

- [ ] **Step 1: Write failing provider and role tests**

Test that the mock provider returns schema-valid planner, evaluator, and implementer objects; malformed provider output is rejected by Zod; the gateway includes model name and usage metadata in the result; and role prompts contain no hidden chain-of-thought request.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npm test -- --run tests/unit/model-gateway.test.ts tests/unit/agent-runner.test.ts`

Expected: FAIL because no gateway or runner exists.

- [ ] **Step 3: Implement the model contracts and mock provider**

`ModelRequest` contains `system`, `user`, `role`, `taskId`, and optional `context`. The mock provider must recognize the MVP intent “统计上传内容行数” and return a `ToolCandidate` for a pure `count_lines` tool; for unsupported requests it must return a planner decision with `needs_user_input` rather than inventing an unsafe capability.

The mock provider must be deterministic so integration tests do not require an API key.

- [ ] **Step 4: Implement the OpenAI-compatible HTTP provider**

Read `MODEL_BASE_URL`, `MODEL_API_KEY`, and `MODEL_NAME` from configuration. Send a chat-completions request with a JSON-only instruction and parse the returned JSON through the supplied Zod schema. Enforce a request timeout with `AbortController`; return a typed provider error containing status code and request ID without including the API key.

- [ ] **Step 5: Implement the role runner**

Keep role prompts in the runner and require structured output schemas:

```ts
type PlannerDecision = {
  intent: string;
  acceptanceCriteria: string[];
  requiredCapabilities: Array<{ name: string; purpose: string; riskLevel: 'low' | 'medium' | 'high' }>;
  steps: Array<{ id: string; description: string; dependsOn: string[] }>;
  status: 'ready' | 'needs_user_input';
  inputRequest?: UserInputRequest;
};
```

The evaluator returns `pass`, `retry`, `wait_approval`, or `fail`; the implementer returns a tool candidate or an execution result. No runner may return a free-form completion status to the orchestrator.

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -- --run tests/unit/model-gateway.test.ts tests/unit/agent-runner.test.ts`

Expected: PASS.

### Task 4: Implement capability generation, validation, sandbox execution, and MCP adapter

**Files:**
- Create: `src/capabilities/manifest.ts`
- Create: `src/capabilities/policy-validator.ts`
- Create: `src/capabilities/sandbox-runner.ts`
- Create: `src/capabilities/registry.ts`
- Create: `src/capabilities/tool-factory.ts`
- Test: `tests/unit/policy-validator.test.ts`
- Test: `tests/unit/capability-registry.test.ts`
- Test: `tests/integration/sandbox-tool.test.ts`

**Interfaces:**
- `PolicyValidator.validate(candidate: ToolCandidate): PolicyResult`
- `SandboxRunner.run(code: string, input: unknown, limits: SandboxLimits): Promise<SandboxResult>`
- `CapabilityRegistry.publish(candidate: ToolCandidate, evaluation: EvaluationRecord): Promise<CapabilityRecord>`
- `CapabilityRegistry.invoke(name: string, input: unknown): Promise<unknown>`
- `ToolFactory.build(request: ToolBuildRequest): Promise<ToolCandidate>`

- [ ] **Step 1: Write failing policy tests**

Reject candidates containing `import`, `require`, `process`, `child_process`, `worker_threads`, `net`, `http`, `https`, `fetch`, `eval`, `Function`, file writes, or undeclared permissions. Accept the pure `count_lines` candidate. Verify rejection occurs before any child process starts.

- [ ] **Step 2: Run policy tests and verify they fail**

Run: `npm test -- --run tests/unit/policy-validator.test.ts`

Expected: FAIL because the validator does not exist.

- [ ] **Step 3: Implement the low-risk manifest and policy validator**

The MVP only accepts `runtime: 'node-sandbox-v1'`, `riskLevel: 'low'`, an empty permission list, and a code contract exporting `async function run(input)`. Keep the validator conservative and return all rejection reasons.

- [ ] **Step 4: Write the sandbox integration test**

Create a valid `count_lines` module in a temporary directory, invoke it with `{ content: 'a\nb\n' }`, and assert `{ count: 2 }`. Add a test that an infinite loop is killed by the timeout and a test that a forbidden module fails validation before execution.

- [ ] **Step 5: Implement the child-process sandbox**

Write the candidate and a fixed runner bootstrap into a temporary directory, pass JSON input over stdin, read one JSON result from stdout, set a hard timeout, use a clean environment, and remove the temporary directory in `finally`. Do not expose the parent process environment or application data directory. Document that production deployment must replace this MVP process sandbox with a container or OS-level sandbox.

- [ ] **Step 6: Implement registry, factory, and MCP-compatible invocation**

`CapabilityRegistry.publish` saves immutable versioned artifacts and only exposes an evaluated `active` low-risk version. `invoke` resolves by name, validates input/output with the stored schemas, and calls `SandboxRunner`. `ToolFactory` converts the implementer’s structured candidate into a manifest and rejects candidates that do not pass policy.

Expose an internal adapter method with the MCP-equivalent shape:

```ts
listTools(): Promise<Array<{ name: string; description: string; inputSchema: unknown }>>;
callTool(name: string, arguments_: unknown): Promise<unknown>;
```

- [ ] **Step 7: Run all capability tests**

Run: `npm test -- --run tests/unit/policy-validator.test.ts tests/unit/capability-registry.test.ts tests/integration/sandbox-tool.test.ts`

Expected: PASS.

### Task 5: Implement the bounded Harness Agent Loop

**Files:**
- Create: `src/runtime/budget-manager.ts`
- Create: `src/runtime/scheduler.ts`
- Create: `src/runtime/agent-loop.ts`
- Create: `src/runtime/task-service.ts`
- Test: `tests/unit/budget-manager.test.ts`
- Test: `tests/unit/scheduler.test.ts`
- Test: `tests/integration/agent-loop.test.ts`

**Interfaces:**
- `BudgetManager.check(input: BudgetInput): BudgetSnapshot`
- `Scheduler.nextReadyStep(plan: TaskPlan, completed: Set<string>): PlanStep | null`
- `AgentLoop.run(taskId: string): Promise<TaskRun>`
- `TaskService.createAndStart(input: CreateTaskInput): Promise<TaskRun>`

- [ ] **Step 1: Write failing budget and scheduler tests**

Cover context overflow detection, reservation for output, max concurrent runs, dependency ordering, and no scheduling after global budget exhaustion.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npm test -- --run tests/unit/budget-manager.test.ts tests/unit/scheduler.test.ts`

Expected: FAIL because the runtime components do not exist.

- [ ] **Step 3: Implement budget and adaptive scheduling**

Use configurable defaults: 32,000 estimated context tokens, 4,000 output reservation, 3 concurrent Agent Runs, 120 seconds per task, 50 total steps, and 5 retries per loop node. Make every default overridable through `RuntimeConfig`.

The scheduler computes concurrency as the minimum of configured concurrency, model concurrency, available resource slots, and ready DAG nodes. The MVP resource monitor uses process memory and a configurable CPU slot count; it must reduce concurrency rather than throw when the limit is reached.

- [ ] **Step 4: Write failing Agent Loop integration tests**

Use the mock provider and a temporary SQLite store. Assert these cases:

```ts
it('generates, evaluates, invokes, and reuses a read-only tool', async () => {
  const first = await service.createAndWait({ message: '统计上传内容有多少行', attachments: [{ content: 'a\nb\n' }] });
  expect(first.status).toBe('COMPLETED');
  expect(first.result).toContain('2');

  const second = await service.createAndWait({ message: '再统计一次行数', attachments: [{ content: 'x\ny\nz\n' }] });
  expect(second.status).toBe('COMPLETED');
  expect(second.metrics.generatedCapabilityCount).toBe(0);
  expect(second.metrics.reusedCapabilityCount).toBe(1);
});
```

Also test evaluator retry then pass, five retries then `FAILED`, `NEEDS_USER_INPUT` pause/resume, and automatic termination after all acceptance criteria pass.

- [ ] **Step 5: Run integration tests and verify they fail**

Run: `npm test -- --run tests/integration/agent-loop.test.ts`

Expected: FAIL because no loop implementation exists.

- [ ] **Step 6: Implement the Agent Loop state machine**

Implement this order:

1. Create an immutable input snapshot and set `BUDGET_CHECK`.
2. Ask the planner for intent, acceptance criteria, required capabilities, and DAG steps.
3. Pause with `NEEDS_USER_INPUT` if the planner reports required fields.
4. For every missing low-risk capability, call the implementer, validate/build it, execute its generated tests, and ask the evaluator for a structured decision.
5. Retry only with prior failure evidence and increment the loop-node retry counter; stop after five corrective retries.
6. Schedule ready plan steps and invoke capabilities through the registry.
7. Evaluate each execution result against acceptance criteria.
8. Terminate only when every required step is terminal-success, no pending approval/input exists, and the result schema validates.
9. Pass only verified artifacts to `ResultSynthesizer`, persist a final event, set `COMPLETED`, and return the user-facing result.

If the task or step reaches a global budget, timeout, max-step, or cancellation condition, persist the reason and set `FAILED` or `CANCELLED`; never call the model again after terminal state.

- [ ] **Step 7: Run runtime tests and typecheck**

Run: `npm test -- --run tests/unit/budget-manager.test.ts tests/unit/scheduler.test.ts tests/integration/agent-loop.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

### Task 6: Add task, attachment, progress, and capability API routes

**Files:**
- Modify: `src/api/app.ts`
- Create: `src/api/routes.ts`
- Modify: `src/server.ts`
- Test: `tests/integration/api.test.ts`

**Interfaces:**
- `POST /api/tasks` multipart fields `message` and zero or more `files`; returns `202` with `{ taskId, status }`.
- `GET /api/tasks/:taskId` returns `{ task, events, result }`.
- `POST /api/tasks/:taskId/input` JSON `{ values: Record<string, unknown> }` resumes `NEEDS_USER_INPUT`.
- `POST /api/tasks/:taskId/approval` JSON `{ approved: boolean }` resolves an approval pause.
- `GET /api/capabilities` returns active capability summaries.

- [ ] **Step 1: Write failing route tests**

Test task creation with text only, task creation with a UTF-8 text attachment, status polling after the background loop completes, missing task returns 404, and input submission resumes a paused task.

- [ ] **Step 2: Run API tests and verify they fail**

Run: `npm test -- --run tests/integration/api.test.ts`

Expected: FAIL because routes and task service wiring do not exist.

- [ ] **Step 3: Implement multipart parsing and attachment snapshots**

Accept files up to 10 MB each and a total of 25 MB per task. Store filename, MIME type, size, and extracted UTF-8 text when possible; reject binary content that the MVP cannot extract with a structured 400 response. Never store uploaded content in the generated tool directory.

- [ ] **Step 4: Implement asynchronous task lifecycle routes**

`POST /api/tasks` creates the task and starts `TaskService.run` without blocking the HTTP response. `GET` returns current status and ordered events. Input and approval routes validate the current state before resuming. Add a process-level error boundary that records `task.failed` rather than leaving a task stuck in an active state.

- [ ] **Step 5: Run API tests**

Run: `npm test -- --run tests/integration/api.test.ts`

Expected: PASS.

### Task 7: Implement the single-page chat experience

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/src/main.tsx`
- Test/verification: `npm run build`

**Interfaces:**
- The UI posts `FormData` to `/api/tasks` and polls `/api/tasks/:taskId` every 750 ms until a terminal state.
- The UI renders task events by type and sends input/approval actions to the corresponding API route.

- [ ] **Step 1: Implement the message and attachment state**

Keep a single `messages` array, a `pendingFiles` array, and `activeTaskId`. File chips must support removal before sending. Disable send while a task is submitting, but allow cancel after a task is active.

- [ ] **Step 2: Implement progress and terminal rendering**

Render concise stage labels, retry count such as `第 2/5 次重试`, approval cards, missing-input cards, error states, and the verified final result. Do not render raw prompts or hidden model reasoning.

- [ ] **Step 3: Apply the reference-style visual treatment**

Use a centered empty state, rounded bordered composer, attachment icon/button, submit button, light neutral background, and responsive width. Keep the page as one chat surface; no dashboard or settings page is included in the MVP.

- [ ] **Step 4: Build the web client**

Run: `npm run build`

Expected: TypeScript and Vite build complete successfully and output `web/dist`.

### Task 8: Wire production defaults and perform full verification

**Files:**
- Modify: `src/api/app.ts`
- Modify: `src/server.ts`
- Modify: `.env.example`
- Create: `tests/integration/mvp-flow.test.ts`

- [ ] **Step 1: Add dependency wiring**

Create a `createDependencies(config)` function that chooses `MockModelProvider` when `MODEL_MODE` is absent or `mock`, otherwise chooses `OpenAICompatibleProvider`; uses one SQLite file under `JARVIS_DATA_DIR`; and shares one registry, sandbox, task service, and event store across routes.

- [ ] **Step 2: Add static web serving**

In production mode, serve `web/dist` with Fastify static and return `web/index.html` for `/`. Keep API routes under `/api` so the Vite dev server can proxy them during local development.

- [ ] **Step 3: Write the full MVP flow test**

Run a first request that generates and publishes `count_lines`, a second request that reuses it, an evaluator retry case, and an unsafe candidate rejection case in one temporary data directory. Assert that the final state is terminal and that the loop does not call the provider after completion.

- [ ] **Step 4: Run the complete verification suite**

Run:

```text
npm run typecheck
npm test -- --run
npm run build
```

Expected: all tests pass, the web build succeeds, and `npm run dev` plus the Vite dev server can serve the chat UI and API.

- [ ] **Step 5: Manual smoke test**

Start the service in mock mode, upload a text file containing three lines, and send `统计上传内容有多少行`. Confirm the UI shows capability analysis, generation, evaluation, execution, completion, and a result of `3`. Send a second equivalent request and confirm the UI reports capability reuse without generating a second version.

## Implementation Notes

The current workspace has no Git metadata, so implementation checkpoints cannot be committed until a repository is initialized. Do not run `git init` implicitly; preserve the user's existing workspace choice. The MVP child-process sandbox is an intentionally narrow development boundary, not a claim of production-grade isolation. Before enabling network, location, file-write, messaging, or third-party credentials, replace it with a container/OS-level sandbox and implement the approval route as a mandatory policy gate.
