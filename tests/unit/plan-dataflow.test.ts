import { describe, expect, it } from 'vitest';
import { normalizeObservedPlan } from '../../src/agents/plan-dataflow.js';

describe('observed plan dataflow', () => {
  it('deletes a placeholder synthesis step and defers a dependent file until its source is read', () => {
    const plan = { steps: [
      { id: 'read', capabilityKey: 'filesystem.read_text', description: 'Read notes', dependsOn: [],
        input: { path: 'D:/demo/notes.txt' } },
      { id: 'synthesize', capabilityKey: 'text.replace', description: 'Summarize notes', dependsOn: ['read'],
        input: { text: '{{read.output}}', instruction: 'Summarize' } },
      { id: 'write', capabilityKey: 'filesystem.write_text', description: 'Save summary', dependsOn: ['synthesize'],
        input: { path: 'D:/demo/summary.md', content: '{{synthesize.output}}' } },
    ] };
    const normalized = normalizeObservedPlan(plan, 'Read notes and save a summary');
    expect(normalized.steps.map(step => step.id)).toEqual(['read', 'write']);
    expect(normalized.steps[1]?.dependsOn).toEqual(['read']);
    expect(normalized.steps[1]?.input).toMatchObject({ path: 'D:/demo/summary.md',
      generation: { instruction: expect.stringContaining('verifiedResults') } });
    expect(normalized.steps[1]?.input).not.toHaveProperty('content');
  });
});
