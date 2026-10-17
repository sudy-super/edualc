import { describe, expect, test } from 'bun:test';
import type { ModelUsage, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSdkRun as makeSdkRun, toInternal, type RunParams } from '../src/sdk-run';
function createSdkRun(options: Parameters<typeof makeSdkRun>[0] = {}) {
  return makeSdkRun({
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
    expect(sdk.starts[0].options!.systemPrompt).toContain('original project rules');
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
    const p = params('resumed', [user('old', 'old'), { type: 'assistant', uuid: 'old-answer', message: {} }, user('new', 'new')]);
    await collect(bridge.run(p));
    expect(cuts).toEqual(['old-answer']);
    expect(saved).toEqual([p.messages.slice(0, 2)]);
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

  test('does not treat subagent assistant messages as main conversation messages', () => {
    expect(toInternal({ type: 'assistant', parent_tool_use_id: 'agent-tool', session_id: 'child', message: { content: [] } } as unknown as SDKMessage)).toBeUndefined();
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
