import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export type InternalSdkEvent = Record<string, any> & { type: string };
export interface NativeSdkEventHelpers {
  convertMessages(messages: SDKMessage[]): InternalSdkEvent[];
  createProgress(options: {
    toolUseID: string;
    parentToolUseID: string;
    data: Record<string, unknown>;
  }): InternalSdkEvent;
}

let nativeHelpers: Promise<NativeSdkEventHelpers> | undefined;
export function loadNativeSdkEventHelpers(): Promise<NativeSdkEventHelpers> {
  return nativeHelpers ??= (async () => {
    const root = new URL('../vendor/claude-full/', import.meta.url);
    const [messages, progress] = await Promise.all([
      import(new URL('chunk-1svntv7y.js', root).href),
      import(new URL('chunk-hqtnbrjd.js', root).href),
    ]);
    if (typeof messages.Yot !== 'function' || typeof progress.YIt !== 'function') {
      throw new Error('The original SDK message and progress converters are unavailable');
    }
    return { convertMessages: messages.Yot, createProgress: progress.YIt };
  })();
}

export async function sdkSubagentProgress(
  message: SDKMessage,
  helpers?: NativeSdkEventHelpers,
): Promise<InternalSdkEvent[]> {
  if (message.type !== 'assistant' && message.type !== 'user') return [];
  const parent = message.parent_tool_use_id;
  if (!parent) return [];
  const native = helpers ?? await loadNativeSdkEventHelpers();
  const frame = message as SDKMessage & { agent_id?: string; subagent_type?: string; task_description?: string };
  return native.convertMessages([message]).map((child) => native.createProgress({
    toolUseID: `agent_${frame.agent_id ?? parent}`,
    parentToolUseID: parent,
    data: {
      type: 'agent_progress', message: child, prompt: '',
      ...(frame.agent_id !== undefined && { agentId: frame.agent_id }),
      ...(frame.subagent_type !== undefined && { agentType: frame.subagent_type }),
      ...(frame.task_description !== undefined && { description: frame.task_description }),
    },
  }));
}
