import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

export interface McpToolSummary {
  server: string;
  name: string;
  description: string;
  inputSchema: unknown;
  readOnly: boolean;
}

interface ServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface Connection {
  client: Client;
  tools: McpToolSummary[];
}

const serverName = /^[a-z][a-z0-9_-]{0,63}$/;

/** Local stdio servers are selected by the host config, never by model output. */
export class McpService {
  private readonly servers: Record<string, ServerConfig>;
  private readonly connections = new Map<string, Promise<Connection>>();

  constructor(workspaceRoot: string, dataDir: string, configPath?: string) {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const bundled = (name: string) => join(projectRoot, 'node_modules', '@modelcontextprotocol', name, 'dist', 'index.js');
    this.servers = {
      filesystem: {
        command: process.execPath,
        args: [bundled('server-filesystem'), '--read-only', resolve(workspaceRoot)],
      },
      memory: {
        command: process.execPath,
        args: [bundled('server-memory')],
        env: { MEMORY_FILE_PATH: join(resolve(dataDir), 'mcp-memory.jsonl') },
      },
    };
    if (configPath) {
      const parsed: unknown = JSON.parse(readFileSync(resolve(configPath), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || !('servers' in parsed) || !parsed.servers || typeof parsed.servers !== 'object'
        || Array.isArray(parsed.servers)) throw new Error('MCP config must contain a servers object.');
      for (const [name, value] of Object.entries(parsed.servers)) {
        if (!serverName.test(name)) throw new Error(`Invalid MCP server name: ${name}`);
        if (value === false) { delete this.servers[name]; continue; }
        if (!isServerConfig(value)) throw new Error(`Invalid MCP server config: ${name}`);
        this.servers[name] = value;
      }
    }
  }

  serverNames(): string[] { return Object.keys(this.servers); }

  async inspect(): Promise<Array<{ server: string; connected: boolean; tools: McpToolSummary[]; error?: string }>> {
    const results = await Promise.allSettled(this.serverNames().map(name => this.connect(name)));
    return results.map((result, index) => ({ server: this.serverNames()[index]!,
      connected: result.status === 'fulfilled',
      tools: result.status === 'fulfilled' ? result.value.tools : [],
      ...(result.status === 'rejected' ? { error: result.reason instanceof Error ? result.reason.message : String(result.reason) } : {}),
    }));
  }

  async listTools(): Promise<McpToolSummary[]> {
    return (await this.inspect()).flatMap(item => item.tools);
  }

  async call(server: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (!serverName.test(server) || !this.servers[server] || !tool || typeof tool !== 'string') {
      throw new Error('MCP server or tool is not configured.');
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('MCP tool arguments must be an object.');
    const connection = await this.connect(server);
    if (!connection.tools.some(item => item.name === tool)) throw new Error(`MCP tool is unavailable: ${server}/${tool}`);
    const result = await connection.client.callTool({ name: tool, arguments: args }, { timeout: 30_000 });
    if (result.isError) {
      const detail = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      throw new Error(`MCP tool failed: ${detail.slice(0, 1000) || `${server}/${tool}`}`);
    }
    const output = { server, tool, content: result.content, structuredContent: result.structuredContent };
    if (Buffer.byteLength(JSON.stringify(output)) > 40_000) {
      throw new Error('MCP result exceeds the 40 KB answer limit; request a smaller result.');
    }
    return output;
  }

  async close(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(connections.map(async item => (await item).client.close()));
  }

  private connect(name: string): Promise<Connection> {
    const existing = this.connections.get(name);
    if (existing) return existing;
    const pending = this.open(name);
    this.connections.set(name, pending);
    void pending.catch(() => { if (this.connections.get(name) === pending) this.connections.delete(name); });
    return pending;
  }

  private async open(name: string): Promise<Connection> {
    const config = this.servers[name];
    if (!config) throw new Error(`MCP server is not configured: ${name}`);
    const client = new Client({ name: 'jarvis-agent-harness', version: '0.1.0' });
    const env = { ...getDefaultEnvironment(), ...Object.fromEntries(Object.entries(config.env ?? {})
      .map(([key, value]) => [key, expandEnvironment(value)])) };
    const transport = new StdioClientTransport({ command: config.command,
      args: config.args?.map(expandEnvironment) ?? [], cwd: config.cwd,
      env, stderr: 'ignore', maxBufferSize: 1_000_000 });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      return { client, tools: tools.map(tool => ({ server: name, name: tool.name,
        description: tool.description ?? '', inputSchema: tool.inputSchema,
        readOnly: tool.annotations?.readOnlyHint === true })) };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }
}

function isServerConfig(value: unknown): value is ServerConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.command === 'string' && item.command.trim().length > 0
    && (item.args === undefined || Array.isArray(item.args) && item.args.every(arg => typeof arg === 'string'))
    && (item.cwd === undefined || typeof item.cwd === 'string')
    && (item.env === undefined || !!item.env && typeof item.env === 'object' && !Array.isArray(item.env)
      && Object.entries(item.env).every(([key, val]) => /^[A-Z_][A-Z0-9_]*$/i.test(key) && typeof val === 'string'));
}

function expandEnvironment(value: string): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_, key: string) => {
    const replacement = process.env[key];
    if (!replacement) throw new Error(`MCP environment variable is missing: ${key}`);
    return replacement;
  });
}
