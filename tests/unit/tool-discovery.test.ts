import { describe, expect, it } from 'vitest';
import { ToolDiscovery } from '../../src/capabilities/tool-discovery.js';

describe('ToolDiscovery', () => {
  const discovery = new ToolDiscovery({ listTools: async () => [
    { server: 'filesystem', name: 'search_files', description: 'Recursively search files by name',
      inputSchema: { type: 'object', required: ['path', 'pattern'], properties: {
        path: { type: 'string' }, pattern: { type: 'string' },
      } }, readOnly: true },
    { server: 'memory', name: 'search_nodes', description: 'Search the knowledge graph',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, readOnly: true },
  ] });

  it('lists builtins and live MCP tools with schemas', async () => {
    const tools = await discovery.list();
    expect(tools).toContainEqual(expect.objectContaining({ id: 'builtin:filesystem.read_text', source: 'builtin' }));
    expect(tools).toContainEqual(expect.objectContaining({ id: 'mcp:filesystem/search_files', source: 'mcp',
      readOnly: true, inputSchema: expect.objectContaining({ required: ['path', 'pattern'] }) }));
  });

  it('searches a Chinese task description and ranks relevant tools', async () => {
    const tools = await discovery.search('搜索文件');
    expect(tools[0]?.id).toBe('mcp:filesystem/search_files');
    expect(tools.every(tool => (tool.score ?? 0) > 0)).toBe(true);
  });

  it('returns no candidate for an unmatched capability and bounds the query', async () => {
    expect(await discovery.search('factorial')).toEqual([]);
    await expect(discovery.search('x'.repeat(501))).rejects.toThrow(/500/);
    await expect(discovery.search('file', 31)).rejects.toThrow(/30/);
  });
});
