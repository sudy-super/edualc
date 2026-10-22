import { describe, expect, test } from 'bun:test';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { applySdkGoalEvent, sdkAgentOptions, sdkFastModeSettings, sdkGoalInput, sdkSessionSettings, syncSdkGoalHistory } from '../src/sdk-options';

describe('native SDK launch and session options', () => {
  test('passes original CLI agent definitions without expanding memory or losing options', async () => {
    const definition: AgentDefinition = { description: 'fixture agent', prompt: 'original prompt', model: 'inherit',
      memory: 'project', tools: ['Read'], disallowedTools: ['Bash'], background: true,
      maxTurns: 3, effort: 'low', initialPrompt: 'first prompt' };
    let validated = '';
    const options = await sdkAgentOptions({ options: { agentDefinitions: { activeAgents: [
      { agentType: 'fixture', source: 'flagSettings', getSystemPrompt: () => { throw new Error('Do not expand memory twice'); } },
    ] } } }, {
      replayConfig: () => ({ agent: 'fixture', agents: JSON.stringify({ fixture: definition }) }),
      validateAgents: value => { validated = value; return null; }, parseJson: JSON.parse,
    });
    expect(JSON.parse(validated)).toEqual({ fixture: definition });
    expect(options).toEqual({ agent: 'fixture', agents: { fixture: definition } });
  });

  test('does not re-enable CLI agents excluded by the original settings policy', async () => {
    const options = await sdkAgentOptions({ options: { agentDefinitions: { activeAgents: [
      { agentType: 'fixture', source: 'policySettings' },
    ] } } }, { replayConfig: () => ({ agents: JSON.stringify({ fixture: { description: 'fixture', prompt: 'prompt' } }) }),
      validateAgents: () => null, parseJson: JSON.parse });
    expect(options.agents).toEqual({});
  });

  test('fails if the original agent validator rejects saved launch definitions', async () => {
    await expect(sdkAgentOptions({ options: {} }, { replayConfig: () => ({ agents: '{}' }),
      validateAgents: () => 'fixture invalid', parseJson: () => { throw new Error('must not parse'); } })).rejects.toThrow('fixture invalid');
  });

  test('keeps explicit fast mode opt-in and opt-out at the SDK flag settings layer', () => {
    expect(sdkFastModeSettings({ options: { fastMode: true } })).toEqual({ fastMode: true });
    expect(sdkFastModeSettings({ options: { fastMode: false } })).toEqual({ fastMode: false });
    expect(sdkFastModeSettings({ options: {} })).toEqual({});
  });

  test('passes session-only advisor and compaction window through SDK settings', () => {
    expect(sdkSessionSettings({ options: { fastMode: false, autoCompactWindow: 200000 }, getAdvisorSetting: () => 'opus' }))
      .toEqual({ fastMode: false, advisorModel: 'opus', autoCompactWindow: 200000 });
    expect(sdkSessionSettings({ options: {}, getAdvisorSetting: () => undefined })).toEqual({ advisorModel: '' });
  });

  test('dispatches only the original goal-setting prompt as the SDK goal command', async () => {
    const context = { getAppState: () => ({ activeGoal: { condition: 'fixture goal' } }) };
    const helpers = { prompt: (condition: string) => `original goal: ${condition}`, stopHooks: () => [] };
    expect(await sdkGoalInput(context, [{ type: 'text', text: 'original goal: fixture goal' }], helpers)).toBe('/goal fixture goal');
    expect(await sdkGoalInput(context, [{ type: 'text', text: 'ordinary message' }], helpers)).toBeUndefined();
  });

  test('applies SDK goal checks and removes only the matching parent Stop hook on completion', async () => {
    let state: any = { activeGoal: { condition: 'fixture goal', origin: 'user' } };
    const removed: any[] = [];
    const context = { session: { id: 'parent' }, sessionHooksRegistry: { remove: (...args: any[]) => removed.push(args) },
      getAppState: () => state, setAppState: (update: any) => { state = update(state); } };
    const helpers = { prompt: (condition: string) => condition,
      stopHooks: () => [{ type: 'prompt', prompt: 'fixture goal' }, { type: 'prompt', prompt: 'other hook' }] };
    await applySdkGoalEvent(context, { condition: 'fixture goal', iterations: 2, set_at: 123, tokens_at_start: 30, last_reason: 'not met' }, helpers);
    expect(state.activeGoal).toEqual({ condition: 'fixture goal', origin: 'user', iterations: 2, setAt: 123, tokensAtStart: 30, lastReason: 'not met' });
    await applySdkGoalEvent(context, null, helpers);
    expect(state.activeGoal).toBeUndefined();
    expect(removed).toEqual([['parent', 'Stop', { type: 'prompt', prompt: 'fixture goal' }]]);
  });

  test('restores SDK goal status using native history and preserves live counters without duplicate hooks', async () => {
    let state: any = { activeGoal: { condition: 'fixture', origin: 'user', setAt: 100, tokensAtStart: 20 } };
    let registrations = 0;
    const setup = { type: 'attachment', uuid: 'setup', attachment: { type: 'goal_status', condition: 'fixture', sentinel: true, met: false } };
    const check = { type: 'attachment', uuid: 'check', attachment: { type: 'goal_status', condition: 'fixture', reason: 'keep working', met: false } };
    const context = { session: { id: 'parent' }, sessionHooksRegistry: { add() { registrations++; } }, messages: [setup],
      getAppState: () => state, setAppState: (change: any) => { state = change(state); } };
    const events = await syncSdkGoalHistory(context, 'child', new Set(), {
      history: async () => [setup, check], restore: (_messages, update, hooks) => {
        hooks.add('parent', 'Stop', '', { type: 'prompt', prompt: 'fixture' });
        update(() => ({ activeGoal: { condition: 'fixture', origin: 'restored', setAt: 999, tokensAtStart: 99 } }));
      },
    });
    expect(state.activeGoal).toEqual({ condition: 'fixture', origin: 'user', setAt: 100, tokensAtStart: 20, iterations: 1, lastReason: 'keep working' });
    expect(events).toEqual([check]);
    expect(registrations).toBe(0);
  });
});
