import { z } from 'zod';
import path from 'node:path';
import { presentationInputSchema } from '../presentations/render.js';

export interface ValidatedPlanStep {
  id: string;
  capabilityKey: string;
  description: string;
  dependsOn: string[];
  input: Record<string, unknown>;
  /** Runtime-only original arguments retained when a generated file becomes concrete content. */
  assignmentInput?: Record<string, unknown>;
  acceptanceCriteria?: string[];
  parameterDescriptions?: Record<string, string>;
  /** Runtime-only schema of the MCP tool chosen after planning. */
  mcpInputSchema?: unknown;
}

export interface ValidatedPlannerDecision {
  status: 'ready' | 'answer' | 'needs_user_input';
  answer?: string;
  /** Greeting/small-talk request: reply only needs to be courteous. */
  casual?: boolean;
  intent?: string;
  inputRequest?: {
    taskId: string;
    question: string;
    requiredFields: Array<{ name: string; reason: string; sensitive: boolean }>;
    resumeToken: string;
    options?: Array<{ label: string; value: string; description?: string }>;
  };
  requiredCapabilities?: Array<{ name: string; purpose: string; riskLevel: 'low' | 'medium' | 'high' }>;
  acceptanceCriteria: string[];
  steps: ValidatedPlanStep[];
}

const nonEmpty = z.string().trim().min(1);
const fsPath = z.object({ path: nonEmpty }).strict();
const writeTextInput = z.union([
  z.object({ path: nonEmpty, content: z.string() }).strict(),
  z.object({ path: nonEmpty, generation: z.object({ instruction: nonEmpty.max(2_000) }).strict() }).strict(),
]);
const networkUrl = z.url().refine(value => {
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* Keep malformed escapes for URL/host validation. */ }
  return !/\bYOUR[_-](?:API[_-]?KEY|TOKEN|KEY)\b|<[^<>]+>|\{[a-z_][a-z0-9_]*\}/i.test(decoded);
}, 'URL contains a placeholder; use concrete parameters and a public endpoint or request the missing credentials.');
const inputSchemas: Record<string, z.ZodType<Record<string, unknown>>> = {
  'filesystem.read_text': fsPath,
  'filesystem.write_text': writeTextInput,
  'filesystem.mkdir': fsPath,
  'filesystem.remove': fsPath,
  'presentation.create': presentationInputSchema,
  'process.launch': z.object({ applicationName: nonEmpty, args: z.array(z.string()).max(100).default([]) }).strict(),
  'process.run': z.object({ command: nonEmpty, args: z.array(z.string()).max(100), cwd: nonEmpty.optional() }).strict(),
  'network.request': z.object({ url: networkUrl, method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']), headers: z.record(z.string(), z.string()).optional(), body: z.string().optional() }).strict(),
  'location.current': z.object({}).strict(),
  'mcp.call': z.object({ server: nonEmpty, tool: nonEmpty,
    dynamicArgs: z.record(z.string(), z.unknown()).default({}) }).strict(),
  'text.count_lines': z.object({ text: z.string().max(100_000) }).strict(),
  'text.replace': z.object({ text: z.string().max(40_000), search: nonEmpty.max(1_000), replacement: z.string().max(1_000) }).strict(),
  'json.format': z.object({ text: nonEmpty.max(40_000) }).strict(),
};

const requestSchema = z.object({
  taskId: z.string(), question: nonEmpty,
  requiredFields: z.array(z.object({ name: nonEmpty, reason: nonEmpty, sensitive: z.boolean() })),
  resumeToken: z.string(),
  options: z.array(z.object({ label: nonEmpty.max(80), value: nonEmpty.max(200),
    description: z.string().max(160).optional() })).max(3).optional(),
});
const requiredCapabilitySchema = z.object({ name: nonEmpty, purpose: nonEmpty, riskLevel: z.enum(['low', 'medium', 'high']) });
export const plannerStepSchema = z.object({
  id: nonEmpty.max(100),
  capabilityKey: nonEmpty,
  description: nonEmpty,
  dependsOn: z.array(nonEmpty.max(100)),
  input: z.record(z.string(), z.unknown()),
  assignmentInput: z.record(z.string(), z.unknown()).optional(),
  mcpInputSchema: z.unknown().optional(),
  acceptanceCriteria: z.array(nonEmpty).min(1).optional(),
  parameterDescriptions: z.record(z.string(), nonEmpty).optional(),
});
const plannerBaseSchema = z.object({
  intent: z.string().optional(),
  requiredCapabilities: z.array(requiredCapabilitySchema).optional(),
  acceptanceCriteria: z.array(z.string()),
});

export const plannerDecisionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), ...plannerBaseSchema.shape, steps: z.array(plannerStepSchema).min(1) }),
  z.object({ status: z.literal('answer'), ...plannerBaseSchema.shape, answer: nonEmpty, steps: z.array(plannerStepSchema).max(0),
    /** Greeting/small-talk requests: the answer only needs to be courteous, not factual. */
    casual: z.boolean().optional() }),
  z.object({ status: z.literal('needs_user_input'), ...plannerBaseSchema.shape, inputRequest: requestSchema, steps: z.array(plannerStepSchema).max(0) }),
]);

export class PlannerContractError extends Error {}

export function parsePlannerDecision(raw: unknown): ValidatedPlannerDecision {
  const normalized = unwrapTypedValues(raw);
  let decision: z.infer<typeof plannerDecisionSchema>;
  try {
    decision = plannerDecisionSchema.parse(normalized);
  } catch (error) {
    throw fieldError(error);
  }
  if (decision.status === 'needs_user_input' && decision.inputRequest.options
    && decision.inputRequest.options.length !== 0 && decision.inputRequest.options.length !== 3) {
    throw new PlannerContractError('inputRequest.options: provide exactly three distinct choices or an empty list.');
  }
  if (decision.status === 'needs_user_input' && decision.inputRequest.options
    && new Set(decision.inputRequest.options.map(option => option.value)).size !== decision.inputRequest.options.length) {
    throw new PlannerContractError('inputRequest.options: choices must have distinct values.');
  }
  const steps = decision.steps.map((step, index) => {
    const schema = inputSchemas[step.capabilityKey];
    if (!schema && !/^dynamic\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(step.capabilityKey)) {
      throw new PlannerContractError(`steps[${index}].capabilityKey: unknown capability key.`);
    }
    let input = step.input;
    if (schema) {
      try {
        input = schema.parse(normalizeKnownPlannerInput(step.capabilityKey, step.input));
      } catch (error) {
        throw fieldError(error, `steps[${index}].input`);
      }
    } else {
      input = flattenDynamicArgs(input);
    }
    return { ...step, input };
  });
  validateStepGraph(steps);
  validateResourceKinds(steps);
  validateObservedDataFlow(steps);
  return { ...decision, steps };
}

const observedDataKeys = new Set(['network.request', 'filesystem.read_text', 'location.current', 'process.run',
  'text.count_lines', 'text.replace', 'json.format', 'mcp.call']);

/** A file that depends on live observations must be written from those observations at execution time. */
export function hasObservedDataDependency(steps: Array<Pick<ValidatedPlanStep, 'id' | 'dependsOn'>
  & { capabilityKey?: string }>, stepId: string): boolean {
  const byId = new Map(steps.map(step => [step.id, step]));
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const step = byId.get(id);
    return !!step && (observedDataKeys.has(step.capabilityKey ?? '') || step.capabilityKey?.startsWith('dynamic.') === true
      || step.dependsOn.some(dependency => visit(dependency)));
  };
  return byId.get(stepId)?.dependsOn.some(dependency => visit(dependency)) ?? false;
}

function validateObservedDataFlow(steps: ValidatedPlanStep[]): void {
  for (const step of steps) {
    if (step.capabilityKey !== 'filesystem.write_text' || !('content' in step.input)) continue;
    if (hasObservedDataDependency(steps, step.id)) {
      throw new PlannerContractError(`step ${step.id} writes static content before using its observed dependency results; use generation.instruction.`);
    }
  }
}

type ResourceKind = 'file' | 'directory';

/** Planner-time resource typing: a file reader cannot consume a directory. */
function validateResourceKinds(steps: ValidatedPlanStep[]): void {
  const producedKinds: Record<string, ResourceKind> = {
    'filesystem.mkdir': 'directory',
    'filesystem.write_text': 'file',
    'presentation.create': 'file',
  };
  const requiredKinds: Record<string, ResourceKind> = {
    'filesystem.read_text': 'file',
    'filesystem.write_text': 'file',
    'presentation.create': 'file',
    'filesystem.mkdir': 'directory',
  };
  const resources = new Map<string, { kind: ResourceKind; stepId: string }>();
  const identityOf = (target: string): string => path.win32.isAbsolute(target)
    ? `win:${path.win32.normalize(target).toLowerCase()}`
    : `posix:${path.posix.normalize(target)}`;
  for (const step of steps) {
    const target = step.input.path;
    if (typeof target !== 'string') continue;
    const identity = identityOf(target);
    const produced = producedKinds[step.capabilityKey];
    if (!produced) continue;
    const known = resources.get(identity);
    if (known && known.kind !== produced) {
      throw new PlannerContractError(`steps ${known.stepId} and ${step.id} assign incompatible resource kinds to the same path.`);
    }
    resources.set(identity, { kind: produced, stepId: step.id });
  }
  for (const step of steps) {
    const target = step.input.path;
    if (typeof target !== 'string') continue;
    const expected = requiredKinds[step.capabilityKey];
    const known = resources.get(identityOf(target));
    if (expected && known && expected !== known.kind) {
      throw new PlannerContractError(`step ${step.id} uses ${step.capabilityKey} on a ${known.kind} target from step ${known.stepId}; `
        + `it requires a ${expected}. Do not add a text-read step to verify a directory: live host tests verify filesystem effects.`);
    }
  }
}

/** Apply the same input contract to a local repair as to an initial plan. */
export function validateStepInput(capabilityKey: string, input: Record<string, unknown>): Record<string, unknown> {
  const schema = inputSchemas[capabilityKey];
  if (!schema) {
    if (!/^dynamic\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(capabilityKey)) {
      throw new PlannerContractError('Unknown capability key in step repair.');
    }
    return flattenDynamicArgs(input);
  }
  // The application resolver adds these trusted fields after planning. A repair
  // may change ordinary planner arguments, but cannot invent a new executable.
  if (capabilityKey === 'process.launch') {
    const { executable, applicationId, ...plannedInput } = input;
    return { ...schema.parse(normalizeKnownPlannerInput(capabilityKey, plannedInput)),
      ...(typeof executable === 'string' ? { executable } : {}),
      ...(typeof applicationId === 'string' ? { applicationId } : {}) };
  }
  return schema.parse(normalizeKnownPlannerInput(capabilityKey, input));
}

/** Correct only unambiguous model-shape mistakes; never invent operation arguments. */
function normalizeKnownPlannerInput(capabilityKey: string, input: Record<string, unknown>): Record<string, unknown> {
  if ((capabilityKey === 'process.launch' || capabilityKey === 'process.run')
    && input.args === undefined && input.dynamicArgs !== undefined) {
    let candidate: unknown = input.dynamicArgs;
    for (let depth = 0; depth < 3 && candidate && typeof candidate === 'object'
      && !Array.isArray(candidate); depth += 1) {
      const wrapper = candidate as Record<string, unknown>;
      const keys = Object.keys(wrapper);
      if (keys.some(key => !['args', 'items', 'length'].includes(key))
        || (keys.includes('args') === keys.includes('items'))
        || (keys.includes('length') && (!Number.isInteger(wrapper.length) || Number(wrapper.length) < 0))) break;
      candidate = wrapper.args ?? wrapper.items;
    }
    if (Array.isArray(candidate) && candidate.length <= 100
      && candidate.every(item => typeof item === 'string')
      && Object.keys(input).every(key => ['command', 'cwd', 'applicationName', 'dynamicArgs', 'name', 'instruction'].includes(key))) {
      const { dynamicArgs: _dynamicArgs, name: _name, instruction: _instruction, ...operation } = input;
      return { ...operation, args: candidate };
    }
  }
  if ((capabilityKey === 'process.launch' || capabilityKey === 'process.run')
    && input.args && typeof input.args === 'object' && !Array.isArray(input.args)
    && Object.keys(input.args).length === 0) {
    return { ...input, args: [] };
  }
  if (capabilityKey === 'network.request') {
    // The host owns request deadlines and retries. These planner-supplied
    // transport hints cannot affect the request and must not invalidate a plan.
    const { timeout: _timeout, timeoutMs: _timeoutMs, retries: _retries, ...operation } = input;
    return operation;
  }
  return input;
}

function unwrapTypedValues(value: unknown, depth = 0): unknown {
  if (depth > 8) throw new PlannerContractError('Planner input nesting exceeds limit.');
  if (Array.isArray(value)) return value.map((item) => unwrapTypedValues(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 2 && typeof record.type === 'string' && 'value' in record) {
    const matches = (record.type === 'string' && typeof record.value === 'string')
      || (record.type === 'array' && Array.isArray(record.value))
      || (record.type === 'object' && !!record.value && typeof record.value === 'object' && !Array.isArray(record.value))
      || (record.type === 'number' && typeof record.value === 'number')
      || (record.type === 'boolean' && typeof record.value === 'boolean');
    if (matches) return unwrapTypedValues(record.value, depth + 1);
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, unwrapTypedValues(item, depth + 1)]));
}

function flattenDynamicArgs(input: Record<string, unknown>): Record<string, unknown> {
  const nested = input.dynamicArgs;
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return input;
  const { dynamicArgs: _dynamicArgs, ...ordinaryInput } = input;
  return { ...(nested as Record<string, unknown>), ...ordinaryInput };
}

export function fieldError(error: unknown, prefix = ''): Error {
  if (!(error instanceof z.ZodError)) return error instanceof Error ? error : new Error(String(error));
  const issue = error.issues[0];
  const path = issue?.path.reduce<string>((current, part) => (
    typeof part === 'number' ? `${current}[${part}]` : `${current}${current ? '.' : ''}${String(part)}`
  ), prefix) ?? prefix;
  return new PlannerContractError(`${path || 'planner'}: ${issue?.message ?? 'invalid input'}`);
}

function validateStepGraph(steps: ValidatedPlanStep[]): void {
  const byId = new Map<string, ValidatedPlanStep>();
  for (const step of steps) {
    if (byId.has(step.id)) throw new PlannerContractError(`duplicate step id: ${step.id}`);
    byId.set(step.id, step);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new PlannerContractError(`dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dependency)) throw new PlannerContractError(`unknown dependency ${dependency} for ${id}`);
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of steps) visit(step.id);
}
