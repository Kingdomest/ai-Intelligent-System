export function MemoryGauge({ used, budget, compacting, onCompact, disabled }: {
  used: number;
  budget: number;
  compacting: boolean;
  onCompact: () => void;
  disabled: boolean;
}) {
  const ratio = budget > 0 ? Math.min(1, used / budget) : 0;
  const level = ratio > 0.8 ? 'is-high' : ratio > 0.6 ? 'is-warm' : '';
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const formatted = (tokens: number) => tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
  return (
    <div className={`memory-gauge ${level}`} title={`会话记忆占用 ${formatted(used)} / ${formatted(budget)} tokens`}>
      <svg viewBox="0 0 26 26" width="26" height="26" aria-hidden="true">
        <circle className="memory-gauge-track" cx="13" cy="13" r={radius} fill="none" strokeWidth="3" />
        <circle className="memory-gauge-value" cx="13" cy="13" r={radius} fill="none" strokeWidth="3"
          strokeDasharray={`${(ratio * circumference).toFixed(1)} ${circumference.toFixed(1)}`}
          transform="rotate(-90 13 13)" />
      </svg>
      <span className="memory-gauge-label">{formatted(used)} / {formatted(budget)}</span>
      <button type="button" className="memory-gauge-compact" onClick={onCompact}
        disabled={disabled || compacting}>
        {compacting ? '压缩中…' : '压缩会话'}
      </button>
    </div>
  );
}
