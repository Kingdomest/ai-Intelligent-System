import { describe, expect, it } from 'vitest';
import { AgentRunner } from '../../src/agents/agent-runner.js';
import { allowsIllustrativeMetrics, maskUnsupportedNumbers } from '../../src/presentations/draft.js';
import { draftLongPresentation } from '../../src/presentations/draft.js';
import { ModelGateway, type ModelRequest } from '../../src/model/gateway.js';

const brief = '请生成一份员工转正述职 PPT 的完整文案与页面结构，共 12 页，每页 3-5 条核心内容、配图建议、演讲备注。'
  + '第1页：封面 第2页：目录 第3页：自我介绍 第4页：工作职责 第5页：主要工作 第6页：项目成果 '
  + '第7页：协作经验 第8页：数据汇总 第9页：个人成长 第10页：不足与改进 第11页：未来计划 第12页：致谢。'
  + '最后给出 800-1000 字述职演讲逐字稿。请只给文案，不生成文件。';

describe('long presentation copy generation', () => {
  it('masks invented metrics while preserving user-supplied dates and numeric facts', () => {
    const input = '留存率从65%提升到82%，ROI 1:3.5，新增3000+用户；入职2026年3月，试用期6个月。';
    const briefWithFacts = '【基本信息】入职时间：2026年3月；试用期：6个月。';
    const result = maskUnsupportedNumbers(input, briefWithFacts);
    expect(result).not.toMatch(/65%|82%|1:3\.5|3000\+/);
    expect(result).toContain('2026年3月');
    expect(result).toContain('6个月');
    expect(result).toContain('【待补充真实数据】');
    expect(maskUnsupportedNumbers('真实留存率为65%', '真实留存率为65%')).toBe('真实留存率为65%');
  });

  it('does not pass invented performance figures into the final draft', async () => {
    const gateway = new ModelGateway({ complete: async request => {
      const data = JSON.parse(request.user) as { pageNumbers?: number[] };
      return { data: request.role === 'presentation.draft_pages'
        ? { pages: data.pageNumbers!.map(number => ({ number, title: `页面${number}`,
          bullets: ['留存率从65%提升到82%', '新增3000+用户', '完成日常工作'],
          visualSuggestion: 'ROI 1:3.5图表', speakerNotes: '现场说明成果' })) }
        : { speech: '留存率提升到82%，新增3000+用户。'.repeat(40) },
      usage: { inputTokens: 1, outputTokens: 1 } };
    } });
    const result = await draftLongPresentation(brief, 'mask-test', gateway);
    expect(result.answer).toContain('【待补充真实数据】');
    expect(result.answer).not.toMatch(/65%|82%|3000\+|1:3\.5/);
  });

  it('respects explicit permission for illustrative metrics and labels the result', async () => {
    const permitted = `${brief} 数据可以合理虚构，但要真实可信、前后一致。`;
    expect(allowsIllustrativeMetrics(permitted)).toBe(true);
    const gateway = new ModelGateway({ complete: async request => {
      const data = JSON.parse(request.user) as { pageNumbers?: number[] };
      return { data: request.role === 'presentation.draft_pages'
        ? { pages: data.pageNumbers!.map(number => ({ number, title: `页面${number}`,
          bullets: ['留存率从65%提升到82%', '新增3000+用户', '完成日常工作'],
          visualSuggestion: 'ROI 1:3.5图表', speakerNotes: '现场说明成果' })) }
        : { speech: '留存率提升到82%，新增3000+用户。'.repeat(40) },
      usage: { inputTokens: 1, outputTokens: 1 } };
    } });
    const result = await draftLongPresentation(permitted, 'sample-data', gateway);
    expect(result.answer).toContain('模拟示例');
    expect(result.answer).toContain('65%');
    expect(result.answer).toContain('82%');
  });
  it('uses bounded page groups and speech requests instead of one huge planner JSON', async () => {
    const roles: string[] = [];
    const gateway = new ModelGateway({ complete: async (request: ModelRequest) => {
      roles.push(request.role);
      const data = JSON.parse(request.user) as { pageNumbers?: number[] };
      if (request.role === 'presentation.draft_pages') return {
        data: { pages: data.pageNumbers!.map(number => ({ number, title: `页面${number}`,
          bullets: ['工作目标', '实施动作', '实际结果'], visualSuggestion: '简洁图表', speakerNotes: '自然讲述' })) },
        usage: { inputTokens: 5, outputTokens: 50 },
      };
      if (request.role === 'presentation.draft_speech') return {
        data: { speech: '这是适合现场汇报的逐字稿。'.repeat(64) },
        usage: { inputTokens: 5, outputTokens: 50 },
      };
      throw new Error(`Unexpected model role: ${request.role}`);
    } });
    const decision = await new AgentRunner(gateway).runPlanner({ taskId: 'long-draft', message: brief, attachments: [] });
    expect(decision.status).toBe('answer');
    expect(decision.answer).toContain('第12页｜页面12');
    expect(decision.answer).toContain('述职演讲逐字稿');
    expect(roles).toEqual([
      'presentation.draft_pages', 'presentation.draft_pages', 'presentation.draft_pages',
      'presentation.draft_pages', 'presentation.draft_speech',
    ]);
  });

  it('handles a full brief supplied after a short retry message', async () => {
    const requests: string[] = [];
    const gateway = new ModelGateway({ complete: async request => {
      requests.push(request.role);
      const data = JSON.parse(request.user) as { pageNumbers?: number[] };
      return { data: request.role === 'presentation.draft_pages'
        ? { pages: data.pageNumbers!.map(number => ({ number, title: `页面${number}`,
          bullets: ['具体目标', '执行行动', '实际结果'], visualSuggestion: '图表示意', speakerNotes: '现场说明' })) }
        : { speech: '我们完成了既定目标。'.repeat(90) }, usage: { inputTokens: 1, outputTokens: 1 } };
    } });
    const message = `重试\n用户补充信息：${JSON.stringify({ answer: brief })}`;
    const decision = await new AgentRunner(gateway).runPlanner({ taskId: 'retry-draft', message, attachments: [] });
    expect(decision.status).toBe('answer');
    expect(requests).not.toContain('planner');
    expect(requests).not.toContain('planner.route');
  });

  it('sends evaluator feedback to bounded draft generation during correction', async () => {
    let seenFeedback: string | undefined;
    const gateway = new ModelGateway({ complete: async request => {
      const input = JSON.parse(request.user) as { pageNumbers?: number[]; correctionFeedback?: string };
      seenFeedback = input.correctionFeedback;
      return { data: request.role === 'presentation.draft_pages'
        ? { pages: input.pageNumbers!.map(number => ({ number, title: `页面${number}`,
          bullets: ['具体目标', '执行行动', '实际结果'], visualSuggestion: '图表示意', speakerNotes: '现场说明' })) }
        : { speech: '我们完成了既定目标。'.repeat(90) }, usage: { inputTokens: 1, outputTokens: 1 } };
    } });
    const answer = await new AgentRunner(gateway).runDraftCorrection({ taskId: 'draft-revision', message: brief,
      acceptanceCriteria: [], results: [], previousAnswer: '初稿', feedback: {
        stage: 'answer', code: 'DETAIL_MISSING', reason: 'Add practical details to page 8.',
      } });
    expect(answer).toContain('第8页｜页面8');
    expect(seenFeedback).toBe('Add practical details to page 8.');
  });
});
