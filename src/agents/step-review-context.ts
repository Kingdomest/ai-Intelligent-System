import type { StepReviewInput } from './agent-runner.js';

const limited = (value: string, max: number): string => value.length <= max
  ? value : `${value.slice(0, max)}… [${value.length} characters total]`;

const isMarkup = (value: string): boolean => /<(?:!doctype|html|head|body|script|style|div|p|h[1-6]|a)\b/i.test(value.slice(0, 1_000));

function readableBody(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim();
}

/** Keep enough source text for synthesis while making truncation explicit. */
export function compactVerifiedResult(value: unknown, maxText = 8_000): unknown {
  if (typeof value === 'string') {
    const readable = isMarkup(value) ? readableBody(value) : value;
    if (value.length <= maxText) return readable;
    return { characters: value.length, excerpt: limited(readable, maxText), truncated: true };
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => compactVerifiedResult(item, maxText));
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(source).slice(0, 24).map(([key, item]) => [key,
    key === 'headers' && item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .filter(([name]) => /^(?:content-type|content-length)$/i.test(name)))
      : compactVerifiedResult(item, maxText)]));
}

/** A review needs observable evidence, not a second copy of an entire page or file. */
export function summarizeStepEvidence(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    // Newlines and spaces can be the evidence itself (for example a line-count
    // input). Keep plain text exact; only flatten actual markup for readability.
    const readable = isMarkup(value) ? readableBody(value) : value;
    return value.length <= 1_200 ? readable : { characters: value.length, preview: limited(readable, 1_200) };
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 3) return { summary: limited(JSON.stringify(value) ?? '', 300) };
  if (Array.isArray(value)) return { length: value.length,
    items: value.slice(0, 3).map(item => summarizeStepEvidence(item, depth + 1)) };
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(source).slice(0, 16).map(([key, item]) => [key,
    key === 'headers' && item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .filter(([name]) => /^(?:content-type|content-length)$/i.test(name)))
      : key === 'content' && typeof item === 'string'
      ? { characters: item.length, preview: limited(readableBody(item), 600) }
      : key === 'body' && typeof item === 'string'
        ? { characters: item.length, preview: limited(readableBody(item), 1_200) }
        : summarizeStepEvidence(item, depth + 1)]));
}

function summarizeStepInput(input: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).map(([key, value]) => [key,
    key === 'content' && typeof value === 'string'
      ? { characters: value.length, omitted: true }
      : summarizeStepEvidence(value)]));
}

export function buildStepReviewContext(input: StepReviewInput): Record<string, unknown> {
  const currentStep = input.plan.steps.find(step => step.id === input.step.id);
  return {
    request: limited(input.message, 4_000),
    intent: input.plan.intent,
    acceptanceCriteria: input.plan.acceptanceCriteria.slice(0, 12).map(item => limited(item, 300)),
    currentStepId: input.step.id,
    currentStep: currentStep && { id: currentStep.id, capabilityKey: currentStep.capabilityKey,
      description: currentStep.description, input: summarizeStepInput(currentStep.input) },
    completedStepIds: input.completedStepIds,
    priorResults: input.results.filter(result => result.stepId !== input.step.id).map(result => ({
      stepId: result.stepId, output: summarizeStepEvidence(result.output),
    })),
    outcome: input.outcome.status === 'success'
      ? { status: 'success', output: summarizeStepEvidence(input.outcome.output) }
      : { status: 'failure', failure: input.outcome.failure,
        output: summarizeStepEvidence(input.outcome.output) },
    ...(input.verification ? { verification: input.verification } : {}),
    remainingSteps: input.plan.steps.filter(step => !input.completedStepIds.includes(step.id)).map(step => ({
      id: step.id, capabilityKey: step.capabilityKey, description: step.description,
      dependsOn: step.dependsOn, input: summarizeStepInput(step.input),
    })),
    previousFailures: input.previousFailures?.slice(-5),
    safeToReplay: input.safeToReplay,
    workspaceRoot: input.workspaceRoot,
    desktopDirectory: input.desktopDirectory,
  };
}
