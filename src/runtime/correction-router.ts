import { z } from 'zod';
import type { CorrectionFailure } from '../domain/contracts.js';

export const correctionDecisionSchema = z.strictObject({
  action: z.enum(['revise_answer', 'revise_plan_or_input', 'rebuild_generated_tool', 'ask_user', 'block']),
  reason: z.string().trim().min(1).max(300),
});

export type CorrectionDecision = z.infer<typeof correctionDecisionSchema>;

export interface CorrectionEvidence {
  sourceTaskId?: string;
  confirmedToolDefect: boolean;
  safeToReplay: boolean;
}

export type FailureCategory = 'model_timeout' | 'permission' | 'uncertain_effect'
  | 'tool_contract' | 'input' | 'verification' | 'execution';

/** Route by failure class, not by the model's free-form explanation alone. */
export function classifyCorrectionFailure(failure: CorrectionFailure): FailureCategory {
  if (/\b(?:MODEL_)?TIMEOUT\b|\btimed out during\b/i.test(`${failure.code} ${failure.reason}`)) return 'model_timeout';
  if (/^(?:APPROVAL_REQUIRED|PERMISSION_DENIED|UNDECLARED_PERMISSION)$/.test(failure.code)) return 'permission';
  if (/^(?:OPERATION_UNKNOWN|HOST_OPERATION_UNCERTAIN)$/.test(failure.code)) return 'uncertain_effect';
  if (failure.stage === 'tool') return 'tool_contract';
  if (failure.stage === 'plan' || /(?:INVALID|MISSING|BAD_PATH|INPUT)/.test(failure.code)) return 'input';
  if (failure.stage === 'test' || failure.stage === 'answer') return 'verification';
  return 'execution';
}

export function routeCorrection(decision: CorrectionDecision, evidence: CorrectionEvidence): CorrectionDecision {
  if (decision.action === 'rebuild_generated_tool'
    && (evidence.sourceTaskId === 'builtin' || !evidence.sourceTaskId || !evidence.confirmedToolDefect)) {
    return { action: 'block', reason: '没有确认生成工具的确定性缺陷，不能停用当前能力。' };
  }
  if (!evidence.safeToReplay && (decision.action === 'rebuild_generated_tool' || decision.action === 'revise_plan_or_input')) {
    return { action: 'block', reason: '已执行的宿主操作不能安全重放。' };
  }
  return decision;
}

export function sanitizeCorrectionFailure(failure: CorrectionFailure): CorrectionFailure {
  const code = /^[A-Z][A-Z0-9_]{1,80}$/.test(failure.code) ? failure.code : 'EVALUATION_FAILED';
  const firstLine = failure.reason.split(/[\r\n]/, 1)[0] ?? '';
  const reason = firstLine
    .replace(/\b(?:token|api[_-]?key|password|secret|authorization)\s*[:=]\s*[^\s;]+/gi, '[credential redacted]')
    .replace(/[A-Za-z]:\\(?:[^\s;]+\\)*[^\s;]+/g, '[path redacted]')
    .replace(/\/(?:Users|home)\/[^\s;]+/g, '[path redacted]')
    .slice(0, 240).trim() || '评估未提供可执行的错误信息';
  return { ...failure, code, reason,
    stepId: failure.stepId?.slice(0, 80), capabilityId: failure.capabilityId?.slice(0, 120), version: failure.version?.slice(0, 40) };
}

/** Persistence and polling never retain evaluator/tool free text; only typed metadata. */
export function persistableCorrectionFailure(failure: CorrectionFailure): CorrectionFailure {
  const safe = sanitizeCorrectionFailure(failure);
  const stageReason: Record<CorrectionFailure['stage'], string> = {
    plan: '任务计划未通过验证', tool: '工具契约或测试未通过验证',
    execution: '任务执行未通过验证', test: '测试未通过或证据不足',
    answer: '最终回答未满足验收条件',
  };
  return { ...safe, reason: `${stageReason[safe.stage]}（${safe.code}）` };
}
