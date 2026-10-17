import { describe, expect, test } from 'bun:test';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSdkComplete } from '../src/sdk-completion';

type Dependencies = NonNullable<Parameters<typeof createSdkComplete>[0]>;
const assistant = (text: string, id = 'answer') => ({
  type: 'assistant', parent_tool_use_id: null, session_id: 'sdk-child', uuid: 'assistant-uuid',
  message: { role: 'assistant', id, content: [{ type: 'text', text }] },
});
const result = (extra: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result: '',
  usage: { input_tokens: 20, output_tokens: 7 }, stop_reason: 'end_turn', ...extra,
});
function fixture(events: Record<string, any>[] = [assistant('Native answer'), result()]) {
  const starts: Parameters<NonNullable<Dependencies['queryFactory']>>[0][] = [];
  const inputs: SDKUserMessage[] = [];
  let closed = 0;
  const complete = createSdkComplete({
    helpers: async () => ({
      helperModel: () => 'native-helper-model', effort: (_model, options) => options.effortValue,
      assistant: content => ({ type: 'assistant', message: { id: 'synthetic', role: 'assistant', content } }),
    }),
    queryFactory: params => {
      starts.push(params);
      return Object.assign((async function* () {
        if (typeof params.prompt !== 'string') for await (const input of params.prompt) inputs.push(input);
        for (const event of events) yield event as SDKMessage;
      })(), { close() { closed++; } }) as Query;
    },
    executable: '/native/claude', env: { BUN_OPTIONS: '--preload=parent', ANTHROPIC_AUTH_TOKEN: 'inherited-token' }, trace() {},
  });
  return { ...complete, starts, inputs, get closed() { return closed; } };
}

describe('single tool-free SDK completions', () => {
  test('preserves system blocks and literal input, uses the native helper model, and disables tool execution', async () => {
    const sdk = fixture();
    const answer = await sdk.complete({
      systemPrompt: ['First system block', 'Second system block'], userPrompt: '/literal @not-a-file',
      options: { model: 'ignored-by-native-nL', maxOutputTokensOverride: 120, helperEffortFor: model => {
        expect(model).toBe('native-helper-model');
        return { effortValue: 'low' };
      } },
    });
    expect(sdk.starts[0].options).toMatchObject({
      pathToClaudeCodeExecutable: '/native/claude', model: 'native-helper-model', effort: 'low',
      systemPrompt: ['First system block', 'Second system block'], thinking: { type: 'disabled' },
      tools: [], maxTurns: 1, verbatimPrompts: true, persistSession: false,
      settingSources: [], strictMcpConfig: true, mcpServers: {}, settings: { disableAllHooks: true },
      env: { ANTHROPIC_AUTH_TOKEN: 'inherited-token', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '120', DISABLE_PROMPT_CACHING: '1' },
    });
    expect(sdk.starts[0].options!.env!.BUN_OPTIONS).toBeUndefined();
    expect(sdk.inputs[0].message.content).toBe('/literal @not-a-file');
    expect(answer.message.content).toEqual([{ type: 'text', text: 'Native answer' }]);
    expect(answer.message.usage).toEqual({ input_tokens: 20, output_tokens: 7 });
    expect(answer).not.toHaveProperty('session_id');
    expect(sdk.closed).toBe(1);
  });

  test('merges finalized content blocks for one assistant response', async () => {
    const sdk = fixture([assistant('First block'), assistant('Second block'), result()]);
    const answer = await sdk.complete({ userPrompt: 'Question', options: {} });
    expect(answer.message.content).toEqual([{ type: 'text', text: 'First block' }, { type: 'text', text: 'Second block' }]);
  });

  test('returns structured output as JSON text in the native assistant shape', async () => {
    const sdk = fixture([result({ structured_output: { title: 'Session name' } })]);
    const outputFormat = { type: 'json_schema' as const, schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } };
    const answer = await sdk.complete({ userPrompt: 'Name this session', outputFormat, options: {} });
    expect(sdk.starts[0].options!.outputFormat).toEqual(outputFormat);
    expect(answer.message.content).toEqual([{ type: 'text', text: '{"title":"Session name"}' }]);
  });

  test('keeps image and text user content blocks unchanged', async () => {
    const sdk = fixture();
    const content = [{ type: 'text' as const, text: 'Classify this' }, { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'sample' } }];
    await sdk.complete({ userPrompt: content, options: {} });
    expect(sdk.inputs[0].message.content).toEqual(content);
  });

  test('propagates SDK failures and rejects missing results or unexpected tools', async () => {
    const failed = fixture([result({ is_error: true, result: 'Model failed' })]);
    await expect(failed.complete({ userPrompt: 'Question', options: {} })).rejects.toThrow('Model failed');
    expect(failed.closed).toBe(1);
    const missing = fixture([assistant('Incomplete')]);
    await expect(missing.complete({ userPrompt: 'Question', options: {} })).rejects.toThrow('without a result');
    const tools = fixture([{ ...assistant(''), message: { id: 'tool', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }, result()]);
    await expect(tools.complete({ userPrompt: 'Question', options: {} })).rejects.toThrow('emitted a tool call');
  });

  test('does not start a subprocess for an already cancelled completion', async () => {
    const sdk = fixture();
    const controller = new AbortController(); controller.abort(new Error('Cancelled by caller'));
    await expect(sdk.complete({ userPrompt: 'Question', signal: controller.signal, options: {} })).rejects.toThrow('Cancelled by caller');
    expect(sdk.starts).toHaveLength(0);
  });
});
