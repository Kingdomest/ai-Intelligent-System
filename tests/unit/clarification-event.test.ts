import { describe, expect, it } from 'vitest';
import { publicTaskEvent } from '../../src/runtime/event-projection.js';

describe('clarification projection', () => {
  it('shows the actual question and three choices without exposing unrelated payload fields', () => {
    const event = publicTaskEvent({ type: 'task.needs_user_input', payload: {
      request: { question: '你想查询广东哪个城市？', requiredFields: [{ name: 'city', reason: '具体城市', sensitive: false }],
        options: [{ label: '广州', value: '广州' }, { label: '深圳', value: '深圳' },
          { label: '东莞', value: '东莞' }], resumeToken: 'private-token' }, secret: 'private-data',
    } });
    expect(event.payload.request).toMatchObject({ question: '你想查询广东哪个城市？',
      options: [{ label: '广州', value: '广州' }, { label: '深圳', value: '深圳' }, { label: '东莞', value: '东莞' }] });
    expect(JSON.stringify(event.payload)).not.toContain('private-token');
    expect(JSON.stringify(event.payload)).not.toContain('private-data');
  });

  it('does not publish model-suggested values for a sensitive field', () => {
    const event = publicTaskEvent({ type: 'task.needs_user_input', payload: { request: {
      question: '请输入凭据', requiredFields: [{ name: 'credential', reason: '需要', sensitive: true }],
      options: [{ label: 'secret', value: 'secret' }],
    } } });
    expect((event.payload.request as { options: unknown[] }).options).toEqual([]);
  });
});
