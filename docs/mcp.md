# MCP 服务接入

项目现在是 MCP **客户端**：使用官方 TypeScript SDK 的 stdio transport 启动本地服务器，发现工具，并把已发现的工具名和参数提示交给规划器。规划器可直接选 `mcp.call`；对尚无明确工具的步骤，所属任务子 Agent 会搜索内置与 MCP 工具清单，读取候选工具描述及输入参数结构，再决定调用已有工具或创建内部临时工具。工具调用仍进入原有审批与操作日志。

## 工具查询与选择

| 接口 | 返回内容 |
| --- | --- |
| `GET /api/mcp/servers` | 各 MCP 服务器的连接状态和实际公布的工具；连接失败的服务器不会提供候选工具。 |
| `GET /api/tools` | 当前可用的内置工具与 MCP 工具，包含来源、服务器、描述、输入参数结构和只读标记。 |
| `GET /api/tools/search?query=搜索文件&limit=8` | 根据工具名、服务器、描述和参数名搜索，返回相关度排序的候选工具；`limit` 为 1～30。 |

执行 `dynamic.*` 步骤时，分配到该步骤的子 Agent 先给出最多 3 个能力搜索词。运行时在已发现的工具中搜索，每个搜索最多取 8 项，合并后将最多 8 个候选及其输入参数结构交给该子 Agent 判断。子 Agent 选择 `use` 时必须提交清单中准确的工具 ID 与参数；运行时校验后才绑定内置工具或 `mcp.call`。选 `create`、搜索无结果或选择不可用时，调用该子 Agent 的内部工具创建流程；生成工具仍要经过策略、通用性、沙箱测试和评估，只在当前任务内可用。已指定且可用的内置工具或 MCP 工具直接沿用原执行流程。任务事件 `tool.searched` 和 `tool.selected` 记录搜索与选择结果，不包含工具参数或用户数据。

## 已接入

| 服务 | 状态与用途 | 权限边界 |
| --- | --- | --- |
| [Filesystem](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/README.md) | 随 `npm ci` 安装；本地验证发现 10 个工具，包括文件读取、目录浏览、搜索和元数据。 | 默认加 `--read-only`，允许目录固定为 `JARVIS_WORKSPACE_ROOT`。不会公布写入工具。项目原有内置文件工具仍可按审批规则写文件。 |
| [Memory](https://github.com/modelcontextprotocol/servers/blob/main/src/memory/README.md) | 随 `npm ci` 安装；本地验证发现 9 个知识图谱工具，可查找和维护实体、关系。 | 数据在 `JARVIS_DATA_DIR/mcp-memory.jsonl`；MCP 调用在“请求批准”和“帮我批准”模式下逐次审批。 |
| [GitHub 官方 MCP Server](https://github.com/github/github-mcp-server) | 提供仓库、Issue、PR 等工具集；示例配置在 [`.mcp.example.json`](../.mcp.example.json)。 | 可选，需要 Docker 和你自己的 GitHub 令牌。示例启用服务器的只读模式，并限制 toolsets。当前没有令牌，因此未验证实际连接。 |

默认安装依赖不会连接 GitHub，也不会向 GitHub 发送本地数据。要启用：

```powershell
Copy-Item .mcp.example.json .mcp.json
```

在本地 `.env` 中设置 `JARVIS_MCP_CONFIG=.mcp.json` 和 `GITHUB_PERSONAL_ACCESS_TOKEN=...`，重启后端，再访问 `http://127.0.0.1:3000/api/mcp/servers` 检查 `github.connected`。`docker` 必须已安装并运行。`.mcp.json` 和 `.env` 均已加入 `.gitignore`。需要更多工具集时调整本地配置中的 `GITHUB_TOOLSETS`；需要写操作时移除 `GITHUB_READ_ONLY`，MCP 调用依然受项目审批模式约束。

可在聊天中请求“用 MCP 文件系统搜索工作区中的配置文件”或“用 Memory MCP 查找某个实体”。规划器只会得到服务器实际公布的工具；服务不可用时不会把它的工具列给规划器。可在本地配置文件的 `servers` 中增加其他 stdio 服务器，字段为 `command`、`args`、`env`、`cwd`。环境变量可写为 `${VARIABLE_NAME}`，运行时从本地进程环境读取。不要让未经审查的第三方服务器运行在拥有敏感文件或高权限令牌的账户下；MCP 服务器进程本身运行在本机，项目审批约束的是**工具调用**，并不沙箱化服务器代码。

## 公开仓库与使用边界

- MCP 客户端 npm 元数据标为 Apache-2.0；[SDK 源仓库](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE)和[参考服务器仓库](https://github.com/modelcontextprotocol/servers/blob/main/LICENSE)处在 Apache-2.0 / MIT 过渡期，Filesystem 和 Memory 的 README 均声明 MIT；[GitHub 官方服务器](https://github.com/github/github-mcp-server/blob/main/LICENSE)为 MIT。这些许可证允许公开仓库引用与依赖，分发第三方代码时应保留其许可证及适用的版权和 NOTICE 声明。本项目不复制服务器源码，`node_modules` 不提交。当前 npm 发布包的 Filesystem/Memory 元数据写着 `SEE LICENSE IN LICENSE`，但安装包中未见 LICENSE 文件；若以后要打包或再分发这些服务器，请先核对上游对应版本的许可文件并补齐声明。
- 许可证允许使用软件，不等于任何具体数据访问或操作都合法。只访问你有权限的文件和仓库；GitHub API 使用还受 [GitHub 服务条款](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)约束。GitHub 建议令牌只授予所需的最小权限，并且[不要提交到任何仓库](https://docs.github.com/en/rest/authentication/keeping-your-api-credentials-secure)。
- Memory 数据、聊天记录和操作日志可能包含个人或项目内容，均保存在本地 `data/`（或你设置的数据目录）中；发布仓库前检查截图、文档、提交历史及忽略规则。服务器返回的内容也应当视为不可信数据。
