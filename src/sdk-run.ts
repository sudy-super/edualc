import { loadNativeModule } from './claude';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CanUseTool, ModelUsage, OnElicitation, Options, PermissionResult, Query, SDKActiveGoalMessage, SDKMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { query, sdkExecutable, sdkVersion, sdkEnvironment, sdkSettings } from './sdk';
import { convertSdkMessages, loadNativeSdkEventHelpers, sdkRetractions, sdkSubagentProgress, sdkSystemMessage, syncSdkModel, type NativeSdkEventHelpers } from './sdk-events';
import { createSdkStream } from './sdk-stream';
import { createSdkTasks } from './sdk-tasks';
import { createSdkMcp } from './sdk-mcp';
import { applySdkGoalEvent, sdkAgentOptions, sdkGoalInput, sdkSessionSettings, syncSdkGoalHistory } from './sdk-options';

type InternalMessage = Record<string, any> & { type: string; uuid?: string; message?: any };
type Tool = { name: string; [key: string]: any };
export interface RunParams {
  messages: InternalMessage[];
  systemPrompt: string[];
  userContext?: Record<string, string>;
  systemContext?: Record<string, string>;
  canUseTool(tool: Tool, input: Record<string, unknown>, context: any, assistant: InternalMessage, id: string, decision?: Record<string, unknown>): Promise<any>;
  toolUseContext: {
    session: { id: string };
    abortController: AbortController;
    options: { tools: Tool[]; mainLoopModel?: string; mcpClients?: { name: string; type: string }[]; [key: string]: any };
    getAppState(): any;
    [key: string]: any;
  };
  [key: string]: any;
}

interface OriginalHelpers {
  createAssistant(options: { content: unknown[] }): InternalMessage;
  findTool(tools: Tool[], name: string): Tool | undefined;
  compactBoundary?(message: SDKMessage): InternalMessage;
  normalizePrompt(messages: InternalMessage[], tools: Tool[]): InternalMessage[];
  saveContext?(params: Record<string, unknown>): void;
  transient?(message: InternalMessage): boolean;
  effort?(context: RunParams['toolUseContext']): Options['effort'];
  thinking?(context: RunParams['toolUseContext']): Options['thinking'];
  permissionContext?(context: RunParams['toolUseContext']): any;
  elicitationDialog?: unknown;
  createUrlElicitationHandler?(deps: Record<string, unknown>): { handle(request: any, options: { signal: AbortSignal }): Promise<any>; complete(id: string): boolean };
  apiError?(message: InternalMessage, context: RunParams['toolUseContext']): { reason: string };
}
interface History { path: string; usage: Record<string, ModelUsage>; apiDuration: number }
interface Dependencies {
  requirePromptEcho?: boolean;
  agentOptions?: typeof sdkAgentOptions;
  goalHistory?: typeof syncSdkGoalHistory;
  convertMessages?: NativeSdkEventHelpers['convertMessages'];
  queryFactory?: typeof query;
  helpers?: () => Promise<OriginalHelpers>;
  executable?: string;
  cwd?: string;
  trace?: (event: Record<string, unknown>) => void;
  ledger?: () => Promise<Ledger>;
  history?: (cutoff: string, messages: InternalMessage[]) => Promise<History>;
}

interface Ledger {
  Z2o(apiDuration: number, noRetryDuration: number): void;
  eGo(cost: number, total: ModelUsage, model: string): void;
  tGo(tokens: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }): void;
  hGo(model: string): ModelUsage | undefined;
}

class Queue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private wait: (() => void) | undefined;
  private ended = false;
  push(value: T): void {
    if (this.ended) throw new Error('SDK input is closed');
    this.values.push(value);
    this.wait?.();
    this.wait = undefined;
  }
  close(): void { this.ended = true; this.values = []; this.wait?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (!this.ended) {
      const value = this.values.shift();
      if (value !== undefined) yield value;
      else await new Promise<void>((done) => { this.wait = done; });
    }
  }
}

interface State {
  mcp: ReturnType<typeof createSdkMcp>;
  actions: Promise<void>;
  turnDone?: ReturnType<typeof Promise.withResolvers<void>>;
  handledCommand?: string;
  stream: ReturnType<typeof createSdkStream>;
  tasks: ReturnType<typeof createSdkTasks>;
  rows: Map<string, InternalMessage>;
  retracted: Set<string>;
  parentId: string;
  childId: string;
  input: Queue<SDKUserMessage>;
  connection: Query;
  controller: AbortController;
  active: RunParams;
  sent: Set<string>;
  model?: string;
  mode: string;
  running: boolean;
  usage: Record<string, ModelUsage>;
  apiDuration: number;
  lastAssistantUuid?: string;
  lastCompactUuid?: string;
  contextAnchorUuid?: string;
  configuration: string;
  urlElicitations: Map<string, { handle(request: any, options: { signal: AbortSignal }): Promise<any>; complete(id: string): boolean }>;
}

function configurationKey(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

function executionOptions(context: RunParams['toolUseContext'], permissions = context.getAppState().toolPermissionContext): Pick<Options, 'tools' | 'mcpServers' | 'strictMcpConfig' | 'settings' | 'allowDangerouslySkipPermissions' | 'fallbackModel' | 'allowedTools' | 'disallowedTools' | 'additionalDirectories'> {
  const app = context.getAppState();
  const fallbackModels = context.options.fallbackModel?.filter((model: string) => model !== context.options.mainLoopModel);
  return {
    tools: context.options.tools.filter(tool => !tool.name.startsWith('mcp__')).map(tool => tool.name),
    mcpServers: context.options.dynamicMcpConfig ?? {},
    strictMcpConfig: process.argv.includes('--strict-mcp-config'),
    settings: sdkSettings({ ...app.settings, ...sdkSessionSettings(context) }),
    allowedTools: [...new Set(Object.values(permissions.alwaysAllowRules ?? {}).flat() as string[])],
    disallowedTools: [...new Set(Object.values(permissions.alwaysDenyRules ?? {}).flat() as string[])],
    additionalDirectories: [...(permissions.additionalWorkingDirectories?.keys() ?? [])],
    fallbackModel: fallbackModels?.length ? fallbackModels.join(',') : undefined,
    ...((app.toolPermissionContext.isBypassPermissionsModeAvailable === true || app.toolPermissionContext.mode === 'bypassPermissions') ? { allowDangerouslySkipPermissions: true } : {}),
  };
}

async function originalHelpers(): Promise<OriginalHelpers> {
  const [messages, tools, events, effort, context, dialogs, elicitation] = await Promise.all([
    loadNativeModule('chunk-hqtnbrjd.js'),
    loadNativeModule('chunk-7s9834qb.js'),
    loadNativeModule('chunk-1svntv7y.js'),
    loadNativeModule('chunk-zgh1374j.js'),
    loadNativeModule('chunk-jpvgb3d5.js'),
    loadNativeModule('chunk-2r2d2fcc.js'),
    loadNativeModule('chunk-gwtdnfbz.js'),
  ]);
  return { createAssistant: messages._d, findTool: tools.$S, compactBoundary: events.uxn, normalizePrompt: messages.wT, saveContext: messages.bNn, transient: messages.Y_t,
    apiError: (message, context) => {
      messages.E4e(message, context);
      return { reason: 'api_error', errorKind: message.error, isTransient: messages.pmo(message),
        quotaLimits: message.quotaLimits, oauthRefreshDiskFull: message.oauthRefreshDiskFull };
    },
    elicitationDialog: dialogs._oe,
    createUrlElicitationHandler: deps => elicitation.eCt({}, deps),
    thinking: context.GYe,
    permissionContext: context.le,
    effort: context => {
      const model = context.options.mainLoopModel;
      if (!model) return undefined;
      const value = effort.bw(model, effort.Pd(context.getAppState(), model));
      return value === undefined ? undefined : effort.LL(value);
    },
  };
}

async function originalHistory(cutoff: string, messages: InternalMessage[]): Promise<History> {
  const [writer, paths] = await Promise.all([loadNativeModule('chunk-hqtnbrjd.js'), loadNativeModule('chunk-5mp833nq.js')]);
  // 再開時に補われたメッセージも元の保存処理に通し、SDK の再開位置を確定する。
  await writer.Ov(messages);
  await writer.Ou();
  await writer._Fn();
  const path = paths.Hu();
  const records = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (!records.some(record => record.type === 'assistant' && record.uuid === cutoff)) throw new Error('The original transcript writer did not persist the SDK fork point');
  const cost = records.findLast(record => record.type === 'cost-state');
  return { path, usage: cost?.modelUsage ?? {}, apiDuration: cost?.totalAPIDuration ?? 0 };
}

function traceFile(event: Record<string, unknown>): void {
  if (process.env.EDUALC_TRACE !== '1') return;
  const path = resolve(import.meta.dir, '../test/artifacts/sdk-run.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}

function sdkPrompt(params: RunParams): string {
  if (!params.systemPrompt.every(value => typeof value === 'string')) {
    throw new Error('Unsupported original system prompt value');
  }
  // 作業場所や CLAUDE.md などの文脈は SDK が共有設定から読み込む。
  return params.systemPrompt.join('\n\n');
}

export async function toInternal(message: SDKMessage, convertMessages?: NativeSdkEventHelpers['convertMessages']): Promise<InternalMessage | undefined> {
  if (message.type === 'system' && message.subtype === 'status') return { type: 'sdk_status', status: message.status };
  if (message.type === 'system' && message.subtype === 'informational') {
    const { session_id: _session, tool_use_id, prevent_continuation, ...notice } = message;
    // SDK の通知は保存済み attachment と UUID を共有するため、表示用の行には別の UUID を付ける。
    return { ...notice, uuid: randomUUID(), timestamp: new Date().toISOString(),
      ...(tool_use_id !== undefined && { toolUseID: tool_use_id }),
      ...(prevent_continuation !== undefined && { preventContinuation: prevent_continuation }) };
  }
  if (message.type === 'system' || message.type === 'tool_use_summary') return sdkSystemMessage(message);
  if (message.type !== 'assistant' && message.type !== 'user' && message.type !== 'stream_event') return undefined;
  if (message.parent_tool_use_id) return undefined;
  if (message.type === 'stream_event') {
    const { parent_tool_use_id: _parent, session_id: _session, ...rest } = message;
    return { ...rest, timestamp: new Date().toISOString() };
  }
  const convert = convertMessages ?? (await loadNativeSdkEventHelpers()).convertMessages;
  return convertSdkMessages(message, convert)[0];
}

// SDK が同じ設定から生成する一覧は、親で展開した本文へ重ねて埋め込まない。
function sdkCatalog(message: InternalMessage): boolean {
  return message.type === 'attachment' && ['skill_listing', 'agent_listing_delta', 'mcp_instructions_delta'].includes(message.attachment?.type);
}

export function createSdkRun(dependencies: Dependencies = {}) {
  const states = new Map<string, State>();
  const acquisitions = new Map<string, Promise<State>>();
  let helperPromise: Promise<OriginalHelpers> | undefined;
  const getHelpers = () => helperPromise ??= (dependencies.helpers ?? originalHelpers)();
  let closed = false;
  const trace = dependencies.trace ?? traceFile;
  const ledger = dependencies.ledger ?? (async () => await loadNativeModule('chunk-hdxpvbx1.js') as Ledger);
  async function syncUsage(state: State, result: SDKResultMessage): Promise<void> {
    // SDK は生成なしの早期終了にも 0 を返す。累積時間のリセットではない。
    const hasApiDuration = !('local_command' in result) && result.duration_api_ms !== 0;
    const duration = hasApiDuration ? result.duration_api_ms - state.apiDuration : 0;
    if (duration < 0) throw new Error(`SDK cumulative API duration decreased: ${state.apiDuration} -> ${result.duration_api_ms}`);
    const target = await ledger();
    const spent = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    const counters = ['inputTokens', 'outputTokens', 'thinkingTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'webSearchRequests', 'costUSD'] as const;
    for (const [name, cumulative] of Object.entries(result.modelUsage)) {
      const previous = state.usage[name];
      const current = target.hGo(name);
      const total = { ...cumulative };
      for (const field of counters) {
        const delta = (cumulative[field] ?? 0) - (previous?.[field] ?? 0);
        if (delta < 0) throw new Error(`SDK cumulative usage decreased for ${name}.${field}`);
        if (field in spent) spent[field as keyof typeof spent] += delta;
        if (cumulative[field] !== undefined || current?.[field] !== undefined) total[field] = (current?.[field] ?? 0) + delta;
      }
      target.eGo(cumulative.costUSD - (previous?.costUSD ?? 0), total, name);
    }
    target.Z2o(duration, duration);
    target.tGo(spent);
    state.usage = { ...state.usage, ...structuredClone(result.modelUsage) };
    if (hasApiDuration) state.apiDuration = result.duration_api_ms;
  }
  const dispose = (state: State) => {
    if (states.get(state.parentId) !== state) return;
    states.delete(state.parentId);
    state.stream.close();
    state.tasks.close();
    state.mcp.close();
    state.input.close();
    state.controller.abort();
    state.connection.close();
    trace({ kind: 'sdk_close', parentId: state.parentId, childId: state.childId });
  };

  async function report(state: State, error: unknown): Promise<void> {
    const context = state.active.toolUseContext;
    trace({ kind: 'sdk_failure', parentId: state.parentId, error: String(error) });
    if (typeof context.sdkApplyEvent !== 'function') return;
    const native = await loadNativeModule('chunk-hqtnbrjd.js');
    context.sdkApplyEvent(native.Bt(error instanceof Error ? error.message : String(error), 'error'));
  }

  function historyRows(state: State): InternalMessage[] {
    const getMessages = state.active.toolUseContext.getMessages;
    const rows = typeof getMessages === 'function' ? getMessages() : [...state.rows.values()];
    const retained = rows.filter((row: InternalMessage) => !state.retracted.has(row.uuid!));
    state.rows = new Map(retained.filter((row: InternalMessage) => row.uuid).map((row: InternalMessage) => [row.uuid!, row]));
    return retained;
  }

  async function events(state: State, message: SDKMessage | SDKActiveGoalMessage): Promise<InternalMessage[]> {
    if (message.type === 'assistant' || message.type === 'user' ||
      (message.type === 'system' && ['compact_boundary', 'model_refusal_fallback'].includes(message.subtype))) historyRows(state);
    if (message.type === 'active_goal') {
      await applySdkGoalEvent(state.active.toolUseContext as any, message.value);
      return [];
    }
    const model = await syncSdkModel(message, state.active.toolUseContext as any);
    if (model) state.model = model;
    if (message.type === 'system' && message.subtype === 'elicitation_complete') state.urlElicitations.get(message.mcp_server_name)?.complete(message.elicitation_id);
    const result: InternalMessage[] = [];
    for (const event of await sdkRetractions(message, [...state.rows.values()])) {
      if (event.type === 'tombstone') {
        state.rows.delete(event.message.uuid);
        state.retracted.add(event.message.uuid);
        state.lastAssistantUuid = [...state.rows.values()].findLast(row => row.type === 'assistant')?.uuid;
      }
      result.push(event);
    }
    result.push(...await state.tasks.handle(message) as InternalMessage[]);
    result.push(...await sdkSubagentProgress(message));
    const helpers = await getHelpers();
    const internal = message.type === 'system' && message.subtype === 'compact_boundary'
      ? helpers.compactBoundary?.(message) : await toInternal(message, dependencies.convertMessages);
    if (message.type === 'system' && message.subtype === 'compact_boundary' && !internal) throw new Error('Original compact-boundary converter is unavailable');
    if (internal) {
      if (state.handledCommand && internal.type === 'system' && internal.subtype === 'local_command' && internal.commandRun?.command === state.handledCommand) return result;
      if (internal.type === 'system' && internal.subtype === 'compact_boundary') state.lastCompactUuid = internal.uuid;
      if (internal.type === 'assistant') state.lastAssistantUuid = internal.uuid;
      if (internal.uuid && ['user', 'assistant', 'attachment', 'system', 'progress'].includes(internal.type) && !helpers.transient?.(internal) && !(internal.type === 'system' && internal.subtype === 'api_error')) state.rows.set(internal.uuid, internal);
      result.push(internal);
    }
    return result;
  }

  async function idle(state: State, message: SDKMessage): Promise<void> {
    if (states.get(state.parentId) !== state) return;
    if (message.type === 'result') {
      await syncUsage(state, message);
      // 中断の result は入力待ちへ戻った後にも届く。SDK の終端理由で中断と実行エラーを区別する。
      const aborted = message.terminal_reason === 'aborted_streaming' || message.terminal_reason === 'aborted_tools';
      if (message.is_error && !aborted) await report(state, new Error(message.subtype === 'success' ? message.result : message.errors.join('\n')));
      for (const row of await goalHistory(state)) state.active.toolUseContext.sdkApplyEvent(row);
    }
    const emitted = await events(state, message);
    for (const event of emitted) {
      const apply = state.active.toolUseContext.sdkApplyEvent;
      if (typeof apply !== 'function') throw new Error('The original TUI event handler is unavailable');
      apply(event);
    }
    if (message.type !== 'result' && !emitted.some(event => ['user', 'assistant', 'system', 'attachment', 'tombstone'].includes(event.type))) return;
    const helpers = await getHelpers();
    const params = state.active;
    helpers.saveContext?.({ systemPrompt: params.systemPrompt, userContext: params.userContext, systemContext: params.systemContext,
      toolUseContext: params.toolUseContext, forkContextMessages: historyRows(state), advisorModel: params.toolUseContext.getAdvisorSetting?.() });
  }

  async function permission(state: State, ...args: Parameters<CanUseTool>): Promise<PermissionResult> {
    const [name, input, request] = args;
    const params = state.active;
    const signal = AbortSignal.any([request.signal, params.toolUseContext.abortController.signal, state.controller.signal]);
    if (signal.aborted) return { behavior: 'deny', message: 'Permission request cancelled', interrupt: true };
    const helpers = await getHelpers();
    const tool = helpers.findTool(params.toolUseContext.options.tools, name);
    if (!tool) return { behavior: 'deny', message: `The original TUI does not expose tool ${name}` };
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    const assistant = helpers.createAssistant({ content: [{ type: 'tool_use', id: request.toolUseID, name: tool.name, input }] });
    trace({ kind: 'permission_request', parentId: state.parentId, childId: state.childId, tool: name, toolUseId: request.toolUseID });
    try {
      const decision = await params.canUseTool(tool, input, {
        ...params.toolUseContext, abortController: controller, forRemoteExecution: false, sameTurnToolUses: undefined,
      }, assistant, request.toolUseID, {
        behavior: 'ask',
        message: request.description ?? request.title ?? 'The SDK requests permission for this operation',
        decisionReason: { type: 'other', reason: request.decisionReason ?? 'SDK permission request' },
        suggestions: request.suggestions,
        suppressAlwaysAllowRule: request.suppressAlwaysAllowRule,
        defaultToNo: request.defaultToNo,
        blockedPath: request.blockedPath,
        forcedByCaller: true,
        personOnly: true,
      });
      trace({ kind: 'permission_result', parentId: state.parentId, childId: state.childId, tool: name, behavior: decision.behavior });
      if (signal.aborted) return { behavior: 'deny', message: 'Permission request cancelled', interrupt: true };
      if (decision.behavior === 'allow') {
        const updated = decision.updatedInput ?? input;
        const { _simulatedSedEdit: _simulation, ...updatedInput } = updated;
        return { behavior: 'allow', updatedInput, ...(decision.updatedPermissions !== undefined ? { updatedPermissions: decision.updatedPermissions } : {}) };
      }
      return { behavior: 'deny', message: decision.message ?? 'The original TUI denied this operation', ...(decision.interrupt !== undefined ? { interrupt: decision.interrupt } : {}) };
    } finally { signal.removeEventListener('abort', onAbort); }
  }

  async function syncControls(state: State, context: RunParams['toolUseContext']): Promise<void> {
    if (state.running || context.abortController.signal.aborted) return;
    await state.mcp.sync();
    if (context.abortController.signal.aborted) return;
    const model = context.options.mainLoopModel;
    const mode = context.getAppState().toolPermissionContext.mode;
    if (state.model !== model) { await state.connection.setModel(model); state.model = model; }
    if (context.abortController.signal.aborted) return;
    if (state.mode !== mode) { await state.connection.setPermissionMode(mode); state.mode = mode; }
  }

  async function elicitation(state: State, ...args: Parameters<OnElicitation>): ReturnType<OnElicitation> {
    const [request, options] = args;
    const context = state.active.toolUseContext;
    const signal = AbortSignal.any([options.signal, context.abortController.signal, state.controller.signal]);
    if (signal.aborted) return { action: 'cancel' };
    const helpers = await getHelpers();
    if (signal.aborted) return { action: 'cancel' };
    if (!helpers.elicitationDialog || typeof context.requestDialog !== 'function') throw new Error('The original MCP input dialog is unavailable');
    const { serverName, title, displayName, description, ...params } = request;
    const display = { ...(title !== undefined && { title }), ...(displayName !== undefined && { displayName }), ...(description !== undefined && { description }) };
    const nativeParams = { ...params, ...(Object.keys(display).length > 0 && { _meta: { 'anthropic/permissionDisplay': display } }) };
    if (params.mode === 'url') {
      let handler = state.urlElicitations.get(serverName);
      if (!handler) {
        if (!helpers.createUrlElicitationHandler) throw new Error('The original MCP URL input handler is unavailable');
        handler = helpers.createUrlElicitationHandler({ serverName,
          requestDialog: (...args: any[]) => state.active.toolUseContext.requestDialog(...args),
          // フックは SDK 側で実行済み。本家の URL 完了待ちと画面だけを利用する。
          runElicitationHooks: async () => undefined,
          runElicitationResultHooks: async (_server: string, result: unknown) => result,
        });
        state.urlElicitations.set(serverName, handler);
      }
      const result = await handler.handle({ params: nativeParams }, { signal });
      return signal.aborted ? { action: 'cancel' } : result;
    }
    const result = await context.requestDialog(helpers.elicitationDialog, {
      serverName, params: nativeParams,
    }, { place: 'under', signal });
    return signal.aborted ? { action: 'cancel' } : result;
  }

  async function acquire(params: RunParams, control = false): Promise<State> {
    if (closed) throw new Error('The SDK bridge is closed');
    const parentId = params.toolUseContext.session.id;
    const pending = acquisitions.get(parentId);
    if (pending) { await pending; return acquire(params, control); }
    const operation = acquireState(params, control);
    acquisitions.set(parentId, operation);
    try { return await operation; }
    finally { if (acquisitions.get(parentId) === operation) acquisitions.delete(parentId); }
  }

  async function acquireState(params: RunParams, control: boolean): Promise<State> {
    const parentId = params.toolUseContext.session.id;
    let state = states.get(parentId);
    if (control && state?.running) return state;
    const previousIndex = params.messages.findLastIndex(message => message.type === 'assistant');
    const previous = params.messages[previousIndex];
    if (previous && !previous.uuid) throw new Error('The original assistant fork point has no UUID');
    const lastCompactUuid = params.messages.findLast(message => message.type === 'system' && message.subtype === 'compact_boundary')?.uuid;
    if (state?.running) throw new Error('The original TUI started overlapping SDK turns');
    const liveMessages = params.toolUseContext.getMessages?.() as InternalMessage[] | undefined;
    const liveAssistant = liveMessages?.findLast(message => message.type === 'assistant')?.uuid;
    const liveCompact = liveMessages?.findLast(message => message.type === 'system' && message.subtype === 'compact_boundary')?.uuid;
    const idleAdvanced = liveMessages && liveAssistant === state?.lastAssistantUuid && liveCompact === state?.lastCompactUuid;
    if (state && !idleAdvanced && (state.lastAssistantUuid !== previous?.uuid || state.lastCompactUuid !== lastCompactUuid)) {
      dispose(state);
      state = undefined;
    }
    const context = params.toolUseContext;
    const helpers = await getHelpers();
    const execution = { ...executionOptions(context, helpers.permissionContext?.(context)),
      ...await (dependencies.agentOptions ?? sdkAgentOptions)(context), effort: helpers.effort?.(context), thinking: helpers.thinking?.(context) };
    const configuration = configurationKey(execution);
    if (state && state.configuration !== configuration) {
      const previousConfiguration = JSON.parse(state.configuration);
      const nextConfiguration = JSON.parse(configuration);
      const live: Parameters<Query['applyFlagSettings']>[0] = {};
      for (const key of ['fastMode', 'advisorModel', 'autoCompactWindow'] as const) {
        const before = previousConfiguration.settings?.[key], after = nextConfiguration.settings?.[key];
        if (before !== after) (live as Record<string, unknown>)[key] = after ?? null;
        delete previousConfiguration.settings?.[key];
        delete nextConfiguration.settings?.[key];
      }
      if (configurationKey(previousConfiguration) === configurationKey(nextConfiguration)) {
        await state.connection.applyFlagSettings(live);
        state.configuration = configuration;
      } else {
        dispose(state);
        state = undefined;
      }
    }
    const model = context.options.mainLoopModel;
    const mode = context.getAppState().toolPermissionContext.mode;
    if (!state) {
      // 圧縮の保持メタデータが参照する、再開位置より後ろの行も保存する。読み込み位置は resumeSessionAt で指定する。
      const history = previous ? await (dependencies.history ?? originalHistory)(previous.uuid!, params.messages) : undefined;
      const input = new Queue<SDKUserMessage>();
      const controller = new AbortController();
      const childId = randomUUID();
      let created!: State;
      const options: Options = {
        ...execution,
        cwd: dependencies.cwd ?? process.cwd(),
        pathToClaudeCodeExecutable: dependencies.executable ?? sdkExecutable(),
        env: sdkEnvironment(),
        sessionId: childId,
        ...(history ? { resume: history.path, forkSession: true, resumeSessionAt: previous.uuid } : {}),
        persistSession: true,
        includePartialMessages: true,
        perTaskStopAffordance: true,
        permissionMode: mode,
        model,
        systemPrompt: sdkPrompt(params),
        abortController: controller,
        canUseTool: (...args) => permission(created, ...args),
        onElicitation: (...args) => elicitation(created, ...args),
      };
      if (closed) throw new Error('The SDK bridge is closed');
      const connection = (dependencies.queryFactory ?? query)({ prompt: input, options });
      const stream = createSdkStream(connection, {
        idle: message => idle(created, message),
        failed: async (error, inTurn) => {
          if (inTurn) return;
          dispose(created);
          await report(created, error);
        },
      });
      const tasks = createSdkTasks({ context: () => created.active.toolUseContext as any, connection,
        onError: error => { void report(created, error); } });
      const mcp = createSdkMcp(connection, () => created.active.toolUseContext);
      created = { parentId, childId, input, controller, connection, stream, tasks, mcp,
        actions: Promise.resolve(),
        rows: new Map(params.messages.filter(row => row.uuid).map(row => [row.uuid!, row])), retracted: new Set(),
        active: params, sent: new Set(), model, mode, running: false, usage: structuredClone(history?.usage ?? {}), apiDuration: history?.apiDuration ?? 0, lastAssistantUuid: previous?.uuid, lastCompactUuid, configuration, urlElicitations: new Map() };
      state = created;
      states.set(parentId, state);
      trace({ kind: 'sdk_start', parentId, childId, sdk: sdkVersion, persistSession: true, resumed: Boolean(history), cutoff: previous?.uuid });
    }
    try {
      if (closed) throw new Error('The SDK bridge is closed');
      state.active = params;
      await syncControls(state, context);
      if (control) state.stream.start();
      if (closed) throw new Error('The SDK bridge is closed');
      return state;
    } catch (error) { dispose(state); throw error; }
  }

  function enqueue(state: State, operation: () => Promise<void>): void {
    state.actions = state.actions.then(async () => {
      if (state.running) await state.turnDone?.promise;
      if (states.get(state.parentId) === state) await operation();
    }).catch(async error => { dispose(state); await report(state, error); });
  }

  async function command(state: State, text: string, context = state.active.toolUseContext): Promise<void> {
    const messages = typeof context.getMessages === 'function' ? context.getMessages() : [...state.rows.values()];
    for await (const event of run({ ...state.active, toolUseContext: context, messages, sdkCommand: text, sdkControl: true })) {
      if (typeof context.sdkApplyEvent !== 'function') throw new Error('The original TUI event handler is unavailable');
      context.sdkApplyEvent(event);
    }
  }

  async function goalHistory(state: State): Promise<InternalMessage[]> {
    const context = state.active.toolUseContext;
    if (state.handledCommand !== 'goal' && !context.getAppState().activeGoal) return [];
    const rows = await (dependencies.goalHistory ?? syncSdkGoalHistory)(context as any, state.childId, new Set(state.rows.keys()));
    for (const row of rows) if (row.uuid) state.rows.set(row.uuid, row);
    return rows;
  }

  async function* run(params: RunParams): AsyncGenerator<InternalMessage, { reason: string }> {
    const control = params.sdkControl === true;
    if (!control) await states.get(params.toolUseContext.session.id)?.actions;
    if (params.toolUseContext.abortController.signal.aborted) return { reason: 'aborted_streaming' };
    const previousIndex = params.messages.findLastIndex(message => message.type === 'assistant');
    const helpers = await getHelpers();
    const state = await acquire(params);
    const anchorIndex = state.contextAnchorUuid ? params.messages.findIndex(message => message.uuid === state.contextAnchorUuid) : -1;
    const segment = params.messages.slice(Math.max(previousIndex, anchorIndex) + 1);
    const command = params.sdkCommand as string | undefined;
    const normalized = command ? [] : helpers.normalizePrompt(segment.filter(message => !sdkCatalog(message)), params.toolUseContext.options.tools);
    if (!command && (!normalized.length || normalized.some(message => message.type !== 'user' || message.message?.role !== 'user'))) throw new Error('The original prompt normalizer did not produce a user-only current turn');
    let content = command ? [{ type: 'text', text: command }] : normalized.flatMap(message => typeof message.message.content === 'string' ? [{ type: 'text', text: message.message.content }] : message.message.content);
    const goal = !command && await sdkGoalInput(params.toolUseContext as any, content);
    if (goal) content = [{ type: 'text', text: goal }];
    if (content.length === 0) throw new Error('The original current turn has no normalized content');
    const prompt = command ? { uuid: randomUUID() } : segment.findLast(message => message.type === 'user' && !message.isMeta) ?? normalized[0];
    if (!prompt.uuid) throw new Error('The original prompt has no UUID');
    const parentId = state.parentId;
    const context = params.toolUseContext;
    if (state.running) throw new Error('The original TUI started overlapping SDK turns');
    if (state.sent.has(prompt.uuid)) throw new Error('The SDK bridge cannot replay a user message in an existing child session');
    state.running = true;
    state.turnDone = Promise.withResolvers<void>();
    state.handledCommand = goal ? 'goal' : control ? command?.slice(1).split(/\s/, 1)[0] : undefined;
    state.active = params;
    for (const row of params.messages) if (row.uuid && !state.retracted.has(row.uuid)) state.rows.set(row.uuid, row);
    let settled = false;
    let retrying = false;
    const clearRetry = () => { if (retrying) { retrying = false; context.onRetryStatus?.(null); } };
    const output: InternalMessage[] = [];
    let interrupted: Promise<void> | undefined;
    const abort = () => {
      interrupted = state.connection.interrupt().then(() => undefined);
      // SDK の応答待ちとは別に中断処理を始め、失敗も次の読取の catch で扱う。
      void interrupted.catch(() => {});
    };
    context.abortController.signal.addEventListener('abort', abort, { once: true });
    try {
      state.stream.beginTurn();
      state.stream.start();
      if (context.abortController.signal.aborted) { settled = true; return { reason: 'aborted_streaming' }; }
      state.sent.add(prompt.uuid);
      state.input.push({ type: 'user', uuid: prompt.uuid as `${string}-${string}-${string}-${string}-${string}`, parent_tool_use_id: null,
        ...(!command && !goal && { client_composed: true }), message: { role: 'user', content } });
      trace({ kind: 'sdk_turn', parentId, childId: state.childId, promptId: prompt.uuid });
      while (true) {
        const next = await state.stream.next(context.abortController.signal);
        if (next.done) throw new Error('The SDK child ended before returning a turn result');
        const message = next.value;
        if (message.type === 'assistant' || message.type === 'result' || (message.type === 'stream_event' && message.event.type === 'message_start')) clearRetry();
        trace({ kind: 'sdk_event', parentId, childId: state.childId, type: message.type,
          ...('subtype' in message ? { subtype: message.subtype } : {}),
          ...('user_message_uuid' in message ? { userMessageUuid: message.user_message_uuid } : {}),
          ...('user_message_uuids' in message ? { userMessageUuids: message.user_message_uuids } : {}),
          ...('queued_turn_count' in message ? { queuedTurnCount: message.queued_turn_count } : {}),
          ...(message.type === 'system' && message.subtype === 'task_started' ? { taskType: message.task_type, isBackgrounded: message.is_backgrounded } : {}),
          ...(message.type === 'result' ? { terminalReason: message.terminal_reason, isError: message.is_error } : {}) });
        if (message.type === 'result') {
          await syncUsage(state, message);
          for (const row of await goalHistory(state)) yield row;
          if (context.abortController.signal.aborted) {
            await interrupted;
            settled = true;
            return { reason: 'aborted_streaming' };
          }
          if (dependencies.requirePromptEcho !== false && !(message.user_message_uuids ?? [message.user_message_uuid]).includes(prompt.uuid)) {
            trace({ kind: 'sdk_background_result', parentId, childId: state.childId });
            continue;
          }
          settled = true;
          if (message.is_error) {
            const assistant = output.findLast(row => row.type === 'assistant');
            if (!command && assistant?.isApiErrorMessage) {
              if (!helpers.apiError) throw new Error('The original API error handler is unavailable');
              return helpers.apiError(assistant, context);
            }
            throw new Error(message.subtype === 'success' ? message.result : message.errors.join('\n'));
          }
          if (!command) helpers.saveContext?.({
            systemPrompt: params.systemPrompt, userContext: params.userContext, systemContext: params.systemContext,
            toolUseContext: context, forkContextMessages: historyRows(state), advisorModel: context.getAdvisorSetting?.(),
          });
          return { reason: 'completed' };
        }
        for (const internal of await events(state, message)) {
          if (internal.type === 'tombstone') {
            const index = output.findIndex(row => row.uuid === internal.message.uuid);
            if (index >= 0) output.splice(index, 1);
          }
          if (internal.type === 'system' && internal.subtype === 'api_error') {
            retrying = true;
            trace({ kind: 'sdk_retry', parentId, attempt: internal.retryAttempt, retryInMs: internal.retryInMs, nativeStatusCallback: typeof context.onRetryStatus === 'function' });
            context.onRetryStatus?.({ kind: 'retrying', error: internal.error, attempt: internal.retryAttempt,
              maxRetries: internal.maxRetries, retryInMs: internal.retryInMs, deadline: Date.now() + internal.retryInMs });
          }
          if (internal.type === 'assistant') output.push(internal);
          yield internal;
        }
      }
    } catch (error) {
      if (context.abortController.signal.aborted) {
        try {
          await interrupted;
          settled = true;
        } catch (interruptError) {
          dispose(state);
          throw interruptError;
        }
        return { reason: 'aborted_streaming' };
      }
      dispose(state);
      throw error;
    } finally {
      clearRetry();
      context.abortController.signal.removeEventListener('abort', abort);
      try { await state.stream.finishTurn(); }
      catch (error) { dispose(state); throw error; }
      finally {
        state.running = false;
        state.turnDone.resolve();
        if (!settled) dispose(state);
      }
    }
  }

  return { run, async mcpChanged(parentId: string) {
    await states.get(parentId)?.mcp.sync();
  }, async mcpReconnect(parentId: string, name: string) {
    await states.get(parentId)?.mcp.reconnect(name);
  }, goalCleared(context: RunParams['toolUseContext']) {
    const state = states.get(context.session.id);
    if (state) enqueue(state, () => command(state, '/goal clear', context));
  }, applySettings(parentId: string, settings: Parameters<Query['applyFlagSettings']>[0]) {
    const state = states.get(parentId);
    if (!state) return;
    enqueue(state, async () => {
      const effective = sdkSettings(settings) as Parameters<Query['applyFlagSettings']>[0];
      const fingerprint = JSON.parse(state.configuration);
      const changed = Object.fromEntries(Object.entries(effective).filter(([key, value]) =>
        configurationKey(fingerprint.settings?.[key]) !== configurationKey(value)));
      if (Object.keys(changed).length) await state.connection.applyFlagSettings(changed);
      fingerprint.settings = { ...fingerprint.settings, ...effective };
      state.configuration = configurationKey(fingerprint);
      trace({ kind: 'sdk_settings', parentId, keys: Object.keys(settings) });
    });
  }, async contextUsage(request: {
    session: RunParams['toolUseContext']['session'];
    toolUseContext: Partial<RunParams['toolUseContext']>;
    detail?: 'summary' | 'full';
  }) {
    if (!request.session?.id) throw new Error('Context inspection requires the original session ID');
    let state = states.get(request.session.id);
    const context = request.toolUseContext;
    if (state && context.session && context.abortController && context.options?.tools && typeof context.getAppState === 'function') {
      const complete = context as RunParams['toolUseContext'];
      if (Array.isArray(context.messages)) state = await acquire({ ...state.active, toolUseContext: complete, messages: context.messages }, true);
      else await syncControls(state, complete);
    }
    if (!state) {
      const context = request.toolUseContext;
      if (!context.session || typeof context.getAppState !== 'function' || !context.abortController || !context.options?.tools) {
        throw new Error('Start a conversation before inspecting context through a control connection');
      }
      const completeContext = context as RunParams['toolUseContext'];
      const native = await loadNativeModule('chunk-w899cfp5.js');
      const params = await native.f5t({ toolUseContext: completeContext, forkContextMessages: context.messages, mainThreadAgentDefinition: completeContext.options.mainThreadAgentDefinition });
      state = await acquire({ ...params, messages: context.messages ?? [], canUseTool: context.canUseTool ?? (async () => ({ behavior: 'deny', message: 'Context inspection cannot execute tools' })) }, true);
    }
    return state.connection.getContextUsage(request.detail ? { detail: request.detail } : undefined);
  }, async history(parentId: string) {
    const state = states.get(parentId);
    if (!state || state.running) throw new Error('SDK history is only available after a completed command');
    const native = await loadNativeModule('chunk-hqtnbrjd.js');
    const transcript = await native.UZ(native.Cf(state.childId), { keepAllLeaves: true });
    return native.twr([...transcript.messages.values()]) as InternalMessage[];
  }, alignHistory(parentId: string, messages: InternalMessage[]) {
    const state = states.get(parentId);
    if (!state || state.running) throw new Error('SDK history can only be aligned after a completed command');
    state.lastAssistantUuid = messages.findLast(message => message.type === 'assistant')?.uuid;
    state.lastCompactUuid = messages.findLast(message => message.type === 'system' && message.subtype === 'compact_boundary')?.uuid;
    state.contextAnchorUuid = messages.at(-1)?.uuid;
    state.rows = new Map(messages.filter(row => row.uuid).map(row => [row.uuid!, row]));
  }, async connection(params: RunParams) {
    await states.get(params.toolUseContext.session.id)?.actions;
    const state = await acquire(params, true);
    return state.connection;
  }, close() { closed = true; for (const state of [...states.values()]) dispose(state); } };
}

const bridge = createSdkRun();
export const sdkRun = bridge.run;
export const closeSdkRuns = bridge.close;

export const getSdkConnection = bridge.connection;
export const alignSdkHistory = bridge.alignHistory;
export const getSdkHistory = bridge.history;

export const sdkContextUsage = bridge.contextUsage;
export const sdkGoalCleared = bridge.goalCleared;
export const sdkApplySettings = bridge.applySettings;
export const sdkMcpChanged = bridge.mcpChanged;
export const sdkMcpReconnect = bridge.mcpReconnect;
