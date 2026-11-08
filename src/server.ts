import 'dotenv/config';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from './api/app.js';
import { registerRoutes } from './api/routes.js';
import { createDependencies } from './runtime/dependencies.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);

const runtime = createDependencies();
const webRoot = resolve(process.cwd(), 'web', 'dist');
const app = await buildApp({
  registerRoutes: (instance) => registerRoutes(instance, runtime),
  webRoot: existsSync(webRoot) ? webRoot : undefined,
});
app.addHook('onClose', async () => { await runtime.mcp.close(); });
await app.listen({ host, port });
void runtime.taskService.resumeAfterRestart().catch((error: unknown) => {
  console.error('Failed to resume checkpointed Jarvis tasks:', error);
});
