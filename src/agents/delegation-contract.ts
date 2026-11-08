import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CollaborativeStep, StepObservation } from '../runtime/task-collaboration.js';

const nonEmpty = z.string().trim().min(1);
const parameterSchema = z.strictObject({
  name: nonEmpty,
  type: nonEmpty,
  required: z.boolean(),
  description: nonEmpty,
});

export const stepAssignmentSchema = z.strictObject({
  kind: z.literal('step.assignment'),
  contractVersion: z.literal(1),
  planVersion: nonEmpty,
  stepId: nonEmpty.max(100),
  objective: nonEmpty,
  capabilityKey: nonEmpty,
  dependsOn: z.array(nonEmpty.max(100)),
  input: z.record(z.string(), z.unknown()),
  parameters: z.array(parameterSchema),
  acceptanceCriteria: z.array(nonEmpty).min(1),
  outputSchema: z.unknown(),
});

export const stepResultSchema = z.strictObject({
  kind: z.literal('step.result'),
  contractVersion: z.literal(1),
  planVersion: nonEmpty,
  stepId: nonEmpty.max(100),
  observedAt: z.string().datetime(),
  status: z.literal('completed'),
  output: z.unknown(),
});

export type StepAssignmentContract = z.infer<typeof stepAssignmentSchema>;
export type StepResultContract = z.infer<typeof stepResultSchema>;

const descriptions: Record<string, Record<string, string>> = {
  'filesystem.read_text': { path: 'Absolute path of the file to read.' },
  'filesystem.write_text': { path: 'Absolute path of the target file.', content: 'Exact text to write to the file.',
    generation: 'Instructions for generating the file content after dependencies are available.' },
  'filesystem.mkdir': { path: 'Absolute path of the directory to create.' },
  'filesystem.remove': { path: 'Absolute path of the file or directory to remove.' },
  'presentation.create': { path: 'Absolute path of the presentation file.', slides: 'Ordered slide titles and bullet content.' },
  'process.launch': { applicationName: 'Application name supplied by the user.', args: 'Arguments passed to the launched application.' },
  'process.run': { command: 'Executable command.', args: 'Arguments passed to the command.', cwd: 'Working directory for the command.' },
  'network.request': { url: 'Complete request URL.', method: 'HTTP method.', headers: 'HTTP request headers.', body: 'HTTP request body.' },
  'mcp.call': { server: 'Configured MCP server name.', tool: 'Tool name on that server.', dynamicArgs: 'Arguments for the selected MCP tool.' },
  'text.count_lines': { text: 'Text whose lines are counted.' },
  'text.replace': { text: 'Source text.', search: 'Literal text to find.', replacement: 'Text substituted for each match.' },
  'json.format': { text: 'JSON text to parse and format.' },
};

const builtinOutputs: Record<string, unknown> = {
  'filesystem.read_text': { type: 'object', required: ['content'], properties: { content: { type: 'string' } } },
  'text.count_lines': { type: 'object', required: ['count'], properties: { count: { type: 'number' } } },
  'text.replace': { type: 'object', required: ['content', 'replacements'], properties: {
    content: { type: 'string' }, replacements: { type: 'number' },
  } },
  'json.format': { type: 'object', required: ['content'], properties: { content: { type: 'string' } } },
  'filesystem.write_text': { type: 'object', required: ['path', 'bytesWritten'], properties: {
    path: { type: 'string' }, bytesWritten: { type: 'number' },
  } },
  'filesystem.mkdir': { type: 'object', required: ['path', 'created'], properties: {
    path: { type: 'string' }, created: { type: 'boolean' },
  } },
  'filesystem.remove': { type: 'object', required: ['path', 'removed'], properties: {
    path: { type: 'string' }, removed: { type: 'boolean' },
  } },
  'presentation.create': { type: 'object', required: ['path', 'bytesWritten', 'slideCount', 'sha256'], properties: {
    path: { type: 'string' }, bytesWritten: { type: 'number' }, slideCount: { type: 'number' },
    sha256: { type: 'string' },
  } },
  'process.run': { anyOf: [
    { type: 'object', required: ['exitCode', 'stdout', 'stderr'], properties: {
      exitCode: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      stdout: { type: 'string' }, stderr: { type: 'string' },
    } },
    { type: 'object', required: ['repositoryUrl', 'path', 'alreadyPresent', 'source', 'gitHistory'], properties: {
      repositoryUrl: { type: 'string' }, path: { type: 'string' },
      alreadyPresent: { type: 'boolean' }, source: { type: 'string' }, gitHistory: { type: 'boolean' },
    } },
  ] },
  'process.launch': { type: 'object', required: ['started', 'pid'], properties: {
    started: { type: 'boolean' }, pid: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
  } },
  'network.request': { type: 'object', required: ['status', 'body'], properties: {
    status: { type: 'number' }, body: { type: 'string' }, ok: { type: 'boolean' },
  } },
  'location.current': { type: 'object', required: ['supported'], properties: {
    supported: { type: 'boolean' }, latitude: { type: 'number' }, longitude: { type: 'number' },
    reason: { type: 'string' },
  } },
  'mcp.call': { type: 'object', required: ['server', 'tool', 'content'], properties: {
    server: { type: 'string' }, tool: { type: 'string' }, content: { type: 'array' },
  } },
};

export function planVersion(steps: CollaborativeStep[], criteria: string[],
  schemas: Record<string, { inputSchema?: unknown; outputSchema?: unknown; version?: string }> = {}): string {
  return createHash('sha256').update(JSON.stringify({ steps: steps.map(step => ({
    id: step.id, description: step.description,
    capabilityKey: step.assignmentCapabilityKey ?? step.capabilityKey,
    dependsOn: step.dependsOn, input: step.assignmentInput ?? step.input ?? {},
    acceptanceCriteria: step.acceptanceCriteria ?? [],
    parameterDescriptions: step.parameterDescriptions ?? {},
    mcpInputSchema: step.mcpInputSchema,
  })), criteria, schemas })).digest('hex').slice(0, 16);
}

export function buildStepAssignment(step: CollaborativeStep, version: string, criteria: string[],
  schemas?: { inputSchema?: unknown; outputSchema?: unknown }): StepAssignmentContract {
  const input = step.assignmentInput ?? step.input ?? {};
  const capabilityKey = step.assignmentCapabilityKey ?? step.capabilityKey;
  const inputSchema = schemaObject(schemas?.inputSchema);
  const properties = schemaObject(inputSchema?.properties);
  const required = Array.isArray(inputSchema?.required) ? inputSchema.required : [];
  const parameters = Object.entries(input).map(([name, value]) => {
    const field = schemaObject(properties?.[name]);
    return { name, type: typeof field?.type === 'string' ? field.type : valueType(value),
      required: inputSchema ? required.includes(name) : true,
      description: step.parameterDescriptions?.[name]
        ?? (typeof field?.description === 'string' && field.description.trim() ? field.description : undefined)
        ?? (name === 'dynamicArgs' && capabilityKey === 'mcp.call'
          ? `Arguments passed to MCP tool ${String(input.server)}/${String(input.tool)}; see dynamicArgs.* entries.` : undefined)
        ?? descriptions[capabilityKey ?? '']?.[name]
          ?? `${name} argument used to ${step.description}.` };
  });
  const nested = schemaObject(input.dynamicArgs);
  if (capabilityKey === 'mcp.call' && nested) {
    const toolSchema = schemaObject(step.mcpInputSchema);
    const toolProperties = schemaObject(toolSchema?.properties);
    const toolRequired = Array.isArray(toolSchema?.required) ? toolSchema.required : [];
    for (const [name, value] of Object.entries(nested)) {
      const field = schemaObject(toolProperties?.[name]);
      parameters.push({ name: `dynamicArgs.${name}`,
        type: typeof field?.type === 'string' ? field.type : valueType(value),
        required: toolRequired.includes(name),
        description: step.parameterDescriptions?.[`dynamicArgs.${name}`]
          ?? (typeof field?.description === 'string' && field.description.trim() ? field.description : undefined)
          ?? `Argument ${name} for MCP tool ${String(input.server)}/${String(input.tool)}.`,
      });
    }
  }
  return stepAssignmentSchema.parse({
    kind: 'step.assignment', contractVersion: 1, planVersion: version,
    stepId: step.id, objective: step.description, capabilityKey,
    dependsOn: step.dependsOn, input, parameters,
    acceptanceCriteria: criteria.length ? criteria : [step.description],
    outputSchema: schemas?.outputSchema && Object.keys(schemaObject(schemas.outputSchema) ?? {}).length
      ? schemas.outputSchema : builtinOutputs[capabilityKey ?? ''] ?? { type: 'unknown' },
  });
}

export function buildStepResult(assignment: StepAssignmentContract, result: StepObservation): StepResultContract {
  if (assignment.stepId !== result.stepId) throw new Error('Step result does not match its assignment.');
  const contract = stepResultSchema.parse({ kind: 'step.result', contractVersion: 1,
    planVersion: assignment.planVersion, stepId: result.stepId, observedAt: result.observedAt,
    status: 'completed', output: result.output });
  if (!matchesOutputSchema(contract.output, assignment.outputSchema)) {
    throw new Error(`Step ${result.stepId} output does not match its declared result structure.`);
  }
  return contract;
}

export function matchesOutputSchema(value: unknown, rawSchema: unknown): boolean {
  const schema = schemaObject(rawSchema);
  if (Array.isArray(schema?.anyOf)) return schema.anyOf.some(option => matchesOutputSchema(value, option));
  if (!schema || schema.type === 'unknown' || !schema.type) return true;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (Array.isArray(schema.required) && schema.required.some(key => typeof key === 'string' && !(key in record))) return false;
    const properties = schemaObject(schema.properties) ?? {};
    return Object.entries(properties).every(([key, child]) => !(key in record) || matchesOutputSchema(record[key], child));
  }
  if (schema.type === 'array') return Array.isArray(value)
    && (schema.items === undefined || value.every(item => matchesOutputSchema(item, schema.items)));
  if (schema.type === 'null') return value === null;
  if (schema.type === 'integer') return Number.isInteger(value);
  return typeof value === schema.type;
}

function schemaObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function valueType(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}
