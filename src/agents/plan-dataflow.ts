import { hasObservedDataDependency } from './planner-contract.js';

interface PlanStepLike {
  id: string;
  capabilityKey?: string;
  description: string;
  dependsOn: string[];
  input?: Record<string, unknown>;
}

/**
 * The planner cannot interpolate a future tool result into static step input.
 * Keep observation steps, then perform synthesis in the responder or the
 * deferred file implementer after those results actually exist.
 */
export function normalizeObservedPlan<T extends { steps: PlanStepLike[] }>(
  plan: T, message: string, completedSteps: PlanStepLike[] = [],
): T {
  const allSteps = [...completedSteps, ...plan.steps];
  const synthetic = new Map(plan.steps.filter(step => {
    if (!['text.replace', 'json.format', 'text.count_lines'].includes(step.capabilityKey ?? '')
      || !hasObservedDataDependency(allSteps, step.id)) return false;
    const input = step.input ?? {};
    const referencesFutureResult = Object.values(input).some(value =>
      typeof value === 'string' && /\{\{[^{}]+\}\}|\$\{[^{}]+\}/.test(value));
    const missingRequiredText = typeof input.text !== 'string'
      || step.capabilityKey === 'text.replace' && (typeof input.search !== 'string'
        || typeof input.replacement !== 'string');
    return referencesFutureResult || missingRequiredText;
  }).map(step => [step.id, step]));

  const expandDependency = (id: string, seen = new Set<string>()): string[] => {
    if (seen.has(id)) return [id];
    const removed = synthetic.get(id);
    if (!removed) return [id];
    seen.add(id);
    return removed.dependsOn.flatMap(parent => expandDependency(parent, seen));
  };
  const steps = plan.steps.filter(step => !synthetic.has(step.id)).map(step => ({
    ...step,
    dependsOn: [...new Set(step.dependsOn.flatMap(id => expandDependency(id)))],
  }));

  const withObservedInputs = [...completedSteps, ...steps];
  const normalized = steps.map(step => {
    if (step.capabilityKey !== 'filesystem.write_text' || !step.input
      || typeof step.input.path !== 'string' || typeof step.input.content !== 'string'
      || !hasObservedDataDependency(withObservedInputs, step.id)) return step;
    const instruction = [
      `Complete this file step: ${step.description.slice(0, 300)}.`,
      'Use only verifiedResults from completed dependency steps for factual content. Preserve supported figures and source context; disclose gaps and never invent findings.',
      `Original user request: ${message.slice(0, 900)}`,
    ].join(' ');
    return { ...step, input: { path: step.input.path, generation: { instruction: instruction.slice(0, 1_900) } } };
  });
  return { ...plan, steps: normalized } as T;
}
