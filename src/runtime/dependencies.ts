import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentRunner } from '../agents/agent-runner.js';
import { A2AProtocol } from '../agents/a2a-protocol.js';
import { TestAgent } from '../agents/test-agent.js';
import { CapabilityRegistry } from '../capabilities/registry.js';
import { SandboxRunner } from '../capabilities/sandbox-runner.js';
import { ToolFactory } from '../capabilities/tool-factory.js';
import { BraveWebSearch } from '../research/web-search.js';
import { ModelGateway, type ModelProvider } from '../model/gateway.js';
import { MockModelProvider } from '../model/mock-provider.js';
import { OpenAICompatibleProvider } from '../model/openai-compatible-provider.js';
import { OllamaProvider } from '../model/ollama-provider.js';
import { AgentLoop } from './agent-loop.js';
import { AgentController } from './agent-controller.js';
import { RoleAgentRuntime } from './role-agent-runtime.js';
import { TaskCollaborationRuntime } from './task-collaboration.js';
import { BudgetManager } from './budget-manager.js';
import { AdaptiveScheduler } from './scheduler.js';
import { SessionService } from './session-service.js';
import { sessionMemoryBudgetTokens } from './session-memory.js';
import { TaskService } from './task-service.js';
import { SqliteStore } from '../storage/sqlite-store.js';
import { DefaultHostOperationExecutor } from '../permissions/host-operations.js';
import { PermissionBroker } from '../permissions/permission-broker.js';
import { TestExecutor } from './test-executor.js';
import { WindowsDesktopObserver } from './windows-desktop-observer.js';
import { McpService } from '../mcp/service.js';
import { ToolDiscovery } from '../capabilities/tool-discovery.js';

export interface RuntimeConfig {
  dataDir: string;
  workspaceRoot: string;
  desktopDirectory: string;
  modelMode: 'mock' | 'openai' | 'ollama';
  modelBaseUrl: string;
  modelApiKey: string;
  modelName: string;
  modelRequestTimeoutMs: number;
  modelReviewTimeoutMs: number;
  modelRouteTimeoutMs: number;
  mcpConfigPath?: string;
  maxConcurrency: number;
  maxRetries: number;
  maxSteps: number;
  maxContextTokens: number;
  outputReserveTokens: number;
}

export interface RuntimeDependencies {
  config: RuntimeConfig;
  store: SqliteStore;
  modelProvider: ModelProvider;
  taskService: TaskService;
  registry: CapabilityRegistry;
  sessionService: SessionService;
  a2aProtocol: A2AProtocol;
  agentController: AgentController;
  mcp: McpService;
  toolDiscovery: ToolDiscovery;
}

export function createDependencies(overrides: Partial<RuntimeConfig> = {}): RuntimeDependencies {
  const environmentModelMode = process.env.MODEL_MODE;
  const config: RuntimeConfig = {
    dataDir: process.env.JARVIS_DATA_DIR ?? './data',
    workspaceRoot: resolve(process.env.JARVIS_WORKSPACE_ROOT ?? process.cwd()),
    desktopDirectory: process.env.JARVIS_DESKTOP_DIR
      ? resolve(process.env.JARVIS_DESKTOP_DIR)
      : resolveDesktopDirectory(),
    modelMode: environmentModelMode === 'mock'
      ? 'mock'
      : environmentModelMode === 'openai'
        ? 'openai'
        : 'ollama',
    modelBaseUrl: process.env.MODEL_BASE_URL ?? 'http://127.0.0.1:11434/v1',
    modelApiKey: process.env.MODEL_API_KEY ?? '',
    modelName: process.env.MODEL_NAME ?? 'qwen3.6-27b-tools:latest',
    modelRequestTimeoutMs: configuredModelTimeout(process.env.MODEL_REQUEST_TIMEOUT_MS),
    modelReviewTimeoutMs: configuredModelTimeout(process.env.MODEL_REVIEW_TIMEOUT_MS, 120_000),
    modelRouteTimeoutMs: configuredModelTimeout(process.env.MODEL_ROUTE_TIMEOUT_MS, 180_000),
    mcpConfigPath: process.env.JARVIS_MCP_CONFIG?.trim() || undefined,
    maxConcurrency: 3,
    maxRetries: 5,
    maxSteps: 50,
    maxContextTokens: 32_000,
    outputReserveTokens: 4_000,
    ...overrides,
  };

  if (config.modelMode === 'openai' && !config.modelApiKey.trim()) {
    throw new Error('MODEL_API_KEY is required when MODEL_MODE=openai. Set it in your local .env file.');
  }

  mkdirSync(config.dataDir, { recursive: true });
  const store = new SqliteStore(join(config.dataDir, 'jarvis.sqlite'));
  store.recoverInterruptedOperations();
  store.recoverInterruptedModelCalls();
  const workspaceRoot = config.workspaceRoot;
  const modelProvider = config.modelMode === 'mock'
    ? new MockModelProvider()
    : config.modelMode === 'ollama'
      ? new OllamaProvider({ baseUrl: config.modelBaseUrl, model: config.modelName,
        timeoutMs: config.modelRequestTimeoutMs,
        reviewTimeoutMs: config.modelReviewTimeoutMs, routeTimeoutMs: config.modelRouteTimeoutMs })
      : new OpenAICompatibleProvider({
        baseUrl: config.modelBaseUrl,
        apiKey: config.modelApiKey,
        model: config.modelName,
        timeoutMs: config.modelRequestTimeoutMs,
        reviewTimeoutMs: config.modelReviewTimeoutMs,
        routeTimeoutMs: config.modelRouteTimeoutMs,
      });
  const a2aProtocol = new A2AProtocol(store);
  const roleAgentRuntime = new RoleAgentRuntime(a2aProtocol);
  const mcp = new McpService(workspaceRoot, config.dataDir, config.mcpConfigPath);
  const toolDiscovery = new ToolDiscovery(mcp);
  const gateway = new ModelGateway(modelProvider, {
    start: (request, details) => store.startModelTrace(request, details?.model ?? config.modelName, details),
    finish: (id, outcome) => store.finishModelTrace(id, outcome),
  }, activity => {
    store.appendEvent(activity.taskId, { type: 'agent.activity', payload: {
      runId: activity.runId, role: activity.role, status: activity.status,
      durationMs: activity.durationMs,
    } });
    roleAgentRuntime.onActivity(activity);
  });
  const agentController = new AgentController(a2aProtocol);
  const agents = new AgentRunner(gateway, process.env.BRAVE_SEARCH_API_KEY?.trim()
    ? new BraveWebSearch(process.env.BRAVE_SEARCH_API_KEY.trim()) : undefined, mcp);
  const tester = new TestAgent(gateway);
  const sandbox = new SandboxRunner();
  const registry = new CapabilityRegistry(store, sandbox);
  registry.installBuiltins();
  const permissionBroker = new PermissionBroker(store, new DefaultHostOperationExecutor({ mcp }), workspaceRoot);
  const sessionService = new SessionService(store, gateway,
    sessionMemoryBudgetTokens(config.maxContextTokens, config.outputReserveTokens));
  const loop = new AgentLoop({
    store,
    agents,
    tester,
    testExecutor: new TestExecutor(sandbox),
    desktopObserver: new WindowsDesktopObserver(),
    factory: new ToolFactory(agents),
    registry,
    toolDiscovery,
    sandbox,
    budget: new BudgetManager({
      maxContextTokens: config.maxContextTokens,
      outputReserveTokens: config.outputReserveTokens,
    }),
    scheduler: new AdaptiveScheduler({ maxConcurrency: config.maxConcurrency }),
    collaboration: new TaskCollaborationRuntime(a2aProtocol, config.maxConcurrency),
    maxRetries: config.maxRetries,
    maxSteps: config.maxSteps,
    permissionBroker,
    workspaceRoot,
    desktopDirectory: config.desktopDirectory,
    sessionMemory: sessionService,
    cancelModelTask: taskId => gateway.cancelTask(taskId),
    clearModelCancellation: taskId => gateway.clearTaskCancellation(taskId),
  });

  return {
    config, store, modelProvider,
    taskService: new TaskService(store, loop, permissionBroker, sessionService, roleAgentRuntime),
    registry, sessionService, a2aProtocol, agentController, mcp, toolDiscovery,
  };
}

function configuredModelTimeout(value: string | undefined, fallback = 300_000): number {
  if (value === undefined || value === '') return fallback;
  const milliseconds = Number(value);
  if (!Number.isInteger(milliseconds) || milliseconds < 30_000 || milliseconds > 600_000) {
    throw new Error('Model timeout must be an integer from 30000 to 600000 milliseconds.');
  }
  return milliseconds;
}

function resolveDesktopDirectory(): string {
  const fallback = join(homedir(), 'Desktop');
  if (process.platform !== 'win32') return fallback;
  try {
    const knownFolder = execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '[Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)',
    ], { encoding: 'utf8', timeout: 2_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return knownFolder || fallback;
  } catch {
    return fallback;
  }
}
