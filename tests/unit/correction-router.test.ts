import { describe, expect, it } from 'vitest';
import { classifyCorrectionFailure, routeCorrection, sanitizeCorrectionFailure } from '../../src/runtime/correction-router.js';

describe('correction router', () => {
  it('distinguishes model delays from bad arguments, unverified effects, and tool defects', () => {
    expect(classifyCorrectionFailure({ stage: 'execution', code: 'EXECUTION_ERROR',
      reason: 'Ollama request timed out during evaluator after 180000ms.' })).toBe('model_timeout');
    expect(classifyCorrectionFailure({ stage: 'execution', code: 'BAD_PATH', reason: 'Wrong destination' })).toBe('input');
    expect(classifyCorrectionFailure({ stage: 'execution', code: 'OPERATION_UNKNOWN', reason: 'Unknown outcome' })).toBe('uncertain_effect');
    expect(classifyCorrectionFailure({ stage: 'tool', code: 'CAPABILITY_ERROR', reason: 'Bad interface' })).toBe('tool_contract');
  });
  it('does not deprecate a builtin or an unproven generated tool on model suspicion', () => {
    const proposal = { action: 'rebuild_generated_tool' as const, reason: 'tool looks wrong' };
    expect(routeCorrection(proposal, { sourceTaskId: 'builtin', confirmedToolDefect: true, safeToReplay: true }).action)
      .not.toBe('rebuild_generated_tool');
    expect(routeCorrection(proposal, { sourceTaskId: 'earlier-task', confirmedToolDefect: false, safeToReplay: true }).action)
      .not.toBe('rebuild_generated_tool');
  });

  it('permits a proven generated-tool defect but blocks unsafe host replay', () => {
    const proposal = { action: 'rebuild_generated_tool' as const, reason: 'contract mismatch' };
    expect(routeCorrection(proposal, { sourceTaskId: 'earlier-task', confirmedToolDefect: true, safeToReplay: true }).action)
      .toBe('rebuild_generated_tool');
    expect(routeCorrection(proposal, { sourceTaskId: 'earlier-task', confirmedToolDefect: true, safeToReplay: false }).action)
      .toBe('block');
    expect(routeCorrection({ action: 'revise_answer', reason: 'missing section' },
      { sourceTaskId: 'earlier-task', confirmedToolDefect: false, safeToReplay: false }).action)
      .toBe('revise_answer');
  });

  it('redacts secrets and absolute paths from persisted evaluator failures', () => {
    const failure = sanitizeCorrectionFailure({ stage: 'answer', code: 'ANSWER_MISMATCH',
      reason: 'Missing section in C:\\Users\\Alice\\Desktop\\secret.md; token=very-secret-123\nfile body follows' });
    expect(failure.code).toBe('ANSWER_MISMATCH');
    expect(failure.reason).toContain('Missing section');
    expect(failure.reason).not.toContain('very-secret-123');
    expect(failure.reason).not.toContain('Alice');
    expect(failure.reason).not.toContain('file body follows');
  });
});
