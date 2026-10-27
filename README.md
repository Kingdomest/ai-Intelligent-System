# ai-Intelligent System

基于 TypeScript、Fastify 和 React 的本地 Agent 应用，包含任务规划、工具调用、权限管理、会话记录和网页界面。

## 本地运行

需要 Node.js 24 或更高版本。

```bash
npm ci
cp .env.example .env
npm run dev
```

另开一个终端运行 `npm run dev:web`，打开 Vite 提示的本地地址。运行 `npm run build` 构建服务端与网页。

模型配置放在本地 `.env` 中。使用兼容 OpenAI 接口的模型时，设置 `MODEL_MODE=openai`、`MODEL_BASE_URL`、`MODEL_NAME` 和 `MODEL_API_KEY`；使用 Ollama 时沿用 `.env.example` 中的设置。`.env` 及其本地变体、数据库和日志均已加入 `.gitignore`，请勿将真实 API Key 写入源码或提交记录。
