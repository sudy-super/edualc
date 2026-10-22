import { loadNativeModule } from './claude';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Options, Query, SDKAssistantMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { query, sdkExecutable, sdkEnvironment, sdkSettings } from './sdk';

type Row = Record<string, any>;
interface CompleteParams {
  systemPrompt?: string[];
  userPrompt: string | Row[];
  outputFormat?: Options['outputFormat'];
  signal?: AbortSignal;
  options: Row & { helperEffortFor?(model: string): Row };
}
interface Helpers {
  helperModel(): string;
  effort(model: string, options: Row): Options['effort'];
  assistant(content: Row[]): Row;
}
interface Dependencies {
  queryFactory?: typeof query;
  helpers?(): Promise<Helpers>;
  executable?: string;
  env?: NodeJS.ProcessEnv;
  trace?(event: Row): void;
}

async function originalHelpers(): Promise<Helpers> {
  const [models, effort, messages] = await Promise.all([
    loadNativeModule('chunk-2jyw98bz.js'),
    loadNativeModule('chunk-zgh1374j.js'),
    loadNativeModule('chunk-hqtnbrjd.js'),
  ]);
  return {
    helperModel: () => models.ple(models.VE()),
    effort: (model, options) => {
      const value = effort.bw(model, options.effortValue, { turnEffort: options.turnEffort, hookEffortValue: options.hookEffortValue });
      return value === undefined ? undefined : effort.LL(value);
    },
    assistant: content => messages._d({ content }),
  };
}

function traceFile(event: Row): void {
  if (process.env.EDUALC_TRACE !== '1') return;
  const path = resolve(import.meta.dir, '../test/artifacts/sdk-run.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}

export function createSdkComplete(dependencies: Dependencies = {}) {
  const children = new Set<Query>();
  async function complete(params: CompleteParams, modelOverride?: string): Promise<Row> {
    params.signal?.throwIfAborted();
    const system = params.systemPrompt ?? [];
    if (!Array.isArray(system) || system.some(block => typeof block !== 'string')) throw new Error('The SDK completion system prompt must be a string array');
    if (typeof params.userPrompt !== 'string' && !Array.isArray(params.userPrompt)) throw new Error('The SDK completion user prompt must be text or content blocks');
    const helpers = await (dependencies.helpers ?? originalHelpers)();
    const model = modelOverride ?? helpers.helperModel();
    const native = { ...params.options, ...params.options.helperEffortFor?.(model) };
    const maxTokens = native.maxOutputTokensOverride;
    if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1)) throw new Error('Invalid SDK completion output token limit');
    const controller = new AbortController();
    const abort = () => controller.abort(params.signal?.reason);
    params.signal?.addEventListener('abort', abort, { once: true });
    if (params.signal?.aborted) abort();
    let connection: Query | undefined;
    const trace = dependencies.trace ?? traceFile;
    try {
      controller.signal.throwIfAborted();
      const env = sdkEnvironment(dependencies.env);
      if (maxTokens !== undefined) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
      if (native.enablePromptCaching !== true) env.DISABLE_PROMPT_CACHING = '1';
      if (native.maxRetries !== undefined) env.CLAUDE_CODE_MAX_RETRIES = String(native.maxRetries);
      if (native.temperatureOverride !== undefined) {
        if (typeof native.temperatureOverride !== 'number' || !Number.isFinite(native.temperatureOverride)) throw new Error('Invalid SDK completion temperature');
        const extra = env.CLAUDE_CODE_EXTRA_BODY ? JSON.parse(env.CLAUDE_CODE_EXTRA_BODY) : {};
        if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) throw new Error('CLAUDE_CODE_EXTRA_BODY must be an object');
        env.CLAUDE_CODE_EXTRA_BODY = JSON.stringify({ ...extra, temperature: native.temperatureOverride });
      }
      const options: Options = {
        pathToClaudeCodeExecutable: dependencies.executable ?? sdkExecutable(),
        cwd: process.cwd(), env, model, systemPrompt: system,
        tools: [], maxTurns: 1, persistSession: false, verbatimPrompts: true,
        settingSources: [], strictMcpConfig: true, mcpServers: {},
        settings: sdkSettings({ disableAllHooks: true }, dependencies.env), thinking: { type: 'disabled' },
        effort: helpers.effort(model, native), outputFormat: params.outputFormat,
        abortController: controller,
        ...(native.fallbackModel !== undefined ? { fallbackModel: native.fallbackModel } : {}),
        canUseTool: async () => { throw new Error('A tool-free SDK completion attempted to use a tool'); },
      };
      async function* input() {
        yield { type: 'user' as const, parent_tool_use_id: null, message: { role: 'user' as const, content: params.userPrompt as any } };
      }
      connection = (dependencies.queryFactory ?? query)({ prompt: input(), options });
      children.add(connection);
      trace({ kind: 'sdk_completion_start', querySource: native.querySource, model });
      let assistant: SDKAssistantMessage | undefined;
      let result: SDKResultMessage | undefined;
      try {
        for await (const message of connection) {
          if (message.type === 'result') {
            if (message.is_error) {
              const status = (message as Row).api_error_status ?? (assistant as unknown as Row | undefined)?.api_error_status;
              throw Object.assign(new Error(message.subtype === 'success' ? message.result : message.errors.join('\n')), { status });
            }
            result = message;
            continue;
          }
          if (message.type !== 'assistant' || message.parent_tool_use_id) continue;
          if (message.message.content.some(block => block.type === 'tool_use' && !(params.outputFormat && block.name === 'StructuredOutput'))) {
            throw new Error('A tool-free SDK completion emitted a tool call');
          }
          assistant = assistant?.message.id === message.message.id
            ? { ...message, message: { ...message.message, content: [...assistant.message.content, ...message.message.content] } }
            : message;
        }
      } catch (error) {
        const status = (assistant as unknown as Row | undefined)?.api_error_status;
        if (error instanceof Error && typeof status === 'number') Object.assign(error, { status });
        throw error;
      }
      controller.signal.throwIfAborted();
      if (!result) throw new Error('The SDK completion ended without a result');
      const { parent_tool_use_id: _parent, session_id: _session, ...internal } = assistant ?? {} as SDKAssistantMessage;
      let answer: Row = assistant ? { ...internal, timestamp: new Date().toISOString() } : {};
      if (result.subtype === 'success' && result.structured_output !== undefined) {
        const content = [{ type: 'text', text: JSON.stringify(result.structured_output) }];
        answer = assistant ? { ...answer, message: { ...answer.message, content } } : helpers.assistant(content);
      } else if (!assistant) throw new Error('The SDK completion returned no assistant message');
      answer.message = { ...answer.message, usage: result.usage, stop_reason: result.stop_reason };
      trace({ kind: 'sdk_completion_result', querySource: native.querySource, model });
      return answer;
    } finally {
      params.signal?.removeEventListener('abort', abort);
      connection?.close();
      if (connection) children.delete(connection);
    }
  }
  return { complete, close() { for (const child of children) child.close(); children.clear(); } };
}

const bridge = createSdkComplete();
export const sdkComplete = bridge.complete;
export const closeSdkCompletions = bridge.close;

export async function sdkModelProbe(params: { model: string; messages: { content: CompleteParams['userPrompt'] }[]; signal?: AbortSignal }) {
  try {
    return await bridge.complete({ userPrompt: params.messages[0].content, signal: params.signal,
      systemPrompt: [], options: { querySource: 'model_validation', maxOutputTokensOverride: 1, maxRetries: 0 } }, params.model);
  } catch (error) {
    const status = (error as { status?: unknown })?.status;
    if (typeof status === 'number') {
      const native = await loadNativeModule('chunk-z6znfyte.js');
      throw native.Mt.generate(status, undefined, error instanceof Error ? error.message : String(error), new Headers());
    }
    throw error;
  }
}
