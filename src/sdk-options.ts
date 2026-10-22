import type { Options, Settings } from '@anthropic-ai/claude-agent-sdk';
import { loadNativeModule } from './claude';

interface NativeLaunchHelpers {
  replayConfig(): { agent?: string; agents?: string };
  validateAgents(value: string): string | null;
  parseJson(value: string): unknown;
}

async function nativeLaunchHelpers(): Promise<NativeLaunchHelpers> {
  const [session, agents, json] = await Promise.all([
    loadNativeModule('chunk-hdxpvbx1.js'),
    loadNativeModule('chunk-hqtnbrjd.js'),
    loadNativeModule('chunk-ytgfx4bj.js'),
  ]);
  return { replayConfig: session.HJ, validateAgents: agents.lXt, parseJson: json.ft };
}

export async function sdkAgentOptions(context: { options: Record<string, any> }, helpers?: NativeLaunchHelpers): Promise<Pick<Options, 'agents' | 'agent'>> {
  const native = helpers ?? await nativeLaunchHelpers();
  const replay = native.replayConfig();
  const result: Pick<Options, 'agents' | 'agent'> = {};
  if (replay.agents !== undefined) {
    const error = native.validateAgents(replay.agents);
    if (error !== null) throw new Error(`Invalid original --agents configuration: ${error}`);
    const definitions = native.parseJson(replay.agents) as NonNullable<Options['agents']>;
    const active = new Set((context.options.agentDefinitions?.activeAgents ?? [])
      .filter((agent: any) => agent.source === 'flagSettings').map((agent: any) => agent.agentType));
    // 本家が fork に引き継ぐ生の定義を使い、memory 指示を二度展開しない。
    result.agents = Object.fromEntries(Object.entries(definitions).filter(([name]) => active.has(name)));
  }
  if (replay.agent !== undefined) result.agent = replay.agent;
  return result;
}

export function sdkFastModeSettings(context: { options: Record<string, any> }): Pick<Settings, 'fastMode'> {
  return typeof context.options.fastMode === 'boolean' ? { fastMode: context.options.fastMode } : {};
}

export function sdkSessionSettings(context: { options: Record<string, any>; getAdvisorSetting?(): string | undefined }): Pick<Settings, 'fastMode' | 'advisorModel' | 'autoCompactWindow'> {
  return {
    ...sdkFastModeSettings(context),
    ...(context.getAdvisorSetting ? { advisorModel: context.getAdvisorSetting() ?? '' } : {}),
    ...(typeof context.options.autoCompactWindow === 'number' ? { autoCompactWindow: context.options.autoCompactWindow } : {}),
  };
}

interface GoalContext {
  session: { id: string };
  sessionHooksRegistry: any;
  getAppState(): any;
  setAppState(update: (state: any) => any): void;
}
interface GoalHelpers {
  prompt(condition: string): string;
  stopHooks(registry: any, sessionId: string): any[];
}
async function nativeGoalHelpers(): Promise<GoalHelpers> {
  const native = await loadNativeModule('chunk-kb3ntcf8.js');
  return { prompt: native.P6n, stopHooks: native.KBe };
}

export async function sdkGoalInput(context: Pick<GoalContext, 'getAppState'>, content: { type: string; text?: string }[], helpers?: GoalHelpers): Promise<string | undefined> {
  const goal = context.getAppState().activeGoal;
  if (!goal) return undefined;
  const native = helpers ?? await nativeGoalHelpers();
  return content.some(block => block.type === 'text' && block.text === native.prompt(goal.condition)) ? `/goal ${goal.condition}` : undefined;
}

export async function applySdkGoalEvent(context: GoalContext, value: { condition: string; iterations: number; set_at: number; tokens_at_start: number; last_reason?: string } | null, helpers?: GoalHelpers): Promise<void> {
  const previous = context.getAppState().activeGoal;
  if (value === null && previous) {
    const native = helpers ?? await nativeGoalHelpers();
    for (const hook of native.stopHooks(context.sessionHooksRegistry, context.session.id)) {
      if (hook.prompt === previous.condition) context.sessionHooksRegistry.remove(context.session.id, 'Stop', hook);
    }
  }
  context.setAppState(state => ({ ...state, activeGoal: value === null ? undefined : {
    condition: value.condition, iterations: value.iterations, setAt: value.set_at,
    tokensAtStart: value.tokens_at_start, origin: previous?.origin ?? 'user',
    ...(value.last_reason !== undefined ? { lastReason: value.last_reason } : {}),
  } }));
}

interface GoalHistoryHelpers {
  history(sessionId: string): Promise<any[]>;
  restore(messages: any[], update: (change: (state: any) => any) => void, hooks: { add(...args: any[]): void }): void;
}
async function nativeGoalHistoryHelpers(): Promise<GoalHistoryHelpers> {
  const [history, goals] = await Promise.all([
    loadNativeModule('chunk-hqtnbrjd.js'),
    loadNativeModule('chunk-137vab9c.js'),
  ]);
  return {
    async history(sessionId) {
      const transcript = await history.UZ(history.Cf(sessionId), { keepAllLeaves: true });
      return history.twr([...transcript.messages.values()]);
    },
    restore: goals.restoreGoalFromTranscript,
  };
}

export async function syncSdkGoalHistory(context: GoalContext & { messages?: any[]; getMessages?(): any[] }, childId: string,
  known: ReadonlySet<string> = new Set(), helpers?: GoalHistoryHelpers): Promise<any[]> {
  const native = helpers ?? await nativeGoalHistoryHelpers();
  const messages = await native.history(childId);
  const goalRows = messages.filter(message => message.type === 'attachment' && message.attachment?.type === 'goal_status');
  if (!goalRows.length) throw new Error('The SDK goal transcript has no goal status');
  let restored: any = {};
  // 復元処理による Stop フックの登録は SDK が担当し、親では状態だけを受け取る。
  native.restore(messages, change => { restored = change(restored); }, { add() {} });
  const previous = context.getAppState().activeGoal;
  if (!restored.activeGoal) await applySdkGoalEvent(context, null);
  else {
    const setup = goalRows.findLastIndex(message => message.attachment.sentinel && !message.attachment.met);
    const checks = goalRows.slice(setup + 1).filter(message => !message.attachment.sentinel);
    const reason = checks.at(-1)?.attachment.reason;
    context.setAppState(state => ({ ...state, activeGoal: {
      ...restored.activeGoal, ...(previous?.condition === restored.activeGoal.condition ? previous : {}),
      iterations: checks.length, ...(reason !== undefined ? { lastReason: reason } : {}),
    } }));
  }
  const displayed = new Set([...(context.getMessages?.() ?? context.messages ?? []).map(message => message.uuid), ...known]);
  return goalRows.filter(message => !message.attachment.sentinel && !displayed.has(message.uuid));
}
