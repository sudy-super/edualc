import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CanUseTool, ModelUsage, Options, PermissionResult, Query, SDKMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { query, sdkExecutable, sdkVersion } from './sdk';
import { sdkSubagentProgress } from './sdk-events';

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
    options: { tools: Tool[]; mainLoopModel?: string; [key: string]: any };
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
}
interface History { path: string; usage: Record<string, ModelUsage>; apiDuration: number }
interface Dependencies {
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
}

async function originalHelpers(): Promise<OriginalHelpers> {
  const root = new URL('../vendor/claude-full/', import.meta.url);
  const [messages, tools, events] = await Promise.all([
    import(new URL('chunk-hqtnbrjd.js', root).href),
    import(new URL('chunk-7s9834qb.js', root).href),
    import(new URL('chunk-1svntv7y.js', root).href),
  ]);
  return { createAssistant: messages._d, findTool: tools.$S, compactBoundary: events.uxn, normalizePrompt: messages.wT, saveContext: messages.bNn };
}

async function originalHistory(cutoff: string, messages: InternalMessage[]): Promise<History> {
  const root = new URL('../vendor/claude-full/', import.meta.url);
  const [writer, paths] = await Promise.all([import(new URL('chunk-hqtnbrjd.js', root).href), import(new URL('chunk-5mp833nq.js', root).href)]);
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
  const contexts = [...Object.values(params.systemContext ?? {}), ...Object.values(params.userContext ?? {})];
  if (![...params.systemPrompt, ...contexts].every((value) => typeof value === 'string')) {
    throw new Error('Unsupported original system prompt or context value');
  }
  return [...params.systemPrompt, ...contexts].join('\n\n');
}

export function toInternal(message: SDKMessage): InternalMessage | undefined {
  if (message.type === 'system' && message.subtype === 'status') return { type: 'sdk_status', status: message.status };
  if (message.type !== 'assistant' && message.type !== 'user' && message.type !== 'stream_event') return undefined;
  if (message.parent_tool_use_id) return undefined;
  const { parent_tool_use_id: _parent, session_id: _session, ...rest } = message;
  const internal: InternalMessage = { ...rest, timestamp: new Date().toISOString() };
  if (message.type === 'user' && message.tool_use_result !== undefined) internal.toolUseResult = message.tool_use_result;
  return internal;
}

export function createSdkRun(dependencies: Dependencies = {}) {
  const states = new Map<string, State>();
  const trace = dependencies.trace ?? traceFile;
  const ledger = dependencies.ledger ?? (async () => await import(new URL('../vendor/claude-full/chunk-hdxpvbx1.js', import.meta.url).href) as Ledger);
  async function syncUsage(state: State, result: SDKResultMessage): Promise<void> {
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
    const localCommand = 'local_command' in result;
    const duration = localCommand ? 0 : result.duration_api_ms - state.apiDuration;
    if (duration < 0) throw new Error('SDK cumulative API duration decreased');
    target.Z2o(duration, duration);
    target.tGo(spent);
    state.usage = structuredClone(result.modelUsage);
    if (!localCommand) state.apiDuration = result.duration_api_ms;
  }
  const dispose = (state: State) => {
    if (states.get(state.parentId) !== state) return;
    states.delete(state.parentId);
    state.input.close();
    state.controller.abort();
    state.connection.close();
    trace({ kind: 'sdk_close', parentId: state.parentId, childId: state.childId });
  };

  async function permission(state: State, ...args: Parameters<CanUseTool>): Promise<PermissionResult> {
    const [name, input, request] = args;
    const params = state.active;
    const signal = AbortSignal.any([request.signal, params.toolUseContext.abortController.signal, state.controller.signal]);
    if (signal.aborted) return { behavior: 'deny', message: 'Permission request cancelled', interrupt: true };
    const helpers = await (dependencies.helpers ?? originalHelpers)();
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
        return { behavior: 'allow', updatedInput };
      }
      return { behavior: 'deny', message: decision.message ?? 'The original TUI denied this operation' };
    } finally { signal.removeEventListener('abort', onAbort); }
  }

  async function acquire(params: RunParams, control = false): Promise<State> {
    const parentId = params.toolUseContext.session.id;
    let state = states.get(parentId);
    if (control && state?.running) return state;
    const previousIndex = params.messages.findLastIndex(message => message.type === 'assistant');
    const previous = params.messages[previousIndex];
    if (previous && !previous.uuid) throw new Error('The original assistant fork point has no UUID');
    const lastCompactUuid = params.messages.findLast(message => message.type === 'system' && message.subtype === 'compact_boundary')?.uuid;
    if (state?.running) throw new Error('The original TUI started overlapping SDK turns');
    if (state && (state.lastAssistantUuid !== previous?.uuid || state.lastCompactUuid !== lastCompactUuid)) {
      dispose(state);
      state = undefined;
    }
    const context = params.toolUseContext;
    const model = context.options.mainLoopModel;
    const mode = context.getAppState().toolPermissionContext.mode;
    if (!state) {
      const history = previous ? await (dependencies.history ?? originalHistory)(previous.uuid!, params.messages.slice(0, previousIndex + 1)) : undefined;
      const input = new Queue<SDKUserMessage>();
      const controller = new AbortController();
      const childId = randomUUID();
      let created!: State;
      const options: Options = {
        cwd: dependencies.cwd ?? process.cwd(),
        pathToClaudeCodeExecutable: dependencies.executable ?? sdkExecutable(),
        env: { ...process.env, BUN_OPTIONS: undefined },
        sessionId: childId,
        ...(history ? { resume: history.path, forkSession: true, resumeSessionAt: previous.uuid } : {}),
        persistSession: true,
        includePartialMessages: true,
        permissionMode: mode,
        ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
        model,
        systemPrompt: sdkPrompt(params),
        abortController: controller,
        canUseTool: (...args) => permission(created, ...args),
      };
      const connection = (dependencies.queryFactory ?? query)({ prompt: input, options });
      created = { parentId, childId, input, controller, connection, active: params, sent: new Set(), model, mode, running: false, usage: structuredClone(history?.usage ?? {}), apiDuration: history?.apiDuration ?? 0, lastAssistantUuid: previous?.uuid, lastCompactUuid };
      state = created;
      states.set(parentId, state);
      trace({ kind: 'sdk_start', parentId, childId, sdk: sdkVersion, persistSession: true, resumed: Boolean(history), cutoff: previous?.uuid });
    }
    return state;
  }

  async function* run(params: RunParams): AsyncGenerator<InternalMessage, { reason: string }> {
    const previousIndex = params.messages.findLastIndex(message => message.type === 'assistant');
    const helpers = await (dependencies.helpers ?? originalHelpers)();
    const state = await acquire(params);
    const anchorIndex = state.contextAnchorUuid ? params.messages.findIndex(message => message.uuid === state.contextAnchorUuid) : -1;
    const segment = params.messages.slice(Math.max(previousIndex, anchorIndex) + 1);
    const command = params.sdkCommand as string | undefined;
    const normalized = command ? [] : helpers.normalizePrompt(segment, params.toolUseContext.options.tools);
    if (!command && (!normalized.length || normalized.some(message => message.type !== 'user' || message.message?.role !== 'user'))) throw new Error('The original prompt normalizer did not produce a user-only current turn');
    const content = command ? [{ type: 'text', text: command }] : normalized.flatMap(message => typeof message.message.content === 'string' ? [{ type: 'text', text: message.message.content }] : message.message.content);
    if (content.length === 0) throw new Error('The original current turn has no normalized content');
    const prompt = command ? { uuid: randomUUID() } : segment.findLast(message => message.type === 'user' && !message.isMeta) ?? normalized[0];
    if (!prompt.uuid) throw new Error('The original prompt has no UUID');
    const parentId = state.parentId;
    const context = params.toolUseContext;
    const model = context.options.mainLoopModel;
    const mode = context.getAppState().toolPermissionContext.mode;
    if (state.running) throw new Error('The original TUI started overlapping SDK turns');
    if (state.sent.has(prompt.uuid)) throw new Error('The SDK bridge cannot replay a user message in an existing child session');
    state.running = true;
    state.active = params;
    let settled = false;
    const output: InternalMessage[] = [];
    const abort = () => { void state!.connection.interrupt().catch(() => {}); };
    context.abortController.signal.addEventListener('abort', abort, { once: true });
    try {
      if (context.abortController.signal.aborted) { settled = true; return { reason: 'aborted_streaming' }; }
      if (state.model !== model) { await state.connection.setModel(model); state.model = model; }
      if (state.mode !== mode) { await state.connection.setPermissionMode(mode); state.mode = mode; }
      state.sent.add(prompt.uuid);
      state.input.push({ type: 'user', uuid: prompt.uuid as `${string}-${string}-${string}-${string}-${string}`, parent_tool_use_id: null,
        ...(!command && { client_composed: true }), message: { role: 'user', content } });
      trace({ kind: 'sdk_turn', parentId, childId: state.childId, promptId: prompt.uuid });
      while (true) {
        const next = await state.connection.next();
        if (next.done) throw new Error('The SDK child ended before returning a turn result');
        const message = next.value;
        if (message.type === 'assistant' && !message.parent_tool_use_id) state.lastAssistantUuid = message.uuid;
        trace({ kind: 'sdk_event', parentId, childId: state.childId, type: message.type, ...('subtype' in message ? { subtype: message.subtype } : {}) });
        if (message.type === 'result') {
          await syncUsage(state, message);
          settled = true;
          if (context.abortController.signal.aborted) return { reason: 'aborted_streaming' };
          if (message.is_error) throw new Error(message.subtype === 'success' ? message.result : message.errors.join('\n'));
          if (!command) helpers.saveContext?.({
            systemPrompt: params.systemPrompt, userContext: params.userContext, systemContext: params.systemContext,
            toolUseContext: context, forkContextMessages: [...params.messages, ...output], advisorModel: context.getAdvisorSetting?.(),
          });
          return { reason: 'completed' };
        }
        for (const progress of await sdkSubagentProgress(message)) yield progress;
        const internal = message.type === 'system' && message.subtype === 'compact_boundary'
          ? (await (dependencies.helpers ?? originalHelpers)()).compactBoundary?.(message)
          : toInternal(message);
        if (message.type === 'system' && message.subtype === 'compact_boundary' && !internal) throw new Error('Original compact-boundary converter is unavailable');
        if (internal?.type === 'system' && internal.subtype === 'compact_boundary') state.lastCompactUuid = internal.uuid;
        if (internal) {
          if (internal.type !== 'stream_event' && internal.type !== 'sdk_status') output.push(internal);
          yield internal;
        }
      }
    } catch (error) {
      dispose(state);
      if (context.abortController.signal.aborted) return { reason: 'aborted_streaming' };
      throw error;
    } finally {
      context.abortController.signal.removeEventListener('abort', abort);
      state.running = false;
      if (!settled) dispose(state);
    }
  }

  return { run, async history(parentId: string) {
    const state = states.get(parentId);
    if (!state || state.running) throw new Error('SDK history is only available after a completed command');
    const native = await import(new URL('../vendor/claude-full/chunk-hqtnbrjd.js', import.meta.url).href);
    const transcript = await native.UZ(native.Cf(state.childId), { keepAllLeaves: true });
    return native.twr([...transcript.messages.values()]) as InternalMessage[];
  }, alignHistory(parentId: string, messages: InternalMessage[]) {
    const state = states.get(parentId);
    if (!state || state.running) throw new Error('SDK history can only be aligned after a completed command');
    state.lastAssistantUuid = messages.findLast(message => message.type === 'assistant')?.uuid;
    state.lastCompactUuid = messages.findLast(message => message.type === 'system' && message.subtype === 'compact_boundary')?.uuid;
    state.contextAnchorUuid = messages.at(-1)?.uuid;
  }, async connection(params: RunParams) { return (await acquire(params, true)).connection; }, close() { for (const state of [...states.values()]) dispose(state); } };
}

const bridge = createSdkRun();
export const sdkRun = bridge.run;
export const closeSdkRuns = bridge.close;

export const getSdkConnection = bridge.connection;
export const alignSdkHistory = bridge.alignHistory;
export const getSdkHistory = bridge.history;
