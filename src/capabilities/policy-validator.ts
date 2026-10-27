import type { ToolCandidate } from '../agents/agent-runner.js';

export interface PolicyResult {
  allowed: boolean;
  reasons: string[];
}

const forbiddenPatterns: Array<[RegExp, string]> = [
  [/\bimport\b|\brequire\s*\(/i, 'imports and require are not allowed'],
  [/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/i, 'direct network APIs are not allowed; use host.network'],
  [/\beval\s*\(|\bFunction\s*\(|\bglobalThis\b|\b__proto__\b|\bconstructor\b/i, 'dynamic code evaluation and sandbox escape primitives are not allowed'],
  [/\b(?:readFile|readFileSync|writeFile|writeFileSync|appendFile|unlink|rmSync|mkdirSync|createWriteStream)\b/i, 'direct filesystem APIs are not allowed; use host.fs'],
];

const hostPermissionPatterns: Array<[RegExp, ToolCandidate['permissions'][number], string]> = [
  [/\.fs\s*\.\s*readText\s*\(/i, 'filesystem.read', 'host.fs.readText'],
  [/\.fs\s*\.\s*(?:writeText|mkdir|remove)\s*\(/i, 'filesystem.write', 'host.fs write methods'],
  [/\.network\s*\.\s*request\s*\(/i, 'network', 'host.network.request'],
  [/\.process\s*\.\s*run\s*\(/i, 'process', 'host.process.run'],
  [/\.process\s*\.\s*launch\s*\(/i, 'process', 'host.process.launch'],
  [/\.location\s*\.\s*current\s*\(/i, 'location', 'host.location.current'],
];

export class PolicyValidator {
  validate(candidate: ToolCandidate): PolicyResult {
    const reasons: string[] = [];

    if (candidate.runtime !== 'node-sandbox-v1') reasons.push('runtime must be node-sandbox-v1');
    if (!/export\s+async\s+function\s+run\s*\(/.test(candidate.code)) {
      reasons.push('code must export an async run function');
    }

    for (const [pattern, permission, methodName] of hostPermissionPatterns) {
      if (pattern.test(candidate.code) && !candidate.permissions.includes(permission)) {
        reasons.push(`${methodName} requires declared permission ${permission}`);
      }
    }

    for (const [pattern, reason] of forbiddenPatterns) {
      if (pattern.test(candidate.code)) reasons.push(reason);
    }

    return { allowed: reasons.length === 0, reasons };
  }
}
