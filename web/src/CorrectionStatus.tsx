export type PublicCorrection = {
  roundsUsed: number;
  maxRounds: number;
  currentOrdinal?: number;
  target?: 'answer' | 'plan_or_input' | 'generated_tool';
  phase?: 'dispatch' | 'implement' | 'test' | 'evaluate';
  lastFailure?: { code: string; reason: string };
};

const targets: Record<NonNullable<PublicCorrection['target']>, string> = {
  answer: '回答', plan_or_input: '计划与输入', generated_tool: '生成工具',
};
const phases: Record<NonNullable<PublicCorrection['phase']>, string> = {
  dispatch: '正在安排修正', implement: '正在实施修正', test: '正在验证', evaluate: '正在评估',
};

export function CorrectionStatus({ correction }: { correction: PublicCorrection }) {
  if (!correction.currentOrdinal && correction.roundsUsed === 0) return null;
  return (
    <article className="correction-status" aria-label="纠正进度" role="status">
      <strong>{correction.currentOrdinal
        ? `第 ${correction.currentOrdinal}/${correction.maxRounds} 轮纠正`
        : `已完成 ${correction.roundsUsed}/${correction.maxRounds} 轮纠正`}</strong>
      {correction.target ? <span>{targets[correction.target]}</span> : null}
      {correction.phase ? <span>{phases[correction.phase]}</span> : null}
      {correction.lastFailure ? <small>上轮问题：{correction.lastFailure.reason}</small> : null}
    </article>
  );
}
