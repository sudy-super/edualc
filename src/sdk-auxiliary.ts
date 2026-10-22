import { loadNativeModule } from './claude';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { query, sdkExecutable, sdkEnvironment, sdkSettings } from './sdk';
import type { RunParams } from './sdk-run';

interface SideExchange { question: string; response: string; fallbackNotice?: string }
interface SideAnswer {
  response: string | null;
  synthetic: boolean;
  refusalFallback?: { originalModel: string; fallbackModel: string; content: string };
}

// 0.3.302 の実装には存在するが、公開された Query の型には含まれない。
export interface AuxiliaryQuery extends Query {
  generateSessionTitle(description: string, options: { persist: false }): Promise<string | null>;
  askSideQuestion(question: string, options: {
    signal?: AbortSignal;
    history?: { question: string; response: string; fallback_notice?: string }[];
  }): Promise<SideAnswer | null>;
}

export interface SideQuestionParams {
  question: string;
  cacheSafeParams: Omit<RunParams, 'messages' | 'canUseTool'> & {
    forkContextMessages: RunParams['messages'];
    toolUseContext: RunParams['toolUseContext'] & {
      session: { id: string; btwHistory?: {
        exchanges: SideExchange[];
        append(question: string, response: string, fallbackNotice?: string): void;
      } };
    };
  };
  parentController?: AbortController;
  onRetry?: (retry: { retryAttempt: number; maxRetries: number; retryInMs: number; status?: number | null }) => void;
  threadHistory?: boolean;
  history?: SideExchange[];
  turnInProgress?: boolean;
}

interface Dependencies {
  queryFactory?: typeof query;
  getConnection(params: RunParams): Promise<Query>;
  titleSettings?(): Promise<Pick<Options, 'model' | 'settings'>>;
  executable?: string;
  logTitleError?(error: unknown): void | Promise<void>;
}

function auxiliary(connection: Query): AuxiliaryQuery {
  const candidate = connection as AuxiliaryQuery;
  if (typeof candidate.generateSessionTitle !== 'function' || typeof candidate.askSideQuestion !== 'function') {
    throw new Error('Claude Agent SDK auxiliary control methods are unavailable');
  }
  return candidate;
}

async function* idleInput(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  if (signal.aborted) return;
  await new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true }));
}

export function createSdkAuxiliary(dependencies: Dependencies) {
  const titleChildren = new Set<Query>();

  async function generateTitle(description: string, signal?: AbortSignal, _credentials?: unknown): Promise<string | null> {
    if (signal?.aborted || description.trim().length < 10) return null;
    const controller = new AbortController();
    let connection: Query | undefined;
    const stop = () => { controller.abort(); connection?.close(); };
    signal?.addEventListener('abort', stop, { once: true });
    try {
      const settings = await dependencies.titleSettings?.();
      if (signal?.aborted) return null;
      connection = (dependencies.queryFactory ?? query)({
        prompt: idleInput(controller.signal),
        options: {
          ...settings,
          settings: sdkSettings({ ...(typeof settings?.settings === 'object' ? settings.settings : {}), disableAllHooks: true }),
          pathToClaudeCodeExecutable: dependencies.executable ?? sdkExecutable(),
          env: sdkEnvironment(),
          settingSources: [], strictMcpConfig: true, mcpServers: {}, tools: [],
          persistSession: false, abortController: controller,
        },
      });
      titleChildren.add(connection);
      const title = await auxiliary(connection).generateSessionTitle(description, { persist: false });
      return signal?.aborted ? null : title;
    } catch (error) {
      if (!signal?.aborted) {
        if (dependencies.logTitleError) await dependencies.logTitleError(error);
        else {
          const log = await loadNativeModule('chunk-s093jfzw.js');
          log.t(`generateSessionTitle failed: ${error}`, { level: 'error' });
        }
      }
      return null;
    } finally {
      signal?.removeEventListener('abort', stop);
      controller.abort();
      connection?.close();
      if (connection) titleChildren.delete(connection);
    }
  }

  async function sideQuestion(params: SideQuestionParams): Promise<SideAnswer & { aborted?: boolean }> {
    const signal = params.parentController?.signal;
    if (signal?.aborted) return { response: null, synthetic: false, aborted: true };
    const cache = params.cacheSafeParams;
    const history = params.threadHistory === false ? undefined : cache.toolUseContext.session.btwHistory;
    const exchanges = params.history ?? history?.exchanges ?? [];
    const connection = auxiliary(await dependencies.getConnection({
      ...cache,
      systemPrompt: cache.systemPrompt,
      toolUseContext: cache.toolUseContext,
      messages: cache.forkContextMessages,
      canUseTool: async () => ({ behavior: 'deny', message: 'Side questions cannot use tools' }),
    }));
    if (signal?.aborted) return { response: null, synthetic: false, aborted: true };
    try {
      const answer = await connection.askSideQuestion(params.question, {
        signal,
        ...(exchanges.length ? { history: exchanges.map(exchange => ({
          question: exchange.question, response: exchange.response,
          ...(exchange.fallbackNotice ? { fallback_notice: exchange.fallbackNotice } : {}),
        })) } : {}),
      });
      if (signal?.aborted) return { response: null, synthetic: false, aborted: true };
      if (!answer) return { response: null, synthetic: false };
      if (history && answer.response && !answer.synthetic) history.append(params.question, answer.response, answer.refusalFallback?.content);
      return answer;
    } catch (error) {
      if (signal?.aborted) return { response: null, synthetic: false, aborted: true };
      throw error;
    }
  }

  return {
    generateTitle,
    sideQuestion,
    close() { for (const connection of titleChildren) connection.close(); titleChildren.clear(); },
  };
}

const bridge = createSdkAuxiliary({
  getConnection: async params => {
    const main = await import('./sdk-run');
    return main.getSdkConnection(params);
  },
  titleSettings: async () => {
    const settings = await loadNativeModule('chunk-1pjd7qsk.js');
    return { settings: { language: settings.ut().language } };
  },
});

export const sdkGenerateTitle = bridge.generateTitle;
export const sdkSideQuestion = bridge.sideQuestion;
export const closeSdkAuxiliary = bridge.close;
