# 贾维斯自我进化智能体设计

## 1. 目标与范围

贾维斯是一个本地优先、云模型驱动的通用个人助理。用户通过单一聊天入口提出需求并上传文件；当当前能力库无法满足需求时，贾维斯能够生成工具或工作流，经过隔离测试、评估和权限治理后持久化保存，并在后续任务中复用。

首版的“自我进化”指能力资产和策略资产的持续积累，不直接修改模型权重。工具、工作流和核心策略都必须版本化、可评估、可灰度启用和可回滚。

首版范围：

- TypeScript/Node.js 全栈；模型通过统一模型网关接入，先支持一个模型供应商。
- 单一聊天页面，支持附件上传、简短进度状态、授权确认和补充信息。
- 三类核心智能体：主智能体、评估智能体、实施智能体。
- 一个确定性的 Harness 运行时，负责状态机、上下文预算、调度、沙箱、权限、MCP 注册、版本、审计、恢复和重试。
- 首个验收场景为：自动生成并复用一个本地只读工具。

不在首版范围内：在线自动训练或修改模型参数、任意本机直接执行生成代码、无审计的自由递归智能体、复杂的多用户企业权限体系。

## 2. 核心原则

1. 模型负责提出方案、生成候选和解释结果；Harness 负责执行不可违背的预算、权限、资源、注册、回滚和重试规则。
2. 评估通过不等于直接上线。工具还必须通过沙箱测试和策略闸门；低风险工具可自动发布，高风险工具必须获得用户确认。
3. 原始输入和事实来源不可被压缩结果覆盖。上下文压缩产物必须保留来源引用、版本和可恢复的原文索引。
4. 个人记忆与能力资产分离。工具、工作流和评估案例可自动版本化；个人偏好和敏感事实必须可查看、确认和删除。
5. 不向用户展示模型隐藏思维。界面只展示阶段、工具调用摘要、评估结论、失败原因、权限请求和最终结果。

## 3. 系统架构

### 3.1 组件

- **Chat UI**：消息、附件、进度状态、授权确认和用户补充信息。
- **Task API**：创建任务、发送用户回复、查询状态和读取结果。
- **Harness Orchestrator**：维护任务状态机，协调智能体和运行时组件。
- **主智能体运行器**：意图理解、能力缺口分析、任务计划和依赖判断。
- **评估智能体运行器**：评估上下文方案、工具、工作流、执行结果和策略候选。
- **实施智能体运行器**：生成工具、执行文件/数据任务和调用已批准能力。
- **Context Budget Manager**：根据模型上下文上限、输入内容、历史消息、附件、工具输出和预计回复计算预算。
- **Adaptive Scheduler**：根据资源、模型速率限制、全局预算和 DAG 宽度控制并发。
- **Sandbox Runner**：以隔离进程或容器运行生成代码，限制文件系统、网络、凭证、CPU、内存、时间和输出大小。
- **Policy Gate**：执行权限、风险等级、用户确认、发布和回滚规则；它不是模型角色。
- **Capability Registry**：保存工具、工作流和策略的版本及其状态。
- **MCP Adapter**：仅暴露已批准的能力版本，提供标准 MCP/function 调用接口。
- **Artifact/Audit Store**：保存代码、Manifest、测试、评估、事件、用户确认和运行指标。
- **Memory Store**：保存用户明确允许的长期记忆，与能力资产隔离。

首版采用本地 SQLite 保存任务、事件、Manifest、版本和评估元数据；代码、附件、日志和测试工件保存到应用数据目录。工具执行使用独立子进程或容器，不与 Harness 主进程共享不受限权限。

### 3.2 运行时边界

智能体以逻辑角色运行，不要求每个角色常驻一个操作系统进程。Harness 为每个子任务创建独立的 Agent Run，注入最小必要上下文和能力引用；真正执行生成代码时必须进入 Sandbox Runner。所有模型调用通过 Model Gateway，以便统一记录模型名、上下文上限、token 用量、速率限制和成本。

## 4. 任务状态机与数据流

任务主流程为：

`INTAKE → BUDGET_CHECK → CONTEXT_READY → CAPABILITY_ANALYSIS → PLAN_READY → EXECUTING → EVALUATING → COMPLETED`

可恢复分支状态：

- `CONTEXT_COMPACTING`：上下文不足，进行候选压缩方案评估和应用。
- `CAPABILITY_BUILDING`：生成、测试和评估缺失能力。
- `WAITING_FOR_APPROVAL`：等待用户批准高风险工具或策略。
- `NEEDS_USER_INPUT`：缺少必要信息，暂停相关分支；用户回复后恢复。
- `RETRYING`：将失败证据和修正要求交给下一轮，最多 5 次重试。
- `FAILED`：达到闭环重试或全局预算上限，返回结构化失败原因和可执行的下一步。
- `CANCELLED`：用户取消或运行时主动取消。

一次用户请求的流程如下：

1. 解析文本和附件，建立不可变的输入快照。
2. Context Budget Manager 计算当前模型的输入、工具、历史和输出预算。
3. 如果预算不足，Context Curator 生成一到多个压缩方案；评估智能体按信息保真度、可追溯性和任务相关性评分；Harness 应用最佳通过方案并验证关键引用仍可解析。
4. 主智能体查询 Capability Registry，确定已有工具、工作流和策略是否足够。
5. 缺失能力进入 Tool/Workflow Builder：生成代码、Manifest、测试和说明，Sandbox Runner 执行测试，评估智能体给出结构化结论，Policy Gate 决定发布、请求确认或拒绝。
6. 主智能体把任务编成带依赖关系的 DAG。调度器只运行依赖已满足的节点，并根据硬上限动态控制并发。
7. 实施智能体执行每个节点，评估智能体检查结果与验收标准；失败时携带失败证据进入下一轮。
8. 汇总结果，保存成功与失败工件、用户反馈和可复用经验；不把未经允许的个人事实写入长期记忆。

## 5. Agent Loop 与自动退出

Harness 使用确定性的任务循环驱动智能体协作。智能体不能通过自由生成文本决定循环是否结束；每轮调用都必须返回结构化结果，由 Harness 和评估规则共同决定下一步。

伪代码如下：

```ts
while (run.status === 'active') {
  const step = scheduler.nextReadyStep(run);
  const output = await agentRunner.execute(step, run.context);
  const checked = await evaluator.check(step, output, run.acceptanceCriteria);

  if (checked.status === 'complete') {
    run.markStepComplete(step, checked.evidence);
  } else if (checked.status === 'needs_user_input') {
    run.pauseForUser(checked.inputRequest);
  } else if (checked.status === 'retry') {
    run.retryWithEvidence(step, checked.failures);
  } else {
    run.fail(checked.failures);
  }

  if (run.allAcceptanceCriteriaPassed() && !run.hasPendingWork()) {
    run.complete();
  }
}

return resultSynthesizer.buildUserResponse(run);
```

每个循环节点返回统一的 `StepDecision`：

```ts
interface StepDecision {
  status: 'complete' | 'retry' | 'needs_user_input' | 'wait_approval' | 'fail';
  evidence: unknown[];
  failures?: Array<{ code: string; message: string }>;
  nextSteps?: string[];
  inputRequest?: UserInputRequest;
}
```

任务只有同时满足以下条件才会自动退出循环并向用户返回最终结果：

- 所有必需 DAG 节点均已成功或被明确标记为无需执行。
- 主任务验收标准全部通过，且评估智能体提供了可审计证据。
- 没有等待中的用户信息、权限确认、审批或未完成工具调用。
- 最终结果已经通过 Schema 校验，并能关联到输入、工具输出和执行步骤。
- 没有触发任务级 token、时间、成本或资源预算上限。

如果条件不满足，Harness 会继续选择下一步、进入修正重试、暂停等待用户，或以结构化失败结束；不会因为模型说“应该完成了”就提前退出。除每个闭环最多 5 次修正重试外，任务还必须设置最大步骤数和最大运行时长，作为防止循环失控的最后保护。

任务完成后由 Result Synthesizer 只负责把已验证的结果组织成用户可读回复；它不能偷偷发起新的工具调用。用户后续提出修改意见时创建新的修正轮，并引用原任务的结果和版本，而不是重新执行整个历史循环。

## 6. 统一接口与资产模型

以下接口是首版跨组件的稳定边界，具体实现可在其内部演进。

```ts
type TaskStatus =
  | 'INTAKE' | 'BUDGET_CHECK' | 'CONTEXT_COMPACTING'
  | 'CAPABILITY_ANALYSIS' | 'CAPABILITY_BUILDING' | 'PLAN_READY'
  | 'EXECUTING' | 'EVALUATING' | 'WAITING_FOR_APPROVAL'
  | 'NEEDS_USER_INPUT' | 'RETRYING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

interface CapabilityManifest {
  id: string;
  version: string;
  kind: 'tool' | 'workflow' | 'policy';
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  entrypoint: string;
  runtime: 'node-sandbox-v1';
  permissions: Array<'filesystem.read' | 'filesystem.write' | 'network' | 'location' | 'process'>;
  riskLevel: 'low' | 'medium' | 'high';
  tests: string[];
  provenance: { sourceTaskId: string; generatedAt: string };
}

interface EvaluationRecord {
  targetId: string;
  targetVersion: string;
  verdict: 'pass' | 'revise' | 'reject';
  score: number;
  failures: Array<{ code: string; message: string; evidence?: unknown }>;
  recommendations: string[];
  evaluatorRunId: string;
}

interface UserInputRequest {
  taskId: string;
  question: string;
  requiredFields: Array<{ name: string; reason: string; sensitive: boolean }>;
  resumeToken: string;
}
```

工具生命周期为：

`draft → sandbox_testing → evaluated → approved/canary → active → deprecated/rollback`

任何 active 版本均不可原地覆盖。新版本必须保留父版本、差异、评估报告和回滚目标。MCP Adapter 只从 Registry 暴露 active 或用户明确批准的 canary 版本。

## 7. 上下文治理

Context Budget Manager 使用模型网关提供的上下文窗口、最大输出和速率限制，并结合当前输入、附件抽取结果、历史消息、工具 Schema、工具输出和预留回复空间计算预算。主智能体不得自行绕过预算。

Context Curator 可提出三类方案：分层摘要、按任务相关性裁剪、原文外置并保留可检索引用。评估重点为关键事实召回、用户约束保留、来源可追溯和压缩后任务成功率。原始输入快照始终保留在本地，压缩只改变当前运行时注入的上下文。

## 8. 调度、重试与恢复

并发数由以下值的最小值决定：用户配置上限、模型并发/速率上限、CPU/内存安全上限、当前 token/成本预算和 DAG 可并行节点数。每个 Agent Run 都有超时、取消信号、输出大小限制和资源配额。

“最多重试 5 次”按独立闭环计算：一次初始尝试之外，最多允许 5 次修正重试。上下文治理、工具生成/评估、每个实施子任务分别计算自己的重试预算；整单还有 token、时间和成本全局预算。重试必须附带上一轮失败证据和修正目标，禁止无变化盲重试。

当工具或任务需要用户提供信息、权限或确认时，运行时进入 `NEEDS_USER_INPUT` 或 `WAITING_FOR_APPROVAL`，释放可释放资源并保存恢复令牌；用户回复后从最近安全检查点继续，不重复已经通过的步骤。

## 9. 安全与权限

- 生成代码默认无网络、无写权限、无凭证、无任意进程权限，只能访问临时工作目录。
- 权限以 Manifest 声明，Sandbox Runner 和 Policy Gate 双重校验；模型不能自行提升权限。
- 用户密钥由运行时的 Secret Broker 管理，不进入提示词、日志、评估输入或生成代码文本。
- 只读、本地、无外部副作用能力为低风险；写文件、网络、定位、消息、购买、系统变更等至少为中高风险。
- 注册、发布、策略启用、用户确认、沙箱结果和回滚均写入审计事件。
- 核心策略变更只能生成候选版本，先在固定回归任务集上评估，再进行小流量/单任务灰度；效果退化自动回滚到父版本。

## 10. 用户界面

首版只做一个聊天页面：中央消息流、附件上传、输入框和发送按钮。长任务在消息流中展示简短状态，例如“正在分析能力缺口”“正在沙箱测试新工具”“第 2/5 次评估重试”。工具代码、评估报告和运行日志默认折叠。高风险授权和缺失信息以聊天中的确认卡片呈现，用户可以批准、拒绝、补充信息或取消任务。

## 11. 分阶段交付与验收

### 阶段一：Harness 基础

- 聊天任务、附件快照、状态机、事件记录、模型网关、任务恢复。
- 上下文预算、固定重试规则、全局预算和自适应并发调度。
- 验收：能恢复中断任务；达到预算或重试上限时给出明确状态，不出现无限循环。

### 阶段二：工具生成闭环

- TypeScript/Node 只读工具模板、Manifest、测试生成、Sandbox Runner、评估和 Registry。
- MCP Adapter 暴露 active 工具；重复需求能检索并复用已发布版本。
- 验收：没有现成能力时自动生成一个本地只读工具；测试失败会携带证据重试；通过后发布并在第二次请求复用。

### 阶段三：上下文治理与文件任务

- 文件抽取、分层摘要、引用索引、上下文压缩评估和信息缺失恢复。
- 验收：在超出预算的长输入上完成压缩；关键约束和引用保留；压缩失败可重试或请求用户选择。

### 阶段四：工作流和策略进化

- 工作流 DAG 资产、策略候选版本、回归评估、灰度、指标和回滚。
- 验收：系统可以提出并验证一条新的复用工作流，但不能直接覆盖 active 策略。

### 阶段五：高权限工具

- 地理位置、网络访问、文件写入和第三方服务等能力，逐项加入权限和用户确认。
- 验收：未经批准的高风险能力不能执行；用户拒绝后任务能安全终止或选择替代方案。

## 12. 关键测试场景

- 能力已存在：直接复用，不重复生成。
- 能力不存在：生成、沙箱测试、评估、发布、MCP 调用和下次复用完整通过。
- 工具测试失败：失败证据进入修正轮，最多重试 5 次后停止。
- 上下文不足：压缩成功、压缩失败和无法保留关键事实三种路径均有明确结果。
- 需要用户信息：进入 `NEEDS_USER_INPUT`，用户补充后从检查点恢复。
- 高风险工具：低风险自动发布；高风险等待确认；拒绝后不执行。
- 资源不足：降低并发或排队，不创建超出硬上限的 Agent Run。
- 进程崩溃/网络失败：任务事件可恢复，已完成能力不重复发布，运行中能力回到安全状态。
- 策略候选退化：灰度评估失败并自动回滚。
- 个人记忆隔离：能力资产可以复用，但未经允许的个人内容不会进入能力库或长期记忆。
