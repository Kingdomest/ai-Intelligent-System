# Jarvis 动态多智能体与 A2A 协作设计

**日期：** 2026-10-12  
**状态：** 已确认设计，进入实现计划

**协议边界：** 本文实现项目内部的 `a2a-local-v1` 协作协议。它借鉴 Agent Card、消息和任务查询概念，但不声明符合官方 Agent2Agent (A2A) 1.0 的数据模型或互操作要求。外部标准客户端接入需要独立适配层。

## 1. 背景与目标

当前 Jarvis 运行时将主 Agent、测试 Agent、评估 Agent 和实施 Agent 固定为 `AgentRunner` 上的若干方法调用。系统没有独立的子 Agent 身份、父子会话关系、持久化收件箱或 Agent 之间的消息协议。现有动态多智能体设计文档已经定义了这些方向，但尚未落地。

本次改造的目标是建立可持久化的本地 A2A 协作基础，并把任务编排逐步转向“主 Agent 动态创建和管理子 Agent”的模型：主 Agent 负责任务图、依赖、权限边界、结果汇总和最终决策；子 Agent 负责被分配的职责和产出；A2A 负责子 Agent 之间的请求、响应、状态和产物引用通信。

现有固定 Agent 方法保留为兼容适配层，直到动态执行循环完成迁移。通信层不能把消息已入箱误报成 Agent 已阅读或已执行。

## 2. 范围

### 本次交付

- `AgentSession` 身份模型：`agentId`、`parentAgentId`、`rootTaskId`、角色、目标、状态和能力范围。
- SQLite 持久化 `agent_sessions` 与 `agent_messages`，支持服务重启后恢复收件箱。
- `A2AProtocol` 服务：创建/查询 Agent、同根任务树隔离、发送消息、读取收件箱、消息确认、幂等去重。
- Agent Card 和本地 HTTP API；JSON-RPC `message/send`、`agents/list`、`tasks/get` 基础入口。
- `AgentController` 最小编排接口，为主 Agent 动态创建子 Agent，并通过 A2A 发送/接收协作消息。
- 主 Agent 创建的子 Agent 数量、消息正文和 payload 大小均有硬上限。
- 单元测试、SQLite 集成测试和 API 测试；现有全量测试保持通过。

### 后续阶段

- 子 Agent 独立模型决策循环与 `trigger_turn` 自动唤醒。
- 将固定测试/评估/实施角色迁移为动态 `AgentSpec`，保留独立核验和现有权限关卡。
- 产物存储、引用版本和任务图失效传播。
- 按官方 A2A 1.0 规范实现可互操作的 Agent Card、Message/Part、Task 和协议绑定；不能把本地 JSON-RPC 方法名直接当作官方方法。

## 3. 核心模型

### AgentSession

每个 Agent 在同一根任务树中拥有唯一身份。父 Agent 创建子 Agent；子 Agent 不能自行创建新的 Agent，也不能修改自己的权限范围。`rootTaskId` 用于隔离通信边界，指定父 Agent 时由内核推导根任务并拒绝冲突值。

状态为 `queued`、`running`、`waiting`、`paused`、`completed`、`failed` 或 `cancelled`。状态变更和消息事件写入现有任务轨迹，公开内容只包含脱敏后的元数据。

### AgentMessage

消息包含 `messageId`、`rootTaskId`、发送者、接收者、类型、`correlationId`、payload、投递状态和时间戳。类型为 `request`、`response`、`event`、`artifact`、`status` 或 `error`；投递状态为 `queued`、`delivered`、`read` 或 `failed`。

同一 `messageId` 重试必须返回已保存的原消息，不创建第二条记录。消息只能发送给同根任务树的已存在 Agent；已取消或已终态 Agent 不接受新的工作请求。

### 协作语义

`queued` 表示已持久化；`delivered` 表示收件箱读取方已确认收到；`read` 表示接收方明确确认已处理。协议层不替 Agent 声称模型已经执行，执行结果必须通过后续 `response` 或 `artifact` 消息产生。

## 4. 运行架构

```text
TaskService / 主 Agent
        |
        v
AgentController ---- A2AProtocol ---- SqliteStore
        |                    |
        +---- AgentSession   +---- agent_messages inbox
        |
        +---- 现有 AgentLoop（兼容执行路径）
```

`A2AProtocol` 是通信和边界校验的唯一入口；API 与未来模型 action 都调用它，不直接写 SQLite。`AgentController` 负责父子关系、根任务和编排限制，不负责绕过现有权限或执行宿主操作。

## 5. HTTP 与 JSON-RPC 契约

- `GET /.well-known/agent-card.json`：返回协议版本、支持的消息类型和本地 endpoint。
- `POST /api/a2a/agents`：由主 Agent 创建 Agent。
- `GET /api/a2a/agents/:agentId`、`GET /api/a2a/agents?rootTaskId=...`：读取身份和状态。
- `POST /api/a2a/agents/:senderAgentId/messages`：向同树 Agent 发送消息。
- `GET /api/a2a/agents/:agentId/inbox`：按状态和游标读取消息。
- `POST /api/a2a/messages/:messageId/ack`：确认 `delivered`、`read` 或 `failed`。
- `POST /api/a2a/jsonrpc`：支持 `message/send`、`agents/list`、`tasks/get`。

公开 API 不返回 Agent 的权限秘密、模型内部推理、附件全文或未经脱敏的宿主命令输出。

## 6. 限制与错误

- 根任务树最多创建 12 个子 Agent，单次创建最多 4 个；主 Agent 不计入子 Agent 上限。
- Agent 名称最多 80 字符，角色和目标各最多 2,000 字符。
- 单条消息正文/payload 序列化后最多 8,000 字符；单次收件箱读取最多 20 条。
- 非法父 Agent、根任务冲突、跨树通信、未知接收方、重复 payload、超过上限或终态冲突返回结构化 4xx 错误。
- SQLite 事务保证 Agent 创建和消息入箱的原子性；内存事件仅用于通知，不能作为事实来源。

## 7. 兼容性与迁移

SQLite 新增幂等迁移版本；现有 `tasks`、`sessions`、`task_events`、权限和模型追踪数据不删除。旧任务继续使用原 AgentLoop；只有显式创建动态 Agent 的任务使用 A2A 会话树。`ApiServices` 和 `RuntimeDependencies` 通过新增服务字段接入，保留现有测试构造方式的兼容性。

## 8. 验收标准

1. 主 Agent 能在一个根任务下创建多个子 Agent，并能查询父子关系。
2. 两个同树子 Agent 可以完成 request/response 或 artifact 协作，消息重试不重复。
3. 跨根任务发送、越权创建、超过数量/长度上限都会被拒绝。
4. 未读消息在关闭并重新打开 SQLite 后仍可读取，确认状态正确恢复。
5. Agent Card 和 API/JSON-RPC 返回稳定契约，敏感字段不会外泄。
6. 现有任务、会话、权限和全量测试不回归。
7. 动态消息只证明通信状态，不伪造模型执行结果；后续动态执行循环可以在不改消息存储契约的前提下接入。
