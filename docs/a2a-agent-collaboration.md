# Jarvis 本地 Agent 协作协议

当前交付的是 `a2a-local-v1`：它为同一个根任务下的多个 Agent 提供持久化身份、收件箱和消息确认。它**不是**官方 Agent2Agent (A2A) 1.0 兼容实现；官方规范采用独立的 Agent Card、Message/Part、Task 和协议绑定，见 [官方 A2A 规范](https://a2a-protocol.org/latest/specification/)。

## 运行前提

默认服务监听 `127.0.0.1:3000`。当前 A2A 端点沿用应用现有的本地访问模型，没有按用户/Agent 分配独立认证令牌；不要将服务直接暴露到不受信任的网络。所有 Agent 消息只允许在同一根任务中传递，消息持久化于 `agent_sessions` 和 `agent_messages` 表。

## 创建队伍

首先创建任务，得到 `taskId`。随后为该任务创建主 Agent：

```http
POST /api/a2a/agents
Content-Type: application/json

{"rootTaskId":"<taskId>","name":"主 Agent","role":"拆分和协调任务","goal":"完成用户目标"}
```

使用返回的主 Agent `id` 创建最多四个子 Agent（同一根任务最多十二个）：

```http
POST /api/a2a/agents
Content-Type: application/json

{
  "parentAgentId": "<mainAgentId>",
  "children": [
    {"name":"研究 Agent","role":"收集资料","goal":"提交资料摘要"},
    {"name":"写作 Agent","role":"整理内容","goal":"形成草稿"}
  ]
}
```

## 协作消息

研究 Agent 将资料引用发送给写作 Agent：

```http
POST /api/a2a/agents/<researchAgentId>/messages
Content-Type: application/json

{
  "messageId": "research-summary-v1",
  "recipientAgentId": "<writerAgentId>",
  "type": "artifact",
  "correlationId": "research-request-1",
  "payload": {"summary":"资料整理完成","sourceRefs":["source-1"]}
}
```

写作 Agent 读取收件箱并确认：

```http
GET /api/a2a/agents/<writerAgentId>/inbox?status=queued
```

```http
POST /api/a2a/messages/research-summary-v1/ack
Content-Type: application/json

{"agentId":"<writerAgentId>","status":"read"}
```

同一 `messageId` 和相同内容重试会返回已保存的消息；相同 ID 但不同内容会被拒绝。`queued` 只表示写入收件箱，`delivered`/`read` 表示明确确认，不代表接收 Agent 已调用模型或完成任务。需要回复时，接收 Agent 再发送 `response` 或 `artifact` 消息并复用 `correlationId`。

## 查询

- `GET /.well-known/agent-card.json`：本地协议能力声明，版本为 `a2a-local-v1`。
- `GET /api/a2a/agents?rootTaskId=<taskId>`：查询队伍。
- `GET /api/a2a/agents/<agentId>`：查询单个 Agent。
- `POST /api/a2a/jsonrpc`：项目自定义 JSON-RPC 入口，方法为 `message/send`、`agents/list`、`tasks/get`。

## 当前限制

此阶段建立通信和编排接口，现有固定 AgentLoop 仍处理任务执行。子 Agent 尚不会因消息到达自动启动独立模型回合，主 Agent 也尚未自动根据任务内容创建队伍。动态执行、自动唤醒及固定测试/评估角色迁移属于下一阶段；界面目前不显示子 Agent 状态。
