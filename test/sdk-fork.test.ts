import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { query } from '../src/sdk';
import { createSdkToolFreeFork as makeSdkToolFreeFork } from '../src/sdk-fork';
function createSdkToolFreeFork(options: Parameters<typeof makeSdkToolFreeFork>[0]) {
  return makeSdkToolFreeFork({ convertMessages: messages => messages as any, ...options });
}

const uuid = '00000000-0000-4000-8000-000000000001';
const usage = { input_tokens: 12, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 7 };
const assistant = { type: 'assistant', uuid, session_id: uuid, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'RECAP' }] } };
const result = { type: 'result', subtype: 'success', is_error: false, usage, result: 'RECAP' };
function params() {
  return { querySource: 'away_summary', forkLabel: 'away_summary', maxTurns: 1,
    promptMessages: [{ type: 'user', uuid, message: { role: 'user', content: 'Summarize.' } }],
    cacheSafeParams: { systemPrompt: ['SYSTEM'], systemContext: { system: 'SYSTEM_CONTEXT' }, userContext: { user: 'USER_CONTEXT' }, forkContextMessages: [
      { type: 'user', uuid: 'history-user', message: { role: 'user', content: 'AGENT_HISTORY' } },
      { type: 'assistant', uuid: 'history-assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'AGENT_REPLY' }] } },
    ], toolUseContext: { options: { tools: [], mainLoopModel: 'model-test' }, abortController: new AbortController() } },
  };
}
const helpers = async () => ({ zxe: (rows: any[]) => rows, JXs: (row: any) => row, Vbr: (id: string) => ({ sessionId: id }), wT: (rows: any[]) => rows });
function factory(events: any[], inspect?: (args: any) => void, closed?: () => void): typeof query {
  return ((args: any) => {
    inspect?.(args);
    return { async *[Symbol.asyncIterator]() { yield* events; }, close() { closed?.(); } };
  }) as unknown as typeof query;
}

describe('SDK tool-free forks', () => {
  test('seeds the supplied history independently and removes it after success', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sdk-fork-test-'));
    let seed = '', input: any, options: any, closed = false;
    const p = params();
    const snapshot = structuredClone(p.cacheSafeParams.forkContextMessages);
    const seen: any[] = [], deltas: any[] = [];
    const run = createSdkToolFreeFork({ helpers, tempRoot: directory, queryFactory: factory([
      { type: 'stream_event', session_id: uuid, parent_tool_use_id: null, event: { type: 'message_stop' } }, assistant, result,
    ], args => { options = args.options; seed = readFileSync(options.resume, 'utf8'); input = args.prompt; }, () => { closed = true; }) });
    try {
      const output = await run({ ...p, maxOutputTokens: 123, onMessage: row => seen.push(row), onStreamDelta: row => deltas.push(row) });
      expect(seed).toContain('AGENT_HISTORY');
      const records = seed.trim().split('\n').map(row => JSON.parse(row));
      expect(records[0].parentUuid).toBeNull();
      expect(records[1].parentUuid).toBe('history-user');
      expect(options.forkSession).toBe(true);
      expect(options.persistSession).toBe(false);
      expect(options.tools).toEqual([]);
      expect(options.systemPrompt).toBe('SYSTEM\n\nSYSTEM_CONTEXT\n\nUSER_CONTEXT');
      expect(options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('123');
      expect(options.maxTurns).toBe(1);
      expect(options.model).toBe('model-test');
      const prompts = []; for await (const message of input) prompts.push(message);
      expect(prompts[0].message.content).toEqual([{ type: 'text', text: 'Summarize.' }]);
      expect(output.messages[0].message.content[0].text).toBe('RECAP');
      expect(output.totalUsage.input_tokens).toBe(12);
      expect(output.totalUsage.cache_read_input_tokens).toBe(7);
      expect(seen).toHaveLength(1);
      expect(deltas).toHaveLength(1);
      expect(closed).toBe(true);
      expect(readdirSync(directory)).toEqual([]);
      expect(p.cacheSafeParams.forkContextMessages).toEqual(snapshot);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  test('preserves native compact boundaries in a seeded history', async () => {
    const p = params();
    p.cacheSafeParams.forkContextMessages.push({ type: 'system', subtype: 'compact_boundary', uuid: 'boundary', compactMetadata: { trigger: 'manual' } } as any);
    let rows: any[] = [];
    const run = createSdkToolFreeFork({ helpers, queryFactory: factory([assistant, result], args => { rows = readFileSync(args.options.resume, 'utf8').trim().split('\n').map(row => JSON.parse(row)); }) });
    await run(p);
    expect(rows[2].parentUuid).toBeNull();
    expect(rows[2].logicalParentUuid).toBe('history-assistant');
  });
  test('does not resume an empty history', async () => {
    const p = params(); p.cacheSafeParams.forkContextMessages = [];
    let options: any;
    const run = createSdkToolFreeFork({ helpers, queryFactory: factory([assistant, result], args => { options = args.options; }) });
    await run(p);
    expect(options.resume).toBeUndefined();
  });
  test('rejects tool calls and removes the seed on failure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sdk-fork-test-'));
    const event = { ...assistant, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id: 'tool', input: {} }] } };
    const run = createSdkToolFreeFork({ helpers, tempRoot: directory, queryFactory: factory([event]) });
    try {
      await expect(run(params())).rejects.toThrow('tool call');
      expect(readdirSync(directory)).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  test('rejects unsupported fork contracts', async () => {
    const run = createSdkToolFreeFork({ helpers, queryFactory: factory([]) });
    await expect(run({ ...params(), querySource: 'auto_dream' })).rejects.toThrow('Unsupported');
    await expect(run({ ...params(), ownPrefix: {} })).rejects.toThrow('Unsupported');
    await expect(run({ ...params(), toolCallRoutes: new Map() })).rejects.toThrow('Unsupported');
  });
  test('aborts a child on cancellation and closes it', async () => {
    const p = params(); let signal: AbortSignal, closed = false;
    const q = ((args: any) => {
      signal = args.options.abortController.signal;
      return { async *[Symbol.asyncIterator]() { p.cacheSafeParams.toolUseContext.abortController.abort(); yield result; }, close() { closed = true; } };
    }) as unknown as typeof query;
    const run = createSdkToolFreeFork({ helpers, queryFactory: q });
    await expect(run(p)).rejects.toThrow('cancelled');
    expect(signal!.aborted).toBe(true);
    expect(closed).toBe(true);
  });
});
