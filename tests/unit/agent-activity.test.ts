import { describe, expect, it } from 'vitest';
import { summarizeAgentActivity } from '../../web/src/agent-activity.js';

describe('summarizeAgentActivity', () => {
  it('shows only agents that actually made model calls and counts calls once', () => {
    const result = summarizeAgentActivity([
      { type: 'agent.activity', payload: { runId: '1', role: 'planner.route', status: 'running' } },
      { type: 'agent.activity', payload: { runId: '1', role: 'planner.route', status: 'completed' } },
      { type: 'agent.activity', payload: { runId: '2', role: 'planner', status: 'running' } },
      { type: 'agent.activity', payload: { runId: '3', role: 'tester.plan', status: 'running' } },
      { type: 'agent.activity', payload: { runId: '3', role: 'tester.plan', status: 'failed' } },
    ]);
    expect(result).toEqual([
      { role: 'planner', label: '规划 Agent', status: 'running', calls: 2 },
      { role: 'tester', label: '测试 Agent', status: 'failed', calls: 1 },
    ]);
  });

  it('keeps a role active while another call from the same role is still running', () => {
    expect(summarizeAgentActivity([
      { type: 'agent.activity', payload: { runId: '1', role: 'planner.route', status: 'running' } },
      { type: 'agent.activity', payload: { runId: '2', role: 'planner', status: 'running' } },
      { type: 'agent.activity', payload: { runId: '1', role: 'planner.route', status: 'completed' } },
    ])[0]).toMatchObject({ role: 'planner', status: 'running', calls: 2 });
  });
});
