import { describe, expect, test } from 'bun:test';
import { createSdkCompact } from '../src/sdk-compact';
import type { RunParams, sdkRun } from '../src/sdk-run';

type Context = Parameters<ReturnType<typeof createSdkCompact>['compactManually']>[0];
const retained = { type: 'user', uuid: 'retained-user', message: { role: 'user', content: 'Retained input' } };
const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'compact-boundary', compactMetadata: { trigger: 'manual', preTokens: 120, postTokens: 482, preservedMessages: { anchorUuid: 'summary', uuids: ['retained-user'], allUuids: ['retained-user'] } } };
const summary = { type: 'user', uuid: 'summary', message: { role: 'user', content: 'SDK summary' } };
function setup(events: RunParams['messages'] = [boundary, summary], terminal = 'completed', error?: Error, output?: { type: 'text'; value: string; level?: 'error' }) {
  const compactEvents: Record<string, unknown>[] = [], queryEvents: Record<string, unknown>[] = [], aligned: unknown[][] = [], calls: RunParams[] = [];
  const context: Context = { messages: [retained], session: { id: 'parent' }, abortController: new AbortController(), options: { tools: [], verbose: true }, getAppState: () => ({}) , onCompactEvent: event => compactEvents.push(event), onQueryEvent: event => queryEvents.push(event) };
  const parameters: RunParams = { messages: context.messages, systemPrompt: ['SYSTEM'], toolUseContext: context, canUseTool: async () => ({ behavior: 'deny' }) };
  const run = (async function* (params: RunParams) { calls.push(params); for (const event of events) yield event; if (error) throw error; return { reason: terminal }; }) as typeof sdkRun;
  const persisted: RunParams['messages'][] = [];
  const adapter = createSdkCompact({ persist: async messages => { persisted.push(messages); }, commandOutput: async () => output, history: async () => [retained], run, parameters: async () => parameters, display: async verbose => verbose ? 'NATIVE_DISPLAY_VERBOSE' : 'NATIVE_DISPLAY', align: (...args) => aligned.push(args) });
  return { adapter, context, compactEvents, queryEvents, aligned, calls, persisted };
}

describe('SDK compact connection to the original TUI', () => {
  test('returns the SDK hook rejection without requiring a compaction boundary', async () => {
    const output = { type: 'text' as const, value: 'Compaction blocked by PreCompact hook: fixture', level: 'error' as const };
    const t = setup([{ type: 'system', subtype: 'local_command', content: '<local-command-stderr>fixture</local-command-stderr>' }], 'completed', undefined, output);
    expect(await t.adapter.call('', t.context)).toEqual(output);
    expect(t.aligned).toEqual([]);
    expect(t.compactEvents.at(-1)).toMatchObject({ metadata: { compactResult: 'failed' } });
  });

  test('uses SDK command display with hook results and excludes replay from the summary', async () => {
    const replay = { type: 'user', uuid: 'display', isReplay: true, message: { content: '<local-command-stdout>Compacted: hook completed</local-command-stdout>' } };
    const t = setup([boundary, summary, replay], 'completed', undefined, { type: 'text', value: 'Compacted: hook completed' });
    const result = await t.adapter.call('', t.context);
    if (result.type !== 'compact') throw new Error('Expected compaction');
    expect(result.displayText).toBe('Compacted: hook completed');
    expect(result.compactionResult.summaryMessages).toHaveLength(1);
  });

  test('uses the SDK summary and retained UUIDs without constructing a new summary', async () => {
    const replay = { ...summary, uuid: 'replayed-summary', isReplay: true };
    const t = setup([{ type: 'sdk_status', status: 'requesting' }, boundary, summary, { ...retained, isReplay: true }, replay]);
    const result = await t.adapter.call('  Keep the code  ', t.context);
    if (result.type !== 'compact') throw new Error('Expected compaction');
    expect(t.calls[0].sdkCommand).toBe('/compact Keep the code');
    expect(result.type).toBe('compact');
    expect(result.compactionResult.boundaryMarker).toBe(boundary);
    expect(result.compactionResult.summaryMessages).toEqual([{ ...summary, isMeta: true, isCompactSummary: true }]);
    expect(result.compactionResult.messagesToKeep).toEqual([retained]);
    expect(result.compactionResult.messagesToKeep[0]).toBe(retained);
    expect(result.compactionResult.attachments).toEqual([]);
    expect(result.compactionResult.hookResults).toEqual([]);
    expect(result.result).toEqual({ tokensBefore: 120, tokensAfter: 482 });
    expect(result.displayText).toBe('NATIVE_DISPLAY_VERBOSE');
    expect(t.aligned).toEqual([['parent', [boundary, { ...summary, isMeta: true, isCompactSummary: true }, retained]]]);
    expect(t.persisted).toEqual([[boundary, { ...summary, isMeta: true, isCompactSummary: true }, retained]]);
    expect(t.compactEvents).toEqual([
      { type: 'sdk_status', status: 'compacting' }, { type: 'compact_progress', event: { type: 'compact_start' } },
      { type: 'sdk_status', status: 'requesting' }, { type: 'compact_progress', event: { type: 'compact_end' } },
      { type: 'sdk_status', status: null, metadata: { compactResult: 'success' } },
    ]);
    expect(t.queryEvents).toEqual([{ type: 'response_length', op: 'reset' }]);
  });
  test('uses the SDK saved history even when a retained row was not emitted to the TUI', async () => {
    const t = setup([boundary, summary]);
    t.context.messages = [];
    const result = await t.adapter.call('', t.context);
    if (result.type !== 'compact') throw new Error('Expected compaction');
    expect(result.compactionResult.messagesToKeep).toEqual([retained]);
  });
  test('rejects a retained UUID that is absent from the SDK saved history', async () => {
    const missing = { ...boundary, compactMetadata: { preservedMessages: { uuids: ['missing'] } } };
    const t = setup([missing, summary]);
    await expect(t.adapter.call('', t.context)).rejects.toThrow('unavailable to the original TUI: missing');
    expect(t.aligned).toEqual([]);
    expect(t.compactEvents.at(-1)).toMatchObject({ metadata: { compactResult: 'failed' } });
  });
  test('rejects incomplete SDK compaction output instead of supplying a replacement', async () => {
    for (const events of [[summary], [boundary]]) {
      const t = setup(events);
      await expect(t.adapter.call('', t.context)).rejects.toThrow(events[0] === summary ? 'boundary' : 'summary');
      expect(t.aligned).toEqual([]);
      expect(t.compactEvents.at(-1)).toMatchObject({ metadata: { compactResult: 'failed' } });
    }
  });
  test('clears compact progress on SDK failure and cancellation', async () => {
    for (const [t, message] of [[setup([], 'completed', new Error('SDK compact failed')), 'SDK compact failed'], [setup([], 'aborted_streaming'), 'Compaction canceled']] as const) {
      await expect(t.adapter.call('', t.context)).rejects.toThrow(message);
      expect(t.aligned).toEqual([]);
      expect(t.queryEvents).toEqual([{ type: 'response_length', op: 'reset' }]);
      expect(t.compactEvents.at(-2)).toEqual({ type: 'compact_progress', event: { type: 'compact_end' } });
      expect(t.compactEvents.at(-1)).toMatchObject({ metadata: { compactResult: 'failed' } });
    }
  });
  test('does not start SDK work after the original controller is already aborted', async () => {
    const t = setup(); t.context.abortController.abort();
    await expect(t.adapter.call('', t.context)).rejects.toThrow('canceled');
    expect(t.calls).toEqual([]);
    expect(t.aligned).toEqual([]);
  });
});
