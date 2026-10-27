# Jarvis Reusable Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让贾维斯以稳定的能力键和严格的参数契约执行任务，同类操作跨不同目标复用同一版本，并以真实证据决定成功或阻塞。

**Architecture:** 规划器只产出回答、待补信息或经过类型校验的步骤 DAG；内置能力和动态能力共享注册、权限代理、测试和评估链。每一步固定绑定能力版本；动态候选必须通过两个不同输入的确定性通用性闸门，GUI 启动另走不等待退出的 `process.launch`。

**Tech Stack:** Node.js >=24、TypeScript 5.9、Zod 4、Fastify 5、SQLite `node:sqlite`、Vitest 5、React 19、Vite 7；Windows 桌面专项验收。

**Spec:** `docs/superpowers/specs/2026-09-23-jarvis-reusable-capabilities-reliability-design.md`

## Global Constraints

- 保留 `request`、`auto`、`full` 三种任务级权限及现有审批语义；任何宿主副作用只通过权限代理。
- 保留测试 Agent、评估 Agent、Canary、最多 5 次纠正重试；沙箱模拟不能替代本机成功证据。
- 不执行模型生成的测试脚本，不删除历史任务/能力，不新增 SQLite 表；迁移可重复运行。
- 不把目标应用名、路径、网址写入能力键或通用能力代码；未验证的旧能力不能冒充通用 active。
- 只记录脱敏证据，不保存附件全文、密钥或完整命令输出；不自动重放不确定的副作用。
- 当前工作区没有 Git 元数据：每项保留提交检查点，但不能伪称已提交，也不为此擅自初始化仓库。

## Review Focus

- `args` 收到 `{type:'array',value:[]}` 或数组元素为对象时必须在宿主调用前归一化或拒绝；任务 1 测试。
- 两个同类步骤的不同目标和乱序依赖不得调用同一错误能力；任务 4 测试。
- 动态候选把首次目标写死、第二目标不改变宿主调用时不得发布；任务 3 测试。
- 用户拒绝启动权限、应用多匹配或仅有后台进程时不得报告启动成功；任务 5、6 测试。
- 重启时 `CAPABILITY_BUILDING` 无检查点以及执行中状态不确定的任务不能永远忙碌或重复副作用；任务 7 测试。

---

### Task 1: 严格规划契约与纯问答

**Files:** Create `src/agents/planner-contract.ts`; modify `src/agents/agent-runner.ts`, `src/runtime/agent-loop.ts`; test `tests/unit/planner-contract.test.ts`, `tests/integration/agent-loop.test.ts`.

**Interfaces:** Consumes `ModelGateway.complete()` and现有 `PlannerInput`。Produces `PlanStep = {id:string; capabilityKey:string; description:string; dependsOn:string[]; input:Record<string,unknown>}`、`parsePlannerDecision(raw:unknown): PlannerDecision`，其中 decision 是 `{status:'answer';answer:string;acceptanceCriteria:string[];steps:[]}`、`{status:'needs_user_input';inputRequest:UserInputRequest;...}` 或 `{status:'ready';steps:PlanStep[];...}` 的判别联合。保留兼容旧模型的明确 `{type,value}` 包装，但不猜测缺失目标。

- [ ] **Step 1: 写失败测试。**

```ts
expect(parsePlannerDecision({ status:'ready', acceptanceCriteria:[], steps:[{id:'a',capabilityKey:'process.launch',description:'launch',dependsOn:[],input:{applicationName:{type:'string',value:'网易云音乐'},args:{type:'array',value:[]}}}]}).steps[0].input).toEqual({applicationName:'网易云音乐',args:[]});
expect(() => parsePlannerDecision({status:'ready',acceptanceCriteria:[],steps:[{id:'a',capabilityKey:'process.launch',description:'launch',dependsOn:[],input:{applicationName:'A',args:[{}]}}]})).toThrow(/steps\[0\]\.input\.args/);
expect(() => parsePlannerDecision({status:'ready',acceptanceCriteria:[],steps:[{id:'a',capabilityKey:'process.launch',description:'launch',dependsOn:[],input:{applicationName:'A',args:[]}},{id:'a',capabilityKey:'process.launch',description:'again',dependsOn:[],input:{applicationName:'B',args:[]}}]})).toThrow(/duplicate/i);
```

同文件另测未知依赖、依赖环、空路径、未登记的动态键、`status:'answer'` 没有 answer。集成测试验证 answer 经评估后原样返回，不产生宿主调用。

- [ ] **Step 2: 确认失败。** Run: `npm test -- --run tests/unit/planner-contract.test.ts tests/integration/agent-loop.test.ts`; expected 新契约测试 FAIL。
- [ ] **Step 3: 最小实现。** 用按 `capabilityKey` 区分的 Zod schema 验证内置输入；包装解开仅接受已知 `type`/`value` 对并递归限制深度；用 DFS 验证 DAG，拒绝重复 ID/未知依赖/环；动态键必须是 `dynamic.<domain>.<verb>` 且与本次输入目标不同。更新 planner 提示为 `applicationName` 和 `args:string[]`，取消必须知道 `.exe` 的要求。模型契约错误返回字段路径并终止，不进行工具生成重试。

```ts
export const launchInput = z.object({applicationName:z.string().trim().min(1),args:z.array(z.string()).max(100)}).strict();
export function parsePlannerDecision(raw: unknown): PlannerDecision {
  const decision = plannerDecisionSchema.parse(unwrapTypedValues(raw));
  if (decision.status === 'ready') validateStepGraph(decision.steps);
  return decision;
}
```

`unwrapTypedValues(value:unknown):unknown` 仅解 `type` 与 `value` 形状完全匹配的包装，最大递归深度 8；`validateStepGraph(steps:PlanStep[]):void` 以 ID 集合和 DFS 验证唯一性、依赖存在性和无环；二者同在 `planner-contract.ts`，错误路径使用 Zod issue path。

- [ ] **Step 4: 验证通过。** Run: `npm test -- --run tests/unit/planner-contract.test.ts tests/integration/agent-loop.test.ts` and `npm run typecheck`; expected PASS。
- [ ] **Step 5: 提交检查点。** Git 可用时仅提交本任务文件，建议消息 `feat: validate typed plans and answer directly`；当前无 `.git` 时记录通过的命令与文件清单，不执行提交。

### Task 2: 稳定能力键、旧版本隔离与内置目录

**Files:** Create `src/capabilities/builtin-catalog.ts`; modify `src/domain/contracts.ts`, `src/storage/sqlite-store.ts`, `src/capabilities/registry.ts`, `src/capabilities/tool-factory.ts`; test `tests/unit/sqlite-store.test.ts`, `tests/unit/capability-registry.test.ts`, `tests/unit/builtin-catalog.test.ts`.

**Interfaces:** Consumes `PlanStep.capabilityKey`。Produces `BuiltinDefinition = {key:string;version:string;permissions:CapabilityPermission[];inputSchema:unknown;code:string}`、`getBuiltin(key:string):BuiltinDefinition|null`、`CapabilityRegistry.findUsableByKey(key:string):CapabilityRecord|null`。`CapabilityManifest.capabilityKey` 新增；旧记录无该字段时按既有 ID 映射、只读/Canary 使用，不得自动宣称通用 active。

- [ ] **Step 1: 写失败测试。**

```ts
expect(getBuiltin('filesystem.mkdir')?.key).toBe('filesystem.mkdir');
expect(getBuiltin('filesystem.mkdir')?.code).not.toContain('网易云音乐');
expect(registry.findUsableByKey('process.launch')?.manifest.capabilityKey).toBe('process.launch');
expect(registry.findUsableByKey('process.launch')?.version).toBe('1.0.0');
```

另测旧目标专属 active 被降至 Canary、第二次启动迁移无变化、原代码/版本不变，以及意图文字包含不同应用名仍查到同一键。

- [ ] **Step 2: 确认失败。** Run: `npm test -- --run tests/unit/sqlite-store.test.ts tests/unit/capability-registry.test.ts tests/unit/builtin-catalog.test.ts`; expected FAIL。
- [ ] **Step 3: 最小实现。** 内置目录定义 `filesystem.read_text/write_text/mkdir/remove`、`process.run/launch`、`network.request`、`location.current` 八个固定版本，代码只读 `input` 并调用对应 host bridge；启动时幂等注册。存储查询从 `manifest_json` 中的键筛选兼容状态，不使用整句 intent 作为唯一条件；老 active 缺键或未经跨输入验证时降为 Canary，保留版本。`ToolFactory` 要求动态候选 ID/Manifest 带同一稳定键，并拒绝键里出现当前目标值。

```ts
export function getBuiltin(key: string): BuiltinDefinition | null { return builtinDefinitions[key] ?? null; }
findUsableByKey(key: string): CapabilityRecord | null { return this.store.findUsableByKey(key); }
```

- [ ] **Step 4: 验证通过。** Run: `npm test -- --run tests/unit/sqlite-store.test.ts tests/unit/capability-registry.test.ts tests/unit/builtin-catalog.test.ts` and `npm run typecheck`; expected PASS。
- [ ] **Step 5: 提交检查点。** Git 可用时提交本任务文件，消息 `feat: index reusable built-in capabilities by stable key`；否则记录测试结果。

### Task 3: 动态能力跨输入发布闸门

**Files:** Create `src/capabilities/genericity-gate.ts`; modify `src/agents/agent-runner.ts`, `src/runtime/test-executor.ts`, `src/runtime/agent-loop.ts`, `src/capabilities/registry.ts`; test `tests/unit/genericity-gate.test.ts`, `tests/integration/agent-loop.test.ts`.

**Interfaces:** Consumes候选 `code/permissions`、当前 `PlanStep.input`、Test Agent 报告。Produces `verifyGenericity(candidate:ToolCandidate, fixtures:[Record<string,unknown>,Record<string,unknown>], sandbox:SandboxRunner):Promise<GenericityReport>`，报告含 `passed:boolean;reason:string;hostCalls:脱敏摘要`。只有通过此闸门及原有测试/评估后才能 `publish`。

- [ ] **Step 1: 写失败测试。**

```ts
const fixtures = [{path:'D:/tmp/alpha'},{path:'D:/tmp/beta'}] as const;
expect((await verifyGenericity(hardCodedMkdir, [...fixtures], sandbox)).passed).toBe(false);
expect((await verifyGenericity(parameterizedMkdir, [...fixtures], sandbox)).passed).toBe(true);
expect((await verifyGenericity(parameterizedMkdir, [{},fixtures[1]], sandbox)).passed).toBe(false);
```

另测宿主失败却返回 `{success:true}`、两个不同纯计算输入输出不变、仅参数变化但 target 不变均拒绝发布；无宿主权限候选以有明确输出断言的两组输入验证。

- [ ] **Step 2: 确认失败。** Run: `npm test -- --run tests/unit/genericity-gate.test.ts tests/integration/agent-loop.test.ts`; expected FAIL。
- [ ] **Step 3: 最小实现。** 两组样本由执行器从已验证的目标型输入 schema 生成，不能由模型提供代码；`SandboxRunner` dry-run 收集两次 `HostCall`，断言 permission/action 相同而 target/相关 arguments 随输入变化，并注入失败响应验证失败传播。Test Agent 可补充但不能覆盖确定性失败；失败原因回馈实施 Agent，最多 5 次纠正；缺少可判定第二样本就阻塞发布。

```ts
export interface GenericityReport { passed: boolean; reason: string; hostCalls: Array<{permission:string;action:string;target:string}>; }
export async function verifyGenericity(candidate:ToolCandidate, fixtures:[Record<string,unknown>,Record<string,unknown>], sandbox:SandboxRunner):Promise<GenericityReport> {
  const first = await captureDryRun(candidate.code, fixtures[0], sandbox);
  const second = await captureDryRun(candidate.code, fixtures[1], sandbox);
  return compareGenericity(first, second, candidate.permissions);
}
```

`captureDryRun(code:string,input:Record<string,unknown>,sandbox:SandboxRunner):Promise<{output:unknown;calls:HostCall[];failed:boolean}>` 用 `sandbox.run(...,{mode:'dry-run',hostCall})` 收集调用并注入受控响应；`compareGenericity(first,second,permissions):GenericityReport` 要求有权限的候选调用形状一致、目标随输入变化，且另一次失败注入不能伪报成功。无权限候选改用可判定输出断言，不用宿主调用差异。

- [ ] **Step 4: 验证通过。** Run: `npm test -- --run tests/unit/genericity-gate.test.ts tests/integration/agent-loop.test.ts` and `npm run typecheck`; expected PASS。
- [ ] **Step 5: 提交检查点。** Git 可用时提交本任务文件，消息 `feat: gate generated tools on cross-input evidence`；否则记录测试结果。

### Task 4: 逐步骤能力绑定和执行检查点

**Files:** Modify `src/domain/contracts.ts`, `src/runtime/agent-loop.ts`, `src/runtime/scheduler.ts`, `src/storage/sqlite-store.ts`; test `tests/integration/agent-loop.test.ts`, `tests/unit/sqlite-store.test.ts`.

**Interfaces:** Consumes `PlannerDecision.steps[].capabilityKey` 和 `CapabilityRegistry.findUsableByKey()`。Produces `StepBinding = {stepId:string;capabilityKey:string;capabilityId:string;version:string}`、`ExecutionCheckpoint.stepBindings:StepBinding[]`。`ensureCapabilities()` 改为按每个键找/建/测，并返回 `Map<string,StepBinding>`；执行循环按 `nextStep.id` 查绑定，旧单能力检查点只有无歧义时转换。

- [ ] **Step 1: 写失败测试。**

```ts
expect(events.filter(e=>e.type==='step.completed').map(e=>e.payload.stepId)).toEqual(['make-dir','read-file']);
expect(hostCalls.map(c=>c.action)).toEqual(['mkdir','readText']);
expect(reloaded.executionCheckpoint?.stepBindings?.map(b=>b.stepId)).toEqual(['make-dir','read-file']);
```

另测乱序依赖、两步骤同一键但不同输入、旧单能力可无歧义恢复、旧多能力无法映射则 BLOCKED；每个步骤的宿主 operation ID 保持稳定。

- [ ] **Step 2: 确认失败。** Run: `npm test -- --run tests/integration/agent-loop.test.ts tests/unit/sqlite-store.test.ts`; expected FAIL。
- [ ] **Step 3: 最小实现。** 去掉 `selectedCapabilityName ??=` 全局单选；对每步输入分别做 dry-run、测试、绑定；检查点写入全部绑定和已完成步骤后再执行宿主操作。依赖环由任务 1 预先拒绝。恢复时不可因键相同自动换用更新版本；Canary 只在对应步骤真实验证及评估通过后升级。

```ts
export interface StepBinding { stepId:string; capabilityKey:string; capabilityId:string; version:string; }
const binding = task.executionCheckpoint.stepBindings.find(item=>item.stepId===nextStep.id);
if (!binding) return this.block(task, `步骤 ${nextStep.id} 缺少已验证能力绑定。`);
```

- [ ] **Step 4: 验证通过。** Run: `npm test -- --run tests/integration/agent-loop.test.ts tests/unit/sqlite-store.test.ts` and `npm run typecheck`; expected PASS。
- [ ] **Step 5: 提交检查点。** Git 可用时提交本任务文件，消息 `fix: bind each plan step to its verified capability`；否则记录测试结果。

### Task 5: 通用 Windows 应用解析与独立启动

**Files:** Create `src/runtime/windows-app-resolver.ts`; modify `src/permissions/operation-protocol.ts`, `src/permissions/policy.ts`, `src/permissions/permission-broker.ts`, `src/permissions/host-operations.ts`, `src/capabilities/sandbox-runner.ts`, `src/capabilities/policy-validator.ts`, `src/runtime/windows-desktop-observer.ts`; test `tests/unit/windows-app-resolver.test.ts`, `tests/unit/host-operations.test.ts`, `tests/unit/permission-broker.test.ts`, `tests/unit/sandbox-runner.test.ts`, `tests/integration/windows-desktop.test.ts`.

**Interfaces:** Consumes `{applicationName:string,args:string[]}`。Produces `resolveWindowsApplication(name:string, adapters?:ResolverAdapters):Promise<{status:'resolved';executable:string;processName:string}|{status:'needs_user_input';candidates:string[];reason:string}>`；`CapabilityHost.process.launch({executable,args,cwd?}):Promise<{pid:number|null;started:boolean}>`。解析器只读 App Paths、Start Menu、PATH 或明确路径；宿主代理实际操作是 `permission:'process', action:'launch'`。

- [ ] **Step 1: 写失败测试。**

```ts
expect(await resolveWindowsApplication('百度网盘',fakeRegistry)).toEqual({status:'resolved',executable:'C:\\Apps\\BaiduNetdisk.exe',processName:'BaiduNetdisk'});
expect((await resolveWindowsApplication('音乐',twoMatchingApps)).status).toBe('needs_user_input');
await expect(broker.handle(task.id,launchOperation,requestModeContext)).rejects.toMatchObject({code:'APPROVAL_REQUIRED'});
expect(launchAdapterCalls).toBe(0);
```

另测非 Windows/无桌面、路径不存在、注入 `&` 不进 shell、dry-run 必须具备非空 executable 和字符串 args、拒绝审批零启动、launch 返回后子进程仍存活。Windows 专项只用受控测试应用。

- [ ] **Step 2: 确认失败。** Run: `npm test -- --run tests/unit/windows-app-resolver.test.ts tests/unit/host-operations.test.ts tests/unit/permission-broker.test.ts tests/unit/sandbox-runner.test.ts`; expected FAIL。
- [ ] **Step 3: 最小实现。** 解析器按明确路径→App Paths→Start Menu→PATH 的顺序收集候选，但不同来源同名结果不一致时请求选择；不执行模型给的 shell 命令。`AgentLoop` 在调用内置 `process.launch` 前解析 `applicationName`，把 `executable/processName` 放入该步运行输入，保持原始用户参数只作查找条件；结果不唯一则进入 `NEEDS_USER_INPUT`。`process.launch` 用 `spawn(executable,args,{cwd,shell:false,windowsHide:false})`，监听 `spawn/error` 后返回 PID，不等待 `exit`、不复用 `runChild` 的超时终止逻辑。审批展示解析出的确切路径、参数、工作目录；完成判定交给现有桌面观察器的进程/可见窗口/前台三项证据。

```ts
process: { run(request:RunRequest):Promise<RunResult>; launch(request:LaunchRequest):Promise<{pid:number|null;started:boolean}>; }
const child = spawn(request.executable, request.args, {cwd:request.cwd,shell:false,windowsHide:false});
```

- [ ] **Step 4: 验证通过。** Run: `npm test -- --run tests/unit/windows-app-resolver.test.ts tests/unit/host-operations.test.ts tests/unit/permission-broker.test.ts tests/unit/sandbox-runner.test.ts` and `npm run typecheck`; expected PASS。Windows 受控机另运行 `npm test -- --run tests/integration/windows-desktop.test.ts`，记录是否因环境跳过。
- [ ] **Step 5: 提交检查点。** Git 可用时提交本任务文件，消息 `feat: launch resolved desktop apps without waiting for exit`；否则记录测试结果。

### Task 6: 真实结果验证、基础能力全覆盖与端到端回归

**Files:** Modify `src/runtime/agent-loop.ts`, `src/runtime/test-executor.ts`, `src/runtime/dependencies.ts`, `src/capabilities/builtin-catalog.ts`, `src/api/routes.ts`; test `tests/integration/agent-loop.test.ts`, `tests/integration/api.test.ts`, `tests/unit/test-executor.test.ts`, `tests/unit/builtin-catalog.test.ts`.

**Interfaces:** Consumes已绑定内置/动态能力和 `process.launch` 观察结果。Produces任务终态 `COMPLETED|BLOCKED|FAILED|NEEDS_USER_INPUT`、脱敏测试摘要与具体阶段事件。内置八种键统一按任务输入、权限、测试、评估执行。

- [ ] **Step 1: 写失败测试。**

```ts
expect(firstTask.metrics.generatedCapabilityCount).toBe(0);
expect(secondTask.metrics.reusedCapabilityCount).toBeGreaterThan(0);
expect(secondTask.status).toBe('COMPLETED');
expect(secondTaskEvents.some(e=>e.type==='capability.reused' && e.payload.name==='process.launch')).toBe(true);
```

使用两个假应用、两个不同目录做隔离端到端；另测网络 GET 与位置查询共用固定键，宿主返回 `supported:false` 不判成功；目标不存在/多匹配为 NEEDS_USER_INPUT；只见进程不见窗口、非前台为 BLOCKED；拒绝权限为 CANCELLED 且宿主调用数零；沙箱成功但本机失败不能激活 Canary；不安全启动不自动重放。

- [ ] **Step 2: 确认失败。** Run: `npm test -- --run tests/integration/agent-loop.test.ts tests/integration/api.test.ts tests/unit/test-executor.test.ts`; expected FAIL。
- [ ] **Step 3: 最小实现。** 注入内置目录到 dependencies；选键时先查内置/已验证 active，动态生成只处理未知键。对每步的实际输出运行测试 Agent 和评估 Agent，桌面步骤额外要求进程、窗口、前台证据；只有全部通过且对应批准日志存在才升级 Canary。响应摘要只含计数、阶段、脱敏原因；不输出完整命令或附件。

```ts
if (step.capabilityKey==='process.launch' && (!observation.processRunning || !observation.windowVisible || !observation.foregroundMatches)) return this.block(task,'启动结果未通过桌面观察验证。');
if (report.failed>0 || report.blocked>0) return this.block(task,report.reason ?? '实际验证未通过。');
```

- [ ] **Step 4: 验证通过。** Run: `npm test -- --run tests/integration/agent-loop.test.ts tests/integration/api.test.ts tests/unit/test-executor.test.ts tests/unit/builtin-catalog.test.ts` and `npm run typecheck`; expected PASS。
- [ ] **Step 5: 提交检查点。** Git 可用时提交本任务文件，消息 `feat: verify real outcomes before completing tasks`；否则记录测试结果。

### Task 7: 重启恢复、前端可解释状态与最终验收

**Files:** Modify `src/storage/sqlite-store.ts`, `src/runtime/agent-loop.ts`, `src/server.ts`, `web/src/App.tsx`; create `web/src/task-polling.ts`; test `tests/unit/sqlite-store.test.ts`, `tests/integration/agent-loop.test.ts`, `tests/integration/api.test.ts`, `web/src/task-polling.test.ts`.

**Interfaces:** Consumes现有 task/event API、operation journal。Produces `SqliteStore.listInterruptedTaskIds():string[]`、`classifyInterruptedTask(task,journal):'resume'|'blocked'|'resubmit'|'waiting'`、`nextPollDelay(attempt:number):number|null`。`resubmit` 以终态 BLOCKED 和明确重新提交指引表示，不自动重新运行。

- [ ] **Step 1: 写失败测试。**

```ts
expect(classifyInterruptedTask(buildingWithoutCheckpoint,[])).toBe('resubmit');
expect(classifyInterruptedTask(executingWithUnknownOperation,[unknownOperation])).toBe('blocked');
expect(nextPollDelay(0)).toBe(750);
expect(nextPollDelay(5)).toBeNull();
```

另测等待审批仍可操作、已完成日志安全续验、重复启动迁移幂等、API 重读保留 BLOCKED 原因、网络短暂失败后查询恢复且输入框最终解锁。

- [ ] **Step 2: 确认失败。** Run: `npm test -- --run tests/unit/sqlite-store.test.ts tests/integration/agent-loop.test.ts tests/integration/api.test.ts web/src/task-polling.test.ts`; expected FAIL。
- [ ] **Step 3: 最小实现。** 启动时枚举非终态且非等待审批任务，按 journal/检查点分类；不确定执行 BLOCKED，无检查点中断 BLOCKED 并给重新提交指引，已完成操作沿原幂等检查点续验。前端按阶段展示字段路径、测试结论和可执行下一步；GET 暂断最多 5 次退避重试，之后显示连接故障并恢复发送能力。

```ts
export function nextPollDelay(attempt:number):number|null { return attempt<5 ? Math.min(750*2**attempt,6000) : null; }
export type InterruptedDisposition = 'resume'|'blocked'|'resubmit'|'waiting';
```

- [ ] **Step 4: 验证通过。** Run: `npm test -- --run`, `npm run typecheck`, `npm run build`; expected 所有非环境限定测试 PASS。Windows 受控本机运行桌面集成；若未运行或因环境跳过，交付中明确标为未验收，不宣称 GUI 本机成功。用实际 Ollama 只读复测包装输入；任何真实启动须遵从当前产品审批，不用开发测试隐式越权。
- [ ] **Step 5: 提交检查点。** Git 可用时提交本任务文件，消息 `fix: recover interrupted tasks and surface reliable status`；否则列出改动文件、测试结果与未运行的 Windows 验收。

## 执行顺序与完成定义

严格按 1→7 执行，每项先红后绿；每项完成后对照本计划接口复查，再进入下一项。最终检查设计文档第 8 节全部六条验收项；任何未通过或仅 dry-run 的项目不能描述为已完成本机验收。
