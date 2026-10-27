# Jarvis A2A Dynamic Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent local A2A protocol and dynamic child-agent controller so a main agent can create bounded child agents that communicate within one task tree.

**Architecture:** Store agent sessions and messages in SQLite, expose them through an `A2AProtocol` service, and keep API/JSON-RPC as thin adapters. Add an `AgentController` for parent/root validation and dynamic creation while retaining the existing AgentLoop as a compatibility execution path.

**Tech Stack:** TypeScript ES2022, Fastify 5, Zod 4, Node `node:sqlite`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-12-jarvis-a2a-dynamic-agents-design.md`

## Global Constraints

- Same-root task isolation is mandatory for every Agent message.
- Agent creation and message delivery are persisted transactions; in-memory events cannot be the source of truth.
- Root task trees allow at most 12 child Agents, each create call at most 4.
- Agent names are limited to 80 chars, role/goal to 2,000 chars, and serialized message payloads to 8,000 chars.
- Existing task/session/permission behavior and tests must remain compatible.
- A delivered message never claims that the recipient model executed it.

## Review Focus

- Duplicate message IDs must be idempotent across retries and restarts.
- Parent/root mismatch and cross-tree delivery must be rejected before persistence.
- Terminal/cancelled recipients must not accept new work requests.
- Malformed JSON-RPC and oversize payloads must produce bounded structured errors.
- Existing API test fixtures without A2A services must still register routes and run.

---

### Task 1: Add domain contracts and SQLite persistence

**Files:**
- Modify: `src/domain/contracts.ts`
- Modify: `src/storage/sqlite-store.ts`
- Test: `tests/unit/sqlite-store.test.ts`

**Interfaces:**
- Produce `AgentStatus`, `AgentMessageType`, `AgentMessageStatus`, `AgentSessionRecord`, `AgentMessageRecord`, `CreateAgentInput`, and `SendAgentMessageInput`.
- Produce `SqliteStore.createAgent`, `getAgent`, `listAgents`, `updateAgentStatus`, `sendAgentMessage`, `getAgentMessage`, `listAgentMessages`, and `ackAgentMessage`.

- [ ] **Step 1: Write failing persistence tests** for agent creation, parent/root links, message round trip, duplicate message ID, ack transitions, and reopen recovery.
- [ ] **Step 2: Run `npm test -- tests/unit/sqlite-store.test.ts` and verify the new tests fail because the contracts/store methods are absent.**
- [ ] **Step 3: Implement migration version 4 and the typed SQLite methods.** Use `CREATE TABLE IF NOT EXISTS`, transactional insert/update, and a unique message primary key; return the existing row on an idempotent duplicate with the same envelope.
- [ ] **Step 4: Run the focused store tests and verify they pass.**
- [ ] **Step 5: Run the existing store test file to catch migration regressions.**

### Task 2: Implement the A2A protocol service

**Files:**
- Create: `src/agents/a2a-protocol.ts`
- Test: `tests/unit/a2a-protocol.test.ts`

**Interfaces:**
- `class A2AProtocol` consumes `SqliteStore`.
- `createAgent(input: CreateAgentInput): AgentSessionRecord`
- `getAgent(agentId: string): AgentSessionRecord | null`
- `listAgents(rootTaskId?: string): AgentSessionRecord[]`
- `sendMessage(input: SendAgentMessageInput): AgentMessageRecord`
- `listInbox(agentId: string, options?: { status?: AgentMessageStatus; limit?: number; before?: string }): AgentMessageRecord[]`
- `ackMessage(agentId: string, messageId: string, status: 'delivered' | 'read' | 'failed', error?: string): AgentMessageRecord`
- `agentCard(): AgentCard`

- [ ] **Step 1: Write failing service tests** for same-tree request/response, invalid parent, cross-tree isolation, max 12 children, payload limits, terminal recipient rejection, and duplicate send idempotency.
- [ ] **Step 2: Run `npm test -- tests/unit/a2a-protocol.test.ts` and verify expected failures.**
- [ ] **Step 3: Implement validation and protocol error types.** Infer `rootTaskId` from the parent, require an existing root task when supplied, and use the store as the only persistence boundary.
- [ ] **Step 4: Run focused service tests and verify they pass.**
- [ ] **Step 5: Refactor only after green to keep protocol validation separate from storage mapping.**

### Task 3: Add AgentController and runtime wiring

**Files:**
- Create: `src/runtime/agent-controller.ts`
- Modify: `src/runtime/dependencies.ts`
- Test: `tests/unit/agent-controller.test.ts`

**Interfaces:**
- `AgentController` consumes `A2AProtocol` and exposes `spawnChildren(parentAgentId, specs)` and `send(parentAgentId, input)`.
- `RuntimeDependencies` produces `a2aProtocol` and `agentController` without changing existing task service construction.

- [ ] **Step 1: Write failing controller tests** for creating several children atomically, preserving parent/root identity, and rejecting non-main recursive creation.
- [ ] **Step 2: Run the focused controller tests and verify expected failures.**
- [ ] **Step 3: Implement bounded orchestration.** Only the designated main/root Agent can spawn; child specs are validated before any child is persisted; sending delegates to `A2AProtocol`.
- [ ] **Step 4: Run controller tests and existing dependency tests.**

### Task 4: Expose Agent Card, REST, and JSON-RPC API

**Files:**
- Modify: `src/api/routes.ts`
- Modify: `src/runtime/dependencies.ts`
- Test: `tests/integration/a2a-api.test.ts`

**Interfaces:**
- Extend `ApiServices` with optional `a2aProtocol` and `agentController` to preserve existing fixtures.
- Add REST endpoints from the spec and `POST /api/a2a/jsonrpc` methods `message/send`, `agents/list`, `tasks/get`.

- [ ] **Step 1: Write failing integration tests** for Agent Card, create/list Agent, send/inbox/ack, cross-tree 409/403 behavior, and JSON-RPC success/error envelopes.
- [ ] **Step 2: Run the focused API tests and verify route-not-found or service-not-wired failures.**
- [ ] **Step 3: Implement Zod request schemas, status mapping, bounded public projections, and optional route registration.** Never return payload secrets outside the stored message contract.
- [ ] **Step 4: Run focused API tests and the existing API integration suite.**

### Task 5: Verify compatibility and document usage

**Files:**
- Modify: `docs/superpowers/specs/2026-10-12-jarvis-a2a-dynamic-agents-design.md` only if implementation constraints changed.
- Create: `docs/a2a-agent-collaboration.md`

- [ ] **Step 1: Write a short usage guide** showing main Agent creation, two child Agents, request/response, artifact message, and ack lifecycle.
- [ ] **Step 2: Run `npm run typecheck`.**
- [ ] **Step 3: Run `npm test` and `npm run build`.**
- [ ] **Step 4: Verify the API and persistence tests cover every Review Focus item and report any pre-existing failures separately.**
