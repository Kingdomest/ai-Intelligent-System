import { describe, expect, it } from 'vitest';
import { AgentRunner } from '../../src/agents/agent-runner.js';
import { ModelGateway } from '../../src/model/gateway.js';
import { MockModelProvider } from '../../src/model/mock-provider.js';
import type { ModelProvider } from '../../src/model/gateway.js';

function createRunner() {
  return new AgentRunner(new ModelGateway(new MockModelProvider()));
}

function branchSchema(schema: unknown, status: string): any {
  const json = schema as any;
  return (json.oneOf ?? json.anyOf)?.find((branch: any) => branch.properties.status.const === status) ?? json;
}

describe('AgentRunner', () => {
  it('uses the routed scenario to compose a focused planner system prompt', async () => {
    let plannerSystem = '';
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      if (request.role === 'planner.route') return { data: { status: 'ready', scenario: 'web' },
        usage: { inputTokens: 1, outputTokens: 1 } };
      plannerSystem = request.system;
      return { data: { status: 'ready', intent: 'read public data', acceptanceCriteria: ['data retrieved'],
        requiredCapabilities: [], steps: [{ id: 'fetch', capabilityKey: 'network.request', description: 'Fetch data',
          dependsOn: [], input: { url: 'https://example.org/data', method: 'GET' } }] },
      usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    await runner.runPlanner({ taskId: 'web-data', message: '查询最新公开数据', attachments: [] });
    expect(plannerSystem).toContain('credential-free sources');
    expect(plannerSystem).not.toContain('Open-Meteo');
    expect(plannerSystem).not.toContain('file-specific instruction');
  });

  it('removes an unrequested saved report from a live research plan', async () => {
    const runner = new AgentRunner(new ModelGateway({ complete: async request => ({
      data: request.role === 'planner.route' ? { status: 'ready', scenario: 'web' }
        : { status: 'ready', intent: 'research hiring',
          acceptanceCriteria: ['Retrieve public evidence', 'Save the report to the desktop'],
          requiredCapabilities: [{ name: 'filesystem.write_text', purpose: 'Save report', riskLevel: 'medium' }],
          steps: [
            { id: 'fetch', capabilityKey: 'network.request', description: 'Fetch evidence', dependsOn: [],
              input: { url: 'https://example.org/data', method: 'GET' } },
            { id: 'report', capabilityKey: 'filesystem.write_text', description: 'Save report', dependsOn: ['fetch'],
              input: { path: 'C:/Users/Example/Desktop/report.md', content: 'Unsupported result' } },
          ] }, usage: { inputTokens: 1, outputTokens: 1 },
    }) }));
    const plan = await runner.runPlanner({ taskId: 'research', message: '调研当前 Java 岗位招聘情况', attachments: [] });
    expect(plan.steps.map(step => step.capabilityKey)).toEqual(['network.request']);
    expect(plan.acceptanceCriteria).toEqual(['Retrieve public evidence']);
  });

  it('does not permit a direct answer when routing identifies a live-data scenario', async () => {
    const requests: import('../../src/model/gateway.js').ModelRequest[] = [];
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      requests.push(request);
      return { data: request.role === 'planner.route' ? { status: 'answer', scenario: 'weather' }
        : { status: 'ready', intent: 'weather', acceptanceCriteria: ['fetch current conditions'],
          requiredCapabilities: [], steps: [{ id: 'weather', capabilityKey: 'network.request',
            description: 'Fetch current weather', dependsOn: [], input: { url: 'https://example.org/weather', method: 'GET' } }] },
      usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    const plan = await runner.runPlanner({ taskId: 'weather-guard', message: '深圳现在天气如何', attachments: [] });
    expect(plan.status).toBe('ready');
    expect(requests.find(request => request.role === 'planner')?.system).toContain('Open-Meteo');
    expect(JSON.parse(requests.find(request => request.role === 'planner')!.user).requestStatus).toBe('ready');
  });

  it('asks again when a custom answer does not satisfy the previous question', async () => {
    const requests: import('../../src/model/gateway.js').ModelRequest[] = [];
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      requests.push(request);
      return { data: { status: 'ready', scenario: 'weather', clarificationValid: false,
        followUpQuestion: '请提供广东省内的具体城市，例如广州或深圳。' },
      usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    const options = [{ label: '广州', value: '广州' }, { label: '深圳', value: '深圳' }, { label: '东莞', value: '东莞' }];
    const plan = await runner.runPlanner({ taskId: 'weather-followup',
      message: '广东天气怎么样\n用户补充信息：{"answer":"广东"}', attachments: [],
      clarification: { question: '你想查广东哪个城市？',
        requiredFields: [{ name: 'city', reason: '需要城市', sensitive: false }], options } });
    expect(plan.status).toBe('needs_user_input');
    expect(plan.inputRequest?.question).toContain('具体城市');
    expect(plan.inputRequest?.options).toEqual(options);
    expect(requests.map(request => request.role)).toEqual(['planner.route']);
  });

  it('recovers from one malformed routing response before planning', async () => {
    let routes = 0;
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      if (request.role === 'planner.route') {
        routes += 1;
        return { data: routes === 1 ? { status: 'invalid' } : { status: 'answer' },
          usage: { inputTokens: 1, outputTokens: 1 } };
      }
      return { data: { status: 'answer', intent: 'greeting', answer: '你好',
        acceptanceCriteria: [], requiredCapabilities: [], steps: [] },
      usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    expect((await runner.runPlanner({ taskId: 'route-repair', message: '你好', attachments: [] })).answer).toBe('你好');
    expect(routes).toBe(2);
  });

  it('searches the prior news topic when a follow-up corrects the year', async () => {
    const prior = '前段时间，华为的汽车踏板踩断事件影响很大，你跟我说下那个事情发生了什么';
    const followup = '不是的，是2026年的事件';
    const runner = new AgentRunner(new ModelGateway({ complete: async () => {
      throw new Error('The correction must not be answered from model memory.');
    } }));
    const plan = await runner.runPlanner({ taskId: 'followup', message: followup, attachments: [], permissionMode: 'request',
      sessionMemory: { summarySeq: 0, tokens: 0, turns: [
        { seq: 1, role: 'user', content: prior, taskId: 'earlier' },
        { seq: 2, role: 'assistant', content: '错误的旧回答', taskId: 'earlier' },
        { seq: 3, role: 'user', content: followup, taskId: 'followup' },
      ] } });
    expect(plan.status).toBe('ready');
    expect(new URL(plan.steps[0]!.input!.url as string).searchParams.get('q')).toBe(`${prior} 2026`);
    expect(plan.acceptanceCriteria.join(' ')).toContain('华为的汽车踏板踩断事件');
  });

  it('grounds a knowledge answer in searched sources when research is available', async () => {
    const requests: import('../../src/model/gateway.js').ModelRequest[] = [];
    const queries: string[] = [];
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      requests.push(request);
      return { data: request.role === 'planner.route'
        ? { status: 'answer', researchQueries: ['TypeScript official fetch docs'] }
        : { status: 'answer', intent: 'explain fetch', acceptanceCriteria: [], requiredCapabilities: [],
          steps: [], answer: '参考官方文档：fetch 返回 Promise。' },
      usage: { inputTokens: 1, outputTokens: 1 } };
    } }), { search: async query => {
      queries.push(query);
      return [{ title: 'Fetch docs', url: 'https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch',
        description: 'The fetch() method starts the process of fetching a resource.' }];
    } });
    await runner.runPlanner({ taskId: 'research-answer', message: '解释 fetch 用法', attachments: [], permissionMode: 'auto' });
    expect(queries).toEqual(['TypeScript official fetch docs']);
    expect(requests.find(request => request.role === 'planner')?.user).toContain('developer.mozilla.org');
  });

  it('researches uncertain file APIs in auto mode but makes no search in request mode', async () => {
    const queries: string[] = [];
    const requests: import('../../src/model/gateway.js').ModelRequest[] = [];
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      requests.push(request);
      return { data: request.role === 'implementer.research'
        ? { queries: ['Vite current configuration official docs'] }
        : { content: 'export default {};' }, usage: { inputTokens: 1, outputTokens: 1 } };
    } }), { search: async query => {
      queries.push(query);
      return [{ title: 'Vite docs', url: 'https://vite.dev/config/', description: 'Configuration reference' }];
    } });
    const base = { taskId: 'research-file', message: '实现配置', path: 'vite.config.ts',
      instruction: 'Configure Vite.', files: [], previousFiles: [] };
    await runner.runFileImplementer({ ...base, permissionMode: 'auto' });
    expect(queries).toEqual(['Vite current configuration official docs']);
    expect(requests.at(-1)?.user).toContain('https://vite.dev/config/');
    const before = requests.length;
    await runner.runFileImplementer({ ...base, permissionMode: 'request' });
    expect(requests.length).toBe(before + 1);
    expect(queries).toHaveLength(1);
  });
  it('uses retained failure evidence for a repair request instead of asking the user to paste an error code', async () => {
    const requests: import('../../src/model/gateway.js').ModelRequest[] = [];
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      requests.push(request);
      const payload = JSON.parse(request.user) as { diagnosticContext?: { taskId?: string } };
      if (request.role === 'planner.route') {
        return { data: { status: payload.diagnosticContext?.taskId ? 'ready' : 'needs_user_input' },
          usage: { inputTokens: 1, outputTokens: 1 } };
      }
      if (request.role === 'planner') {
        return payload.diagnosticContext?.taskId
          ? { data: { status: 'ready', intent: 'repair the failed task', acceptanceCriteria: ['The failed task is repaired'],
              requiredCapabilities: [], steps: [{ id: 'inspect', capabilityKey: 'filesystem.read_text',
                description: 'Inspect the affected file', dependsOn: [], input: { path: 'D:/demo/app.ts' } }] },
            usage: { inputTokens: 1, outputTokens: 1 } }
          : { data: { status: 'needs_user_input', intent: 'repair', acceptanceCriteria: [], requiredCapabilities: [], steps: [],
              inputRequest: { taskId: 'repair', question: '请提供错误码', requiredFields: [], resumeToken: 'resume' } },
            usage: { inputTokens: 1, outputTokens: 1 } };
      }
      throw new Error(`Unexpected model role: ${request.role}`);
    } }));
    const plan = await runner.runPlanner({ taskId: 'repair', message: '请根据上轮错误日志排查并修复', attachments: [],
      diagnosticContext: { taskId: 'failed-task', status: 'FAILED', request: '创建 app.ts', result: '任务未完成：路径错误',
        entries: [{ kind: 'event', type: 'step.failed', createdAt: new Date().toISOString(), details: { failureCode: 'BAD_PATH' } }] } } as any);
    expect(plan.status).toBe('ready');
    const route = requests.find(request => request.role === 'planner.route');
    expect(route?.system).toMatch(/error code|log|错误码|日志/i);
    expect(JSON.parse(route!.user).diagnosticContext).toMatchObject({ taskId: 'failed-task' });
  });

  it('treats a generic “还是不行” follow-up as a repair when failure evidence is available', async () => {
    const requests: import('../../src/model/gateway.js').ModelRequest[] = [];
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      requests.push(request);
      if (request.role === 'planner.route') return { data: { status: 'needs_user_input' }, usage: { inputTokens: 1, outputTokens: 1 } };
      const payload = JSON.parse(request.user) as { requestStatus?: string };
      return payload.requestStatus === 'ready'
        ? { data: { status: 'ready', intent: 'inspect failure', acceptanceCriteria: ['Failure inspected'], requiredCapabilities: [],
            steps: [{ id: 'inspect', capabilityKey: 'filesystem.read_text', description: 'Inspect failure', dependsOn: [], input: { path: 'D:/demo/app.ts' } }] },
          usage: { inputTokens: 1, outputTokens: 1 } }
        : { data: { status: 'needs_user_input', intent: 'inspect', acceptanceCriteria: [], requiredCapabilities: [], steps: [],
            inputRequest: { taskId: 'repair', question: '请提供日志', requiredFields: [], resumeToken: 'resume' } },
          usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    const plan = await runner.runPlanner({ taskId: 'repair', message: '还是不行啊，整体排查下为什么，我觉得是新模型的问题', attachments: [],
      diagnosticContext: { taskId: 'failed-task', status: 'FAILED', request: '创建 app.ts', result: '任务超时', entries: [] } } as any);
    expect(plan.status).toBe('ready');
    expect(JSON.parse(requests.find(request => request.role === 'planner')!.user).requestStatus).toBe('ready');
  });

  it('re-prompts the planner when it still asks for diagnostic logs that are already available', async () => {
    let plannerCalls = 0;
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      if (request.role === 'planner.route') return { data: { status: 'ready' }, usage: { inputTokens: 1, outputTokens: 1 } };
      plannerCalls += 1;
      return plannerCalls === 1
        ? { data: { status: 'needs_user_input', intent: 'repair', acceptanceCriteria: [], requiredCapabilities: [], steps: [],
            inputRequest: { taskId: 'repair', question: '请提供错误码和日志', requiredFields: [], resumeToken: 'resume' } },
          usage: { inputTokens: 1, outputTokens: 1 } }
        : { data: { status: 'ready', intent: 'repair', acceptanceCriteria: ['Repair complete'], requiredCapabilities: [],
            steps: [{ id: 'inspect', capabilityKey: 'filesystem.read_text', description: 'Inspect affected file', dependsOn: [], input: { path: 'D:/demo/app.ts' } }] },
          usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    const plan = await runner.runPlanner({ taskId: 'repair', message: '根据上轮错误日志排查并修复', attachments: [],
      diagnosticContext: { taskId: 'failed-task', status: 'FAILED', request: '创建 app.ts', result: '路径错误', entries: [] } } as any);
    expect(plan.status).toBe('ready');
    expect(plannerCalls).toBe(2);
  });

  it('repairs a plan that attempts to read a directory before any host operation runs', async () => {
    let plans = 0;
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      if (request.role === 'planner.route') return { data: { status: 'ready' }, usage: { inputTokens: 1, outputTokens: 1 } };
      plans += 1;
      const steps: Array<{ id: string; capabilityKey: string; description: string; dependsOn: string[]; input: { path: string } }> = [{ id: 'mkdir', capabilityKey: 'filesystem.mkdir', description: 'Create folder',
        dependsOn: [], input: { path: 'D:/demo/folder' } }];
      if (plans === 1) steps.push({ id: 'verify', capabilityKey: 'filesystem.read_text',
        description: 'Read directory', dependsOn: ['mkdir'], input: { path: 'D:/demo/folder' } });
      return { data: { status: 'ready', intent: 'create folder', acceptanceCriteria: ['Folder exists'],
        requiredCapabilities: [], steps }, usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    const plan = await runner.runPlanner({ taskId: 'folder', message: '在 D:/demo 创建 folder 文件夹', attachments: [] });
    expect(plans).toBe(2);
    expect(plan.steps.map(step => step.id)).toEqual(['mkdir']);
  });
  it('requests a bounded current-step patch without sending completed file bodies or a full plan', async () => {
    const requests: import('../../src/model/gateway.js').ModelRequest[] = [];
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      requests.push(request);
      return { data: { changes: { path: 'D:\\demo\\fixed.md' } }, usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    const changes = await runner.runStepRepair({ taskId: 'repair', message: 'Fix the second file',
      step: { id: 'second', capabilityKey: 'filesystem.write_text', description: 'Write second file',
        input: { path: 'D:\\demo\\wrong.md', content: 'sensitive-file-body'.repeat(1000) } },
      failure: { stage: 'execution', code: 'BAD_PATH', reason: 'The path is wrong', stepId: 'second' },
      workspaceRoot: 'D:\\demo', desktopDirectory: 'C:\\Users\\Administrator\\Desktop',
      completedStepIds: ['first'] });
    expect(changes).toEqual({ path: 'D:\\demo\\fixed.md' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.role).toBe('planner.step_repair');
    expect(requests[0]?.maxOutputTokens).toBeLessThanOrEqual(1024);
    expect(requests[0]?.user).not.toContain('sensitive-file-body'.repeat(10));
    expect(requests[0]?.user).toContain('"completedStepIds":["first"]');
  });
  it('keeps a software build plan small and delegates each file body to the implementer', async () => {
    const requests: import('../../src/model/gateway.js').ModelRequest[] = [];
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      requests.push(request);
      return { data: request.role === 'planner.route' ? { status: 'ready' }
        : request.role === 'planner' ? { status: 'ready', intent: 'build minesweeper', acceptanceCriteria: ['Playable game'],
          requiredCapabilities: [], steps: [{ id: 'game', capabilityKey: 'filesystem.write_text',
            description: 'Create game logic', dependsOn: [],
            input: { path: 'D:/demo/game.js', generation: { instruction: 'Implement minesweeper logic.' } } }] }
          : { content: 'const mines = 10;' }, usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    const plan = await runner.runPlanner({ taskId: 'game', message: '做一个扫雷小游戏demo', attachments: [],
      workspaceRoot: 'D:/project', desktopDirectory: 'C:/Users/Test/Desktop' });
    expect(plan.steps[0]?.input).toHaveProperty('generation');
    const plannerRequest = requests.find(request => request.role === 'planner')!;
    expect(plannerRequest.maxOutputTokens).toBeLessThanOrEqual(4096);
    expect(plannerRequest.system).toContain('generation');
    const content = await runner.runFileImplementer({ taskId: 'game', message: '做一个扫雷小游戏demo',
      path: 'D:/demo/game.js', instruction: 'Implement minesweeper logic.',
      files: [{ path: 'D:/demo/game.js', instruction: 'Implement minesweeper logic.' }], previousFiles: [] });
    expect(content).toBe('const mines = 10;');
    expect(requests.at(-1)?.role).toBe('implementer.file');
  });

  it('sends a bounded planner grammar so open-ended inputs cannot trigger invented HTTP options', async () => {
    const requests: import('../../src/model/gateway.js').ModelRequest[] = [];
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      requests.push(request);
      return request.role === 'planner.route'
        ? { data: { status: 'ready' }, usage: { inputTokens: 1, outputTokens: 1 } }
        : { data: { status: 'ready', intent: 'fetch data', acceptanceCriteria: ['Data fetched'], requiredCapabilities: [],
            steps: [{ id: 'fetch', capabilityKey: 'network.request', description: 'Fetch data', dependsOn: [],
              input: { url: 'https://example.com', method: 'GET' } }] }, usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    await runner.runPlanner({ taskId: 'bounded-schema', message: '查一下数据', attachments: [] });
    const schema = requests.find(request => request.role === 'planner')?.outputSchema as any;
    const ready = branchSchema(schema, 'ready');
    const input = ready.properties.steps.items.properties.input;
    expect(input.additionalProperties).toBe(false);
    expect(input.properties).toHaveProperty('url');
    expect(input.properties).not.toHaveProperty('timeout');
  });

  it('rejects source code embedded in a software plan and asks the planner for a file brief', async () => {
    let plans = 0;
    const runner = new AgentRunner(new ModelGateway({ complete: async request => ({
      data: request.role === 'planner.route' ? { status: 'ready' } : {
        status: 'ready', intent: 'build game', acceptanceCriteria: ['Game exists'], requiredCapabilities: [],
        steps: [{ id: 'game', capabilityKey: 'filesystem.write_text', description: 'Create source', dependsOn: [],
          input: ++plans === 1 ? { path: 'D:/demo/game.js', content: 'const mines = 10;' }
            : { path: 'D:/demo/game.js', generation: { instruction: 'Implement minesweeper.' } } }],
      }, usage: { inputTokens: 1, outputTokens: 1 },
    }) }));
    const plan = await runner.runPlanner({ taskId: 'game', message: '做一个扫雷小游戏demo', attachments: [] });
    expect(plans).toBe(2);
    expect(plan.steps[0]?.input).toHaveProperty('generation');
  });
  it('routes pasted multi-page PPT copy directly to the maintained desktop capability', async () => {
    const runner = new AgentRunner(new ModelGateway({ complete: async () => {
      throw new Error('Pasted slide copy must not be regenerated as a model JSON payload');
    } }));
    const pasted = '### 转正述职 **第1页｜封面** - 核心内容： 1. 标题：试用期转正述职报告 2. 汇报人：李明'
      + ' - 配图/图表建议：简洁背景 **第2页｜工作成果** - 核心内容： 1. 完成用户调研 2. 推动流程改进'
      + ' - 演讲备注：按实际情况讲述';
    const decision = await runner.runPlanner({ taskId: 'task-12345678',
      message: `把这份ppt生成一份ppt文件，然后放到我的桌面上\n用户补充信息：${JSON.stringify({ answer: pasted })}`,
      attachments: [], workspaceRoot: 'C:\\project', desktopDirectory: 'C:\\Users\\Tester\\Desktop' });
    expect(decision.status).toBe('ready');
    expect(decision.steps).toHaveLength(1);
    expect(decision.steps[0]?.capabilityKey).toBe('presentation.create');
    expect(decision.steps[0]?.input?.path).toMatch(/^C:\\Users\\Tester\\Desktop\\.*\.pptx$/);
    expect(decision.steps[0]?.input?.slides).toEqual([
      { title: '封面', bullets: ['标题：试用期转正述职报告', '汇报人：李明'] },
      { title: '工作成果', bullets: ['完成用户调研', '推动流程改进'] },
    ]);
  });

  it('preserves slide copy pasted directly into the first user message', async () => {
    const runner = new AgentRunner(new ModelGateway({ complete: async () => {
      throw new Error('Directly pasted slides must bypass model JSON');
    } }));
    const decision = await runner.runPlanner({ taskId: 'direct-12345678',
      message: '把以下PPT生成文件放桌面：\n**第1页｜项目成果** - 核心内容： 1. 项目交付 2. 风险控制 '
        + '**第2页｜未来计划** - 核心内容： 1. 自动化测试 2. 迭代优化',
      attachments: [], workspaceRoot: 'C:\\project', desktopDirectory: 'C:\\Users\\Tester\\Desktop' });
    expect(decision.steps[0]?.input?.slides).toEqual([
      { title: '项目成果', bullets: ['项目交付', '风险控制'] },
      { title: '未来计划', bullets: ['自动化测试', '迭代优化'] },
    ]);
  });

  it('plans a new PPT topic as structured slides using the existing model provider', async () => {
    const roles: string[] = [];
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      roles.push(request.role);
      return { data: { slides: [
        { title: '冒险小说', bullets: ['荒野启程'] },
        { title: '故事脉络', bullets: ['主角寻找失落地图', '同伴化解危机'] },
      ] }, usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    const decision = await runner.runPlanner({ taskId: 'topic-12345678', message: '帮我做一份冒险小说题材的PPT文件，放在桌面',
      attachments: [], workspaceRoot: 'C:\\project', desktopDirectory: 'C:\\Users\\Tester\\Desktop' });
    expect(roles).toEqual(['presentation.plan']);
    expect(decision.steps[0]?.capabilityKey).toBe('presentation.create');
    expect((decision.steps[0]?.input?.slides as unknown[]).length).toBe(2);
  });
  it('asks the main agent for a structured correction decision with the concrete failure', async () => {
    const requests: import('../../src/model/gateway.js').ModelRequest[] = [];
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      requests.push(request);
      return { data: { action: 'revise_answer', reason: 'The third section is missing' },
        usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    const decision = await runner.runCorrection({ taskId: 'task-1', request: 'Summarize the guide',
      failure: { stage: 'answer', code: 'ANSWER_MISMATCH', reason: 'The third section is missing' },
      safeToReplay: false });
    expect(decision.action).toBe('revise_answer');
    expect(requests[0]?.role).toBe('planner.correction');
    expect(requests[0]?.user).toContain('The third section is missing');
  });

  it('reviews the global outcome while restoring completed steps without copying large file bodies', async () => {
    let reviewUser = '';
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      if (request.role === 'planner.review') {
        reviewUser = request.user;
        return { data: { action: 'replan', reason: 'The result points to a different source.' },
          usage: { inputTokens: 1, outputTokens: 1 } };
      }
      expect(request.role).toBe('planner.replan');
      return { data: { status: 'ready', intent: 'read the relevant source', acceptanceCriteria: ['Answer using evidence'],
        requiredCapabilities: [], steps: [{ id: 'new-read', capabilityKey: 'filesystem.read_text',
          description: 'Read the relevant source', dependsOn: ['write'], input: { path: 'D:/demo/relevant.md' } }] },
      usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    const written = { id: 'write', capabilityKey: 'filesystem.write_text', description: 'Write a large file',
      dependsOn: [], input: { path: 'D:/demo/file.txt', content: 'large-file-body'.repeat(2000) } };
    const decision = await runner.runPlannerReview({ taskId: 'review-1', message: 'Use the right source',
      plan: { status: 'ready', intent: 'write and read', acceptanceCriteria: ['Answer using evidence'],
        requiredCapabilities: [], steps: [written, { id: 'old-read', capabilityKey: 'filesystem.read_text',
          description: 'Read old source', dependsOn: ['write'], input: { path: 'D:/demo/old.md' } }] },
      step: written, completedStepIds: ['write'],
      results: [{ stepId: 'write', output: { path: written.input.path }, observedAt: new Date().toISOString() }],
      outcome: { status: 'success', output: { path: written.input.path } }, safeToReplay: false,
      workspaceRoot: 'D:/demo', desktopDirectory: 'D:/demo/Desktop' });
    expect(reviewUser).not.toContain('large-file-body'.repeat(10));
    expect(decision.action).toBe('replan');
    if (decision.action === 'replan') {
      expect(decision.plan.steps.map(step => step.id)).toEqual(['write', 'new-read']);
      expect(decision.plan.steps[0]?.input?.content).toBe(written.input.content);
    }
  });

  it('keeps a large network result out of the per-step review prompt and schema', async () => {
    let calls = 0;
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      calls += 1;
      expect(request.role).toBe('planner.review');
      expect(request.maxOutputTokens).toBeLessThanOrEqual(384);
      expect(request.user.length).toBeLessThan(6_000);
      expect(request.user).toContain(String(output.body.length));
      expect(request.user).not.toContain('SENSITIVE_HTML_MARKER'.repeat(100));
      expect(request.user).not.toContain('set-cookie');
      expect(JSON.stringify(request.outputSchema)).not.toContain('requiredCapabilities');
      return { data: { action: 'continue', reason: 'Relevant content was returned.' },
        usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    const step = { id: 'fetch', capabilityKey: 'network.request', description: 'Fetch public job listings',
      dependsOn: [], input: { url: 'https://example.org/jobs', method: 'GET' } };
    const output = { status: 200, ok: true, headers: { 'content-type': 'text/html', 'set-cookie': 'private' },
      body: `<html><body><h1>Java jobs</h1>${'SENSITIVE_HTML_MARKER'.repeat(4800)}</body></html>` };
    await runner.runPlannerReview({ taskId: 'large-network-review', message: 'Review Java job listings',
      plan: { status: 'ready', intent: 'research jobs', acceptanceCriteria: ['Find current Java jobs'],
        requiredCapabilities: [], steps: [step] }, step, completedStepIds: ['fetch'],
      results: [{ stepId: 'fetch', output, observedAt: new Date().toISOString() }],
      outcome: { status: 'success', output }, safeToReplay: true,
      workspaceRoot: 'D:/demo', desktopDirectory: 'D:/demo/Desktop' });
    expect(calls).toBe(1);
  });

  it('leaves report synthesis to the responder during a research replan', async () => {
    const runner = new AgentRunner(new ModelGateway({ complete: async request => ({
      data: request.role === 'planner.review'
        ? { action: 'replan', reason: 'The first source was a redirect.' }
        : { status: 'ready', intent: 'research jobs', acceptanceCriteria: ['Use public evidence'], requiredCapabilities: [],
          steps: [
            { id: 'new-source', capabilityKey: 'network.request', description: 'Fetch another source',
              dependsOn: [], input: { url: 'https://example.org/jobs', method: 'GET' } },
            { id: 'synthesize', capabilityKey: 'text.replace', description: 'Synthesize a report',
              dependsOn: ['new-source'], input: { content: 'Premature report' } },
          ] }, usage: { inputTokens: 1, outputTokens: 1 },
    }) }));
    const step = { id: 'fetch', capabilityKey: 'network.request', description: 'Fetch first source',
      dependsOn: [], input: { url: 'https://example.org/redirect', method: 'GET' } };
    const decision = await runner.runPlannerReview({ taskId: 'research-replan', message: '调研当前 Java 招聘市场',
      plan: { status: 'ready', intent: 'research jobs', acceptanceCriteria: ['Use public evidence'],
        requiredCapabilities: [], steps: [step] }, step, completedStepIds: ['fetch'],
      results: [{ stepId: 'fetch', output: { ok: true, body: 'redirect' }, observedAt: new Date().toISOString() }],
      outcome: { status: 'success', output: { ok: true, body: 'redirect' } }, safeToReplay: true,
      workspaceRoot: 'D:/demo', desktopDirectory: 'D:/demo/Desktop' });
    expect(decision.action).toBe('replan');
    if (decision.action === 'replan') expect(decision.plan.steps.map(item => item.id)).toEqual(['fetch', 'new-source']);
  });

  it('refuses to summarize an incomplete preview of an oversized tool result', async () => {
    let modelCalls = 0;
    const runner = new AgentRunner(new ModelGateway({ complete: async () => {
      modelCalls += 1;
      return { data: { answer: 'A complete summary' }, usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    await expect(runner.runResponder({ taskId: 'large-file', message: 'Summarize the file',
      acceptanceCriteria: ['complete summary'], results: [{ stepId: 'read', observedAt: new Date().toISOString(),
        output: { content: 'x'.repeat(50_000) } }] }))
      .rejects.toThrow(/too large|exceeds|过大|超过/i);
    expect(modelCalls).toBe(0);
  });
  it('constrains generated step identifiers in the schema sent to the model', async () => {
    let schema: unknown;
    const provider: ModelProvider = { complete: async (request) => {
      schema = request.outputSchema;
      return { data: { status: 'answer', answer: '你好', intent: 'greeting', acceptanceCriteria: [], requiredCapabilities: [], steps: [] },
        usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    await new AgentRunner(new ModelGateway(provider)).runPlanner({ taskId: 'task-1', message: '你好', attachments: [] });
    const decisionSchema = branchSchema(schema, 'ready');
    expect(decisionSchema.properties.steps.items.properties.id.minLength).toBe(1);
  });

  it('requires capability bindings and operation inputs in the schema sent to the model', async () => {
    let schema: unknown;
    const provider: ModelProvider = { complete: async (request) => {
      schema = request.outputSchema;
      return {
        data: {
          status: 'ready', intent: 'query weather', acceptanceCriteria: ['current weather data'],
          requiredCapabilities: [],
          steps: [{
            id: 'fetch-weather', capabilityKey: 'network.request', description: 'Fetch current weather',
            dependsOn: [], input: { url: 'https://weather.example.test/current', method: 'GET' },
          }],
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    } };
    const decision = await new AgentRunner(new ModelGateway(provider)).runPlanner({
      taskId: 'task-weather', message: '广东天气怎么样', attachments: [],
    });
    const decisionSchema = branchSchema(schema, 'ready');
    expect(decisionSchema.properties.steps.items.required).toEqual(
      expect.arrayContaining(['id', 'capabilityKey', 'description', 'dependsOn', 'input']),
    );
    expect(decisionSchema.properties.steps.items.properties.input.properties.url.type).toBe('string');
    expect(decisionSchema.properties.steps.items.properties.input.properties.method.enum).toContain('GET');
    expect(decision.steps[0]).toMatchObject({
      capabilityKey: 'network.request', input: { url: 'https://weather.example.test/current', method: 'GET' },
    });
  });

  it.each(['ready', 'answer', 'needs_user_input'])('requires the fields for the selected %s state in the model schema', async status => {
    let schema: unknown;
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      if (request.role === 'planner.route') return { data: { status }, usage: { inputTokens: 1, outputTokens: 1 } };
      schema = request.outputSchema;
      return { data: { status, answer: '你好', intent: 'greeting', acceptanceCriteria: [], requiredCapabilities: [],
        steps: status === 'ready' ? [{ id: 'read', capabilityKey: 'filesystem.read_text', description: 'Read a file', dependsOn: [], input: { path: 'notes.txt' } }] : [],
        inputRequest: { taskId: 'question', question: '哪个城市？', requiredFields: [], resumeToken: 'resume', options: [] } },
        usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    await runner.runPlanner({ taskId: 'question', message: '你好', attachments: [] });
    const selected = branchSchema(schema, status);
    expect(selected.properties.status.const).toBe(status);
    if (status === 'needs_user_input') {
      expect(selected.required).toContain('inputRequest');
      expect(selected.properties.inputRequest.required).toContain('question');
      expect(selected.properties.inputRequest.required).toContain('options');
      expect(selected.properties.steps.maxItems).toBe(0);
    } else if (status === 'answer') expect(selected.required).toContain('answer');
    else expect(selected.properties.steps.minItems).toBe(1);
  });

  it('corrects a malformed clarification once before returning it to the task', async () => {
    const requests: import('../../src/model/gateway.js').ModelRequest[] = [];
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      if (request.role === 'planner.route') return { data: { status: 'needs_user_input' }, usage: { inputTokens: 1, outputTokens: 1 } };
      requests.push(request);
      return { data: { status: 'needs_user_input', intent: 'weather', acceptanceCriteria: [], requiredCapabilities: [], steps: [],
        ...(requests.length === 1 ? {} : { inputRequest: { taskId: 'question', question: '你想查广东哪个城市？',
          requiredFields: [{ name: 'city', reason: '天气需要具体城市', sensitive: false }], resumeToken: 'resume',
          options: [{ label: '广州', value: '广州' }, { label: '深圳', value: '深圳' }, { label: '东莞', value: '东莞' }] } }) },
      usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    const decision = await runner.runPlanner({ taskId: 'question', message: '广东天气怎么样', attachments: [] });
    expect(decision.inputRequest?.question).toBe('你想查广东哪个城市？');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.system).toContain('inputRequest');
  });

  it('stops after one correction for persistently invalid plans', async () => {
    let calls = 0;
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      if (request.role === 'planner.route') return { data: { status: 'needs_user_input' }, usage: { inputTokens: 1, outputTokens: 1 } };
      calls += 1;
      return { data: { status: 'needs_user_input', intent: 'weather', acceptanceCriteria: [], requiredCapabilities: [], steps: [] },
        usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    await expect(runner.runPlanner({ taskId: 'question', message: '天气', attachments: [] }))
      .rejects.toThrow(/规划.*inputRequest/);
    expect(calls).toBe(2);
  });

  it('cannot turn a request routed to tools into an ungrounded direct answer', async () => {
    let plans = 0;
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      if (request.role === 'planner.route') return { data: { status: 'ready' }, usage: { inputTokens: 1, outputTokens: 1 } };
      plans += 1;
      return { data: plans === 1
        ? { status: 'answer', answer: '深圳现在28°C', intent: 'weather', acceptanceCriteria: [], requiredCapabilities: [], steps: [] }
        : { status: 'ready', intent: 'weather', acceptanceCriteria: [], requiredCapabilities: [],
          steps: [{ id: 'weather', capabilityKey: 'network.request', description: 'Fetch weather', dependsOn: [],
            input: { url: 'https://weather.example.test/current', method: 'GET' } }] },
        usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    const decision = await runner.runPlanner({ taskId: 'weather', message: '广东深圳的天气怎么样', attachments: [] });
    expect(decision.status).toBe('ready');
    expect(decision.answer).toBeUndefined();
    expect(plans).toBe(2);
  });

  it('allows a tool request to ask for essential information discovered during planning', async () => {
    const runner = new AgentRunner(new ModelGateway({ complete: async request => ({
      data: request.role === 'planner.route' ? { status: 'ready' }
        : { status: 'needs_user_input', intent: 'weather', acceptanceCriteria: [], requiredCapabilities: [], steps: [],
          inputRequest: { taskId: 'region', question: '你想查询广东哪个城市？', requiredFields: [{ name: 'city', reason: '需要具体城市', sensitive: false }], resumeToken: 'resume',
            options: [{ label: '广州', value: '广州' }, { label: '深圳', value: '深圳' }, { label: '东莞', value: '东莞' }] } },
      usage: { inputTokens: 1, outputTokens: 1 },
    }) }));
    const plan = await runner.runPlanner({ taskId: 'region', message: '广东天气怎么样', attachments: [] });
    expect(plan.status).toBe('needs_user_input');
    expect(plan.inputRequest?.question).toBe('你想查询广东哪个城市？');
  });

  it.each(['ready', 'needs_user_input'])('uses supplemental answers and shares the %s routing decision with the planner', async routeStatus => {
    const requests: import('../../src/model/gateway.js').ModelRequest[] = [];
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      requests.push(request);
      return { data: request.role === 'planner.route' ? { status: routeStatus }
        : { status: 'ready', intent: 'weather', acceptanceCriteria: [], requiredCapabilities: [],
          steps: [{ id: 'weather', capabilityKey: 'network.request', description: 'Fetch Shenzhen weather', dependsOn: [],
            input: { url: 'https://weather.example.test/current?city=Shenzhen', method: 'GET' } }] },
        usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    const plan = await runner.runPlanner({ taskId: 'region', message: '广东天气怎么样\n用户补充信息：{"answer":"深圳"}', attachments: [] });
    expect(plan.status).toBe('ready');
    for (const request of requests) expect(JSON.parse(request.user)).toMatchObject({
      message: '广东天气怎么样', userInputs: [{ answer: '深圳' }],
    });
    expect(JSON.parse(requests.find(request => request.role === 'planner')!.user).requestStatus).toBe(routeStatus);
  });

  it('normalizes wrapped launch parameters from a model response', async () => {
    const provider: ModelProvider = { complete: async () => ({
      data: { status: 'ready', intent: 'open app', acceptanceCriteria: ['window foreground'], requiredCapabilities: [],
        steps: [{ id: 'launch', capabilityKey: 'process.launch', description: 'Open app', dependsOn: [],
          input: { applicationName: { type: 'string', value: '网易云音乐' }, args: { type: 'array', value: [] } } }] },
      usage: { inputTokens: 1, outputTokens: 1 },
    }) };
    const decision = await new AgentRunner(new ModelGateway(provider)).runPlanner({ taskId: 'task-1', message: '打开网易云音乐', attachments: [] });
    expect(decision.steps[0]?.input).toEqual({ applicationName: '网易云音乐', args: [] });
  });

  it('rejects malformed process arguments before execution', async () => {
    const provider: ModelProvider = { complete: async () => ({
      data: { status: 'ready', intent: 'open app', acceptanceCriteria: [], requiredCapabilities: [],
        steps: [{ id: 'launch', capabilityKey: 'process.launch', description: 'Open app', dependsOn: [],
          input: { applicationName: '网易云音乐', args: [{}] } }] },
      usage: { inputTokens: 1, outputTokens: 1 },
    }) };
    await expect(new AgentRunner(new ModelGateway(provider)).runPlanner({ taskId: 'task-1', message: '打开网易云音乐', attachments: [] }))
      .rejects.toThrow(/steps\[0\]\.input\.args/);
  });

  it('returns a structured planner decision for the MVP request', async () => {
    const decision = await createRunner().runPlanner({
      taskId: 'task-1',
      message: '统计上传内容有多少行',
      attachments: [{ filename: 'notes.txt', content: 'a\nb\n' }],
    });

    expect(decision.status).toBe('ready');
    expect(decision.requiredCapabilities[0]?.name).toBe('count_lines');
    expect(decision.acceptanceCriteria.length).toBeGreaterThan(0);
  });

  it('returns a passing evaluation for a valid tool result', async () => {
    const decision = await createRunner().runEvaluator({
      taskId: 'task-1',
      target: 'count_lines',
      phase: 'tool',
      output: { count: 2 },
      acceptanceCriteria: ['result contains a line count'],
    });

    expect(decision.status).toBe('pass');
    expect(decision.verdict).toBe('pass');
  });

  it('repairs an out-of-range evaluator score without repeating task execution', async () => {
    const requests: import('../../src/model/gateway.js').ModelRequest[] = [];
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      requests.push(request);
      return { data: { status: 'pass', verdict: 'pass', score: requests.length === 1 ? 10 : 1,
        failures: [], recommendations: [], evidence: ['document structure checked'] },
        usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    const decision = await runner.runEvaluator({ taskId: 'task-1', target: 'answer', phase: 'execution',
      output: { answer: 'A complete outline', toolResults: [] }, acceptanceCriteria: [] });
    expect(decision.status).toBe('pass');
    expect(decision.score).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.system).toContain('score');
  });

  it('reports a persistent evaluator contract error without accepting a passing verdict', async () => {
    let calls = 0;
    const runner = new AgentRunner(new ModelGateway({ complete: async () => {
      calls += 1;
      return { data: { status: 'pass', verdict: 'pass', score: 10,
        failures: [], recommendations: [], evidence: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
    } }));
    await expect(runner.runEvaluator({ taskId: 'task-1', target: 'answer', phase: 'execution',
      output: { answer: 'A complete outline', toolResults: [] }, acceptanceCriteria: [] }))
      .rejects.toMatchObject({ code: 'EVALUATOR_OUTPUT_INVALID', message: expect.stringContaining('score') });
    expect(calls).toBe(2);
  });

  it('bounds evaluator evidence in the schema sent to the model', async () => {
    let schema: any;
    const mock = new MockModelProvider();
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      schema = request.outputSchema;
      return mock.complete(request);
    } }));
    await runner.runEvaluator({ taskId: 'task-1', target: 'task-answer', phase: 'execution',
      output: { answer: 'ok', results: [] }, acceptanceCriteria: [] });
    expect(schema.properties.evidence.maxItems).toBe(2);
    expect(schema.properties.evidence.items.maxLength).toBe(180);
  });

  it('returns a pure read-only tool candidate from the implementer', async () => {
    const result = await createRunner().runImplementer({
      taskId: 'task-1',
      intent: 'count lines in uploaded content',
      name: 'count_lines',
      taskContext: {
        message: 'Count these lines.',
        attachments: [{ filename: 'notes.txt', content: 'a\nb' }],
        workspaceRoot: 'C:\\workspace',
        desktopDirectory: 'C:\\Users\\Ada\\Desktop',
        executionInput: {},
      },
    });

    expect(result.kind).toBe('tool_candidate');
    if (result.kind === 'tool_candidate') {
      expect(result.candidate.permissions).toEqual([]);
      expect(result.candidate.code).toContain('export async function run');
    }
  });

  it('flags casual-chat evaluation requests so greetings are not failed for lacking facts', async () => {
    const mock = new MockModelProvider();
    const requests: Array<{ system: string; user: string }> = [];
    const runner = new AgentRunner(new ModelGateway({ complete: async request => {
      requests.push({ system: request.system, user: request.user });
      return mock.complete(request);
    } }));
    await runner.runEvaluator({ taskId: 'task-1', target: 'answer', phase: 'execution',
      output: { answer: '你好小明！很高兴认识你。', toolResults: [] }, acceptanceCriteria: [], isCasualChat: true });

    const evaluatorCall = requests.find(item => item.system.includes('Jarvis evaluator'))!;
    expect(evaluatorCall.system).toContain('isCasualChat is true the user request is greeting or small talk');
    expect(evaluatorCall.system).toContain('sessionMemory is the authoritative evidence source');
    expect(JSON.parse(evaluatorCall.user).isCasualChat).toBe(true);
  });
});
