import { describe, expect, test } from 'bun:test';
import type { ModelUsage, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSdkRun as makeSdkRun, toInternal, type RunParams } from '../src/sdk-run';
function createSdkRun(options: Parameters<typeof makeSdkRun>[0] = {}) {
  return makeSdkRun({
    requirePromptEcho: false,
    agentOptions: async () => ({}),
    goalHistory: async () => [],
    convertMessages: messages => messages.map(({ parent_tool_use_id, session_id, ...message }: any) => ({ ...message, timestamp: new Date().toISOString(), isMeta: message.isSynthetic })),
    ledger: async () => ({ Z2o() {}, eGo() {}, tGo() {}, hGo() { return undefined; } }),
    helpers: async () => ({
      createAssistant: ({ content }) => ({ type: 'assistant', message: { content } }),
      findTool: (tools, name) => tools.find(tool => tool.name === name),
      normalizePrompt: messages => messages.filter(message => message.type === 'user'),
    }),
    ...options,
  });
}
type QueryFactory = NonNullable<NonNullable<Parameters<typeof createSdkRun>[0]>['queryFactory']>;

const user = (uuid: string, text: string) => ({ type: 'user', uuid, message: { role: 'user', content: text } });
function params(id = 'parent-1', messages: RunParams['messages'] = [user('prompt-1', 'first')]): RunParams {
  return {
    messages, systemPrompt: ['original system prompt'], userContext: { instructions: 'original project rules' },
    canUseTool: async () => ({ behavior: 'allow' }),
    toolUseContext: {
      session: { id }, abortController: new AbortController(),
      options: { mainLoopModel: 'sonnet', tools: [{ name: 'Write' }] },
      getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
    },
  };
}

function mockSdk(handler?: (input: SDKUserMessage) => Promise<void>, result?: (turn: number) => Record<string, unknown>) {
  const starts: Parameters<QueryFactory>[0][] = [];
  const inputs: SDKUserMessage[] = [];
  const changes: unknown[] = [];
  let closed = 0;
  const factory = ((configuration: any) => {
    starts.push(configuration);
    const generator = (async function* () {
      for await (const input of configuration.prompt) {
        inputs.push(input);
        await handler?.(input);
        yield { type: 'stream_event', session_id: 'child', parent_tool_use_id: null, uuid: 'event-1', event: { type: 'message_start', message: { id: 'answer-1' } } };
        yield { type: 'assistant', session_id: 'child', parent_tool_use_id: null, uuid: 'assistant-1', message: { id: 'answer-1', role: 'assistant', content: [{ type: 'text', text: 'answer' }], stop_reason: 'end_turn' } };
        yield { type: 'user', session_id: 'child', parent_tool_use_id: null, uuid: 'tool-result-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'write-1', content: 'done' }] }, tool_use_result: { success: true } };
        yield { type: 'result', subtype: 'success', is_error: false, session_id: 'child', modelUsage: {}, duration_api_ms: 0, ...result?.(inputs.length) };
      }
    })();
    return Object.assign(generator, {
      close() { closed++; },
      async interrupt() { changes.push('interrupt'); },
      async setModel(value: string) { changes.push(['model', value]); },
      async setPermissionMode(value: string) { changes.push(['mode', value]); },
    }) as Query;
  }) as QueryFactory;
  return { starts, inputs, changes, factory, get closed() { return closed; } };
}

async function collect(generator: ReturnType<ReturnType<typeof createSdkRun>['run']>) {
  const messages: unknown[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) return { messages, terminal: next.value };
    messages.push(next.value);
  }
}

describe('original RD to Agent SDK bridge', () => {
  for (const terminal_reason of ['aborted_streaming', 'aborted_tools', 'api_error'] as const) {
    test(`handles a late ${terminal_reason} result without mistaking interruption for failure`, async () => {
      const release = Promise.withResolvers<void>(), delivered = Promise.withResolvers<void>();
      const rendered: any[] = [], failures: any[] = [];
      let saved = 0;
      const bridge = createSdkRun({ trace: event => { if (event.kind === 'sdk_failure') failures.push(event); },
        queryFactory: ((configuration: any) => Object.assign((async function* () {
        for await (const _input of configuration.prompt) {
          yield { type: 'result', subtype: 'success', is_error: false, modelUsage: {}, duration_api_ms: 0 };
          await release.promise;
          yield { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason,
            errors: ['fixture terminal detail'], modelUsage: {}, duration_api_ms: 0 };
        }
      })(), { close() {}, async interrupt() {} })) as QueryFactory,
      helpers: async () => ({
        createAssistant: ({ content }) => ({ type: 'assistant', message: { content } }),
        findTool: (tools, name) => tools.find(tool => tool.name === name),
        normalizePrompt: messages => messages.filter(message => message.type === 'user'),
        saveContext: () => { if (++saved === 2) delivered.resolve(); },
      }) });
      const p = params();
      if (terminal_reason !== 'api_error') p.toolUseContext.sdkApplyEvent = (event: any) => rendered.push(event);
      await collect(bridge.run(p));
      release.resolve();
      await delivered.promise;
      expect(rendered).toHaveLength(0);
      expect(failures).toHaveLength(terminal_reason === 'api_error' ? 1 : 0);
      if (terminal_reason === 'api_error') expect(JSON.stringify(failures)).toContain('fixture terminal detail');
      bridge.close();
    });
  }

  test('does not finish a user turn on the result of an overlapping background response', async () => {
    const bridge = createSdkRun({ requirePromptEcho: true, queryFactory: ((configuration: any) => Object.assign((async function* () {
      for await (const input of configuration.prompt) {
        yield { type: 'assistant', uuid: 'autonomous-answer', message: { role: 'assistant', content: 'background answer' } };
        yield { type: 'result', subtype: 'success', is_error: false, modelUsage: {}, duration_api_ms: 0 };
        yield { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools',
          user_message_uuid: 'previous-interrupted-input', errors: ['old interruption detail'], modelUsage: {}, duration_api_ms: 0 };
        yield { type: 'assistant', uuid: 'own-answer', message: { role: 'assistant', content: 'own answer' } };
        yield { type: 'result', subtype: 'success', is_error: false, modelUsage: {}, duration_api_ms: 0,
          user_message_uuid: input.uuid, user_message_uuids: [input.uuid] };
      }
    })(), { close() {}, async interrupt() {} })) as QueryFactory });
    const result = await collect(bridge.run(params()));
    expect(result.messages.map((message: any) => message.uuid)).toEqual(['autonomous-answer', 'own-answer']);
    expect(result.terminal.reason).toBe('completed');
    bridge.close();
  });

  test('delivers late SDK notices to the original TUI without another user input and preserves them in fork context', async () => {
    const release = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    const rendered: any[] = [], snapshots: any[] = [];
    let starts = 0;
    const bridge = createSdkRun({ queryFactory: ((configuration: any) => {
      starts++;
      return Object.assign((async function* () {
        for await (const _input of configuration.prompt) {
          yield { type: 'assistant', uuid: 'answer-1', message: { role: 'assistant', content: 'answer' } };
          yield { type: 'result', subtype: 'success', is_error: false, modelUsage: {}, duration_api_ms: 0 };
          await release.promise;
          yield { type: 'system', subtype: 'informational', uuid: 'notice-wire', message: 'LATE_TASK_NOTICE', level: 'info' };
        }
      })(), { close() {}, async interrupt() {} });
    }) as unknown as QueryFactory,
    helpers: async () => ({ createAssistant: ({ content }) => ({ type: 'assistant', message: { content } }),
      findTool: (tools, name) => tools.find(tool => tool.name === name), normalizePrompt: messages => messages.filter(message => message.type === 'user'),
      saveContext: snapshot => { snapshots.push(snapshot); if ((snapshot.forkContextMessages as any[]).some(row => row.message === 'LATE_TASK_NOTICE')) delivered.resolve(); } }) });
    const p = params();
    p.toolUseContext.sdkApplyEvent = (event: any) => rendered.push(event);
    await collect(bridge.run(p));
    expect(rendered).toHaveLength(0);
    release.resolve();
    await delivered.promise;
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ type: 'system', message: 'LATE_TASK_NOTICE' });
    expect(snapshots.at(-1).forkContextMessages.map((row: any) => row.uuid)).toContain('answer-1');
    expect(starts).toBe(1);
    bridge.close();
  });

  test('queues a goal clear after an active turn and applies settings through the same SDK connection', async () => {
    const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    const sdk = mockSdk(async () => { entered.resolve(); await finish.promise; });
    const applied: any[] = [];
    const bridge = createSdkRun({ queryFactory: ((configuration: any) => Object.assign(sdk.factory(configuration), {
      applyFlagSettings: async (settings: any) => { applied.push(settings); },
    })) as QueryFactory });
    const p = params();
    p.toolUseContext.sdkApplyEvent = () => {};
    const first = collect(bridge.run(p));
    await entered.promise;
    bridge.goalCleared(p.toolUseContext);
    bridge.applySettings(p.toolUseContext.session.id, { fastMode: true });
    p.toolUseContext.options.fastMode = true;
    expect(sdk.inputs).toHaveLength(1);
    finish.resolve();
    await first;
    await bridge.connection({ ...p, messages: [p.messages[0], { type: 'assistant', uuid: 'assistant-1' }] });
    expect(sdk.inputs).toHaveLength(2);
    expect(sdk.inputs[1].message.content).toEqual([{ type: 'text', text: '/goal clear' }]);
    expect(sdk.inputs[1].client_composed).toBeUndefined();
    expect(applied).toEqual([{ fastMode: true }]);
    bridge.close();
  });

  test('returns the native API-error terminal after displaying an API error instead of throwing it again', async () => {
    const sdk = mockSdk(undefined, () => ({ is_error: true, result: 'DENIED_COMPARE_401' }));
    const seen: unknown[] = [];
    const bridge = createSdkRun({ queryFactory: sdk.factory,
      convertMessages: messages => messages.map(message => ({ ...message, ...(message.type === 'assistant' && { isApiErrorMessage: true }) })) as any,
      helpers: async () => ({ createAssistant: ({ content }) => ({ type: 'assistant', message: { content } }),
        findTool: (tools, name) => tools.find(tool => tool.name === name),
        normalizePrompt: messages => messages.filter(message => message.type === 'user'),
        apiError: message => { seen.push(message); return { reason: 'api_error' }; } }) });
    const result = await collect(bridge.run(params()));
    expect(result.terminal).toEqual({ reason: 'api_error' });
    expect(result.messages.filter((message: any) => message.type === 'assistant')).toHaveLength(1);
    expect(seen).toHaveLength(1);
    bridge.close();
  });

  test('forwards SDK URL completion events to the original pending dialog handler', async () => {
    const completed: string[] = [];
    let options: any;
    const factory = ((configuration: any) => {
      options = configuration.options;
      return Object.assign((async function* () {
        await options.onElicitation({ serverName: 'fixture', mode: 'url', message: 'Authorize',
          url: 'http://127.0.0.1/', elicitationId: 'url-1' }, { signal: new AbortController().signal, requestId: 'url-1' });
        yield { type: 'system', subtype: 'elicitation_complete', mcp_server_name: 'fixture', elicitation_id: 'url-1' };
        yield { type: 'result', subtype: 'success', is_error: false, modelUsage: {}, duration_api_ms: 0 };
      })(), { close() {}, async interrupt() {}, async setModel() {}, async setPermissionMode() {} });
    }) as unknown as QueryFactory;
    const bridge = createSdkRun({ queryFactory: factory, helpers: async () => ({
      createAssistant: ({ content }) => ({ type: 'assistant', message: { content } }),
      findTool: (tools, name) => tools.find(tool => tool.name === name),
      normalizePrompt: messages => messages.filter(message => message.type === 'user'),
      elicitationDialog: { kind: 'mcp_elicitation' },
      createUrlElicitationHandler: () => ({ handle: async () => ({ action: 'accept' }), complete: id => { completed.push(id); return true; } }),
    }) });
    const p = params();
    p.toolUseContext.requestDialog = async () => { throw new Error('URL flow must use the native handler'); };
    await collect(bridge.run(p));
    expect(completed).toEqual(['url-1']);
    bridge.close();
  });

  test('passes effective permission rules and working directories to SDK execution', async () => {
    const sdk = mockSdk();
    const p = params();
    p.toolUseContext.getAppState = () => ({ toolPermissionContext: {
      mode: 'bypassPermissions',
      alwaysAllowRules: { cliArg: ['mcp__fixture__allowed'], session: ['Read(/fixture/**)'] },
      alwaysDenyRules: { cliArg: ['mcp__fixture__blocked'], session: ['Bash(rm *)'] },
      additionalWorkingDirectories: new Map([['/fixture/extra', { path: '/fixture/extra', source: 'session' }]]),
    } });
    const bridge = createSdkRun({ queryFactory: sdk.factory });
    await collect(bridge.run(p));
    expect(sdk.starts[0].options).toMatchObject({
      allowedTools: ['mcp__fixture__allowed', 'Read(/fixture/**)'],
      disallowedTools: ['mcp__fixture__blocked', 'Bash(rm *)'],
      additionalDirectories: ['/fixture/extra'],
      permissionMode: 'bypassPermissions',
    });
    bridge.close();
  });

  test('uses the native effective permission context including command restrictions', async () => {
    const sdk = mockSdk();
    const p = params();
    const bridge = createSdkRun({ queryFactory: sdk.factory, helpers: async () => ({
      createAssistant: ({ content }) => ({ type: 'assistant', message: { content } }),
      findTool: (tools, name) => tools.find(tool => tool.name === name),
      normalizePrompt: messages => messages.filter(message => message.type === 'user'),
      permissionContext: () => ({ alwaysAllowRules: {}, alwaysDenyRules: { command: ['mcp__fixture__blocked'] },
        additionalWorkingDirectories: new Map([['/fixture/layer', { source: 'session' }]]) }),
    }) });
    await collect(bridge.run(p));
    expect(sdk.starts[0].options!.disallowedTools).toEqual(['mcp__fixture__blocked']);
    expect(sdk.starts[0].options!.additionalDirectories).toEqual(['/fixture/layer']);
    bridge.close();
  });

  test('updates native retry status and clears it on response or failure', async () => {
    for (const fail of [false, true]) {
      const statuses: any[] = [];
      const bridge = createSdkRun({ queryFactory: ((configuration: any) => Object.assign((async function* () {
        for await (const input of configuration.prompt) {
          yield { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 5000,
            error_status: 529, error: 'overloaded', session_id: 'child', uuid: 'retry-1' };
          expect(statuses[0]).toMatchObject({ kind: 'retrying', attempt: 2, maxRetries: 10, retryInMs: 5000,
            error: { status: 529, message: 'overloaded', requestId: undefined } });
          expect(statuses[0].deadline).toBeGreaterThan(Date.now());
          if (fail) throw new Error('fixture child failed during retry');
          yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'answer-1' } } };
          expect(statuses.at(-1)).toBeNull();
          yield { type: 'assistant', uuid: 'answer-1', message: { role: 'assistant', content: 'answer' } };
          yield { type: 'result', subtype: 'success', is_error: false, modelUsage: {}, duration_api_ms: 0 };
        }
      })(), { close() {}, async interrupt() {} }) as Query) as QueryFactory });
      const p = params();
      p.toolUseContext.onRetryStatus = (status: any) => statuses.push(status);
      if (fail) await expect(collect(bridge.run(p))).rejects.toThrow('fixture child failed during retry');
      else expect((await collect(bridge.run(p))).terminal.reason).toBe('completed');
      expect(statuses).toHaveLength(2);
      expect(statuses.at(-1)).toBeNull();
      bridge.close();
    }
  });

  test('routes MCP form and URL input through the original dialog, including decline and cancellation', async () => {
    const sdk = mockSdk();
    const descriptor = { kind: 'mcp_elicitation' };
    const bridge = createSdkRun({ queryFactory: sdk.factory, helpers: async () => ({
      createAssistant: ({ content }) => ({ type: 'assistant', message: { content } }),
      findTool: (tools, name) => tools.find(tool => tool.name === name),
      normalizePrompt: messages => messages.filter(message => message.type === 'user'),
      elicitationDialog: descriptor,
      createUrlElicitationHandler: deps => ({
        handle: async (request, options) => (deps.requestDialog as any)(descriptor, { serverName: 'fixture', params: request.params }, options),
        complete: () => true,
      }),
    }) });
    const p = params();
    await collect(bridge.run(p));
    const callback = sdk.starts[0].options!.onElicitation!;
    const signal = new AbortController();
    const calls: any[] = [];
    let answer: any = { action: 'accept', content: { name: 'fixture' } };
    p.toolUseContext.requestDialog = async (...args: any[]) => { calls.push(args); return answer; };
    const request = { serverName: 'fixture', message: 'Choose a name', mode: 'form' as const, requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } };
    expect(await callback(request, { signal: signal.signal, requestId: 'form-1' })).toEqual(answer);
    expect(calls[0][0]).toBe(descriptor);
    expect(calls[0][1]).toEqual({ serverName: 'fixture', params: { message: request.message, mode: 'form', requestedSchema: request.requestedSchema } });
    expect(calls[0][2].place).toBe('under');
    answer = { action: 'decline' };
    expect(await callback(request, { signal: signal.signal, requestId: 'form-2' })).toEqual(answer);
    expect(await callback({ serverName: 'fixture', mode: 'url', message: 'Authorize', url: 'https://example.invalid', elicitationId: 'url-1' }, { signal: signal.signal, requestId: 'url-1' })).toEqual(answer);
    expect(calls[2][1]).not.toHaveProperty('userConfirmsCompletion');
    p.toolUseContext.requestDialog = async (_descriptor: any, _payload: any, options: any) => {
      signal.abort();
      expect(options.signal.aborted).toBe(true);
      return { action: 'accept' };
    };
    expect(await callback(request, { signal: signal.signal, requestId: 'form-3' })).toEqual({ action: 'cancel' });
    expect(await callback(request, { signal: signal.signal, requestId: 'form-4' })).toEqual({ action: 'cancel' });
    bridge.close();
  });

  test('passes the native resolved fallback model order to the SDK', async () => {
    const sdk = mockSdk();
    const bridge = createSdkRun({ queryFactory: sdk.factory });
    const p = params();
    p.toolUseContext.options.fallbackModel = ['claude-sonnet-5', 'claude-haiku-4-5'];
    await collect(bridge.run(p));
    expect(sdk.starts[0].options!.fallbackModel).toBe('claude-sonnet-5,claude-haiku-4-5');
    bridge.close();
  });

  test('excludes the current model from SDK fallback options after a model switch', async () => {
    const sdk = mockSdk();
    const bridge = createSdkRun({ queryFactory: sdk.factory });
    const p = params();
    p.toolUseContext.options.mainLoopModel = 'claude-sonnet-5';
    p.toolUseContext.options.fallbackModel = ['claude-sonnet-5'];
    await collect(bridge.run(p));
    expect(sdk.starts[0].options!.fallbackModel).toBeUndefined();
    bridge.close();
  });

  test('passes native effective thinking and recreates the child when thinking is toggled', async () => {
    const sdk = mockSdk();
    const p = params();
    p.toolUseContext.options.thinkingConfig = { type: 'adaptive' };
    const bridge = createSdkRun({ queryFactory: sdk.factory,
      helpers: async () => ({ createAssistant: ({ content }) => ({ type: 'assistant', message: { content } }),
        findTool: (tools, name) => tools.find(tool => tool.name === name),
        normalizePrompt: messages => messages.filter(message => message.type === 'user'),
        thinking: context => context.options.thinkingConfig }),
      history: async () => ({ path: '/fixture/history.jsonl', usage: {}, apiDuration: 0 }) });
    await collect(bridge.run(p));
    expect(sdk.starts[0].options!.thinking).toEqual({ type: 'adaptive' });
    p.messages.push({ type: 'assistant', uuid: 'assistant-1' }, user('prompt-2', 'second'));
    p.toolUseContext.options.thinkingConfig = { type: 'disabled' };
    await collect(bridge.run(p));
    expect(sdk.starts).toHaveLength(2);
    expect(sdk.starts[1].options!.thinking).toEqual({ type: 'disabled' });
    bridge.close();
  });

  test('keeps SDK hook notices and their continuation metadata in the native message format', async () => {
    const row = await toInternal({ type: 'system', subtype: 'informational', content: 'Stop says: hook notice',
      level: 'warning', uuid: 'notice-1', session_id: 'child', tool_use_id: 'tool-1', prevent_continuation: true } as unknown as SDKMessage);
    expect(row).toMatchObject({ type: 'system', subtype: 'informational', content: 'Stop says: hook notice',
      level: 'warning', toolUseID: 'tool-1', preventContinuation: true });
    expect(row?.uuid).not.toBe('notice-1');
    expect(row?.timestamp).toBeString();
    expect(row).not.toHaveProperty('session_id');
    expect(row).not.toHaveProperty('tool_use_id');
  });

  test('keeps the history cursor on the converted assistant when a hidden hook row follows', async () => {
    let starts = 0;
    const bridge = createSdkRun({
      convertMessages: messages => messages.filter((message: any) => !message.is_meta) as any,
      queryFactory: ((configuration: any) => {
        starts++;
        return Object.assign((async function* () {
          for await (const input of configuration.prompt) {
            yield { type: 'assistant', uuid: 'visible-' + input.uuid, message: { role: 'assistant', content: 'answer' } };
            yield { type: 'assistant', uuid: 'hidden-' + input.uuid, is_meta: true, message: { role: 'assistant', content: 'hook metadata' } };
            yield { type: 'result', subtype: 'success', is_error: false, modelUsage: {}, duration_api_ms: 0 };
          }
        })(), { close() {}, async interrupt() {} }) as Query;
      }) as QueryFactory,
    });
    const p = params();
    const first = await collect(bridge.run(p));
    p.messages.push(...first.messages as any[], user('prompt-2', 'second'));
    await collect(bridge.run(p));
    expect(starts).toBe(1);
    bridge.close();
  });

  test('shares concurrent initialization and closes the only created child', async () => {
    const sdk = mockSdk();
    const bridge = createSdkRun({ queryFactory: sdk.factory });
    const p = params();
    const children = await Promise.all([bridge.connection(p), bridge.connection(p), bridge.connection(p)]);
    expect(sdk.starts).toHaveLength(1);
    expect(children.every(child => child === children[0])).toBe(true);
    bridge.close();
    expect(sdk.closed).toBe(1);
  });

  test('cannot create a child after closing the bridge during initialization', async () => {
    const sdk = mockSdk();
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const bridge = createSdkRun({ queryFactory: sdk.factory, helpers: async () => {
      started.resolve(); await gate.promise;
      return { createAssistant: ({ content }) => ({ type: 'assistant', message: { content } }),
        findTool: (tools, name) => tools.find(tool => tool.name === name), normalizePrompt: messages => messages };
    } });
    const opening = bridge.connection(params());
    const outcome = opening.then(() => undefined, error => error);
    await started.promise;
    bridge.close(); gate.resolve();
    expect((await outcome)?.message).toContain('SDK bridge is closed');
    expect(sdk.starts).toHaveLength(0);
  });

  test('does not send input cancelled while the SDK applies a mode change', async () => {
    const sdk = mockSdk();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const bridge = createSdkRun({ queryFactory: configuration => {
      const q = sdk.factory(configuration);
      q.setPermissionMode = async () => { entered.resolve(); await release.promise; };
      return q;
    } });
    const p = params();
    let mode = 'default';
    p.toolUseContext.getAppState = () => ({ toolPermissionContext: { mode } });
    await collect(bridge.run(p));
    p.messages.push({ type: 'assistant', uuid: 'assistant-1' }, user('cancelled', 'must not execute'));
    mode = 'acceptEdits';
    const waiting = collect(bridge.run(p));
    await entered.promise;
    p.toolUseContext.abortController.abort(); release.resolve();
    expect((await waiting).terminal.reason).toBe('aborted_streaming');
    expect(sdk.inputs.map(input => String(input.uuid))).toEqual(['prompt-1']);
    bridge.close();
  });

  test('does not initialize a child for an already cancelled turn', async () => {
    const sdk = mockSdk();
    const bridge = createSdkRun({ queryFactory: sdk.factory });
    const p = params(); p.toolUseContext.abortController.abort();
    expect((await collect(bridge.run(p))).terminal.reason).toBe('aborted_streaming');
    expect(sdk.starts).toHaveLength(0);
    bridge.close();
  });

  test('refreshes model and settings before context inspection with a complete TUI context', async () => {
    const sdk = mockSdk();
    const inspected: number[] = [];
    const bridge = createSdkRun({ queryFactory: configuration => {
      const q = sdk.factory(configuration);
      q.getContextUsage = async () => { inspected.push(sdk.starts.length); return { model: configuration.options!.model } as any; };
      return q;
    }, history: async () => ({ path: '/fixture/history.jsonl', usage: {}, apiDuration: 0 }) });
    const p = params();
    await collect(bridge.run(p));
    p.messages.push({ type: 'assistant', uuid: 'assistant-1' });
    p.toolUseContext.messages = p.messages;
    p.toolUseContext.options.mainLoopModel = 'opus';
    await bridge.contextUsage({ session: p.toolUseContext.session, toolUseContext: p.toolUseContext });
    expect(sdk.changes).toContainEqual(['model', 'opus']);
    p.toolUseContext.getAppState = () => ({ toolPermissionContext: { mode: 'default' }, settings: { language: 'Japanese' } });
    await bridge.contextUsage({ session: p.toolUseContext.session, toolUseContext: p.toolUseContext });
    expect(sdk.starts).toHaveLength(2);
    expect(sdk.starts[1].options!.settings).toMatchObject({ language: 'Japanese' });
    expect(inspected).toEqual([1, 2]);
    bridge.close();
  });

  test('updates an idle SDK connection before a side control uses a changed model or mode', async () => {
    const sdk = mockSdk();
    const bridge = createSdkRun({ queryFactory: sdk.factory });
    const p = params();
    let mode = 'default';
    p.toolUseContext.getAppState = () => ({ toolPermissionContext: { mode } });
    await collect(bridge.run(p));
    p.messages.push({ type: 'assistant', uuid: 'assistant-1' });
    p.toolUseContext.options.mainLoopModel = 'opus';
    mode = 'acceptEdits';
    await bridge.connection(p);
    expect(sdk.starts).toHaveLength(1);
    expect(sdk.changes).toContainEqual(['model', 'opus']);
    expect(sdk.changes).toContainEqual(['mode', 'acceptEdits']);
    bridge.close();
  });

  test('mirrors native bypass availability so a permitted mode switch works in an existing child', async () => {
    const sdk = mockSdk();
    const bridge = createSdkRun({ queryFactory: sdk.factory });
    const p = params();
    let mode = 'default';
    p.toolUseContext.getAppState = () => ({ toolPermissionContext: { mode, isBypassPermissionsModeAvailable: true } });
    await collect(bridge.run(p));
    expect(sdk.starts[0].options!.allowDangerouslySkipPermissions).toBe(true);
    p.messages.push({ type: 'assistant', uuid: 'assistant-1' }, user('prompt-2', 'second'));
    mode = 'bypassPermissions';
    await collect(bridge.run(p));
    expect(sdk.starts).toHaveLength(1);
    expect(sdk.changes).toContainEqual(['mode', 'bypassPermissions']);
    bridge.close();
    const restricted = mockSdk();
    const restrictedBridge = createSdkRun({ queryFactory: restricted.factory });
    await collect(restrictedBridge.run(params()));
    expect(restricted.starts[0].options!.allowDangerouslySkipPermissions).toBeUndefined();
    restrictedBridge.close();
  });

  test('returns persistent permission changes and explicit interruption to the SDK', async () => {
    const sdk = mockSdk();
    const bridge = createSdkRun({ queryFactory: sdk.factory });
    const p = params();
    const changes = [{ type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'session' }];
    p.canUseTool = async () => ({ behavior: 'allow', updatedInput: { content: 'updated' }, updatedPermissions: changes });
    await collect(bridge.run(p));
    const request = { signal: new AbortController().signal, toolUseID: 'write-fixture', requestId: 'permission-fixture' };
    expect(await sdk.starts[0].options!.canUseTool!('Write', {}, request)).toMatchObject({ behavior: 'allow', updatedPermissions: changes });
    p.canUseTool = async () => ({ behavior: 'deny', message: 'Stop this turn', interrupt: true });
    expect(await sdk.starts[0].options!.canUseTool!('Write', {}, request)).toMatchObject({ behavior: 'deny', interrupt: true });
    bridge.close();
  });

  test('uses the native converter for synthetic skill messages and keeps structured tool output', async () => {
    const message = { type: 'user', isSynthetic: true, parent_tool_use_id: null, session_id: 'child',
      message: { role: 'user', content: 'SKILL_INTERNAL_BODY' }, tool_use_result: { success: true } } as Extract<SDKMessage, { type: 'user' }>;
    const converted = { type: 'user', isMeta: true, message: message.message, uuid: 'native-uuid' };
    const seen: SDKMessage[][] = [];
    const row = await toInternal(message, messages => { seen.push(messages); return [converted]; });
    expect(seen).toEqual([[message]]);
    expect(row).toBe(converted);
    expect(row).toMatchObject({ isMeta: true, toolUseResult: { success: true } });
  });

  test('uses the outer session ID for control-connection context inspection', async () => {
    const sdk = mockSdk();
    const inspections: unknown[] = [];
    const usage: Awaited<ReturnType<Query['getContextUsage']>> = {
      totalTokens: 123, maxTokens: 1000, rawMaxTokens: 1000, percentage: 12,
      categories: [], gridRows: [], model: 'sonnet', memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, apiUsage: null,
    };
    const bridge = createSdkRun({ queryFactory: ((configuration: any) => Object.assign(sdk.factory(configuration), {
      async getContextUsage(options: unknown) { inspections.push(options); return usage; },
    })) as QueryFactory });
    try {
      await collect(bridge.run(params()));
      // Wce supplies the session outside its deliberately partial toolUseContext.
      expect(await bridge.contextUsage({ session: { id: 'parent-1' }, toolUseContext: { options: { tools: [] } }, detail: 'summary' })).toBe(usage);
      expect(await bridge.contextUsage({ session: { id: 'parent-1' }, toolUseContext: params().toolUseContext, detail: 'full' })).toBe(usage);
      expect(inspections).toEqual([{ detail: 'summary' }, { detail: 'full' }]);
      expect(sdk.starts).toHaveLength(1);
      expect(sdk.inputs).toHaveLength(1);
    } finally { bridge.close(); }
  });

  test('rejects control-connection context inspection before its SDK session exists', async () => {
    const sdk = mockSdk();
    const bridge = createSdkRun({ queryFactory: sdk.factory });
    await expect(bridge.contextUsage({ session: { id: 'not-started' }, toolUseContext: { options: { tools: [] } } }))
      .rejects.toThrow('Start a conversation before inspecting context through a control connection');
    expect(sdk.starts).toHaveLength(0);
    bridge.close();
  });

  test('keeps authentication but does not let the SDK child control the outer background job', async () => {
    const parent = {
      ANTHROPIC_API_KEY: 'private-key-fixture', BUN_OPTIONS: '--preload=outer',
      CLAUDE_JOB_DIR: '/outer/job', CLAUDE_CODE_SESSION_KIND: 'bg', CLAUDE_BG_BACKEND: 'daemon',
      CLAUDE_BG_RENDEZVOUS_SOCK: '/outer/socket', CLAUDE_BG_RV_AUTH: 'outer-control-token',
      CLAUDE_BG_SOCKET_TOKENS_PATH: '/outer/control-keys',
    };
    const previous = Object.fromEntries(Object.keys(parent).map(key => [key, process.env[key]]));
    const sdk = mockSdk();
    const bridge = createSdkRun({ queryFactory: sdk.factory });
    try {
      Object.assign(process.env, parent);
      await collect(bridge.run(params()));
      const child = sdk.starts[0].options!.env!;
      expect(child.ANTHROPIC_API_KEY).toBe(parent.ANTHROPIC_API_KEY);
      for (const key of Object.keys(parent).filter(key => key !== 'ANTHROPIC_API_KEY')) {
        expect(child[key]).toBeUndefined();
        expect(process.env[key]).toBe(parent[key as keyof typeof parent]);
      }
    } finally {
      bridge.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('preserves an empty effective built-in tool list instead of enabling SDK defaults', async () => {
    const sdk = mockSdk();
    const p = params();
    p.toolUseContext.options.tools = [];
    const bridge = createSdkRun({ queryFactory: sdk.factory });
    await collect(bridge.run(p));
    expect(sdk.starts[0].options!.tools).toEqual([]);
    bridge.close();
  });

  test('passes the original effective effort and restarts after a session effort change', async () => {
    const sdk = mockSdk();
    let effort: 'low' | 'high' = 'low';
    const bridge = createSdkRun({ queryFactory: sdk.factory,
      helpers: async () => ({
        createAssistant: ({ content }) => ({ type: 'assistant', message: { content } }),
        findTool: (tools, name) => tools.find(tool => tool.name === name),
        normalizePrompt: messages => messages.filter(message => message.type === 'user'),
        effort: () => effort,
      }),
      history: async () => ({ path: '/tmp/parent.jsonl', usage: {}, apiDuration: 0 }),
    });
    await collect(bridge.run(params()));
    expect(sdk.starts[0].options!.effort).toBe('low');
    effort = 'high';
    await collect(bridge.run(params('parent-1', [{ type: 'assistant', uuid: 'assistant-1', message: {} }, user('prompt-2', 'second')])));
    expect(sdk.starts).toHaveLength(2);
    expect(sdk.starts[1].options!.effort).toBe('high');
    bridge.close();
  });

  test('passes effective parent settings and explicit MCP configuration without rediscovering strict MCP servers', async () => {
    const sdk = mockSdk();
    const p = params();
    const servers = { fixture: { type: 'stdio', command: 'fixture-server', args: ['--local'] } };
    p.toolUseContext.options.dynamicMcpConfig = servers;
    p.toolUseContext.options.tools.push({ name: 'mcp__fixture__probe' });
    p.toolUseContext.getAppState = () => ({ settings: { effortLevel: 'low', apiKeyHelper: 'shared-key-helper', permissions: { deny: ['Bash(rm *)'] } }, toolPermissionContext: { mode: 'default' } });
    const bridge = createSdkRun({ queryFactory: sdk.factory });
    process.argv.push('--strict-mcp-config');
    try {
      await collect(bridge.run(p));
      expect(sdk.starts[0].options).toMatchObject({
        tools: ['Write'], mcpServers: servers, strictMcpConfig: true,
        settings: { effortLevel: 'low', apiKeyHelper: '', permissions: { deny: ['Bash(rm *)'] } },
      });
    } finally {
      process.argv.pop();
      bridge.close();
    }
  });

  test('recreates the SDK child from saved history when its effective tool configuration changes', async () => {
    const sdk = mockSdk();
    const bridge = createSdkRun({ queryFactory: sdk.factory, history: async () => ({ path: '/tmp/parent.jsonl', usage: {}, apiDuration: 0 }) });
    await collect(bridge.run(params()));
    const next = params('parent-1', [user('prompt-1', 'first'), { type: 'assistant', uuid: 'assistant-1', message: {} }, user('prompt-2', 'second')]);
    next.toolUseContext.options.tools = [];
    await collect(bridge.run(next));
    expect(sdk.starts).toHaveLength(2);
    expect(sdk.starts[1].options).toMatchObject({ tools: [], resume: '/tmp/parent.jsonl', resumeSessionAt: 'assistant-1' });
    expect(sdk.closed).toBe(1);
    bridge.close();
  });

  test('keeps one child process across turns, sends only new prompts, and converts SDK messages', async () => {
    const sdk = mockSdk();
    const events: Record<string, unknown>[] = [];
    const bridge = createSdkRun({ queryFactory: sdk.factory, trace: (event) => events.push(event) });
    const first = await collect(bridge.run(params()));
    expect(first.terminal).toEqual({ reason: 'completed' });
    expect(first.messages).toHaveLength(3);
    expect(first.messages[1]).not.toHaveProperty('parent_tool_use_id');
    expect(first.messages[1]).toHaveProperty('timestamp');
    expect(first.messages[2]).toHaveProperty('toolUseResult', { success: true });
    const second = params('parent-1', [user('prompt-1', 'first'), { type: 'assistant', uuid: 'assistant-1', message: {} }, user('prompt-2', 'second')]);
    second.toolUseContext.options.mainLoopModel = 'opus';
    await collect(bridge.run(second));
    expect(sdk.starts).toHaveLength(1);
    expect(sdk.inputs.every(input => input.client_composed === true)).toBe(true);
    expect(sdk.inputs.map((input) => input.message.content)).toEqual([[{ type: 'text', text: 'first' }], [{ type: 'text', text: 'second' }]]);
    expect(sdk.changes).toEqual([['model', 'opus']]);
    expect(sdk.starts[0].options).toMatchObject({ persistSession: true, permissionMode: 'default', includePartialMessages: true });
    expect(sdk.starts[0].options!.sessionId).not.toBe('parent-1');
    expect(sdk.starts[0].options!.systemPrompt).toBe('original system prompt');
    expect(JSON.stringify(events)).not.toContain('first');
    bridge.close();
    expect(sdk.closed).toBe(1);
  });

  test('uses the original permission callback and preserves SDK safety prompt metadata', async () => {
    const sdk = mockSdk();
    const calls: unknown[][] = [];
    const p = params();
    p.canUseTool = async (...args) => { calls.push(args); return { behavior: 'allow', updatedInput: { file_path: '/tmp/ok', _simulatedSedEdit: true } }; };
    const bridge = createSdkRun({ queryFactory: sdk.factory, helpers: async () => ({
      createAssistant: ({ content }) => ({ type: 'assistant', message: { content } }),
      findTool: (tools, name) => tools.find((tool) => tool.name === name),
      normalizePrompt: messages => messages.filter(message => message.type === 'user'),
    }) });
    const generator = bridge.run(p);
    await generator.next();
    const answer = await sdk.starts[0].options!.canUseTool!('Write', { file_path: '/tmp/ok' }, {
      signal: new AbortController().signal, toolUseID: 'write-1', requestId: 'request-1', defaultToNo: true, suppressAlwaysAllowRule: true,
    });
    expect(answer).toEqual({ behavior: 'allow', updatedInput: { file_path: '/tmp/ok' } });
    expect(calls[0][0]).toBe(p.toolUseContext.options.tools[0]);
    expect(calls[0][2]).toMatchObject({ forRemoteExecution: false });
    expect(calls[0][5]).toMatchObject({ behavior: 'ask', forcedByCaller: true, personOnly: true, defaultToNo: true, suppressAlwaysAllowRule: true });
    await collect(generator);
    bridge.close();
  });

  test('finishes an interrupted turn without a result and keeps the SDK available for background events and the next input', async () => {
    const started = Promise.withResolvers<void>(), cancelled = Promise.withResolvers<void>(), late = Promise.withResolvers<void>();
    let starts = 0, closed = 0, interrupts = 0;
    const bridge = createSdkRun({ requirePromptEcho: true, queryFactory: ((configuration: any) => {
      starts++;
      return Object.assign((async function* () {
        let turn = 0;
        for await (const input of configuration.prompt) {
          if (!turn++) {
            started.resolve();
            await cancelled.promise;
            // interrupt can finish without a result; the same reader must continue while idle.
            yield { type: 'system', subtype: 'informational', uuid: 'late', message: 'BACKGROUND_STILL_CONNECTED', level: 'info' };
          } else {
            yield { type: 'assistant', uuid: 'second-answer', message: { role: 'assistant', content: 'second answer' } };
            yield { type: 'result', subtype: 'success', is_error: false, modelUsage: {}, duration_api_ms: 0, user_message_uuid: input.uuid };
          }
        }
      })(), { close() { closed++; }, async interrupt() { interrupts++; } });
    }) as QueryFactory });
    const p = params();
    p.toolUseContext.sdkApplyEvent = () => { late.resolve(); };
    const pending = collect(bridge.run(p));
    await started.promise;
    p.toolUseContext.abortController.abort();
    expect((await pending).terminal.reason).toBe('aborted_streaming');
    expect(interrupts).toBe(1);
    expect(closed).toBe(0);
    cancelled.resolve();
    await late.promise;
    const next = { ...p, messages: [...p.messages, user('prompt-2', 'second')],
      toolUseContext: { ...p.toolUseContext, abortController: new AbortController() } };
    expect((await collect(bridge.run(next))).terminal.reason).toBe('completed');
    expect(starts).toBe(1);
    bridge.close();
  });

  test('keeps turn controls serialized while an interrupted unread notification is being delivered', async () => {
    const started = Promise.withResolvers<void>(), releaseNotice = Promise.withResolvers<void>();
    const idleEntered = Promise.withResolvers<void>(), finishIdle = Promise.withResolvers<void>();
    const applied: unknown[] = [];
    const bridge = createSdkRun({ queryFactory: ((configuration: any) => Object.assign((async function* () {
      for await (const _input of configuration.prompt) {
        started.resolve();
        await releaseNotice.promise;
        yield { type: 'result', subtype: 'success', is_error: false, modelUsage: {}, duration_api_ms: 0 };
      }
    })(), {
      close() {},
      async interrupt() {
        releaseNotice.resolve();
        // Let the sole SDK reader queue the arriving frame before interrupt ACK.
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      },
      async applyFlagSettings(settings: unknown) { applied.push(settings); },
    })) as QueryFactory,
    ledger: async () => {
      idleEntered.resolve(); await finishIdle.promise;
      return { Z2o() {}, eGo() {}, tGo() {}, hGo() { return undefined; } };
    } });
    const p = params();
    p.toolUseContext.sdkApplyEvent = () => {};
    const pending = collect(bridge.run(p));
    await started.promise;
    p.toolUseContext.abortController.abort();
    await idleEntered.promise;
    bridge.applySettings(p.toolUseContext.session.id, { fastMode: true });
    p.toolUseContext.options.fastMode = true;
    await Promise.resolve(); await Promise.resolve();
    expect(applied).toHaveLength(0);
    finishIdle.resolve();
    expect((await pending).terminal.reason).toBe('aborted_streaming');
    await bridge.connection(p);
    expect(applied).toEqual([{ fastMode: true }]);
    bridge.close();
  });

  test('fails explicitly and closes the child when the SDK rejects interruption', async () => {
    const started = Promise.withResolvers<void>();
    const denied = new Error('fixture interrupt rejected');
    let closed = 0;
    const bridge = createSdkRun({ queryFactory: ((configuration: any) => Object.assign((async function* () {
      for await (const _input of configuration.prompt) {
        started.resolve();
        await new Promise(() => {});
      }
    })(), { close() { closed++; }, async interrupt() { throw denied; } })) as unknown as QueryFactory });
    const p = params();
    const pending = collect(bridge.run(p));
    await started.promise;
    p.toolUseContext.abortController.abort();
    await expect(pending).rejects.toBe(denied);
    expect(closed).toBe(1);
    bridge.close();
  });

  test('does not discard an interrupt result that lacks the user UUID', async () => {
    const started = Promise.withResolvers<void>(), cancelled = Promise.withResolvers<void>();
    const bridge = createSdkRun({ requirePromptEcho: true, queryFactory: ((configuration: any) => Object.assign((async function* () {
      for await (const _input of configuration.prompt) {
        started.resolve(); await cancelled.promise;
        yield { type: 'result', subtype: 'success', is_error: false, modelUsage: {}, duration_api_ms: 0 };
      }
    })(), { close() {}, async interrupt() { cancelled.resolve(); } })) as QueryFactory });
    const p = params();
    const pending = collect(bridge.run(p));
    await started.promise;
    p.toolUseContext.abortController.abort();
    expect((await pending).terminal.reason).toBe('aborted_streaming');
    bridge.close();
  });

  test('interrupts the SDK child when the original turn aborts', async () => {
    const sdk = mockSdk();
    const bridge = createSdkRun({ queryFactory: sdk.factory });
    const p = params();
    const generator = bridge.run(p);
    await generator.next();
    p.toolUseContext.abortController.abort();
    const result = await collect(generator);
    expect(result.terminal.reason).toBe('aborted_streaming');
    expect(sdk.changes).toContain('interrupt');
    bridge.close();
  });

  test('forks an existing parent transcript at the last assistant before the current prompt', async () => {
    const sdk = mockSdk();
    const cuts: string[] = [];
    const saved: unknown[] = [];
    const bridge = createSdkRun({ queryFactory: sdk.factory, history: async (cutoff, messages) => {
      cuts.push(cutoff); saved.push(messages);
      return { path: '/tmp/parent.jsonl', usage: {}, apiDuration: 0 };
    } });
    const retainedHook = { type: 'attachment', uuid: 'retained-hook', attachment: { type: 'hook_system_message', content: 'notice' } };
    const p = params('resumed', [{ type: 'system', subtype: 'compact_boundary', uuid: 'boundary',
      compactMetadata: { preservedMessages: { uuids: ['old-answer', 'retained-hook'] } } },
      user('old', 'old'), { type: 'assistant', uuid: 'old-answer', message: {} }, retainedHook, user('new', 'new')]);
    await collect(bridge.run(p));
    expect(cuts).toEqual(['old-answer']);
    expect(saved).toEqual([p.messages]);
    expect(sdk.starts[0].options).toMatchObject({ resume: '/tmp/parent.jsonl', resumeSessionAt: 'old-answer', forkSession: true, persistSession: true });
    expect(sdk.inputs[0].message.content).toEqual([{ type: 'text', text: 'new' }]);
    bridge.close();
  });

  test('passes SDK execution failures to the original engine instead of calling a local runner', async () => {
    const sdk = mockSdk(undefined, () => ({ subtype: 'error_during_execution', is_error: true, errors: ['SDK failed'] }));
    const bridge = createSdkRun({ queryFactory: sdk.factory });
    await expect(collect(bridge.run(params()))).rejects.toThrow('SDK failed');
    expect(sdk.closed).toBe(1);
  });

  test('denies unknown tools and already aborted permission requests', async () => {
    const sdk = mockSdk();
    let approvals = 0;
    const p = params();
    p.canUseTool = async () => { approvals++; return { behavior: 'allow' }; };
    const bridge = createSdkRun({ queryFactory: sdk.factory, helpers: async () => ({
      createAssistant: ({ content }) => ({ type: 'assistant', message: { content } }),
      findTool: (tools, name) => tools.find((tool) => tool.name === name),
      normalizePrompt: messages => messages.filter(message => message.type === 'user'),
    }) });
    const generator = bridge.run(p);
    await generator.next();
    const request = { signal: new AbortController().signal, toolUseID: 'tool-1', requestId: 'request-1' };
    expect(await sdk.starts[0].options!.canUseTool!('Unknown', {}, request)).toMatchObject({ behavior: 'deny' });
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await sdk.starts[0].options!.canUseTool!('Write', {}, { ...request, signal: cancelled.signal })).toMatchObject({ behavior: 'deny', interrupt: true });
    expect(approvals).toBe(0);
    await collect(generator);
    bridge.close();
  });

  test('does not treat subagent assistant messages as main conversation messages', async () => {
    expect(await toInternal({ type: 'assistant', parent_tool_use_id: 'agent-tool', session_id: 'child', message: { content: [] } } as unknown as SDKMessage)).toBeUndefined();
  });

  test('restarts from parent history after rewind and compaction and starts empty after clear', async () => {
    const sdk = mockSdk();
    const cuts: string[] = [];
    const bridge = createSdkRun({ queryFactory: sdk.factory, history: async cutoff => {
      cuts.push(cutoff); return { path: '/tmp/parent.jsonl', usage: {}, apiDuration: 0 };
    } });
    await collect(bridge.run(params()));
    await collect(bridge.run(params('parent-1', [user('old', 'old'), { type: 'assistant', uuid: 'rewind-point', message: {} }, user('after-rewind', 'revised')])));
    await collect(bridge.run(params('parent-1', [
      { type: 'system', subtype: 'compact_boundary', uuid: 'manual-compact' },
      { type: 'assistant', uuid: 'assistant-1', message: {} }, user('after-compact', 'continue'),
    ])));
    await collect(bridge.run(params('parent-1', [user('after-clear', 'fresh')])));
    expect(sdk.starts).toHaveLength(4);
    expect(cuts).toEqual(['rewind-point', 'assistant-1']);
    expect(sdk.starts[3].options!.resume).toBeUndefined();
    expect(sdk.closed).toBe(3);
    bridge.close();
  });

  test('delegates generated catalogs to the SDK and preserves hook and file attachments', async () => {
    const sdk = mockSdk();
    let ids: unknown[] = [];
    const bridge = createSdkRun({ queryFactory: sdk.factory, helpers: async () => ({
      createAssistant: () => ({ type: 'assistant' }), findTool: () => undefined,
      normalizePrompt(messages) {
        ids = messages.map(message => message.uuid);
        return [user('normalized', 'human + hook + file')];
      },
    }) });
    const attachment = (uuid: string, type: string) => ({ type: 'attachment', uuid, attachment: { type } });
    await collect(bridge.run(params('parent-1', [user('human', 'question'),
      attachment('skills', 'skill_listing'), attachment('agents', 'agent_listing_delta'),
      attachment('mcp', 'mcp_instructions_delta'), attachment('hook', 'hook_additional_context'), attachment('file', 'file'),
    ])));
    expect(ids).toEqual(['human', 'hook', 'file']);
    bridge.close();
  });

  test('normalizes the entire current turn including meta and hook attachments', async () => {
    const sdk = mockSdk();
    let segment: RunParams['messages'] = [];
    const bridge = createSdkRun({ queryFactory: sdk.factory, helpers: async () => ({
      createAssistant: () => ({ type: 'assistant' }), findTool: () => undefined,
      normalizePrompt(messages) {
        segment = messages;
        return [{ type: 'user', uuid: 'normalized', message: { role: 'user', content: 'human + hook + attachment' } }];
      },
    }) });
    await collect(bridge.run(params('parent-1', [user('current', 'human'), { type: 'user', isMeta: true, uuid: 'meta', message: { role: 'user', content: 'hook' } }, { type: 'attachment', uuid: 'attachment', attachment: { content: 'attachment' } }])));
    expect(segment.map(message => message.uuid)).toEqual(['current', 'meta', 'attachment']);
    expect(sdk.inputs[0].message.content).toEqual([{ type: 'text', text: 'human + hook + attachment' }]);
    bridge.close();
  });

  test('subtracts restored transcript costs from a newly forked SDK child', async () => {
    const usage = (inputTokens: number, costUSD: number): ModelUsage => ({ inputTokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD, contextWindow: 200000, maxOutputTokens: 32000 });
    const sdk = mockSdk(undefined, () => ({ modelUsage: { sonnet: usage(12, 101) }, duration_api_ms: 1200 }));
    const costs: number[] = [], durations: number[] = [];
    let parentUsage = usage(10, 100);
    const bridge = createSdkRun({ queryFactory: sdk.factory,
      history: async () => ({ path: '/tmp/parent.jsonl', usage: { sonnet: usage(10, 100) }, apiDuration: 1000 }),
      ledger: async () => ({ hGo: () => parentUsage, eGo(cost, total) { costs.push(cost); parentUsage = total; }, Z2o(duration) { durations.push(duration); }, tGo() {} }),
    });
    await collect(bridge.run(params('parent-1', [{ type: 'assistant', uuid: 'saved', message: {} }, user('new', 'new')])));
    expect(costs).toEqual([1]);
    expect(durations).toEqual([200]);
    expect(parentUsage.inputTokens).toBe(12);
    expect(parentUsage.costUSD).toBe(101);
    bridge.close();
  });

  test('adds cumulative SDK usage differences without overwriting existing parent costs', async () => {
    const usage = (inputTokens: number, costUSD: number): ModelUsage => ({ inputTokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD, contextWindow: 200000, maxOutputTokens: 32000 });
    const sdk = mockSdk(undefined, (turn) => ({ modelUsage: { sonnet: usage(turn === 1 ? 2 : 5, turn === 1 ? 1 : 3) }, duration_api_ms: turn === 1 ? 100 : 250 }));
    let parentUsage = usage(10, 100);
    const costs: number[] = [], durations: number[] = [], spent: number[] = [];
    const bridge = createSdkRun({ queryFactory: sdk.factory, ledger: async () => ({
      hGo: () => parentUsage,
      eGo(cost, total) { costs.push(cost); parentUsage = total; },
      Z2o(duration) { durations.push(duration); },
      tGo(tokens) { spent.push(tokens.inputTokens); },
    }) });
    await collect(bridge.run(params()));
    await collect(bridge.run(params('parent-1', [user('prompt-1', 'first'), { type: 'assistant', uuid: 'assistant-1', message: {} }, user('prompt-2', 'second')])));
    expect(costs).toEqual([1, 2]);
    expect(durations).toEqual([100, 150]);
    expect(spent).toEqual([2, 3]);
    expect(parentUsage.inputTokens).toBe(15);
    expect(parentUsage.costUSD).toBe(103);
    bridge.close();
  });
  test('keeps the API duration baseline when SDK local command results report zero', async () => {
    const sdk = mockSdk(undefined, turn => ({ duration_api_ms: turn === 1 ? 100 : turn === 2 ? 0 : 250, ...(turn === 2 ? { local_command: 'compact' } : {}) }));
    const durations: number[] = [];
    const bridge = createSdkRun({ queryFactory: sdk.factory, ledger: async () => ({ hGo() { return undefined; }, eGo() {}, tGo() {}, Z2o(duration) { durations.push(duration); } }) });
    await collect(bridge.run(params()));
    const after = params('parent-1', [user('prompt-1', 'first'), { type: 'assistant', uuid: 'assistant-1', message: {} }]);
    await collect(bridge.run({ ...after, sdkCommand: '/compact' }));
    await collect(bridge.run(params('parent-1', [...after.messages, user('prompt-3', 'continue')])));
    expect(durations).toEqual([100, 0, 150]);
    expect(sdk.starts).toHaveLength(1);
    bridge.close();
  });

  test('accepts SDK no-API results without a local-command marker', async () => {
    const sdk = mockSdk(undefined, turn => ({ duration_api_ms: turn === 1 ? 100 : turn === 2 ? 0 : 250 }));
    const durations: number[] = [];
    const bridge = createSdkRun({ queryFactory: sdk.factory, ledger: async () => ({
      hGo() { return undefined; }, eGo() {}, tGo() {}, Z2o(value) { durations.push(value); },
    }) });
    for (let turn = 1; turn <= 3; turn++) {
      const messages = turn === 1 ? [user('prompt-1', 'first')] :
        [user('prompt-1', 'first'), { type: 'assistant', uuid: 'assistant-1', message: {} }, user(`prompt-${turn}`, 'continue')];
      expect((await collect(bridge.run(params('parent-1', messages)))).terminal.reason).toBe('completed');
    }
    expect(durations).toEqual([100, 0, 150]);
    expect(sdk.starts).toHaveLength(1);
    expect(sdk.closed).toBe(0);
    bridge.close();
  });

  test('keeps the child and cumulative baselines after a zero-duration background handback', async () => {
    const released = Promise.withResolvers<void>(), delivered = Promise.withResolvers<void>();
    const durations: number[] = [], costs: number[] = [];
    const usage = (tokens: number, cost: number) => ({ inputTokens: tokens, outputTokens: 0,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: cost,
      contextWindow: 200000, maxOutputTokens: 32000 });
    let closed = 0, parentUsage = usage(0, 0), saves = 0;
    const bridge = createSdkRun({ queryFactory: ((configuration: any) => Object.assign((async function* () {
      let turn = 0;
      for await (const input of configuration.prompt) {
        turn++;
        yield { type: 'assistant', uuid: `answer-${turn}`, message: { role: 'assistant', content: 'answer' } };
        yield { type: 'result', subtype: 'success', is_error: false, duration_api_ms: turn === 1 ? 100 : 250,
          modelUsage: { sonnet: usage(turn === 1 ? 2 : 5, turn === 1 ? 1 : 3) } };
        if (turn === 1) {
          await released.promise;
          yield { type: 'result', subtype: 'success', is_error: false, duration_api_ms: 0, modelUsage: {} };
          yield { type: 'system', subtype: 'informational', uuid: 'late-notice', message: 'HANDOVER_COMPLETED', level: 'info' };
        }
      }
    })(), { close() { closed++; }, async interrupt() {}, async setModel() {}, async setPermissionMode() {} })) as unknown as QueryFactory,
    ledger: async () => ({ hGo: () => parentUsage, eGo(cost, total) { costs.push(cost); parentUsage = total; },
      Z2o(value) { durations.push(value); }, tGo() {} }),
    helpers: async () => ({ createAssistant: ({ content }) => ({ type: 'assistant', message: { content } }),
      findTool: () => undefined, normalizePrompt: messages => messages.filter(message => message.type === 'user'),
      saveContext() { if (++saves === 3) delivered.resolve(); } }) });
    const first = params();
    first.toolUseContext.sdkApplyEvent = () => {};
    await collect(bridge.run(first));
    released.resolve();
    await delivered.promise;
    expect(closed).toBe(0);
    const next = params('parent-1', [first.messages[0], { type: 'assistant', uuid: 'answer-1', message: {} }, user('next', 'continue')]);
    await collect(bridge.run(next));
    expect(durations).toEqual([100, 0, 150]);
    expect(costs).toEqual([1, 2]);
    expect(parentUsage.inputTokens).toBe(5);
    expect(closed).toBe(0);
    bridge.close();
  });

  test('sends only the next input after aligning a compacted history ending in retained user messages', async () => {
    const sdk = mockSdk();
    let historyReads = 0;
    const bridge = createSdkRun({ queryFactory: sdk.factory, history: async () => { historyReads++; return { path: '/tmp/unexpected.jsonl', usage: {}, apiDuration: 0 }; } });
    await collect(bridge.run(params()));
    await collect(bridge.run({ ...params('parent-1', [user('prompt-1', 'first'), { type: 'assistant', uuid: 'assistant-1', message: {} }]), sdkCommand: '/compact' }));
    const compacted = [
      { type: 'system', subtype: 'compact_boundary', uuid: 'boundary' },
      { ...user('summary', 'SDK COMPACT SUMMARY'), isMeta: true, isCompactSummary: true },
      user('retained', 'RETAINED USER INPUT'),
    ];
    bridge.alignHistory('parent-1', compacted);
    await collect(bridge.run(params('parent-1', [...compacted, user('next', 'NEXT INPUT ONLY')])));
    expect(sdk.starts).toHaveLength(1);
    expect(historyReads).toBe(0);
    expect(sdk.inputs.map(input => input.message.content)).toEqual([
      [{ type: 'text', text: 'first' }], [{ type: 'text', text: '/compact' }], [{ type: 'text', text: 'NEXT INPUT ONLY' }],
    ]);
    bridge.close();
  });

});
