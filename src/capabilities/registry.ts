import type { EvaluationRecord, CapabilityRecord } from '../domain/contracts.js';
import { normalizeIntent, SqliteStore } from '../storage/sqlite-store.js';
import type { ToolCandidate } from '../agents/agent-runner.js';
import { PolicyValidator } from './policy-validator.js';
import { SandboxRunner } from './sandbox-runner.js';
import type { HostCall, HostCallResult, HostExecutionContext } from '../permissions/operation-protocol.js';
import { getBuiltin, listBuiltins } from './builtin-catalog.js';

export interface CapabilityInvocationContext {
  taskId: string;
  mode: HostExecutionContext['mode'];
  workspaceRoot: string;
  stepId: string;
  operationSequence: number;
  capabilityVersion: string;
  hostCall: (call: HostCall, context: HostExecutionContext) => Promise<HostCallResult>;
}

export class CapabilityRegistry {
  private readonly taskCapabilities = new Map<string, Map<string, CapabilityRecord>>();

  constructor(
    private readonly store: SqliteStore,
    private readonly sandbox: SandboxRunner,
    private readonly policy = new PolicyValidator(),
  ) {}

  installBuiltins(): void {
    for (const builtin of listBuiltins()) {
      if (this.store.getCapabilityVersion(builtin.key, builtin.version)) continue;
      this.store.saveCapability({
        id: builtin.key,
        version: builtin.version,
        status: builtin.permissions.length ? 'canary' : 'active',
        normalizedIntent: normalizeIntent(builtin.key),
        manifest: {
          id: builtin.key, capabilityKey: builtin.key, version: builtin.version,
          kind: 'tool', name: builtin.key, description: `Built-in ${builtin.key}`,
          inputSchema: builtin.inputSchema, outputSchema: {}, entrypoint: 'tool.mjs',
          runtime: 'node-sandbox-v1', permissions: builtin.permissions, riskLevel: 'medium',
          tests: ['parameterized input contract'],
          provenance: { sourceTaskId: 'builtin', generatedAt: new Date().toISOString() },
        },
        code: builtin.code,
        evaluation: { targetId: builtin.key, targetVersion: builtin.version, verdict: 'pass', score: 1,
          failures: [], recommendations: [], evaluatorRunId: 'builtin-maintained' },
        createdAt: new Date().toISOString(),
      });
    }
  }

  findUsableByKey(key: string, taskId?: string): CapabilityRecord | null {
    const temporary = taskId && [...(this.taskCapabilities.get(taskId)?.values() ?? [])].reverse()
      .find((record) => record.manifest.capabilityKey === key && (record.status === 'active' || record.status === 'canary'));
    return temporary || this.maintained(this.store.findUsableByKey(key));
  }

  registerTemporary(candidate: ToolCandidate, evaluation: EvaluationRecord, sourceTaskId: string): CapabilityRecord {
    const policyResult = this.policy.validate(candidate);
    if (!policyResult.allowed) {
      throw new Error(`Capability rejected by policy: ${policyResult.reasons.join('; ')}`);
    }
    if (evaluation.verdict !== 'pass') {
      throw new Error('Only passing capabilities can be registered.');
    }

    const taskTools = this.taskCapabilities.get(sourceTaskId) ?? new Map<string, CapabilityRecord>();
    const existing = taskTools.get(`${candidate.id}@${candidate.version}`);
    if (existing) {
      if (existing.code === candidate.code && (existing.status === 'active' || existing.status === 'canary')
        && JSON.stringify(existing.manifest.permissions) === JSON.stringify(candidate.permissions)) return existing;
      throw new Error(`Capability version ${candidate.id}@${candidate.version} already exists; generate a new version.`);
    }

    if (getBuiltin(candidate.id)) throw new Error('Generated tools cannot replace a maintained built-in.');
    const record: CapabilityRecord = {
      id: candidate.id,
      version: candidate.version,
      status: candidate.permissions.length === 0 ? 'active' : 'canary',
      normalizedIntent: normalizeIntent(candidate.intent),
      manifest: {
        id: candidate.id,
        capabilityKey: candidate.capabilityKey ?? candidate.id,
        version: candidate.version,
        kind: 'tool',
        name: candidate.name,
        description: candidate.description,
        inputSchema: candidate.inputSchema,
        outputSchema: candidate.outputSchema,
        entrypoint: candidate.entrypoint,
        runtime: candidate.runtime,
        permissions: candidate.permissions,
        riskLevel: candidate.riskLevel,
        tests: candidate.tests,
        provenance: { sourceTaskId, generatedAt: new Date().toISOString() },
      },
      code: candidate.code,
      evaluation: { ...evaluation, targetVersion: candidate.version },
      createdAt: new Date().toISOString(),
    };
    taskTools.set(`${candidate.id}@${candidate.version}`, record);
    this.taskCapabilities.set(sourceTaskId, taskTools);
    return record;
  }

  getVersion(name: string, version: string, taskId?: string): CapabilityRecord | null {
    const temporary = taskId ? this.taskCapabilities.get(taskId)?.get(`${name}@${version}`) : undefined;
    return temporary ?? this.maintained(this.store.getCapabilityVersion(name, version));
  }

  releaseTask(taskId: string): void {
    this.taskCapabilities.delete(taskId);
  }

  async invoke(name: string, input: unknown, invocation?: CapabilityInvocationContext): Promise<unknown> {
    const capability = invocation
      ? this.getVersion(name, invocation.capabilityVersion, invocation.taskId)
      : this.getActive(name);
    if (!capability) throw new Error(`Active capability not found: ${name}`);
    if (capability.status !== 'active' && capability.status !== 'canary') {
      throw new Error(`Capability version is quarantined: ${name}@${capability.version}`);
    }
    if (!invocation) return (await this.sandbox.run(capability.code, input, { mode: 'dry-run' })).output;
    let operationSequence = invocation.operationSequence;
    return (await this.sandbox.run(capability.code, input, {
      mode: 'live',
      hostCall: (call) => invocation.hostCall(call, {
        taskId: invocation.taskId,
        mode: invocation.mode,
        workspaceRoot: invocation.workspaceRoot,
        capabilityPermissions: capability.manifest.permissions,
        capabilityVersion: capability.version,
        stepId: invocation.stepId,
        operationSequence: operationSequence++,
        dryRun: false,
      }),
    })).output;
  }

  findByIntent(intent: string): CapabilityRecord | null {
    return this.maintained(this.store.findByIntent(intent));
  }

  getActive(name: string): CapabilityRecord | null {
    return this.maintained(this.store.getActive(name));
  }

  findUsableByIntent(intent: string, taskId?: string): CapabilityRecord | null {
    const temporary = taskId && [...(this.taskCapabilities.get(taskId)?.values() ?? [])].reverse()
      .find((record) => record.normalizedIntent === normalizeIntent(intent)
        && (record.status === 'active' || record.status === 'canary'));
    return temporary || this.maintained(this.store.findUsableByIntent(intent));
  }

  getUsable(name: string, taskId?: string): CapabilityRecord | null {
    const temporary = taskId && [...(this.taskCapabilities.get(taskId)?.values() ?? [])].reverse()
      .find((record) => record.id === name && (record.status === 'active' || record.status === 'canary'));
    return temporary || this.maintained(this.store.getUsable(name));
  }

  promote(name: string, version: string, taskId?: string): CapabilityRecord {
    const temporary = taskId && this.taskCapabilities.get(taskId)?.get(`${name}@${version}`);
    if (temporary) {
      const active = { ...temporary, status: 'active' as const };
      this.taskCapabilities.get(taskId)!.set(`${name}@${version}`, active);
      return active;
    }
    return this.store.promoteCapability(name, version);
  }

  deprecate(name: string, version: string, taskId?: string): void {
    const temporary = taskId && this.taskCapabilities.get(taskId)?.get(`${name}@${version}`);
    if (temporary) {
      this.taskCapabilities.get(taskId)!.set(`${name}@${version}`, { ...temporary, status: 'deprecated' });
      return;
    }
    this.store.deprecateCapability(name, version);
  }

  async listTools(): Promise<Array<{ name: string; description: string; inputSchema: unknown }>> {
    return this.store.listActiveCapabilities().filter((capability) => this.maintained(capability)).map((capability) => ({
      name: capability.manifest.name,
      description: capability.manifest.description,
      inputSchema: capability.manifest.inputSchema,
    }));
  }

  async callTool(name: string, arguments_: unknown, invocation?: CapabilityInvocationContext): Promise<unknown> {
    return this.invoke(name, arguments_, invocation);
  }

  private maintained(record: CapabilityRecord | null): CapabilityRecord | null {
    return record?.manifest.provenance.sourceTaskId === 'builtin' ? record : null;
  }
}
