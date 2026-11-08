export interface PlanStep {
  id: string;
  description: string;
  dependsOn: string[];
  input?: Record<string, unknown>;
}

export interface TaskPlan {
  steps: PlanStep[];
}

export interface SchedulerConfig {
  maxConcurrency: number;
}

export interface ConcurrencyInput {
  modelLimit: number;
  resourceSlots: number;
  readySteps: number;
}

export class AdaptiveScheduler {
  constructor(private readonly config: SchedulerConfig) {}

  nextReadyStep<T extends PlanStep>(plan: { steps: T[] }, completed: Set<string>): T | null {
    return plan.steps.find((step) => (
      !completed.has(step.id) && step.dependsOn.every((dependency) => completed.has(dependency))
    )) ?? null;
  }

  concurrency(input: ConcurrencyInput): number {
    return Math.max(0, Math.min(
      this.config.maxConcurrency,
      input.modelLimit,
      input.resourceSlots,
      input.readySteps,
    ));
  }
}
