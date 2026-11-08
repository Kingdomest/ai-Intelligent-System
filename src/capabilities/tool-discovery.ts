import { listBuiltins } from './builtin-catalog.js';
import type { McpService } from '../mcp/service.js';

export interface ToolOption {
  id: string;
  source: 'builtin' | 'mcp';
  name: string;
  server?: string;
  description: string;
  inputSchema: unknown;
  readOnly: boolean;
  score?: number;
}

const descriptions: Record<string, string> = {
  'filesystem.read_text': 'Read a text file by path',
  'filesystem.write_text': 'Create or overwrite a text file by path',
  'filesystem.mkdir': 'Create a directory by path',
  'filesystem.remove': 'Remove a file or directory by path',
  'presentation.create': 'Create a PowerPoint presentation from slides',
  'process.run': 'Run a bounded command with explicit arguments',
  'process.launch': 'Launch a desktop application',
  'network.request': 'Make an HTTP network request',
  'location.current': 'Get the current device location',
  'text.count_lines': 'Count lines in supplied text',
  'text.replace': 'Replace occurrences of a string in supplied text',
  'json.format': 'Parse and format JSON text',
};

const chineseTerms: Array<[RegExp, string[]]> = [
  [/文件|文本/, ['file', 'text']], [/目录|文件夹/, ['directory', 'folder']],
  [/搜索|查找|查询|检索/, ['search', 'find']], [/读取|阅读/, ['read']],
  [/写入|保存|创建/, ['write', 'create']], [/删除/, ['delete', 'remove']],
  [/记忆|知识图谱/, ['memory', 'graph']], [/实体|节点/, ['entity', 'node']],
  [/关系/, ['relation']], [/仓库|代码库/, ['repository', 'repo']],
  [/分支/, ['branch']], [/提交/, ['commit']], [/问题|议题/, ['issue']],
  [/拉取请求|合并请求/, ['pull', 'request']], [/网页|网络/, ['web', 'network']],
  [/统计|计数/, ['count']], [/替换/, ['replace']], [/格式化/, ['format']],
];
const stopwords = new Set(['a', 'an', 'and', 'as', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'use', 'using', 'with', 'tool']);

/** Lists all host-approved tool definitions and ranks them without executing any tool. */
export class ToolDiscovery {
  constructor(private readonly mcp?: Pick<McpService, 'listTools'>) {}

  async list(): Promise<ToolOption[]> {
    const builtins: ToolOption[] = listBuiltins().filter(item => item.key !== 'mcp.call').map(item => ({
      id: `builtin:${item.key}`, source: 'builtin', name: item.key,
      description: descriptions[item.key] ?? item.key, inputSchema: item.inputSchema,
      readOnly: item.permissions.length === 0 || item.permissions.every(permission => permission === 'filesystem.read'),
    }));
    const mcp = this.mcp ? await this.mcp.listTools() : [];
    return [...builtins, ...mcp.map(item => ({ id: `mcp:${item.server}/${item.name}`,
      source: 'mcp' as const, name: item.name, server: item.server,
      description: item.description, inputSchema: item.inputSchema, readOnly: item.readOnly }))];
  }

  async search(query: string, limit = 8): Promise<ToolOption[]> {
    if (!query.trim() || query.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 30) {
      throw new Error('Tool search requires a query up to 500 characters and a limit from 1 to 30.');
    }
    const terms = searchTerms(query);
    if (!terms.length) return [];
    return (await this.list()).map(item => ({ ...item, score: score(item, terms) }))
      .filter(item => item.score > 0)
      .sort((left, right) => right.score! - left.score! || left.id.localeCompare(right.id))
      .slice(0, limit);
  }
}

function searchTerms(query: string): string[] {
  const normalized = query.toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2');
  const english = normalized.match(/[a-z][a-z0-9]*/g) ?? [];
  const chinese = chineseTerms.flatMap(([pattern, terms]) => pattern.test(query) ? terms : []);
  return [...new Set([...english, ...chinese].filter(term => term.length > 1 && !stopwords.has(term)))].slice(0, 20);
}

function score(item: ToolOption, terms: string[]): number {
  const name = item.name.toLowerCase().replace(/[._-]/g, ' ');
  const server = item.server?.toLowerCase() ?? '';
  const description = item.description.toLowerCase();
  const fields = item.inputSchema && typeof item.inputSchema === 'object'
    ? Object.keys((item.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}).join(' ').toLowerCase() : '';
  return terms.reduce((total, term) => total + (name.includes(term) ? 5 : 0)
    + (server.includes(term) ? 2 : 0) + (description.includes(term) ? 1 : 0)
    + (fields.includes(term) ? 1 : 0), 0);
}
