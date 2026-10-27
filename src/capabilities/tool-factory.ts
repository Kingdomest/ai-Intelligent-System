import type { AgentRunner, ImplementerInput, ToolCandidate } from '../agents/agent-runner.js';
import { PolicyValidator } from './policy-validator.js';

export class ToolFactory {
  constructor(
    private readonly agents: Pick<AgentRunner, 'runImplementer'>,
    private readonly policy = new PolicyValidator(),
  ) {}

  async build(input: ImplementerInput): Promise<ToolCandidate> {
    const result = await this.agents.runImplementer(input);
    const candidate = {
      ...result.candidate,
      code: normalizeEntrypoint(result.candidate.code),
    };
    if (input.capabilityKey) {
      if (candidate.capabilityKey && candidate.capabilityKey !== input.capabilityKey) {
        throw new Error(`candidate.capabilityKey does not match the requested target-independent key ${input.capabilityKey}.`);
      }
      candidate.capabilityKey = input.capabilityKey;
      candidate.id = input.capabilityKey;
    }
    const policyResult = this.policy.validate(candidate);
    if (!policyResult.allowed) {
      throw new Error(`Generated tool rejected by policy: ${policyResult.reasons.join('; ')}`);
    }
    return candidate;
  }
}

function normalizeEntrypoint(code: string): string {
  if (/export\s+async\s+function\s+run\s*\(/.test(code)) return code;
  if (/^\s*async\s+function\s+run\s*\(/m.test(code)) return code.replace(/^(\s*)async\s+function\s+run/m, '$1export async function run');
  return code;
}
