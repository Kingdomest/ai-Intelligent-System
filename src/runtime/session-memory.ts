import type { MemoryTurn, SessionMemorySnapshot, SessionMessageRecord } from '../domain/contracts.js';

/** Mirrors BudgetManager's characters-per-token heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Session memory budget: the model context window minus the output reserve
 * minus room for the current turn's own work (attachments, tool round-trips).
 * Configured from RuntimeConfig in dependencies.ts.
 */
export function sessionMemoryBudgetTokens(maxContextTokens: number, outputReserveTokens: number): number {
  return Math.max(4_000, maxContextTokens - outputReserveTokens - 4_000);
}

export function compactionTriggerTokens(budgetTokens: number): number {
  return Math.floor(budgetTokens * 0.8);
}

export function compactionRetainTokens(budgetTokens: number): number {
  return Math.floor(budgetTokens * 0.16);
}

const USER_TRIM = { max: 6_000, head: 4_500, tail: 1_000 };
const ASSISTANT_TRIM = { max: 10_000, head: 8_000, tail: 1_000 };
const OMISSION_MARK = '\n…[历史消息中间已省略]…\n';

/**
 * First gate of the three-layer compaction design: oversized turns are
 * trimmed once at write time so a single message can never overflow the
 * memory budget on its own.
 */
export function trimSessionContent(role: 'user' | 'assistant', content: string): string {
  const limits = role === 'user' ? USER_TRIM : ASSISTANT_TRIM;
  if (content.length <= limits.max) return content;
  return `${content.slice(0, limits.head)}${OMISSION_MARK}${content.slice(-limits.tail)}`;
}

export interface CompactionRange {
  domainMessages: SessionMessageRecord[];
  domainTokens: number;
  /** Everything up to and including this seq is folded into the new summary. */
  cutoffSeq: number;
}

/**
 * Split memory turns into the compaction domain and the verbatim tail.
 * Turns are kept whole (a user message with its assistant reply is never
 * split); the tail retains at least `retainTokens` starting from the newest
 * complete turn. A trailing user message without a reply is treated as part
 * of the tail because its turn has not finished. The domain must contain at
 * least two whole turns to be worth a summarization request.
 */
export function selectCompactableRange(messages: SessionMessageRecord[], retainTokens: number): CompactionRange | null {
  const turns: SessionMessageRecord[][] = [];
  for (const message of messages) {
    if (message.role === 'user') turns.push([message]);
    else if (message.role === 'assistant' && turns.length > 0) turns[turns.length - 1]!.push(message);
  }
  const complete = turns.filter(turn => turn.some(item => item.role === 'assistant'));
  if (complete.length < 3) return null;

  let tailTokens = 0;
  let tailStart = complete.length;
  while (tailStart > 0 && tailTokens < retainTokens) {
    tailStart -= 1;
    tailTokens += complete[tailStart]!.reduce((sum, item) => sum + item.tokens, 0);
  }
  const domain = complete.slice(0, tailStart);
  if (domain.length < 2) return null;

  const domainMessages = domain.flat();
  return {
    domainMessages,
    domainTokens: domainMessages.reduce((sum, item) => sum + item.tokens, 0),
    cutoffSeq: domainMessages[domainMessages.length - 1]!.seq,
  };
}

const ROUTE_TURN_CHARS = 800;
const ROUTE_SUMMARY_CHARS = 2_000;

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * Bounded session context for the cheap route/classification call: the
 * summary plus the last two turns, each side clipped.
 */
export function formatRouteContext(snapshot: SessionMemorySnapshot): {
  summary?: string;
  recentTurns: Array<{ user: string; assistant: string }>;
} {
  const recentTurns: Array<{ user: string; assistant: string }> = [];
  for (const turn of snapshot.turns.slice(-4)) {
    if (turn.role === 'user') recentTurns.push({ user: clip(turn.content, ROUTE_TURN_CHARS), assistant: '' });
    else if (recentTurns.length > 0) {
      recentTurns[recentTurns.length - 1]!.assistant = clip(turn.content, ROUTE_TURN_CHARS);
    }
  }
  return {
    summary: snapshot.summary ? clip(snapshot.summary, ROUTE_SUMMARY_CHARS) : undefined,
    recentTurns: recentTurns.slice(-2),
  };
}
