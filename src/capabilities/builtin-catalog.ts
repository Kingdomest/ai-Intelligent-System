import type { CapabilityPermission } from '../domain/contracts.js';

export interface BuiltinDefinition {
  key: string;
  version: string;
  permissions: CapabilityPermission[];
  inputSchema: unknown;
  code: string;
}

function define(key: string, permissions: CapabilityPermission[], required: string[], properties: Record<string, unknown>, code: string): BuiltinDefinition {
  return {
    key, version: '1.0.0', permissions,
    inputSchema: { type: 'object', required, properties, additionalProperties: false },
    code,
  };
}

const pathProperty = { path: { type: 'string', minLength: 1 } };
const stringArray = { type: 'array', items: { type: 'string' }, maxItems: 100 };
const catalog: Record<string, BuiltinDefinition> = {
  'filesystem.read_text': define('filesystem.read_text', ['filesystem.read'], ['path'], pathProperty,
    'export async function run(input, host) { return { content: await host.fs.readText(input.path) }; }'),
  'filesystem.write_text': define('filesystem.write_text', ['filesystem.write'], ['path', 'content'], { ...pathProperty, content: { type: 'string' } },
    'export async function run(input, host) { return await host.fs.writeText(input.path, input.content); }'),
  'filesystem.mkdir': define('filesystem.mkdir', ['filesystem.write'], ['path'], pathProperty,
    'export async function run(input, host) { return await host.fs.mkdir(input.path); }'),
  'filesystem.remove': define('filesystem.remove', ['filesystem.write'], ['path'], pathProperty,
    'export async function run(input, host) { return await host.fs.remove(input.path); }'),
  'presentation.create': define('presentation.create', ['filesystem.write'], ['path', 'slides'], {
    path: { type: 'string', minLength: 1, maxLength: 4096 },
    slides: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object',
      required: ['title', 'bullets'], additionalProperties: false, properties: {
        title: { type: 'string', minLength: 1, maxLength: 140 },
        bullets: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 240 } },
      } } },
  }, 'export async function run(input, host) { return await host.presentation.create({ path: input.path, slides: input.slides }); }'),
  'process.run': define('process.run', ['process'], ['command', 'args'], { command: { type: 'string', minLength: 1 }, args: stringArray, cwd: { type: 'string' } },
    'export async function run(input, host) { return await host.process.run({ command: input.command, args: input.args, cwd: input.cwd }); }'),
  'process.launch': define('process.launch', ['process'], ['applicationName', 'args'], { applicationName: { type: 'string', minLength: 1 }, args: stringArray },
    'export async function run(input, host) { return await host.process.launch({ executable: input.executable, args: input.args, cwd: input.workspaceRoot }); }'),
  'network.request': define('network.request', ['network'], ['url', 'method'], { url: { type: 'string', format: 'uri' }, method: { type: 'string' }, headers: { type: 'object' }, body: { type: 'string' } },
    'export async function run(input, host) { return await host.network.request({ url: input.url, method: input.method, headers: input.headers, body: input.body }); }'),
  'location.current': define('location.current', ['location'], [], {},
    'export async function run(input, host) { return await host.location.current(); }'),
  'text.count_lines': define('text.count_lines', [], ['text'], {
    text: { type: 'string', maxLength: 100000 },
  }, 'export async function run(input) { if (input.text === "") return { count: 0 }; const lines = input.text.split(/\\r\\n|\\n|\\r/); return { count: lines.length - (lines[lines.length - 1] === "" ? 1 : 0) }; }'),
  'text.replace': define('text.replace', [], ['text', 'search', 'replacement'], {
    text: { type: 'string', maxLength: 40000 },
    search: { type: 'string', minLength: 1, maxLength: 1000 },
    replacement: { type: 'string', maxLength: 1000 },
  }, 'export async function run(input) { if (!input.search) throw new Error("Search text is required."); const parts = input.text.split(input.search); const replacements = parts.length - 1; if (replacements > 1000 || input.text.length + replacements * (input.replacement.length - input.search.length) > 40000) throw new Error("Replacement output exceeds the limit."); return { content: parts.join(input.replacement), replacements }; }'),
  'json.format': define('json.format', [], ['text'], {
    text: { type: 'string', minLength: 1, maxLength: 40000 },
  }, 'export async function run(input) { const content = JSON.stringify(JSON.parse(input.text), null, 2); if (content.length > 40000) throw new Error("Formatted JSON exceeds the limit."); return { content }; }'),
};

export function getBuiltin(key: string): BuiltinDefinition | null {
  return catalog[key] ?? null;
}

export function listBuiltins(): BuiltinDefinition[] {
  return Object.values(catalog);
}
