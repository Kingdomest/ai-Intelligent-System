import { describe, expect, it } from 'vitest';
import { BudgetManager } from '../../src/runtime/budget-manager.js';

describe('BudgetManager', () => {
  it('reserves output space and reports context overflow', () => {
    const manager = new BudgetManager({ maxContextTokens: 100, outputReserveTokens: 20 });

    expect(manager.check({ message: 'a'.repeat(200), attachments: [] }).fits).toBe(true);
    expect(manager.check({ message: 'a'.repeat(500), attachments: [] }).fits).toBe(false);
  });

  it('compacts an oversized input without removing the original task message', () => {
    const manager = new BudgetManager({ maxContextTokens: 100, outputReserveTokens: 20 });
    const compacted = manager.compact({
      message: 'please preserve this request',
      attachments: [{ filename: 'large.txt', content: 'x'.repeat(2_000) }],
    });

    expect(compacted.message).toContain('please preserve this request');
    expect(compacted.attachments[0]?.content?.length).toBeLessThan(2_000);
  });
});
