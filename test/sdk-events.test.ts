import { describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { sdkSubagentProgress, type InternalSdkEvent, type NativeSdkEventHelpers } from '../src/sdk-events';

function converters(rows: InternalSdkEvent[]) {
  const inputs: SDKMessage[][] = [];
  const options: Parameters<NativeSdkEventHelpers['createProgress']>[0][] = [];
  const helpers: NativeSdkEventHelpers = {
    convertMessages(messages) { inputs.push(messages); return rows; },
    createProgress(value) { options.push(value); return { type: 'progress', ...value, uuid: `progress-${options.length}` }; },
  };
  return { helpers, inputs, options };
}
function sdkFrame(type: string, parent: string | null, extra = {}): SDKMessage {
  return { type, uuid: 'sdk-row', session_id: 'sdk-child', parent_tool_use_id: parent, message: { role: type, content: [] }, ...extra } as unknown as SDKMessage;
}

describe('native subagent event conversion', () => {
  test('routes confirmed child assistant rows through the original converters', async () => {
    const row = { type: 'assistant', uuid: 'original-row', message: { content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: {} }] } };
    const mock = converters([row]);
    const frame = sdkFrame('assistant', 'parent-agent-tool', { agent_id: 'child-agent', subagent_type: 'Explore', task_description: 'Inspect project' });
    const progress = await sdkSubagentProgress(frame, mock.helpers);
    expect(mock.inputs).toEqual([[frame]]);
    expect(progress).toEqual([{ type: 'progress', uuid: 'progress-1', toolUseID: 'agent_child-agent', parentToolUseID: 'parent-agent-tool', data: { type: 'agent_progress', message: row, prompt: '', agentId: 'child-agent', agentType: 'Explore', description: 'Inspect project' } }]);
  });

  test('keeps child tool-result rows nested under the parent invocation', async () => {
    const row = { type: 'user', toolUseResult: { success: true }, message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'contents' }] } };
    const mock = converters([row]);
    const progress = await sdkSubagentProgress(sdkFrame('user', 'parent-agent-tool'), mock.helpers);
    expect(progress[0]?.parentToolUseID).toBe('parent-agent-tool');
    expect(progress[0]?.toolUseID).toBe('agent_parent-agent-tool');
    expect(progress[0]?.data.message).toBe(row);
    expect(progress[0]?.data).not.toHaveProperty('agentId');
  });

  test('does not turn main conversation, partial child frames, or task lifecycle into transcript rows', async () => {
    const mock = converters([]);
    for (const frame of [sdkFrame('assistant', null), sdkFrame('user', null), sdkFrame('stream_event', 'parent'), sdkFrame('system', 'parent', { subtype: 'task_started' }), sdkFrame('system', null, { subtype: 'task_progress' })]) {
      expect(await sdkSubagentProgress(frame, mock.helpers)).toEqual([]);
    }
    expect(mock.inputs).toEqual([]);
    expect(mock.options).toEqual([]);
  });

  test('preserves all rows returned by the original message converter', async () => {
    const rows = [{ type: 'assistant', uuid: 'row-1' }, { type: 'assistant', uuid: 'row-2' }];
    const mock = converters(rows);
    const progress = await sdkSubagentProgress(sdkFrame('assistant', 'parent'), mock.helpers);
    expect(progress.map(event => event.data.message)).toEqual(rows);
    expect(progress.map(event => event.uuid)).toEqual(['progress-1', 'progress-2']);
  });

  test('propagates original converter failures', async () => {
    const mock = converters([]);
    mock.helpers.convertMessages = () => { throw new Error('invalid original frame'); };
    await expect(sdkSubagentProgress(sdkFrame('assistant', 'parent'), mock.helpers)).rejects.toThrow('invalid original frame');
  });
});
