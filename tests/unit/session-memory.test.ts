import { describe, expect, it } from 'vitest';
import type { SessionMessageRecord } from '../../src/domain/contracts.js';
import {
  estimateTokens,
  formatRouteContext,
  selectCompactableRange,
  sessionMemoryBudgetTokens,
  trimSessionContent,
} from '../../src/runtime/session-memory.js';

function message(seq: number, role: 'user' | 'assistant', characters: number): SessionMessageRecord {
  return {
    seq, sessionId: 'session-1', role,
    content: role === 'user' ? `u${seq}`.padEnd(Math.min(characters, seq + 1), 'x') : 'a'.repeat(characters),
    status: 'final', tokens: estimateTokens('a'.repeat(characters)),
    createdAt: new Date(2026, 8, 29, 12, seq).toISOString(),
  };
}

describe('session memory helpers', () => {
  it('estimates tokens from character count', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });

  it('derives the memory budget from the model window', () => {
    expect(sessionMemoryBudgetTokens(32_000, 4_000)).toBe(24_000);
    expect(sessionMemoryBudgetTokens(8_000, 4_000)).toBe(4_000);
  });

  it('keeps short session content untouched and trims oversized turns with a middle omission', () => {
    const short = '短消息';
    expect(trimSessionContent('user', short)).toBe(short);
    const longUser = 'u'.repeat(7_000);
    const trimmedUser = trimSessionContent('user', longUser);
    expect(trimmedUser.length).toBeLessThan(6_000);
    expect(trimmedUser).toContain('历史消息中间已省略');
    expect(trimmedUser.startsWith('u')).toBe(true);
    expect(trimmedUser.endsWith('u')).toBe(true);
    expect(trimSessionContent('assistant', 'a'.repeat(12_000))).toContain('历史消息中间已省略');
  });

  it('returns null when there are fewer than two complete domain turns', () => {
    const messages = [message(1, 'user', 100), message(2, 'assistant', 100)];
    expect(selectCompactableRange(messages, 10)).toBeNull();
  });

  it('keeps the verbatim tail, excludes a trailing unanswered turn, and never splits a turn', () => {
    const messages = [
      message(1, 'user', 200), message(2, 'assistant', 200),
      message(3, 'user', 200), message(4, 'assistant', 200),
      message(5, 'user', 200), message(6, 'assistant', 200),
      message(7, 'user', 50), // trailing unanswered turn belongs to the tail
    ];
    const range = selectCompactableRange(messages, 10)!;
    expect(range).not.toBeNull();
    expect(range.cutoffSeq).toBe(4);
    expect(range.domainMessages.map(item => item.seq)).toEqual([1, 2, 3, 4]);
    expect(range.domainTokens).toBe(range.domainMessages.reduce((sum, item) => sum + item.tokens, 0));
  });

  it('clips route context to the last two turns with bounded fields', () => {
    const snapshot = {
      summary: 's'.repeat(3_000),
      summarySeq: 2,
      tokens: 5_000,
      turns: [
        { seq: 3, role: 'user' as const, content: 'u'.repeat(2_000) },
        { seq: 4, role: 'assistant' as const, content: 'a'.repeat(2_000) },
        { seq: 5, role: 'user' as const, content: '最新问题' },
        { seq: 6, role: 'assistant' as const, content: '最新回答' },
      ],
    };
    const context = formatRouteContext(snapshot);
    expect(context.summary!.length).toBeLessThanOrEqual(2_001);
    expect(context.recentTurns).toHaveLength(2);
    expect(context.recentTurns[1]).toEqual({ user: '最新问题', assistant: '最新回答' });
    expect(context.recentTurns[0]!.user.length).toBeLessThanOrEqual(801);
  });
});
