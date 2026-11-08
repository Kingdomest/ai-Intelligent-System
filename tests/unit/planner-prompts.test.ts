import { describe, expect, it } from 'vitest';
import { buildPlannerRouteSystem, buildPlannerSystem, selectPlannerScenario } from '../../src/agents/planner-prompts.js';

describe('planner prompt composition', () => {
  it('selects the relevant task scenario and keeps unrelated rules out', () => {
    const weather = selectPlannerScenario({ message: '广东天气怎么样', requestStatus: 'needs_user_input',
      diagnosticReady: false, softwareBuild: false });
    const software = selectPlannerScenario({ routed: 'files', message: '请开发一个小程序', requestStatus: 'ready',
      diagnosticReady: false, softwareBuild: true });
    const common = { requestStatus: 'ready' as const, hasSessionMemory: false,
      hasDiagnosticContext: false, hasResearch: false, hasFeedback: false };
    const weatherPrompt = buildPlannerSystem({ ...common, scenario: weather });
    const softwarePrompt = buildPlannerSystem({ ...common, scenario: software });
    expect(weather).toBe('weather');
    expect(software).toBe('software');
    expect(weatherPrompt).toContain('Open-Meteo');
    expect(weatherPrompt).not.toContain('file-specific instruction');
    expect(softwarePrompt).toContain('file-specific instruction');
    expect(softwarePrompt).not.toContain('Open-Meteo');
    expect(selectPlannerScenario({ message: '天气和气候有什么区别？', requestStatus: 'answer',
      diagnosticReady: false, softwareBuild: false })).toBe('conversation');
  });

  it('keeps routing concise and only includes context that exists', () => {
    const route = buildPlannerRouteSystem();
    const answer = buildPlannerSystem({ scenario: 'conversation', requestStatus: 'answer',
      hasSessionMemory: false, hasDiagnosticContext: false, hasResearch: false, hasFeedback: false });
    expect(route).toContain('latest userInputs');
    expect(route.length).toBeLessThan(2_000);
    expect(answer).not.toContain('Built-in keys');
    expect(answer).not.toContain('diagnosticContext is verified runtime failure evidence');
  });

  it('routes current hiring research to web even if a model calls it a general answer', () => {
    expect(selectPlannerScenario({ routed: 'general', message: '帮我做一份真实的市场调研，看看当前 Java 岗位招聘怎么样',
      requestStatus: 'answer', diagnosticReady: false, softwareBuild: false })).toBe('web');
  });
});
