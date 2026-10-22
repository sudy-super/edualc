import { loadNativeModule } from './claude';
import { randomUUID } from 'node:crypto';
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

export function convertSdkMessages(message: SDKMessage, convert: NativeSdkEventHelpers['convertMessages']): InternalSdkEvent[] {
  const rows = convert([message]);
  if (message.type === 'assistant' && 'supersedes' in message && Array.isArray(message.supersedes)) {
    for (const row of rows) if (row.type === 'assistant') row.supersedesUuids = message.supersedes;
  }
  if (message.type === 'user' && message.tool_use_result !== undefined) {
    for (const row of rows) if (row.type === 'user') row.toolUseResult = message.tool_use_result;
  }
  if (message.type === 'user' && 'isReplay' in message && message.isReplay) {
    for (const row of rows) if (row.type === 'user') { row.isReplay = true; row.isVisibleInTranscriptOnly = true; }
  }
  return rows;
}

export async function sdkSystemMessage(message: SDKMessage): Promise<InternalSdkEvent | undefined> {
  if (message.type === 'tool_use_summary') {
    const native = await loadNativeModule('chunk-hqtnbrjd.js');
    if (typeof native.fbs !== 'function') throw new Error('The original tool-summary converter is unavailable');
    return native.fbs(message.summary, message.preceding_tool_use_ids);
  }
  if (message.type !== 'system') return undefined;
  if (message.subtype === 'api_retry') {
    // 元の nV は export されていないため、SDK の再試行通知をその表示用データ形式へ接続する。
    return {
      type: 'system', subtype: 'api_error', level: 'error',
      error: {
        message: message.error, formatted: message.error, status: message.error_status ?? undefined,
        requestId: undefined, connection: null, isNetworkDown: false, rateLimits: null,
        noResponse: message.no_response ? { waitedMs: message.no_response.waited_ms, retryWaitMs: message.no_response.retry_wait_ms } : null,
      },
      retryInMs: message.retry_delay_ms, retryAttempt: message.attempt, maxRetries: message.max_retries,
      source: 'request_retry', timestamp: new Date().toISOString(), uuid: message.uuid ?? randomUUID(),
    };
  }
  const converters: Record<string, string> = {
    model_fallback: 'mxn', model_refusal_fallback: 'pxn',
    model_refusal_no_fallback: 'fxn', model_consent_fallback: 'Jot',
  };
  const converter = converters[message.subtype];
  if (!converter) return undefined;
  const native = await loadNativeModule('chunk-1svntv7y.js');
  if (typeof native[converter] !== 'function') throw new Error(`The original ${message.subtype} converter is unavailable`);
  return native[converter](message);
}

let nativeHelpers: Promise<NativeSdkEventHelpers> | undefined;
export function loadNativeSdkEventHelpers(): Promise<NativeSdkEventHelpers> {
  return nativeHelpers ??= (async () => {
    const [messages, progress] = await Promise.all([
      loadNativeModule('chunk-1svntv7y.js'),
      loadNativeModule('chunk-hqtnbrjd.js'),
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
  return convertSdkMessages(message, native.convertMessages).map((child) => native.createProgress({
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


export async function sdkRetractions(message: SDKMessage, rows: InternalSdkEvent[]): Promise<InternalSdkEvent[]> {
  if (!(message.type === 'assistant' && 'supersedes' in message) && !(message.type === 'system' && message.subtype === 'model_refusal_fallback')) return [];
  const [native, messages] = await Promise.all([
    loadNativeModule('chunk-321961dh.js'),
    loadNativeModule('chunk-hqtnbrjd.js'),
  ]);
  const signal = native.kze(message);
  if (!signal) return [];
  const index = native.MQn();
  const targets = new Set(signal.uuids);
  const unique = [...new Map(rows.filter(row => typeof row.uuid === 'string').map(row => [row.uuid, row])).values()];
  const affected = unique.filter(row => targets.has(row.uuid) || messages.cf([row]).some((alias: InternalSdkEvent) => targets.has(alias.uuid)));
  if (affected.length === 0) return [];
  const operations: InternalSdkEvent[] = [];
  for (const row of affected) {
    if (row.type === 'assistant' && Array.isArray(row.message?.content)) {
      native.DQn(index, row.uuid, row.message.content.filter((block: Record<string, any>) => block.type === 'tool_use').map((block: Record<string, any>) => block.id));
    }
  }
  let retained = unique;
  native.Byn({ index, signal: { ...signal, uuids: affected.map(row => row.uuid) }, surface: 'sdk_host',
    setMessages: (update: (rows: InternalSdkEvent[]) => InternalSdkEvent[]) => { retained = update(unique); },
    setInProgressToolUseIDs: (op: Record<string, unknown>) => operations.push({ type: 'set_in_progress_tool_use_ids', op }),
  });
  const kept = new Set(retained.map(row => row.uuid));
  return [...unique.filter(row => !kept.has(row.uuid)).map(row => ({ type: 'tombstone', message: row })), ...operations];
}

export interface SdkModelContext {
  options: Record<string, any>;
  getAppState(): Record<string, any>;
  setAppState(update: (state: Record<string, any>) => Record<string, any>): void;
}

export async function syncSdkModel(message: SDKMessage, context: SdkModelContext): Promise<string | undefined> {
  if (message.type !== 'system') return undefined;
  const event = message as SDKMessage & { subtype: string; scope?: string; direction?: string; fallback_model?: string; api_refusal_category?: string; saw_cyber_refusal?: boolean; request_id?: string };
  if (event.subtype !== 'model_refusal_fallback' && event.subtype !== 'model_consent_fallback') return undefined;
  if (event.subtype === 'model_refusal_fallback' && event.scope === 'local') return undefined;
  if (typeof event.fallback_model !== 'string' || !event.fallback_model) throw new Error('SDK session model switch has no fallback model');
  const [selection, models] = await Promise.all([
    loadNativeModule('chunk-hdxpvbx1.js'),
    loadNativeModule('chunk-2jyw98bz.js'),
  ]);
  const model = event.fallback_model;
  const current = context.getAppState();
  const fastMode = models.$o() ? models.LI(model, current.fastMode) : Boolean(current.fastMode);
  if (event.subtype === 'model_refusal_fallback') {
    if (event.direction === 'revert') selection.aye();
    else selection.Gjt({ fallbackModel: model, previousOverride: selection.gc(),
      previousAppStateModel: current.mainLoopModel, previousModelForSession: current.mainLoopModelForSession });
    if (event.api_refusal_category === 'cyber' || event.saw_cyber_refusal === true) selection.Wjt(event.request_id);
  }
  context.setAppState(state => ({ ...state, mainLoopModel: model, mainLoopModelForSession: null, fastMode }));
  selection.Bp(model);
  context.options.mainLoopModel = model;
  context.options.availabilityFallback = undefined;
  models.NI(current.fastMode, fastMode);
  return model;
}
