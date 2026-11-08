import { describe, expect, it } from 'vitest';
import { parsePlannerDecision } from '../../src/agents/planner-contract.js';

describe('planner contract', () => {
  it('requires three distinct clarification choices when choices are offered', () => {
    const base = { status: 'needs_user_input', acceptanceCriteria: [], steps: [], inputRequest: {
      taskId: 'weather', question: '哪个城市？', requiredFields: [{ name: 'city', reason: '需要城市', sensitive: false }],
      resumeToken: 'resume', options: [{ label: '广州', value: '广州' }, { label: '深圳', value: '深圳' },
        { label: '东莞', value: '东莞' }],
    } };
    expect(parsePlannerDecision(base).inputRequest?.options).toHaveLength(3);
    expect(() => parsePlannerDecision({ ...base, inputRequest: { ...base.inputRequest,
      options: base.inputRequest.options.slice(0, 2) } })).toThrow(/three distinct choices/);
    expect(() => parsePlannerDecision({ ...base, inputRequest: { ...base.inputRequest,
      options: [{ label: '广州', value: '广州' }, { label: '广州2', value: '广州' }, { label: '深圳', value: '深圳' }] } }))
      .toThrow(/distinct values/);
  });

  it('rejects reading a directory as text but permits reading a file inside it', () => {
    const folder = { id: 'folder', capabilityKey: 'filesystem.mkdir', description: 'Create directory',
      dependsOn: [], input: { path: 'D:\\Demo\\game' } };
    const read = { id: 'verify', capabilityKey: 'filesystem.read_text', description: 'Verify directory',
      dependsOn: ['folder'], input: { path: 'd:/demo/game' } };
    expect(() => parsePlannerDecision({ status: 'ready', acceptanceCriteria: [], steps: [folder, read] }))
      .toThrow(/requires a file.*live host tests/i);
    const valid = parsePlannerDecision({ status: 'ready', acceptanceCriteria: [],
      steps: [folder, { ...read, input: { path: 'D:/Demo/game/index.html' } }] });
    expect(valid.steps).toHaveLength(2);
  });
  it('accepts a source-file brief without source code and rejects an incomplete write', () => {
    const step = { id: 'game', capabilityKey: 'filesystem.write_text', description: 'Create the game', dependsOn: [],
      input: { path: 'D:/demo/game.js', generation: { instruction: 'Implement a playable minesweeper game.' } } };
    expect(parsePlannerDecision({ status: 'ready', acceptanceCriteria: ['Playable game'], steps: [step] }).steps[0]?.input)
      .toEqual(step.input);
    expect(() => parsePlannerDecision({ status: 'ready', acceptanceCriteria: [], steps: [
      { ...step, input: { path: 'D:/demo/game.js' } },
    ] })).toThrow(/steps\[0\]\.input/);
  });
  it('rejects a report body written before dependent observations are available', () => {
    const fetch = { id: 'fetch', capabilityKey: 'network.request', description: 'Fetch source', dependsOn: [],
      input: { url: 'https://example.org/data', method: 'GET' } };
    const write = { id: 'report', capabilityKey: 'filesystem.write_text', description: 'Write report',
      dependsOn: ['fetch'], input: { path: 'D:/demo/report.md', content: 'Prewritten findings' } };
    expect(() => parsePlannerDecision({ status: 'ready', acceptanceCriteria: [], steps: [fetch, write] }))
      .toThrow(/static content.*generation\.instruction/);
    expect(parsePlannerDecision({ status: 'ready', acceptanceCriteria: [], steps: [fetch, {
      ...write, input: { path: 'D:/demo/report.md', generation: { instruction: 'Summarize the fetched evidence.' } },
    }] }).steps).toHaveLength(2);
  });
  it('unwraps explicit typed values before launch input reaches a host call', () => {
    const plan = parsePlannerDecision({
      status: 'ready', acceptanceCriteria: [],
      steps: [{ id: 'launch-1', capabilityKey: 'process.launch', description: 'Open app', dependsOn: [],
        input: { applicationName: { type: 'string', value: '网易云音乐' }, args: { type: 'array', value: [] } } }],
    });
    expect(plan.steps[0]?.input).toEqual({ applicationName: '网易云音乐', args: [] });
  });

  it('repairs only unambiguous planner argument shapes seen in failed tasks', () => {
    const plan = parsePlannerDecision({ status: 'ready', acceptanceCriteria: [], steps: [
      { id: 'launch', capabilityKey: 'process.launch', description: 'Open app', dependsOn: [],
        input: { applicationName: 'Demo', args: {} } },
      { id: 'fetch', capabilityKey: 'network.request', description: 'Fetch data', dependsOn: ['launch'],
        input: { url: 'https://example.org/data', method: 'GET', timeout: 5_000 } },
      { id: 'write', capabilityKey: 'filesystem.write_text', description: 'Create file', dependsOn: ['fetch'],
        input: { path: 'D:/demo/result.txt', generation: { instruction: 'A'.repeat(603) } } },
    ] });
    expect(plan.steps.map(step => step.input)).toEqual([
      { applicationName: 'Demo', args: [] },
      { url: 'https://example.org/data', method: 'GET' },
      { path: 'D:/demo/result.txt', generation: { instruction: 'A'.repeat(603) } },
    ]);
  });

  it('unwraps the recorded git clone argument nesting without changing the command', () => {
    const args = ['clone', 'https://github.com/deepseek-ai/deepseek-harness.git', '.'];
    const base = { id: 'clone_repo', capabilityKey: 'process.run', description: 'Clone repository',
      dependsOn: [], input: { command: 'git', cwd: 'C:/Users/Administrator/Desktop/deepseek-code',
        dynamicArgs: { args: { args } } } };
    const plan = parsePlannerDecision({ status: 'ready', acceptanceCriteria: [], steps: [base] });
    expect(plan.steps[0]?.input).toEqual({ command: 'git', cwd: base.input.cwd, args });
    const replanned = parsePlannerDecision({ status: 'ready', acceptanceCriteria: [], steps: [{ ...base,
      input: { command: 'git', cwd: base.input.cwd, name: 'git clone', instruction: 'Use a shallow clone',
        dynamicArgs: { args: { length: 4, items: args } } } }] });
    expect(replanned.steps[0]?.input).toEqual({ command: 'git', cwd: base.input.cwd, args });
    const alternate = parsePlannerDecision({ status: 'ready', acceptanceCriteria: [], steps: [{ ...base,
      input: { command: 'git', cwd: base.input.cwd, name: 'git clone', instruction: 'Use a shallow clone',
        dynamicArgs: { items: { length: 4, items: args } } } }] });
    expect(alternate.steps[0]?.input).toEqual({ command: 'git', cwd: base.input.cwd, args });
    expect(() => parsePlannerDecision({ status: 'ready', acceptanceCriteria: [], steps: [{ ...base,
      input: { ...base.input, args: ['status'] } }] })).toThrow(/steps\[0\]\.input/);
  });

  it('does not guess nonempty argument objects or accept unbounded file briefs', () => {
    const launch = { id: 'launch', capabilityKey: 'process.launch', description: 'Open app', dependsOn: [],
      input: { applicationName: 'Demo', args: { unknown: 'value' } } };
    expect(() => parsePlannerDecision({ status: 'ready', acceptanceCriteria: [], steps: [launch] }))
      .toThrow(/steps\[0\]\.input\.args/);
    const write = { id: 'write', capabilityKey: 'filesystem.write_text', description: 'Create file', dependsOn: [],
      input: { path: 'D:/demo/result.txt', generation: { instruction: 'A'.repeat(2_001) } } };
    expect(() => parsePlannerDecision({ status: 'ready', acceptanceCriteria: [], steps: [write] }))
      .toThrow(/steps\[0\]\.input\.generation\.instruction/);
  });

  it('rejects an object element in process arguments with a field path', () => {
    expect(() => parsePlannerDecision({
      status: 'ready', acceptanceCriteria: [],
      steps: [{ id: 'launch-1', capabilityKey: 'process.launch', description: 'Open app', dependsOn: [],
        input: { applicationName: '网易云音乐', args: [{}] } }],
    })).toThrow(/steps\[0\]\.input\.args/);
  });

  it('flattens bounded dynamic capability arguments before execution', () => {
    const plan = parsePlannerDecision({ status: 'ready', acceptanceCriteria: [], steps: [{ id: 'custom',
      capabilityKey: 'dynamic.text.transform', description: 'Transform text', dependsOn: [],
      input: { dynamicArgs: { text: 'hello', mode: 'upper' } } }] });
    expect(plan.steps[0]?.input).toEqual({ text: 'hello', mode: 'upper' });
  });

  it('rejects duplicate ids, unknown dependencies, and dependency cycles', () => {
    const step = (id: string, dependsOn: string[] = []) => ({
      id, capabilityKey: 'filesystem.mkdir', description: 'Create a folder', dependsOn, input: { path: 'D:/demo' },
    });
    expect(() => parsePlannerDecision({ status: 'ready', acceptanceCriteria: [], steps: [step('one'), step('one')] })).toThrow(/duplicate/i);
    expect(() => parsePlannerDecision({ status: 'ready', acceptanceCriteria: [], steps: [step('one', ['absent'])] })).toThrow(/unknown dependency/i);
    expect(() => parsePlannerDecision({ status: 'ready', acceptanceCriteria: [], steps: [step('one', ['two']), step('two', ['one'])] })).toThrow(/cycle/i);
  });

  it('requires a real answer in answer mode', () => {
    expect(() => parsePlannerDecision({ status: 'answer', acceptanceCriteria: [], steps: [], answer: '' })).toThrow(/answer/);
    expect(parsePlannerDecision({ status: 'answer', acceptanceCriteria: [], steps: [], answer: '你好' }).answer).toBe('你好');
  });

  it('accepts the casual flag on greeting answers but only as a boolean', () => {
    const casual = parsePlannerDecision({ status: 'answer', acceptanceCriteria: [], steps: [], answer: '你好小明！', casual: true });
    expect(casual.casual).toBe(true);
    expect(parsePlannerDecision({ status: 'answer', acceptanceCriteria: [], steps: [], answer: '你好', casual: false }).casual).toBe(false);
    expect(() => parsePlannerDecision({ status: 'answer', acceptanceCriteria: [], steps: [], answer: '你好', casual: 'yes' as unknown as boolean }))
      .toThrow();
  });

  it('rejects placeholder credentials before any network request is executed', () => {
    for (const url of [
      'https://weather.example.test/current?appid=YOUR_API_KEY',
      'https://weather.example.test/current?key=%3CAPI_KEY%3E',
      'https://weather.example.test/current?latitude={latitude}',
    ]) {
      expect(() => parsePlannerDecision({ status: 'ready', acceptanceCriteria: [],
        steps: [{ id: 'weather', capabilityKey: 'network.request', description: 'Fetch weather', dependsOn: [],
          input: { url, method: 'GET' } }] })).toThrow(/steps\[0\]\.input.*placeholder/);
    }
  });
});
