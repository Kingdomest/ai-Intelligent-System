import { useState } from 'react';

export function CompactionDivider({ content, createdAt }: { content: string; createdAt: string }) {
  const [expanded, setExpanded] = useState(false);
  const count = content.length;
  return (
    <div className="compaction-divider">
      <span className="compaction-divider-line" aria-hidden="true" />
      <button type="button" className="compaction-divider-toggle" aria-expanded={expanded}
        onClick={() => setExpanded(current => !current)}>
        ⏳ 此前的对话已压缩为摘要 · {new Date(createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {expanded ? '收起' : '查看摘要'}
      </button>
      {expanded ? (
        <div className="compaction-summary" role="note">
          <p className="compaction-summary-note">由系统生成的会话检查点，供回溯参考，不作为原始对话。</p>
          <pre>{content}</pre>
        </div>
      ) : null}
      <span className="compaction-divider-line" aria-hidden="true" />
      <span className="visually-hidden">{`压缩于 ${createdAt}，包含约 ${count} 字摘要`}</span>
    </div>
  );
}
