import { describe, expect, it } from 'vitest';
import { parsePlannerDecision } from '../../src/agents/planner-contract.js';

describe('planner contract', () => {
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
  it('unwraps explicit typed values before launch input reaches a host call', () => {
    const plan = parsePlannerDecision({
      status: 'ready', acceptanceCriteria: [],
      steps: [{ id: 'launch-1', capabilityKey: 'process.launch', description: 'Open app', dependsOn: [],
        input: { applicationName: { type: 'string', value: '网易云音乐' }, args: { type: 'array', value: [] } } }],
    });
    expect(plan.steps[0]?.input).toEqual({ applicationName: '网易云音乐', args: [] });
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
