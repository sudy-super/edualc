import { describe, expect, test } from 'bun:test';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { createSdkAuxiliary, type AuxiliaryQuery, type SideQuestionParams } from '../src/sdk-auxiliary';

type Configuration = Parameters<typeof createSdkAuxiliary>[0];
function control(overrides: Partial<AuxiliaryQuery> = {}) {
  const titles: unknown[][] = [];
  const questions: unknown[][] = [];
  let closed = 0;
  const connection = {
    async generateSessionTitle(...args: unknown[]) { titles.push(args); return 'Original session title'; },
    async askSideQuestion(...args: unknown[]) { questions.push(args); return { response: 'Context answer', synthetic: false }; },
    close() { closed++; },
    ...overrides,
  } as unknown as AuxiliaryQuery;
  return { connection, titles, questions, get closed() { return closed; } };
}

function sideParams(): SideQuestionParams {
  return {
    question: 'What did we change?',
    cacheSafeParams: {
      systemPrompt: ['original system prompt'], userContext: { project: 'original project rules' },
      forkContextMessages: [{ type: 'user', uuid: 'previous-user', message: { role: 'user', content: 'Original conversation context' } }],
      toolUseContext: {
        session: { id: 'original-session' }, options: { tools: [] }, abortController: new AbortController(),
        getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
      },
    },
  };
}

describe('SDK auxiliary controls', () => {
  test('generates titles with the SDK method, without another tool or settings connection', async () => {
    const sdk = control();
    const starts: Parameters<NonNullable<Configuration['queryFactory']>>[0][] = [];
    const bridge = createSdkAuxiliary({
      getConnection: async () => { throw new Error('A title must not start a main conversation'); },
      queryFactory: configuration => { starts.push(configuration); return sdk.connection; },
      titleSettings: async () => ({ settings: { language: 'Japanese' } }),
      executable: '/native/claude',
    });
    expect(starts).toHaveLength(0);
    expect(await bridge.generateTitle('Please explain the SDK interface')).toBe('Original session title');
    expect(sdk.titles).toEqual([['Please explain the SDK interface', { persist: false }]]);
    expect(starts[0].options).toMatchObject({
      pathToClaudeCodeExecutable: '/native/claude', persistSession: false,
      settingSources: [], strictMcpConfig: true, mcpServers: {}, tools: [],
      settings: { language: 'Japanese', disableAllHooks: true },
    });
    expect(starts[0].options!.env!.BUN_OPTIONS).toBeUndefined();
    expect(sdk.closed).toBe(1);
  });

  test('preserves native title cancellation and the ten character minimum', async () => {
    const sdk = control();
    let starts = 0;
    const controller = new AbortController();
    const bridge = createSdkAuxiliary({
      getConnection: async () => sdk.connection,
      queryFactory: () => { starts++; return sdk.connection; },
    });
    expect(await bridge.generateTitle('too short')).toBeNull();
    controller.abort();
    expect(await bridge.generateTitle('Title request already cancelled', controller.signal)).toBeNull();
    expect(starts).toBe(0);
  });

  test('uses the main SDK connection with the original conversation and forwards side question history', async () => {
    const sdk = control({ async askSideQuestion(question, options) {
      sdk.questions.push([question, options]);
      return { response: 'Context answer', synthetic: false, refusalFallback: { originalModel: 'a', fallbackModel: 'b', content: 'Fallback notice' } };
    } });
    const requests: unknown[] = [];
    const appended: unknown[][] = [];
    const params = sideParams();
    params.cacheSafeParams.toolUseContext.session.btwHistory = {
      exchanges: [{ question: 'Earlier side question', response: 'Earlier answer', fallbackNotice: 'Earlier fallback' }],
      append: (...args) => { appended.push(args); },
    };
    const bridge = createSdkAuxiliary({ getConnection: async request => { requests.push(request); return sdk.connection; } });
    const answer = await bridge.sideQuestion(params);
    expect(requests[0]).toMatchObject({
      messages: params.cacheSafeParams.forkContextMessages,
      systemPrompt: ['original system prompt'], userContext: { project: 'original project rules' },
    });
    expect(sdk.questions).toEqual([['What did we change?', {
      signal: undefined,
      history: [{ question: 'Earlier side question', response: 'Earlier answer', fallback_notice: 'Earlier fallback' }],
    }]]);
    expect(answer.refusalFallback?.content).toBe('Fallback notice');
    expect(appended).toEqual([['What did we change?', 'Context answer', 'Fallback notice']]);
    expect(sdk.closed).toBe(0);
  });

  test('explicit side history overrides thread history and synthetic replies are not saved', async () => {
    const sdk = control({ async askSideQuestion(question, options) {
      sdk.questions.push([question, options]);
      return { response: 'API error', synthetic: true };
    } });
    const params = sideParams();
    params.threadHistory = false;
    params.history = [{ question: 'Explicit question', response: 'Explicit answer' }];
    params.cacheSafeParams.toolUseContext.session.btwHistory = {
      exchanges: [{ question: 'Ignored', response: 'Ignored' }],
      append() { throw new Error('Synthetic replies must not be saved'); },
    };
    await createSdkAuxiliary({ getConnection: async () => sdk.connection }).sideQuestion(params);
    expect(sdk.questions[0][1]).toMatchObject({ history: [{ question: 'Explicit question', response: 'Explicit answer' }] });
  });

  test('cancels a side control request without closing the main conversation', async () => {
    const controller = new AbortController();
    const sdk = control({ askSideQuestion(_question, options) {
      return new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
    } });
    const params = sideParams();
    params.parentController = controller;
    const started = Promise.withResolvers<void>();
    const bridge = createSdkAuxiliary({ getConnection: async () => { started.resolve(); return sdk.connection; } });
    const result = bridge.sideQuestion(params);
    await started.promise;
    await Promise.resolve();
    controller.abort();
    expect(await result).toEqual({ response: null, synthetic: false, aborted: true });
    expect(sdk.closed).toBe(0);
  });

  test('refuses SDK versions without the required controls', async () => {
    const bridge = createSdkAuxiliary({ getConnection: async () => ({ close() {} }) as Query });
    await expect(bridge.sideQuestion(sideParams())).rejects.toThrow('auxiliary control methods are unavailable');
  });

});
