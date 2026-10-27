import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelCompletion, ModelProvider, ModelRequest } from '../../src/model/gateway.js';
import { ModelGateway } from '../../src/model/gateway.js';
import { SessionMemoryFullError, SessionService } from '../../src/runtime/session-service.js';
import { estimateTokens } from '../../src/runtime/session-memory.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

const temporaryDirectories: string[] = [];
const openStores: SqliteStore[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): SqliteStore {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-session-'));
  temporaryDirectories.push(directory);
  const store = new SqliteStore(join(directory, 'jarvis.sqlite'));
  openStores.push(store);
  return store;
}

class FakeCompactionProvider implements ModelProvider {
  public requests: ModelRequest[] = [];

  constructor(private readonly summaryFactory: (request: ModelRequest) => unknown) {}

  async complete(request: ModelRequest): Promise<ModelCompletion> {
    this.requests.push(request);
    return { data: this.summaryFactory(request), usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

function createUserMessage(sessionId: string, content: string) {
  return { sessionId, role: 'user' as const, content };
}

describe('SqliteStore session persistence', () => {
  it('creates sessions with a default title and lists them newest first with a preview', () => {
    const store = createStore();
    const first = store.createSession();
    expect(first.title).toBe('新的会话');
    store.appendSessionMessage(createUserMessage(first.id, '帮我整理销售数据并生成图表'));
    const second = store.createSession('自定义标题');
    store.appendSessionMessage(createUserMessage(second.id, '第二条'));

    const page = store.listSessions();
    expect(page.items.map(item => item.id)).toEqual([second.id, first.id]);
    expect(page.items[1]!.preview).toContain('销售数据');
    expect(page.nextCursor).toBeNull();
  });

  it('paginates sessions with a stable cursor and keeps message ordering', () => {
    const store = createStore();
    for (let index = 0; index < 3; index += 1) {
      const session = store.createSession(`会话 ${index}`);
      store.appendSessionMessage(createUserMessage(session.id, `消息 ${index}`));
    }
    const firstPage = store.listSessions({ limit: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = store.listSessions({ limit: 2, cursor: firstPage.nextCursor! });
    expect(secondPage.items).toHaveLength(1);
    expect(firstPage.items.map(item => item.id)).not.toContain(secondPage.items[0]!.id);

    const session = firstPage.items[0]!;
    store.appendSessionMessage({ sessionId: session.id, role: 'assistant', content: '回答', taskId: 'task-1' });
    const messages = store.listSessionMessages(session.id);
    expect(messages.items.map(item => item.role)).toEqual(['user', 'assistant']);
    expect(messages.items[1]!.taskId).toBe('task-1');
    expect(messages.hasMore).toBe(false);
  });

  it('pins selected sessions ahead of recent ones and preserves the order across pages and reopen', () => {
    const store = createStore();
    const first = store.createSession('第一条');
    const second = store.createSession('第二条');
    const third = store.createSession('第三条');
    const fourth = store.createSession('第四条');
    const originalUpdatedAt = store.getSession(first.id)!.updatedAt;

    const pinnedFirst = store.updateSession(first.id, { pinned: true });
    const pinnedSecond = store.updateSession(second.id, { pinned: true });
    expect(pinnedFirst.pinnedAt).toBeTruthy();
    expect(pinnedFirst.updatedAt).toBe(originalUpdatedAt);
    expect(store.updateSession(first.id, { pinned: true }).pinnedAt).toBe(pinnedFirst.pinnedAt);
    expect(pinnedSecond.pinnedAt).toBeTruthy();

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = store.listSessions({ limit: 1, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map(item => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen.slice(0, 2))).toEqual(new Set([first.id, second.id]));
    expect(new Set(seen)).toEqual(new Set([first.id, second.id, third.id, fourth.id]));
    expect(seen).toHaveLength(4);

    const reopened = new SqliteStore(store.filename);
    openStores.push(reopened);
    expect(reopened.getSession(first.id)?.pinnedAt).toBe(pinnedFirst.pinnedAt);
    expect(reopened.listSessions().items.slice(0, 2).map(item => item.id))
      .toEqual(store.listSessions().items.slice(0, 2).map(item => item.id));
    expect(reopened.updateSession(first.id, { pinned: false }).pinnedAt).toBeNull();
    expect(reopened.listSessions().items[0]?.id).toBe(second.id);
  });

  it('renames, archives, and deletes sessions while detaching their tasks', () => {
    const store = createStore();
    const session = store.createSession();
    const task = store.createTask({ message: '归属任务', attachments: [], sessionId: session.id });
    store.appendSessionMessage(createUserMessage(session.id, '历史消息'));

    expect(store.updateSession(session.id, { title: '  重命名  ' }).title).toBe('重命名');
    expect(store.updateSession(session.id, { status: 'archived' }).status).toBe('archived');
    expect(store.listSessions().items).toHaveLength(0);
    expect(store.listSessions({ includeArchived: true }).items).toHaveLength(1);

    store.deleteSession(session.id);
    expect(store.getSession(session.id)).toBeNull();
    expect(store.listSessionMessages(session.id).items).toHaveLength(0);
    expect(store.getTask(task.id)?.sessionId).toBeUndefined();
  });

  it('tracks memory tokens from the summary plus un-watermarked messages only', () => {
    const store = createStore();
    const session = store.createSession();
    store.appendSessionMessage(createUserMessage(session.id, 'a'.repeat(400)));
    store.appendSessionMessage({ sessionId: session.id, role: 'assistant', content: 'b'.repeat(400), taskId: 't1' });
    let reloaded = store.getSession(session.id)!;
    expect(reloaded.memoryTokens).toBe(200);

    store.commitSessionCompaction(session.id, 1, 'c'.repeat(80));
    reloaded = store.getSession(session.id)!;
    // summary (20 tokens) + tail beyond seq 1 (100 tokens); the folded user row no longer counts
    expect(reloaded.summarySeq).toBe(1);
    expect(reloaded.memoryTokens).toBe(20 + 100);

    const snapshot = store.getSessionMemorySnapshot(session.id)!;
    expect(snapshot.summary).toContain('cc');
    expect(snapshot.turns.map(turn => turn.seq)).toEqual([2]);
  });

  it('records at most one assistant message per task and detects active tasks', () => {
    const store = createStore();
    const session = store.createSession();
    const task = store.createTask({ message: '工作', attachments: [], sessionId: session.id });
    expect(store.insertAssistantMessage(session.id, task.id, '第一次')).toBe(true);
    expect(store.insertAssistantMessage(session.id, task.id, '重复')).toBe(false);
    expect(store.listSessionMessages(session.id).items.filter(item => item.role === 'assistant')).toHaveLength(1);

    task.status = 'EXECUTING';
    store.saveTask(task);
    expect(store.hasActiveTaskInSession(session.id)).toBe(true);
    task.status = 'COMPLETED';
    store.saveTask(task);
    expect(store.hasActiveTaskInSession(session.id)).toBe(false);
  });

  it('migrates the schema to user_version 3 and keeps legacy tasks unassigned', () => {
    const store = createStore();
    const userVersion = (store as unknown as { database: { prepare: (sql: string) => { get: () => { user_version: number } } } })
      .database.prepare('PRAGMA user_version').get().user_version;
    expect(userVersion).toBe(4);
    const legacy = store.createTask({ message: '旧任务', attachments: [] });
    expect(legacy.sessionId).toBeUndefined();
    expect(store.listUnassignedTasks().map(task => task.id)).toContain(legacy.id);
  });
});

describe('SessionService compaction', () => {
  const BUDGET = 1_000;
  const TRIGGER = 800;

  function createService(summary: (request: ModelRequest) => unknown) {
    const store = createStore();
    const provider = new FakeCompactionProvider(summary);
    const service = new SessionService(store, new ModelGateway(provider), BUDGET);
    return { store, provider, service };
  }

  function fillMemory(store: SqliteStore, sessionId: string, turnCount: number, characters: number, prefix = 'task'): void {
    for (let index = 0; index < turnCount; index += 1) {
      store.appendSessionMessage({ sessionId, role: 'user', content: `问题${index} ` + 'u'.repeat(characters) });
      store.appendSessionMessage({ sessionId, role: 'assistant', content: 'a'.repeat(characters), taskId: `${prefix}-${index}` });
    }
  }

  it('compacts the domain, keeps the tail verbatim, and records the checkpoint marker', async () => {
    const { store, provider, service } = createService(request => {
      const parsed = JSON.parse(request.user) as { transcript: unknown[] };
      return { summary: `检查点：共压缩 ${parsed.transcript.length} 条消息。` };
    });
    const session = store.createSession();
    fillMemory(store, session.id, 8, 400);

    expect(store.getSession(session.id)!.memoryTokens).toBeGreaterThanOrEqual(TRIGGER);
    const result = await service.compactSession(session.id);
    expect(result.compacted).toBe(true);

    const reloaded = store.getSession(session.id)!;
    expect(reloaded.summary).toContain('检查点');
    expect(reloaded.memoryTokens).toBeLessThan(TRIGGER);
    const messages = store.listSessionMessages(session.id);
    expect(messages.items.at(-1)!.role).toBe('compaction');
    // original rows are retained
    expect(messages.items.filter(item => item.role === 'assistant')).toHaveLength(8);
    expect(provider.requests[0]!.role).toBe('session.compaction');
  });

  it('merges a prior checkpoint into the next summarization request', async () => {
    const { store, provider, service } = createService(() => ({ summary: 's'.repeat(50) }));
    const session = store.createSession();
    fillMemory(store, session.id, 8, 400);
    store.commitSessionCompaction(session.id, 12, '旧检查点内容');
    fillMemory(store, session.id, 4, 400, 'task-b');
    provider.requests.length = 0;

    const result = await service.compactSession(session.id);
    expect(result.compacted).toBe(true);
    const payload = JSON.parse(provider.requests[0]!.user) as { priorSummary?: string };
    expect(payload.priorSummary).toContain('旧检查点内容');
  });

  it('rejects summaries that do not shrink the domain', async () => {
    const { store, service } = createService(() => ({ summary: '过长'.repeat(3_900) }));
    const session = store.createSession();
    fillMemory(store, session.id, 8, 400);
    const before = store.getSession(session.id)!.memoryTokens;

    const result = await service.compactSession(session.id);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe('summary-not-smaller');
    expect(store.getSession(session.id)!.memoryTokens).toBe(before);
    expect(store.getSession(session.id)!.summary).toBeNull();
  });

  it('skips compaction when the domain has fewer than two whole turns', async () => {
    const { store, service } = createService(() => ({ summary: '短摘要' }));
    const session = store.createSession();
    fillMemory(store, session.id, 2, 400);
    const result = await service.compactSession(session.id);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe('insufficient-history');
  });

  it('ensureTurnCapacity compacts pre-turn and blocks when still over the hard budget', async () => {
    const { store, service } = createService(() => ({ summary: 's'.repeat(120) }));
    const session = store.createSession();
    fillMemory(store, session.id, 8, 400);

    await service.ensureTurnCapacity(session.id);
    expect(store.getSession(session.id)!.summary).not.toBeNull();

    const stubborn = createStore();
    const failing = new SessionService(stubborn, new ModelGateway({
      complete: async () => { throw new Error('model unavailable'); },
    }), BUDGET);
    const fullSession = stubborn.createSession();
    for (let index = 0; index < 20; index += 1) {
      stubborn.appendSessionMessage(createUserMessage(fullSession.id, 'u'.repeat(1_200)));
      stubborn.appendSessionMessage({ sessionId: fullSession.id, role: 'assistant', content: 'a'.repeat(1_200), taskId: `t-${index}` });
    }
    expect(stubborn.getSession(fullSession.id)!.memoryTokens).toBeGreaterThan(BUDGET);
    await expect(failing.ensureTurnCapacity(fullSession.id)).rejects.toBeInstanceOf(SessionMemoryFullError);
  });

  it('records the assistant turn once when a task reaches a terminal status', async () => {
    const { store, service } = createService(() => ({ summary: '摘要' }));
    const session = store.createSession();
    const task = store.createTask({ message: '执行', attachments: [], sessionId: session.id });
    task.status = 'COMPLETED';
    task.result = '任务已完成：结果如下。';
    await service.onTaskTerminal(task);
    await service.onTaskTerminal(task);

    const messages = store.listSessionMessages(session.id).items.filter(item => item.role === 'assistant');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toContain('结果如下');
    // a non-terminal task never records
    task.status = 'EXECUTING';
    await service.onTaskTerminal(task);
    expect(store.listSessionMessages(session.id).items.filter(item => item.role === 'assistant')).toHaveLength(1);
    expect(estimateTokens(messages[0]!.content)).toBeGreaterThan(0);
  });
});
