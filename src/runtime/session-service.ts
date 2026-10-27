import { z } from 'zod';
import type { SessionListItem, SessionMemorySnapshot, SessionMessageRecord, SessionRecord, SessionStatus, TaskRun } from '../domain/contracts.js';
import type { ModelGateway } from '../model/gateway.js';
import { SqliteStore } from '../storage/sqlite-store.js';
import {
  compactionRetainTokens,
  compactionTriggerTokens,
  estimateTokens,
  selectCompactableRange,
  sessionMemoryBudgetTokens,
  trimSessionContent,
} from './session-memory.js';

const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED']);
const COMPACTION_RETRIES = 1;
/** The summary must genuinely shrink the compacted span, otherwise it is rejected. */
const SHRINK_RATIO = 0.9;
const SUMMARY_MAX_CHARS = 8_000;

const summarySchema = z.object({ summary: z.string().trim().min(1).max(SUMMARY_MAX_CHARS) });

export class SessionMemoryFullError extends Error {
  readonly code = 'SESSION_MEMORY_FULL';
  constructor() {
    super('会话记忆已满，自动压缩未能释放足够空间；请手动压缩会话或开启新会话。');
  }
}

export interface CompactionResult {
  compacted: boolean;
  reason?: string;
  freedTokens?: number;
}

const COMPACT_SYSTEM = [
  'You are the Jarvis session compaction engine. Condense the supplied earlier conversation of one',
  'session into a structured checkpoint that lets another model resume the session with no loss of',
  'essential context. Return JSON with one summary field containing Markdown.',
].join(' ');

function buildCompactionUser(domain: SessionMessageRecord[], priorSummary?: string): string {
  const transcript = domain.map((message) => ({ role: message.role, content: message.content }));
  return JSON.stringify({ transcript, priorSummary });
}

export class SessionService {
  public readonly budgetTokens: number;
  public readonly triggerTokens: number;
  private readonly retainTokens: number;
  private readonly compactingSessions = new Set<string>();

  constructor(
    private readonly store: SqliteStore,
    private readonly gateway: ModelGateway,
    budgetTokens = sessionMemoryBudgetTokens(32_000, 4_000),
  ) {
    this.budgetTokens = budgetTokens;
    this.triggerTokens = compactionTriggerTokens(budgetTokens);
    this.retainTokens = compactionRetainTokens(budgetTokens);
  }

  createSession(title?: string): SessionRecord {
    return this.store.createSession(title);
  }

  getSession(sessionId: string): SessionRecord | null {
    return this.store.getSession(sessionId);
  }

  listSessions(options: { limit?: number; cursor?: string; includeArchived?: boolean } = {}): {
    items: SessionListItem[];
    nextCursor: string | null;
  } {
    return this.store.listSessions(options);
  }

  updateSession(sessionId: string, patch: { title?: string; status?: SessionStatus; pinned?: boolean }): SessionRecord {
    return this.store.updateSession(sessionId, patch);
  }

  deleteSession(sessionId: string): void {
    this.store.deleteSession(sessionId);
  }

  listMessages(sessionId: string, options: { before?: number; limit?: number } = {}): {
    items: SessionMessageRecord[];
    hasMore: boolean;
  } {
    return this.store.listSessionMessages(sessionId, options);
  }

  loadSnapshot(sessionId: string): SessionMemorySnapshot | null {
    return this.store.getSessionMemorySnapshot(sessionId);
  }

  /** Records the user side of a turn; the first message also names the session. */
  recordUserTurn(sessionId: string, taskId: string, message: string): void {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.title === '新的会话') {
      const title = message.replace(/\s+/g, ' ').trim().slice(0, 24);
      if (title) this.store.updateSession(sessionId, { title });
    }
    this.store.appendSessionMessage({ sessionId, taskId, role: 'user', content: trimSessionContent('user', message) });
  }

  /**
   * Pre-turn gate: compact before a new task is created when memory is over
   * the trigger, and refuse the turn when compaction could not get under the
   * hard budget.
   */
  async ensureTurnCapacity(sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.memoryTokens < this.triggerTokens) return;
    await this.compactSession(sessionId);
    const after = this.store.getSession(sessionId);
    if (after && after.memoryTokens >= this.budgetTokens) throw new SessionMemoryFullError();
  }

  /** Called when a task reaches a terminal status; records the reply and maybe compacts. */
  async onTaskTerminal(task: TaskRun): Promise<void> {
    if (!task.sessionId || !TERMINAL_STATUSES.has(task.status)) return;
    const content = task.result?.trim() || '任务已结束（无结果输出）。';
    this.store.insertAssistantMessage(task.sessionId, task.id, trimSessionContent('assistant', content));
    const session = this.store.getSession(task.sessionId);
    if (session && session.memoryTokens >= this.triggerTokens) {
      void this.compactSession(task.sessionId).catch(() => undefined);
    }
  }

  async compactSession(sessionId: string): Promise<CompactionResult> {
    if (this.compactingSessions.has(sessionId)) return { compacted: false, reason: 'compaction-in-progress' };
    this.compactingSessions.add(sessionId);
    try {
      return await this.runCompaction(sessionId);
    } finally {
      this.compactingSessions.delete(sessionId);
    }
  }

  private async runCompaction(sessionId: string): Promise<CompactionResult> {
    const session = this.store.getSession(sessionId);
    if (!session) return { compacted: false, reason: 'session-not-found' };
    const messages = this.store.listMemoryMessages(sessionId);
    const range = selectCompactableRange(messages, this.retainTokens);
    if (!range) return { compacted: false, reason: 'insufficient-history' };

    const priorSummary = session.summary ?? undefined;
    let lastError = '';
    for (let attempt = 0; attempt <= COMPACTION_RETRIES; attempt += 1) {
      try {
        const completion = await this.gateway.complete({
          role: 'session.compaction',
          sessionId,
          system: COMPACT_SYSTEM,
          user: buildCompactionUser(range.domainMessages, priorSummary),
        }, summarySchema);
        const summary = completion.data.summary;
        const summaryTokens = estimateTokens(summary);
        if (summaryTokens >= Math.floor(range.domainTokens * SHRINK_RATIO)) {
          return { compacted: false, reason: 'summary-not-smaller' };
        }
        this.store.commitSessionCompaction(sessionId, range.cutoffSeq, summary);
        return { compacted: true, freedTokens: range.domainTokens - summaryTokens };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    return { compacted: false, reason: `summarization-failed: ${lastError}` };
  }
}
