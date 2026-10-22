import { loadNativeModule } from './claude';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { query, sdkExecutable, sdkEnvironment, sdkSettings } from './sdk';
import { toInternal } from './sdk-run';

type Row = Record<string, any>;
interface ForkParams {
  promptMessages: Row[];
  cacheSafeParams: {
    systemPrompt: string[];
    userContext?: Record<string, string>;
    systemContext?: Record<string, string>;
    toolUseContext: Row;
    forkContextMessages: Row[];
    model?: string;
  };
  querySource: string;
  forkLabel: string;
  overrides?: Row;
  maxOutputTokens?: number;
  maxTurns?: number;
  onMessage?(row: Row): void;
  onRequestUsage?(usage: Row): void;
  onStreamDelta?(row: Row): void;
  ownPrefix?: unknown;
  toolCallRoutes?: unknown;
}
interface Helpers {
  zxe(rows: Row[]): Row[];
  JXs(row: Row): Row;
  Vbr(id: string): Row;
  wT(rows: Row[], tools: Row[]): Row[];
}
interface Dependencies {
  queryFactory?: typeof query;
  convertMessages?: Parameters<typeof toInternal>[1];
  helpers?: () => Promise<Helpers>;
  tempRoot?: string;
  executable?: string;
  env?: NodeJS.ProcessEnv;
  trace?(event: Row): void;
}
const supported = new Set(['away_summary', 'prompt_suggestion', 'rename_generate_name', 'agent_summary']);
const emptyUsage = () => ({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, service_tier: null });
async function originalHelpers(): Promise<Helpers> {
  return await loadNativeModule('chunk-hqtnbrjd.js') as Helpers;
}
function traceFile(event: Row): void {
  if (process.env.EDUALC_TRACE !== '1') return;
  const directory = resolve(import.meta.dir, '../test/artifacts');
  mkdirSync(directory, { recursive: true });
  appendFileSync(join(directory, 'sdk-run.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}
export function createSdkToolFreeFork(dependencies: Dependencies = {}) {
  return async function sdkToolFreeFork(params: ForkParams): Promise<{ messages: Row[]; totalUsage: Row }> {
    if (!supported.has(params.querySource) || params.ownPrefix !== undefined || params.toolCallRoutes !== undefined) {
      throw new Error(`Unsupported SDK tool-free fork: ${params.querySource}`);
    }
    const context = params.cacheSafeParams;
    const signal: AbortSignal = (params.overrides?.abortController ?? context.toolUseContext.abortController).signal;
    if (signal.aborted) throw new Error('SDK tool-free fork was cancelled');
    const helpers = await (dependencies.helpers ?? originalHelpers)();
    const prompt = helpers.wT(params.promptMessages, context.toolUseContext.options.tools);
    if (!prompt.length || prompt.some(row => row.type !== 'user' || row.message?.role !== 'user')) throw new Error('SDK tool-free fork requires user prompt messages');
    const content = prompt.flatMap(row => typeof row.message.content === 'string' ? [{ type: 'text', text: row.message.content }] : row.message.content);
    const system = [...context.systemPrompt, ...Object.values(context.systemContext ?? {}), ...Object.values(context.userContext ?? {})];
    if (!system.every(value => typeof value === 'string')) throw new Error('SDK tool-free fork has an invalid system prompt');
    const rows = helpers.zxe(context.forkContextMessages);
    const seedId = randomUUID();
    const childId = randomUUID();
    const directory = mkdtempSync(join(dependencies.tempRoot ?? tmpdir(), 'edualc-fork-'));
    const path = join(directory, `${seedId}.jsonl`);
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let connection: ReturnType<typeof query> | undefined;
    const trace = dependencies.trace ?? traceFile;
    try {
      let parentUuid: string | null = null;
      const records = rows.map(row => {
        if (typeof row.uuid !== 'string') throw new Error('SDK fork history has a message without UUID');
        const boundary = row.type === 'system' && row.subtype === 'compact_boundary';
        const record = { ...helpers.JXs(row), ...helpers.Vbr(seedId), parentUuid: boundary ? null : parentUuid, ...(boundary ? { logicalParentUuid: parentUuid } : {}), isSidechain: false };
        parentUuid = row.uuid;
        return record;
      });
      if (records.length) writeFileSync(path, records.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
      const options: Options = {
        cwd: process.cwd(), pathToClaudeCodeExecutable: dependencies.executable ?? sdkExecutable(),
        sessionId: childId, persistSession: false,
        ...(records.length ? { resume: path, forkSession: true } : {}),
        systemPrompt: system.join('\n\n'), model: context.model ?? params.overrides?.options?.mainLoopModel ?? context.toolUseContext.options.mainLoopModel,
        tools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [],
        settings: sdkSettings({}, dependencies.env),
        maxTurns: params.maxTurns ?? 50,
        abortController: controller, includePartialMessages: true,
        env: { ...sdkEnvironment(dependencies.env), ...(params.maxOutputTokens !== undefined ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(params.maxOutputTokens) } : {}) },
        canUseTool: async () => { throw new Error('A tool-free SDK fork attempted to use a tool'); },
      };
      async function* input(): AsyncGenerator<SDKUserMessage> {
        yield { type: 'user', parent_tool_use_id: null, uuid: randomUUID(), message: { role: 'user', content } };
      }
      connection = (dependencies.queryFactory ?? query)({ prompt: input(), options });
      trace({ kind: 'sdk_fork_start', childId, querySource: params.querySource, historyRows: records.length });
      const messages: Row[] = [];
      let totalUsage: Row = emptyUsage();
      let completed = false;
      for await (const event of connection) {
        if (event.type === 'result') {
          if (event.is_error) throw new Error(event.subtype === 'success' ? event.result : event.errors.join('\n'));
          totalUsage = { ...emptyUsage(), ...event.usage };
          params.onRequestUsage?.(totalUsage);
          completed = true;
          trace({ kind: 'sdk_fork_result', childId, querySource: params.querySource });
          continue;
        }
        if (event.type === 'assistant' && event.message.content.some(block => block.type === 'tool_use')) throw new Error('A tool-free SDK fork emitted a tool call');
        const row = await toInternal(event as SDKMessage, dependencies.convertMessages);
        if (!row) continue;
        if (row.type === 'stream_event') params.onStreamDelta?.(row);
        else if (row.type === 'assistant' || row.type === 'user') {
          messages.push(row);
          params.onMessage?.(row);
        }
      }
      if (signal.aborted) throw new Error('SDK tool-free fork was cancelled');
      if (!completed) throw new Error('SDK tool-free fork ended without a result');
      return { messages, totalUsage };
    } finally {
      signal.removeEventListener('abort', abort);
      controller.abort();
      connection?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}
export const sdkToolFreeFork = createSdkToolFreeFork();
