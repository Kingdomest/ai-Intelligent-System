# 贾维斯动态 Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保留现有技术栈，以主智能体动态创建独立子会话，提供证据驱动的任务完成、通用能力复用和受控自进化。

**Architecture:** 统一 Harness 执行内核，角色配置动态化；调度、权限、测试断言和纠正额度由内核强制执行。SQLite 保存会话、动作检查点和证据谱系，旧任务继续使用 legacy 引擎。自进化分为验证后的知识／能力沉淀，以及显式请求、隔离测试、逐次审批的源码修复。

**Tech Stack:** TypeScript、Node.js >=24、Fastify、React、SQLite、Zod、Vitest、Ollama；不迁移 Rust，不接入 Codex app-server。

**Spec:** [已确认设计](<D:/project/ai-Intelligent System/docs/superpowers/specs/2026-09-27-jarvis-dynamic-harness-design.md>)。执行前完整阅读；实现冲突以该设计及用户后续明确要求为准。

## Global Constraints

- 初次执行之外，整个用户任务共享最多 5 个完整纠正回合；不是每个智能体、工具、调用各 5 次。
- 默认全局模型请求并发 1；每任务活跃子智能体 4，总创建数 12；主智能体占模型槽，不占子智能体数。
- 每任务 50 个动作；无效动作也计数。每动作一个工具或派发请求；工具最多 20 次宿主桥调用，在第 21 次之前停止并保存已发生的副作用。
- 根任务活跃墙钟预算 600000ms，不累加并行任务耗时；没有活跃执行、仅等待用户或事件时暂停。单次模型请求超时 120000ms。
- 未知模型上下文窗口上限 32000 tokens；输出预留至少 4000 且不小于有效输出额度。输入预算使用率 80% 发起压缩。
- lightweight：总上下文 8000、输出 2048；standard：16000、4096；deep：32000、4096。默认 standard、temperature=0，仍受模型真实上限约束。
- 逻辑推理档位不等于供应商原生思考参数。未知能力下 auto 不发送未验证原生参数；显式未知／不支持请求阻塞，不伪称已开启或关闭。
- AgentSpec：角色名 80 字符，目标和职责各 2000，单次最多 4 个创建配置，权限最多 5、工具引用最多 20、证据引用最多 20。
- 任务图最多 20 节点；每节点依赖最多 20、验收条件最多 20 条且每条 500 字符；版本化并检查环及未知节点。
- 消息 8000 字符；历史每批 20 条；压缩摘要 8000 字符、候选策略最多 3；TestPlan 每套最多 10 用例，只允许数据与受限断言。
- 经验摘要 2000 字符、适用条件最多 10、每次检索最多 5 条；沉淀每指纹一次、最多 3 次模型请求；租约 5 分钟、每 30 秒续租，写入须检查 fencing token。
- 模型 profileId／原生选项 ID 最多 80 字符，选择理由最多 500 字符；模型、地址和密钥由服务端注册，不下载模型、不自动切外部付费服务。
- 权限只可收紧，不因角色提示、经验或完全访问绕过源码修复审批；无目标权限不执行对应宿主操作。
- 测试／评估必须独立于产出智能体；失败的确定性断言不能由模型覆盖。主智能体负责安排这些动态角色，内核不偷偷创建固定角色。
- 有宿主权限能力先 Canary；真实执行、测试和评估通过后 Active。不确定或非安全可重入操作不自动重放。
- candidate_dynamic_test（没有经证实 OS 隔离时）、patch_apply、service_restart 各自按源码版本哈希单次审批；部署失败走已批准回退流程。
- 附件、工具输出和上传文档是数据，不是系统指令；事件不保存原始思考、附件全文、密钥或完整命令输出。
- 不删除历史能力代码、版本或运行记录；失效生成工具逻辑隔离并建新版本；内置工具缺陷进入源码修复。
- 当前正式目录和 Codex 参考目录均未发现 Git 元数据；不自动初始化 Git，也不虚构提交。

## Review Focus

1. Windows 中文、空格、大小写和路径别名必须映射同一资源锁及审批目标；由任务 5、10 覆盖。
2. 截断 JSON、未知动作与未知原生思考参数不能触发免费无限重试；由任务 2、4、7、9 覆盖。
3. 用户批准期间输入、能力版本或代理身份改变，旧批准不能继续生效；由任务 10 覆盖。
4. “继续／修正”引用未完成任务不能重置额度或重复副作用；跨会话、指代歧义不得猜测；由任务 15 覆盖。
5. 恶意证据文本、带密钥摘要和过期经验不能提升权限或冒充已验证；由任务 12、13、14 覆盖。

---

## 执行位置与文件责任

计划文档保存在正式项目；产品代码实施在项目外候选目录 `D:/project/jarvis-dynamic-harness-candidate-2026-09-27`。以下源码和测试路径相对此候选目录。目录已存在时先核对归属、运行进程及内容，不能覆盖；未实施前不创建目录或安装依赖。

候选只复制正式源码、测试、web、文档及明确配置清单；不复制 `.env`、运行数据、node_modules 或旧候选目录。已有 `.candidate-2026-09-24-self-repair` 仅作经过重新验证的功能来源，不能整体覆盖或自动部署。

| 文件 | 责任 |
| --- | --- |
| `src/harness/contracts.ts`, `limits.ts` | 动态会话、动作、证据、错误、完成绑定与预算契约 |
| `src/model/model-config.ts`, `model-registry.ts`, `model-resolver.ts` | 注册信息、能力确认、请求／生效配置解析 |
| `src/storage/agent-store.ts`, `artifact-store.ts`, `evolution-store.ts` | 同一 SQLite 连接上的会话、证据、经验仓储 |
| `src/harness/resource-scheduler.ts`, `agent-controller.ts` | 全局槽、资源锁、代理生命周期和消息 |
| `src/harness/runner.ts`, `action-dispatcher.ts`, `main-controller.ts` | 统一动作循环、执行入口、动态任务图 |
| `src/harness/correction-coordinator.ts`, `verification-gate.ts` | 共享纠正回合、证据驱动终态与能力晋升 |
| `src/harness/context-manager.ts`, `evolution-coordinator.ts` | 原始上下文引用、审查后压缩、有限沉淀 |
| `src/runtime/task-service.ts`, `legacy-engine.ts` | 新旧引擎路由及恢复兼容 |
| `src/api/routes.ts`, `src/runtime/event-projection.ts` | 会话范围 API、游标、脱敏事件 |
| `web/src/AgentProgress.tsx`, `agent-view-model.ts` | 动态角色、配置、审批队列和持久化摘要 |
| `src/repair/*`, `scripts/supervisor.mjs` | 从旧候选择取并复验的源码修复、部署和回退 |

新增类型统一使用 `ActorScope {sessionId, workspaceRoot, rootTaskId, agentId}`、`AccessScope {sessionId, workspaceRoot}`。代理 ID、根任务 ID 和会话 ID 不可互相替代。证据含产出者、目标、任务图版本、能力版本、输入摘要哈希及宿主 journal 序号范围，不把模型报告文本当执行证据。

每项任务使用 Vitest `it`；下方代码是测试名及核心断言，不是完整测试脚本。依赖前序任务的构造器／fixture 在相应测试内建立。验证失败必须是预期行为缺失，而不是误写导入或测试崩溃。每项最后保存修改文件 SHA-256 清单与命令／结果到候选 `docs/implementation-checkpoints.md`，替代当前不可用的 Git 提交。

## 第一阶段：契约、存储和运行资源

### Task 1: 建立隔离基线和旧行为刻画

**Files:** 创建候选源码副本及 `docs/implementation-checkpoints.md`；新增 `src/harness/engine-version.ts`、`tests/unit/engine-version.test.ts`；不修改正式源码。

**Interfaces:** 消费旧任务元数据；产出 `resolveEngineVersion(metadata: {engineVersion?: string}): 'legacy-v1' | 'dynamic-v2'` 及 baseline 文件哈希清单。Task 15 使用该函数路由，未知版本抛出明确错误而不是降级。

- [ ] 建立候选后写行为测试：`it('keeps historical engine identity and rejects unknown versions', ...)`；核心断言 `expect(resolveEngineVersion({})).toBe('legacy-v1')`、`expect(resolveEngineVersion({engineVersion:'dynamic-v2'})).toBe('dynamic-v2')`、`expect(() => resolveEngineVersion({engineVersion:'future'})).toThrow()`。
- [ ] 用显式源文件清单复制，不删正式目录；候选执行 `npm ci`，先另存 `npm test -- --run` 旧基线结果。运行 `npx vitest run tests/unit/engine-version.test.ts`，确认不支持历史身份的行为 FAIL，已有失败不得隐藏。
- [ ] 在 `src/harness/engine-version.ts` 实现上述纯函数；不存在版本字段只归 legacy-v1，不尝试推断宿主动作或改变旧记录。
- [ ] 同命令应 PASS；运行 `npm run typecheck` 与原有测试并记录差异。
- [ ] 保存候选／正式基线哈希与测试结果；不启动监听正式数据的候选服务。

### Task 2: 严格动态代理与动作契约

**Files:** 新增 `src/harness/contracts.ts`, `limits.ts`, `src/model/model-config.ts`；新增 `tests/unit/harness-contracts.test.ts`。

**Interfaces:** 产出 Zod schemas 及推导类型 `AgentSpec, AgentSession, AgentAction, TaskGraph, TaskArtifact, FailureEnvelope, VerificationBinding, AgentBudget, TaskBudgetSnapshot, RequestedModelConfig, ResolvedModelConfig`；`parseAction(value: unknown): AgentAction`。

- [ ] 写测试 `it('accepts arbitrary role names but rejects excess actions and scripts', ...)`：`expect(validRole.success).toBe(true)`、`expect(fiveSpawns.success).toBe(false)`、`expect(scriptTestPlan.success).toBe(false)`；覆盖长度上限和 unknown key。
- [ ] 运行 `npx vitest run tests/unit/harness-contracts.test.ts`，预期限制缺失 FAIL。
- [ ] 实现 schemas 与全局常量；角色非固定 enum。动作判别字段 `kind`；主代理支持 replace_plan/spawn_agent/send_message/call_tool/run_tests/request_input/wait/interrupt_agent/submit_artifact/propose_correction/propose_source_repair/complete，子代理不允许 spawn、权限提升、直接激活或部署。定义 `AgentTurnOutcome`、`ActionOutcome` 和下面使用的消息／纠正／完成结果类型。
- [ ] 同命令应全 PASS；补充截断 JSON 返回结构化格式错误，不接收执行脚本。
- [ ] 保存检查点。

### Task 3: SQLite 增量会话与证据存储

**Files:** 修改 `src/storage/sqlite-store.ts`, `src/domain/contracts.ts`；新增 `agent-store.ts`, `artifact-store.ts`；新增 `tests/unit/agent-store.test.ts`, `artifact-store.test.ts`。

**Interfaces:** `SqliteStore.agents: AgentStore`, `.artifacts: ArtifactStore`；`AgentStore.create(spec: AgentSpec, scope: ActorScope): AgentSession`、`get(id: string, scope: AccessScope): AgentSession`、`appendMessage(id: string, message: AgentMessageInput, scope: AccessScope): DeliveryReceipt`、`commitTurn(id: string, expectedRevision: number, commit: TurnCommit): AgentSession`；`ArtifactStore.put(input: ArtifactInput, scope: ActorScope): TaskArtifact`、`get(id: string, scope: AccessScope): TaskArtifact`。

- [ ] 写测试 `it('atomically commits artifacts and turn cursor and migrates twice', ...)`：`expect(secondMigration.rows).toEqual(firstMigration.rows)`、`expect(failedTransaction.cursor).toBe(oldCursor)`、`expect(crossSessionRead).toThrow()`。
- [ ] 运行 `npx vitest run tests/unit/agent-store.test.ts tests/unit/artifact-store.test.ts`，预期 FAIL。
- [ ] 在 store 内同一私有数据库连接组合仓储；新增 agent_sessions/messages/artifacts，任务追加 engineVersion/rootIdentity/预算字段；未标记旧记录归 legacy-v1。事务提交动作结果、消息游标及状态，乐观版本冲突不得执行副作用。
- [ ] 同命令及 `npx vitest run tests/unit/sqlite-store.test.ts` 应 PASS。
- [ ] 保存检查点。

### Task 4: 注册模型、解析配置及无串扰请求

**Files:** 新增 `src/model/model-registry.ts`, `model-resolver.ts`；修改 `gateway.ts`, `ollama-provider.ts`, `openai-compatible-provider.ts`；新增 `tests/unit/model-resolver.test.ts`；扩展现有 provider 测试。

**Interfaces:** `ModelRegistry.list(scope: AccessScope): ModelProfile[]`、`ModelConfigResolver.resolve(input: ResolveModelInput): ResolvedModelConfig`。`ModelRequest` 增加可选 `resolvedModelConfig`、`signal`；旧请求保留。产出 requested/resolved/submitted/confirmed 配置事件，不混用。

- [ ] 写测试 `it('omits unknown native options and isolates concurrent configs', ...)`：`expect(autoPayload).not.toHaveProperty('think')`、`expect(explicitUnknown.code).toBe('NATIVE_REASONING_UNVERIFIED')`、`expect(payloadA.model).not.toBe(payloadB.model)`；另断言 explicit unsupported、未知／禁用模型、模型返回身份不匹配。
- [ ] 运行 `npx vitest run tests/unit/model-resolver.test.ts tests/unit/ollama-provider.test.ts tests/unit/model-gateway.test.ts`，预期 FAIL。
- [ ] 服务端当前 MODEL_MODE/NAME 映射 local-default；实施优先级为硬上限／用户权限→用户任务指定→主代理配置→已验证模板→子代理默认→根配置。模型和 native option 联合验证，不继承别的模型参数。每次请求读取不可变配置；未知 auto 省略 optional 原生参数；不得声称发送即确认。记录能力版本及预算收紧理由，provider 使用 AbortSignal。
- [ ] 同命令及 OpenAI adapter 新测试应 PASS；小模型上下文／输出不足须明确报告，不能负预算执行。
- [ ] 保存检查点。

### Task 5: 全局模型槽、活跃时钟与目标锁

**Files:** 新增 `src/harness/resource-scheduler.ts`；修改 `src/runtime/budget-manager.ts`；新增 `tests/unit/resource-scheduler.test.ts`。

**Interfaces:** `ResourceScheduler.withModelPermit<T>(profileId: string, signal: AbortSignal, work: () => Promise<T>): Promise<T>`、`withResourceLock<T>(targetKey: string, signal: AbortSignal, work: () => Promise<T>): Promise<T>`；`TaskBudget.consumeAction(rootTaskId: string): TaskBudgetSnapshot`、`recordActivity(rootTaskId: string, event: ActivityEvent): TaskBudgetSnapshot`。

- [ ] 写测试 `it('limits global concurrency and counts parallel wall time once', ...)`：`expect(maxInFlight).toBe(1)`、`expect(activeMs).toBe(1000)`、`expect(pausedMs).toBe(0)`；`it('locks equivalent Chinese Windows targets', ...)` 断言同目标两写不重叠。
- [ ] 运行 `npx vitest run tests/unit/resource-scheduler.test.ts tests/unit/budget-manager.test.ts`，预期 FAIL。
- [ ] 实现可取消 FIFO 信号量及资源锁，使用现有 canonical path 边界处理；50 动作超额提前停，600000ms 根墙钟持久化，120000ms 请求超时释放槽。重启时不能把等待时间计作执行，也不能清零已用额度。
- [ ] 同命令 PASS；锁冲突取消／异常后均释放，宿主 20 调用硬上限由桥计数另在 Task 10 验证。
- [ ] 保存检查点。

## 第二阶段：动态代理、闭环和权限

### Task 6: 子代理生命周期与持久化消息

**Files:** 新增 `src/harness/agent-controller.ts`；新增 `tests/unit/agent-controller.test.ts`。

**Interfaces:** `AgentController.spawn(callerAgentId: string, spec: AgentSpec): Promise<AgentSession>`、`send(callerAgentId: string, targetId: string, input: AgentMessageInput): Promise<DeliveryReceipt>`、`followup(callerAgentId: string, targetId: string, input: AgentMessageInput): Promise<DeliveryReceipt>`、`interrupt(callerAgentId: string, targetId: string): Promise<AgentSession>`、`watch(scope: ActorScope, afterCursor: string | undefined): AsyncIterable<AgentEvent>`。

- [ ] 写测试 `it('enforces 4 active and 12 lifetime children with idempotent deliveries', ...)`：`expect(fifth.code).toBe('ACTIVE_AGENT_LIMIT')`、`expect(thirteenth.code).toBe('TOTAL_AGENT_LIMIT')`、`expect(duplicate.messageId).toBe(first.messageId)`；子代理 spawn 与跨会话 send 拒绝。
- [ ] 运行 `npx vitest run tests/unit/agent-controller.test.ts`，预期 FAIL。
- [ ] 通过 AgentStore、resolver 和预算事务创建独立上下文／队列；根代理才可创建。followup 复用会话，不重置纠正或预算；显式状态转换与 revision CAS，取消只阻止将来操作、不撤销已发生的效果。
- [ ] 同命令 PASS；同时派发和中断不会遗漏消息或多创建代理。
- [ ] 保存检查点。

### Task 7: 统一 action loop 和受控分派

**Files:** 新增 `src/harness/runner.ts`, `action-dispatcher.ts`；新增 `tests/unit/harness-runner.test.ts`。

**Interfaces:** `HarnessRunner.runTurn(agentId: string, signal?: AbortSignal): Promise<AgentTurnOutcome>`；`HarnessActionDispatcher.dispatch(session: AgentSession, action: AgentAction, signal: AbortSignal): Promise<ActionOutcome>`。消费 ModelGateway、controller、预算和现有注册工具桥；完成动作交给 Task 11 gate。

- [ ] 写测试 `it('runs distinct role prompts on one model without hidden retries', ...)`：`expect(roleA.context).not.toContain(roleB.privateMessage)`、`expect(invalidActionsUsed).toBe(50)`、`expect(completion.accepted).toBe(false)`；未知 action 形成 FailureEnvelope。
- [ ] 运行 `npx vitest run tests/unit/harness-runner.test.ts`，预期 FAIL。
- [ ] 每轮构造最小上下文、不可变配置和角色允许动作；执行一个动作后事务提交再下一轮。删除新引擎角色内部独立 5 次纠正逻辑；格式错误也进入根预算，不内部无限请求。wait 状态可恢复，不循环空转；服务关闭信号不将执行中宿主动作改成成功。
- [ ] 同命令 PASS；错误码、输入证据引用反馈原代理，原始思考不入日志。
- [ ] 保存检查点。

### Task 8: 主智能体动态任务图及职责安排

**Files:** 新增 `src/harness/main-controller.ts`；修改 `src/agents/planner-contract.ts`；新增 `tests/unit/main-controller.test.ts`。

**Interfaces:** `MainController.replacePlan(rootTaskId: string, graph: TaskGraph): Promise<PlanRevision>`、`dispatchReady(rootTaskId: string): Promise<AgentSession[]>`；图节点 owner、dependencies、artifact contract、criteria，职责字符串不固定 enum。

- [ ] 写测试 `it('creates task-specific roles and rejects cyclic or missing review graphs', ...)`：`expect(roleNames).toEqual(['资料解读', '结论核验'])`、`expect(cyclic.accepted).toBe(false)`、`expect(missingGate.canComplete).toBe(false)`。
- [ ] 运行 `npx vitest run tests/unit/main-controller.test.ts`，预期 FAIL。
- [ ] 主代理分析目标、工具和设备预算后创建角色；固定内核 gate 返回缺失独立测试／评估职责信息，交主代理补图，不偷偷派固定角色。图修改标版本并使过期下游证据失效，不自动重放已经执行的宿主动作。
- [ ] 同命令 PASS；图最多 20 节点，资源不足排队，不启动额外模型进程。
- [ ] 保存检查点。

### Task 9: 根任务共享纠正回合与错误决策

**Files:** 新增 `src/harness/correction-coordinator.ts`；修改 `src/runtime/correction-round.ts`, `correction-router.ts`；新增 `tests/unit/dynamic-correction.test.ts`。

**Interfaces:** `CorrectionCoordinator.begin(rootTaskId: string, failures: FailureEnvelope[]): CorrectionRound`、`finish(rootTaskId: string, roundId: string, outcome: CorrectionOutcome): CorrectionState`、`classify(rootTaskId: string, failure: FailureEnvelope): Promise<CorrectionDecision>`；沿用原有 CorrectionState 持久化格式并增量扩展。

- [ ] 写测试 `it('counts a full chain once and shares five rounds across siblings', ...)`：`expect(afterExecuteAndTestAndReview.roundsUsed).toBe(1)`、`expect(afterResume.roundsUsed).toBe(1)`、`expect(sixth.allowed).toBe(false)`；首次执行不计纠正，两个并行错误合并同回合。
- [ ] 运行 `npx vitest run tests/unit/dynamic-correction.test.ts tests/unit/correction-round.test.ts tests/unit/correction-router.test.ts`，预期新行为 FAIL。
- [ ] 分类规划／参数、生成工具、答案、源码、权限／环境、不确定副作用错误；根代理决策写明原因、证据引用和修复对象，再给对应子代理完整 FailureEnvelope。零副作用可重规划，答案修正只使用已有结果；无法安全重放 BLOCKED。五回合耗尽返回具体错误和尝试总结，不只“测试未通过”。
- [ ] 同命令 PASS；重复 finish、重启、重新分配角色、修改模型都不增加或重置同回合。
- [ ] 保存检查点。

### Task 10: 多代理审批队列与宿主执行检查点

**Files:** 修改 `src/permissions/permission-broker.ts`, `host-operations.ts`, `operation-protocol.ts`、SQLite journal；新增 `tests/integration/agent-approvals.test.ts`。

**Interfaces:** 保留 `PermissionBroker.handle(taskId, operation, context)`、`resolve(taskId, requestId, approved)`；context 增加 agentId、scope、输入哈希及版本。新增 `pending(taskId: string, scope: AccessScope): PermissionRequest[]`；旧 pendingPermission 映射队首，不丢其他项。

- [ ] 写测试 `it('rejects stale approval and resumes only the matching agent', ...)`：`expect(changedVersion.hostCalls).toBe(0)`、`expect(denied.hostCalls).toBe(0)`、`expect(sibling.status).not.toBe('blocked')`；别名路径审批目标一致；第 21 调用停止。
- [ ] 运行 `npx vitest run tests/integration/agent-approvals.test.ts tests/unit/permission-broker.test.ts tests/unit/permission-policy.test.ts`，预期 FAIL。
- [ ] 审批绑定代理／根任务／会话／模式／目标／能力版本／输入哈希，独立持久化每代理 checkpoint。原有三模式政策不扩权；已完成 journal 可复用确定结果，executing/unknown 不重放，拒绝不执行。20 次桥上限保留已发生证据，不能伪报全部成功。
- [ ] 同命令 PASS；同目标并发写经资源锁串行，审批后再次校验 canonical target。
- [ ] 保存检查点。

### Task 11: 独立验证关卡、通用工具与 Canary 发布

**Files:** 新增 `src/harness/verification-gate.ts`；修改 `src/capabilities/registry.ts`, `tool-factory.ts`, `genericity-gate.ts`、`src/agents/test-agent.ts`、`src/runtime/test-executor.ts`；新增 `tests/integration/dynamic-verification.test.ts`。

**Interfaces:** `VerificationGate.checkCompletion(rootTaskId: string, artifactId: string): Promise<CompletionCheck>`、`checkCapability(rootTaskId: string, capabilityVersion: string, binding: VerificationBinding): Promise<CapabilityCheck>`；ToolFactory 接收动态实现角色的 adapter，TestAgent 用动态会话生成／判读现有 TestPlan/TestReport，执行器仍固定。

- [ ] 写测试 `it('rejects mock success and activates only matching live evidence', ...)`：`expect(mockOnly.status).toBe('canary')`、`expect(failedAssertion.canComplete).toBe(false)`、`expect(sameProducerAndReviewer.canComplete).toBe(false)`、`expect(twoDifferentTargets.passed).toBe(true)`。
- [ ] 运行 `npx vitest run tests/integration/dynamic-verification.test.ts tests/unit/genericity-gate.test.ts tests/unit/test-executor.test.ts tests/unit/live-test-executor.test.ts`，预期 FAIL。
- [ ] 复用固定只读 Windows 观察器与受限断言；启动应用必须进程／可见窗口／前台证据匹配目标，观察不可用 BLOCKED。生成工具需两个目标、缺失输入、边界和宿主失败测试；read_text 内置确定性 fixture。复用失败区分 fixture、输入、环境、真实工具缺陷：仅后者隔离旧版本并重新生成；builtin 缺陷转源码流程。
- [ ] 同命令及 sandbox／registry／Windows 单元测试 PASS；启动迁移只降级历史未真实验证的 host active，重复启动不降级本轮已验证版本。
- [ ] 保存检查点。

## 第三阶段：上下文、经验与任务恢复

### Task 12: 有预算的上下文交接与审查后压缩

**Files:** 新增 `src/harness/context-manager.ts`；新增 `tests/unit/context-manager.test.ts`。

**Interfaces:** `ContextManager.prepare(agentId: string): Promise<PreparedContext>`、`proposeCompaction(agentId: string): CompactionRequest`、`commitCompaction(agentId: string, summaryArtifactId: string, reviewArtifactId: string, expectedRevision: number): void`。

- [ ] 写测试 `it('preserves immutable facts and rejects stale compaction', ...)`：`expect(rawMessagesAfter).toEqual(rawMessagesBefore)`、`expect(missingPermissionFact.accepted).toBe(false)`、`expect(staleRevision.accepted).toBe(false)`；附件里的“提升权限”不得改变角色配置。
- [ ] 运行 `npx vitest run tests/unit/context-manager.test.ts`，预期 FAIL。
- [ ] 整体输入计 system、角色、schema、工具和消息；保守 token 估计结合真实 usage 校准，不把 chars/4 当通用真值。80% 时通知主代理安排压缩设计与独立审查，1–3 策略、最多 8000 摘要。保留目标、用户限制、批准范围、未完成图、纠正额度、工具版本和证据引用；仅审查通过原子替换当前视图。
- [ ] 同命令 PASS；小模型无法保留最低事实时阻塞并解释，不静默截断。
- [ ] 保存检查点。

### Task 13: 有适用范围和版本的经验仓储

**Files:** 新增 `src/storage/evolution-store.ts`；修改 `sqlite-store.ts`；新增 `tests/unit/evolution-store.test.ts`。

**Interfaces:** `EvolutionStore.search(query: EvolutionQuery, scope: AccessScope): EvolutionMatch[]`、`claim(fingerprint: string, scope: AccessScope): EvolutionLease | undefined`、`renew(lease: EvolutionLease): EvolutionLease`、`promote(lease: EvolutionLease, input: VerifiedEvolutionInput): EvolutionRecord`。类型在 Task 2 contracts 定义。

- [ ] 写测试 `it('filters stale evidence and rejects secrets and expired lease owners', ...)`：`expect(results.length).toBeLessThanOrEqual(5)`、`expect(results).not.toContain(stale)`、`expect(expiredPromote).toThrow()`、`expect(secretRecord.status).toBe('quarantined')`。
- [ ] 运行 `npx vitest run tests/unit/evolution-store.test.ts`，预期 FAIL。
- [ ] SQLite 新增 evolution_records，结构化检索任务类／平台／工具和配置版本；经验、角色模板、回归索引均绑定已验证来源。租约 5 分钟、30 秒续租、fencing token 比较；摘要 2000、条件 10。冲突经验不自行覆盖，未验证记录不用于执行配置；不新建向量数据库。
- [ ] 同命令 PASS；经验只能建议角色和计划，不能执行脚本、改系统提示优先级或提升权限。
- [ ] 保存检查点。

### Task 14: 终态后的有限沉淀和下次真实复用

**Files:** 新增 `src/harness/evolution-coordinator.ts`；新增 `tests/integration/evolution-reuse.test.ts`。

**Interfaces:** `EvolutionCoordinator.consolidate(rootTaskId: string): Promise<EvolutionOutcome>`；消费 evolutionStore、agentController、证据仓储与模型槽。主代理声明沉淀职责，不能内核暗建固定角色。

- [ ] 写测试 `it('consolidates once and reuses applicable knowledge on the next task', ...)`：`expect(modelCalls).toBeLessThanOrEqual(3)`、`expect(secondConsolidation.created).toBe(false)`、`expect(nextTask.usedEvolutionIds).toContain(record.id)`、`expect(consolidation.hostCalls).toBe(0)`。
- [ ] 运行 `npx vitest run tests/integration/evolution-reuse.test.ts`，预期 FAIL。
- [ ] 终态快照每指纹最多一次、租约恢复有边界，最多 3 次模型请求，角色会话受创建上限约束；只有已有证据，不能新宿主操作、源码写入或额外 5 回合。沉淀失败显示独立失败／未完成，不改已证实任务结论，不宣传已进化。
- [ ] 同命令 PASS；第二个目标复用通用能力而不是第一个目标写死参数；过期记录无资格用作完成证据。
- [ ] 保存检查点。

### Task 15: 新旧引擎路由、继续任务和恢复

**Files:** 修改 `src/runtime/task-service.ts`, `agent-loop.ts`, `dependencies.ts`；新增 `legacy-engine.ts`；新增 `tests/integration/dynamic-task-service.test.ts`, `legacy-engine-routing.test.ts`。

**Interfaces:** `TaskEngine.run(rootTaskId: string): Promise<TaskRun>`；保留 TaskService createAndStart/createAndWait/resumeWithInput/resolveApproval/resumeAfterRestart，增加显式 `AccessScope` 参数及根身份查找。`resolveContinuation(input: CreateTaskInput, scope: AccessScope): ContinuationResolution` 返回 new/continue/ambiguous。

- [ ] 写测试 `it('continues the same ledger without replay and blocks ambiguous references', ...)`：`expect(continued.rootTaskId).toBe(original.rootTaskId)`、`expect(continued.roundsUsed).toBe(original.roundsUsed)`、`expect(hostCalls).toBe(1)`、`expect(ambiguous.status).toBe('waiting_input')`；跨会话找不到旧任务。
- [ ] 运行 `npx vitest run tests/integration/dynamic-task-service.test.ts tests/integration/legacy-engine-routing.test.ts`，预期 FAIL。
- [ ] 提取旧 TaskService 并封装 legacy engine；新任务标 dynamic-v2，旧 checkpoint 只能旧引擎恢复或明确 BLOCKED。新引擎统一注入上述 controller/gate/coordinator；已发生宿主操作后禁止切引擎 fallback。失败引用和“修正”续同根，独立新任务新预算；指代不明请求澄清。
- [ ] 同命令及 `npx vitest run tests/integration/agent-loop.test.ts tests/integration/mvp-flow.test.ts` PASS；任何失败／未验证关键条件不能 SUCCESS。
- [ ] 保存检查点。

## 第四阶段：API、界面和受控源码更新

### Task 16: 会话范围 API 和脱敏事件

**Files:** 修改 `src/api/routes.ts`, `app.ts`, `src/runtime/event-projection.ts`；新增 `tests/integration/dynamic-api.test.ts`。

**Interfaces:** 保留任务创建／读取／输入／审批 API；新增 GET `/api/tasks/:id/agents`、GET `/api/tasks/:id/events?after=cursor`、GET `/api/tasks/:id/approvals`、POST `/api/tasks/:id/cancel`。模型注册信息只暴露安全 profile 元数据。请求 session/workspace 校验贯穿仓储，不声明本地 token 实现多租户身份认证。

- [ ] 写测试 `it('scopes every task artifact and approval endpoint and redacts events', ...)`：`expect(otherSession.statusCode).toBe(404)`、`expect(events).not.toContain(secret)`、`expect(pending).toHaveLength(2)`、`expect(nextPage.duplicates).toBe(0)`。
- [ ] 运行 `npx vitest run tests/integration/dynamic-api.test.ts tests/integration/api.test.ts tests/unit/test-report-redaction.test.ts`，预期 FAIL。
- [ ] 实现安全投影白名单，显示角色、状态、选择理由、requested/resolved/submitted/confirmed、轮次、断言摘要和沉淀结果；未知事件不给原始 JSON。cancel 返回已发生效果及未完成项，不称撤销。
- [ ] 同命令 PASS；游标及终态摘要重启后保持，不能通过 artifact ID 绕根会话范围。
- [ ] 保存检查点。

### Task 17: 简约聊天 UI 的动态进度和审批队列

**Files:** 新增 `web/src/AgentProgress.tsx`, `agent-view-model.ts`；修改 `App.tsx`, `task-polling.ts`, `CorrectionStatus.tsx`, `TestSummaryCard.tsx`, `styles.css`, `tsconfig.json`；新增 `tsconfig.server.json`；新增 `tests/unit/agent-progress.test.ts`, `agent-view-model.test.ts`。

**Interfaces:** `deriveAgentView(events: PublicTaskEvent[], previous?: AgentViewState): AgentViewState`；`AgentProgress(props: {state: AgentViewState}): ReactElement`。API 输出类型来自 Task 16，不在 UI 重新猜 engine/status。

- [ ] 写 SSR／reducer 测试 `it('restores blocked status, five-round summary and multiple approvals', ...)`：`expect(html).toContain('已阻塞')`、`expect(html).toContain('1/5')`、`expect(state.pendingApprovals).toHaveLength(2)`、`expect(state).toEqual(reloaded)`。
- [ ] 运行 `npx vitest run tests/unit/agent-progress.test.ts tests/unit/agent-view-model.test.ts`，预期 FAIL。
- [ ] 保留文件上传及三权限模式；进度折叠显示角色和配置、具体测试原因、每整链回合摘要和沉淀状态；对单项明确是／否、对应暂停代理。扩大 typecheck 到 web/src，用 server tsconfig 限定服务端产物。SSR 测试不能称真实点击测试，浏览器交互在 Task 21 验收。
- [ ] 同命令、现有 chat-layout/task-polling/test-summary-card 测试及 `npm run typecheck` PASS。
- [ ] 保存检查点。

### Task 18: 保留旧候选中 PPT 与失败任务解释的修复

**Files:** 从旧候选择取并适配 `src/presentations/render.ts`, `src/runtime/parent-task.ts`；修改 builtin catalog、host operations、planner contract、package.json／lock；新增 `tests/integration/presentation-regression.test.ts`。

**Interfaces:** 保留 `renderPresentation(input: PresentationInput): Promise<Buffer>`、`verifyPresentationFile(pathname: string, input: PresentationInput, sha256?: string): Promise<boolean>`、`summarizeParentTask(store: SqliteStore, child: TaskRun): ParentTaskSummary | null`、`isFailureExplanationRequest(message: string): boolean`、`isSourceRepairRequest(message: string): boolean`、`explainParentFailure(parent: ParentTaskSummary): string`。对外动态工具仍为注册工具的 JSON 输入／输出；writePresentation 只能经宿主桥受控调用。安装候选已使用并重新审查的 pptxgenjs/jszip 依赖，不顺带修改其它业务。

- [ ] 写测试 `it('creates a real pptx from structured content and corrects answers without replay', ...)`：`expect(zipEntries).toContain('ppt/presentation.xml')`、`expect(writeJournal.path).toBe(explicitDesktopPath)`、`expect(answerCorrection.hostCalls).toBe(0)`；不得把结构化对象硬塞 string 字段。
- [ ] 运行 `npx vitest run tests/integration/presentation-regression.test.ts`，预期原行为 FAIL。
- [ ] 将结构化 PPT 输入作为独立明确契约；文件写入走桥，已有验证结果修正答案不因“有宿主调用”一律阻塞，也不重放写入。保留原有文件读取→基于实际内容总结链路；候选补丁先与新 gate／作用域集成再使用。
- [ ] 同命令及 planner/builtin/host 测试 PASS；产物 ZIP 和内容均检查，不能仅检查路径字符串。
- [ ] 保存检查点。

### Task 19: 接入动态代理的隔离源码修复流程

**Files:** 从旧候选择取 `src/repair/contracts.ts`, `candidate.ts`, `test-runner.ts`, `coordinator.ts`, `deployment.ts`, `revalidation.ts`, `scripts/supervisor.mjs` 及对应实际测试；新增 `src/repair/dynamic-agent-adapter.ts`, `tests/integration/dynamic-source-repair.test.ts`；适配 store/API/UI。

**Interfaces:** 保留旧候选 RepairCoordinator 的 start/approve/review 和 NativeRepairDeployment.stage/revertStage，复制前核对源码签名。新增 `DynamicRepairAgentAdapter` 实现其所需 runRepairDiagnosis/runSourceRepair/runEvaluator 接口，调用 AgentController 而非固定 AgentRunner 角色；固定执行器和 TestAgent 断言仍是独立执行证据。

- [ ] 写测试 `it('requires separate hash-bound approvals and restores failed staging', ...)`：`expect(unapproved.hostChanges).toBe(0)`、`expect(approvals.kinds).toEqual(['candidate_dynamic_test','patch_apply','service_restart'])`、`expect(changedCandidate.approvalValid).toBe(false)`、`expect(afterRollback.formalHash).toBe(before.formalHash)`。
- [ ] 运行 `npx vitest run tests/integration/dynamic-source-repair.test.ts`，预期 FAIL；执行复制的 repair-contracts/candidate/test-runner/coordinator/deployment/revalidation/supervisor 测试记录旧候选基线。
- [ ] 只有显式“修复贾维斯源码”创建独立 RepairJob；旧任务五回合不自动转换免费源码重试。固定重现基线红、候选绿，标准 suite/typecheck/build，单次候选哈希审批；候选文件夹不等于 OS 隔离。保留 stage 前 checkpoint 和中断恢复、服务健康及原需求效果再验证，回退也按批准范围执行。正式 `.env`、数据不覆盖，已构建的 supervisor 版本 pin 不绕过。
- [ ] 同命令及全部复制的 repair 测试 PASS；完整测试未通过不允许申请部署成功，未批准重启不停止正式服务。
- [ ] 保存检查点。

## 第五阶段：系统验收（不能用全绿模拟代替真实效果）

### Task 20: 全链路回归、故障注入和重启恢复

**Files:** 新增 `tests/integration/dynamic-harness.test.ts`, `dynamic-recovery.test.ts`；修改必要 mock-provider fixture；新增 `docs/dynamic-harness-acceptance.md`。

**Interfaces:** 通过真实 Fastify API、候选 SQLite、动态 TaskService、固定桥调用执行测试；mock 只替代模型和受控 OS 观察，不绕验证关卡。

- [ ] 写测试 `it('repairs a tool defect and reuses the new version for a different target', ...)`：`expect(oldTool.enabled).toBe(false)`、`expect(secondTask.generatedTools).toBe(0)`；`it('survives restart during approval without uncertain replay', ...)`：`expect(hostCalls).toBe(1)`、`expect(uncertain.status).toBe('BLOCKED')`。
- [ ] 运行 `npx vitest run tests/integration/dynamic-harness.test.ts tests/integration/dynamic-recovery.test.ts`，预期集成缺口 FAIL。
- [ ] 补齐装配而非放松断言；覆盖模型错误、双并发审批、拒绝、单／双目标工具、测试失败反馈、5 整链上限、答案只修复、能力重建、跨会话证据、取消、压缩、经验复用和源码批准取消。验收矩阵列出自动／需本机／未验证项，不把 Windows skip 当通过。
- [ ] 运行 `npm test -- --run`、`npm run typecheck`、`npm run build`，要求所有应执行测试 PASS、build 退出 0；逐一说明 skip 和环境阻塞。
- [ ] 保存全量结果及新旧文件哈希清单；产品代码待独立审查，未部署。

### Task 21: 本地模型、真实文件及 Windows／浏览器验收

**Files:** 更新 `docs/dynamic-harness-acceptance.md`；新增／扩展 `tests/integration/windows-desktop.test.ts` 受控应用 fixture；不自动写正式配置或用户桌面业务文件。

**Interfaces:** 使用经用户配置的 local-default 真实 Ollama；候选端口和独立测试数据目录，不抢占正式 3000；固定 Windows observer 观察受控应用。真实应用的副作用仍遵循用户选择的权限模式。

- [ ] 在验收表记录待验证：真实模型动态角色创建、中文带空格路径读取总结、两目标通用创建、PPT 产物、失败纠正再成功、重启审批恢复、聊天按钮及上传；Windows 应用存在／可见／前台观察分别列项。
- [ ] 运行候选全量测试／build，随后检查 Ollama 可达和登记模型存在；不可达记录 BLOCKED，不静默用 mock 宣称通过。测试启动前批准所有必要本机操作。
- [ ] 在独立临时目录执行已批准案例，使用受控本机应用而非无授权打开私人应用；保存脱敏目标、产物哈希、断言和 journal 证据。实际浏览器验证上传、队列是／否、折叠动态角色和刷新后的摘要；无可用浏览器工具则记录未验收。
- [ ] 真实验收全部符合预期后才标候选可交付；由独立新 reviewer 审查整体变更，再重跑受影响测试。无独立审查能力须如实说明，不能把自审充作独立审查。
- [ ] 最终提供完成项／失败项／BLOCKED／未测试项、补丁哈希和部署回退步骤。请求正式补丁批准与重启批准前不应用正式目录、不重启正式服务。

## 自审及执行交接

- 设计覆盖：动态职责与配置 Task 2/4/6–8；资源 Task 5；权限 Task 10；真实验证／通用能力 Task 11；根纠正 Task 9/15；上下文 Task 12；自进化 Task 13/14；兼容恢复 Task 3/15/20；API/UI Task 16/17；PPT 历史修复 Task 18；源码审批／回退 Task 19；本机验收 Task 21。
- 新增类型在 contracts 或 model-config 中集中声明；后续任务不得重复定义不同语义的同名 ID／状态。公共事件不直接暴露内部合同；ActionOutcome 不自行决定最终 SUCCESS。
- 五项 Review Focus 已各有拥有者和测试；每项都有红／绿验证和检查点。旧引擎身份在 Task 1 单测，实际不重放恢复在 Task 15 集成验证，不能把纯函数通过说成全链路通过。
- 当前仅是已保存的计划，所有实施复选框均未完成。没有修改产品代码、安装新依赖、迁移运行数据库或重启服务。
- 建议 Native：同一会话连续实现这些共享接口，再做独立整体审查。也可选择 Subagent-driven：逐任务实施与独立审查，但资源／接口协调成本更高。
- 待用户审阅本计划并确认执行方式后，才读取对应实施技能并开始 Task 1。正式补丁与重启是更后的独立审批，不因计划批准自动授权。
