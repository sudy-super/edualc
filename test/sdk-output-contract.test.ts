import { expect, test } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { convertSdkMessages, sdkRetractions } from '../src/sdk-events';

test('keeps SDK supersedes IDs on the native assistant for reply tracking', () => {
  const rows = [{ type: 'assistant', uuid: 'new' }, { type: 'system', subtype: 'local_command' }];
  const input = { type: 'assistant', supersedes: ['old'], uuid: 'new' } as unknown as SDKMessage;
  expect(convertSdkMessages(input, () => rows)).toEqual([
    { type: 'assistant', uuid: 'new', supersedesUuids: ['old'] },
    { type: 'system', subtype: 'local_command' },
  ]);
});

test('ordinary streaming and task frames do not load native retraction helpers', async () => {
  for (const frame of [{ type: 'assistant' }, { type: 'stream_event' }, { type: 'system', subtype: 'task_notification' }]) {
    expect(await sdkRetractions(frame as SDKMessage, [])).toEqual([]);
  }
});
