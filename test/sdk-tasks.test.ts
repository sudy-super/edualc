import { expect, test } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createSdkTasks, sdkTaskUpdated, sdkTaskCanBackground, sdkBackgroundTask, type TaskRegistry } from '../src/sdk-tasks';

function fixture() {
  const records: Record<string, any> = {};
  const transcripts: Record<string, any> = {};
  const registry: TaskRegistry = {
    register(task) { records[task.id] = task; },
    update(id, change) { if (records[id]) { const before = records[id]; const after = change(before); sdkTaskUpdated(id, before, after); records[id] = after; } },
    updateTranscript(id, change) { transcripts[id] = change(transcripts[id] ?? { messages: [] }); },
    get(id) { return records[id]; }, all() { return records; },
  };
  return { registry, records, transcripts };
}
const helpers = async () => ({
  base: (id: string, type: string, description: string, toolUseId?: string) => ({ id, type, description, toolUseId, status: 'pending', startTime: 1 }),
  agent: (options: any) => ({ id: options.agentId, type: 'local_agent', status: 'running', ...options, pendingMessages: [], keepaliveReasons: new Set() }),
  progress: (options: any) => ({ type: 'progress', ...options }),
});
const event = (value: Record<string, unknown>) => ({ type: 'system', uuid: 'fixture', session_id: 'child', ...value }) as unknown as SDKMessage;
const started = (id: string, type = 'local_bash', run = 'run-1') => event({ subtype: 'task_started', task_id: id, task_type: type, description: 'Fixture task', tool_use_id: 'call-1', run_id: run });

test('native background controls target SDK-owned foreground tasks and wait for SDK state', async () => {
  const f = fixture(), calls: string[] = [], errors: Error[] = [];
  const ack = Promise.withResolvers<boolean>();
  const bridge = createSdkTasks({ context: () => ({ taskRegistry: f.registry }),
    connection: { stopTask: async () => {}, backgroundTasks: async id => { calls.push(id!); return ack.promise; } },
    helpers, onError: error => errors.push(error) });
  await bridge.handle(event({ subtype: 'task_started', task_id: 'shell', task_type: 'local_bash',
    tool_use_id: 'call-shell', description: 'Foreground shell', is_backgrounded: false }));
  expect(sdkTaskCanBackground(f.records.shell)).toBe(true);
  expect(sdkBackgroundTask({ ...f.records.shell }, f.registry)).toBe(false);
  expect(sdkBackgroundTask(f.records.shell, f.registry)).toBe(true);
  expect(sdkBackgroundTask(f.records.shell, f.registry)).toBe(true);
  expect(calls).toEqual(['call-shell']);
  expect(f.records.shell.isBackgrounded).toBe(false);
  ack.resolve(true);
  await bridge.settled();
  await bridge.handle(event({ subtype: 'task_updated', task_id: 'shell', patch: { is_backgrounded: true } }));
  expect(sdkTaskCanBackground(f.records.shell)).toBe(false);
  expect(errors).toEqual([]);
  bridge.close();
});

test('rejected background controls preserve the foreground state and report failure', async () => {
  const f = fixture(), errors: Error[] = [];
  const bridge = createSdkTasks({ context: () => ({ taskRegistry: f.registry }),
    connection: { stopTask: async () => {}, backgroundTasks: async () => false },
    helpers, onError: error => errors.push(error) });
  await bridge.handle(event({ subtype: 'task_started', task_id: 'agent', task_type: 'local_agent',
    tool_use_id: 'call-agent', description: 'Foreground agent', is_backgrounded: false }));
  expect(sdkBackgroundTask(f.records.agent, f.registry)).toBe(true);
  await bridge.settled();
  expect(f.records.agent.isBackgrounded).toBe(false);
  expect(errors[0].message).toContain('no matching foreground task');
  bridge.close();
  expect(sdkTaskCanBackground(f.records.agent)).toBeUndefined();
});

test('parent background controls leave nested tools under their owning agent', async () => {
  const f = fixture(), calls: string[] = [];
  const bridge = createSdkTasks({ context: () => ({ taskRegistry: f.registry }),
    connection: { stopTask: async () => {}, backgroundTasks: async id => { calls.push(id!); return true; } },
    helpers, onError: error => { throw error; } });
  await bridge.handle(event({ subtype: 'task_started', task_id: 'agent', task_type: 'local_agent',
    tool_use_id: 'call-agent', description: 'Parent', is_backgrounded: false }));
  await bridge.handle(event({ subtype: 'task_started', task_id: 'shell', task_type: 'local_bash',
    tool_use_id: 'call-shell', parent_task_id: 'agent', description: 'Nested shell', is_backgrounded: false }));
  expect(sdkTaskCanBackground(f.records.shell)).toBe(false);
  expect(sdkBackgroundTask(f.records.shell, f.registry)).toBe(false);
  expect(sdkBackgroundTask(f.records.agent, f.registry)).toBe(true);
  await bridge.settled();
  expect(calls).toEqual(['call-agent']);
  bridge.close();
});

test('mirrors SDK task starts, progress, updates and completion through the original registry', async () => {
  const f = fixture();
  const stopCalls: string[] = [];
  const bridge = createSdkTasks({ context: () => ({ taskRegistry: f.registry }), connection: { backgroundTasks: async () => true, stopTask: async id => { stopCalls.push(id); } }, helpers, onError: error => { throw error; } });
  await bridge.handle(started('task-1', 'local_agent'));
  expect(f.records['task-1'].type).toBe('local_agent');
  await bridge.handle(event({ subtype: 'task_progress', task_id: 'task-1', description: 'Fixture task', usage: { total_tokens: 25, tool_uses: 3, duration_ms: 10 }, summary: 'Working', last_tool_name: 'Read' }));
  expect(f.records['task-1'].progress).toMatchObject({ tokenCount: 25, toolUseCount: 3, summary: 'Working', lastActivity: 'Read' });
  expect(f.transcripts['task-1'].progress.tokenCount).toBe(25);
  await bridge.handle(event({ subtype: 'task_updated', task_id: 'task-1', patch: { is_backgrounded: true, description: 'Updated task' } }));
  expect(f.records['task-1'].description).toBe('Updated task');
  await bridge.handle(event({ subtype: 'task_notification', task_id: 'task-1', status: 'completed', output_file: '/tmp/fixture.output', summary: 'Done' }));
  expect(f.records['task-1']).toMatchObject({ status: 'completed', notified: true, outputFile: '/tmp/fixture.output', terminal: { summary: 'Done' } });
  expect(stopCalls).toEqual([]);
  bridge.close();
});

test('native stop transitions stop only SDK-owned tasks without replacing original registry methods', async () => {
  const f = fixture();
  const original = f.registry.update;
  f.registry.register({ id: 'original', type: 'local_bash', status: 'running' });
  const stopped: string[] = [];
  const bridge = createSdkTasks({ context: () => ({ taskRegistry: f.registry }), connection: { backgroundTasks: async () => true, stopTask: async id => { stopped.push(id); } }, helpers, onError: error => { throw error; } });
  for (const [id, type] of [['shell', 'local_bash'], ['agent', 'local_agent'], ['monitor', 'monitor_ws'], ['mcp', 'mcp_task'], ['workflow', 'local_workflow']]) await bridge.handle(started(id, type));
  f.registry.update('original', task => ({ ...task, status: 'killed' }));
  for (const id of ['shell', 'agent', 'monitor', 'mcp', 'workflow']) f.registry.update(id, task => ({ ...task, status: 'killed' }));
  await bridge.settled();
  expect(stopped).toEqual(['shell', 'agent', 'monitor', 'mcp', 'workflow']);
  expect(f.records.original.status).toBe('killed');
  bridge.close();
  expect(f.registry.update).toBe(original);
});

test('SDK stop notifications do not send a duplicate stop request, and stale runs cannot overwrite a resumed task', async () => {
  const f = fixture();
  const stopped: string[] = [];
  const bridge = createSdkTasks({ context: () => ({ taskRegistry: f.registry }), connection: { backgroundTasks: async () => true, stopTask: async id => { stopped.push(id); } }, helpers, onError: error => { throw error; } });
  await bridge.handle(started('shell', 'local_bash', 'run-2'));
  await bridge.handle(event({ subtype: 'task_notification', task_id: 'shell', run_id: 'run-1', status: 'completed', summary: 'Stale', output_file: '' }));
  expect(f.records.shell.status).toBe('running');
  await bridge.handle(event({ subtype: 'task_updated', task_id: 'shell', run_id: 'run-2', patch: { status: 'killed' } }));
  expect(stopped).toEqual([]);
  bridge.close();
});

test('shared registry observers keep other live SDK connections intact', async () => {
  const f = fixture();
  const original = f.registry.update;
  const stopped: string[] = [];
  const make = () => createSdkTasks({ context: () => ({ taskRegistry: f.registry }), connection: { backgroundTasks: async () => true, stopTask: async id => { stopped.push(id); } }, helpers, onError: error => { throw error; } });
  const a = make(), b = make();
  await a.handle(started('a'));
  await b.handle(started('b'));
  a.close();
  expect(f.registry.update).toBe(original);
  f.registry.update('b', task => ({ ...task, status: 'killed' }));
  await b.settled();
  expect(stopped).toEqual(['b']);
  b.close();
  expect(f.registry.update).toBe(original);
});

test('failed SDK stop is reported and does not leave the parent task falsely stopped', async () => {
  const f = fixture();
  const errors: Error[] = [];
  const bridge = createSdkTasks({ context: () => ({ taskRegistry: f.registry }), connection: { backgroundTasks: async () => true, stopTask: async () => { throw new Error('Rejected stop'); } }, helpers, onError: error => errors.push(error) });
  await bridge.handle(started('shell'));
  f.registry.update('shell', task => ({ ...task, status: 'killed' }));
  await bridge.settled();
  expect(f.records.shell.status).toBe('running');
  expect(errors[0].message).toContain('Rejected stop');
  bridge.close();
});

test('tool progress uses the original progress constructor', async () => {
  const f = fixture();
  const bridge = createSdkTasks({ context: () => ({ taskRegistry: f.registry }), connection: { backgroundTasks: async () => true, stopTask: async () => {} }, helpers, onError: error => { throw error; } });
  const progress = await bridge.handle({ type: 'tool_progress', uuid: 'progress', tool_use_id: 'call-1', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 5 } as unknown as SDKMessage);
  expect(progress).toEqual([{ type: 'progress', toolUseID: 'progress', parentToolUseID: 'call-1', data: { type: 'tool_heartbeat', toolName: 'Bash', elapsedTimeSeconds: 5 } }]);
  bridge.close();
});

test('the SDK child retry resolution clears the original retry display', async () => {
  const f = fixture();
  const bridge = createSdkTasks({ context: () => ({ taskRegistry: f.registry }), connection: { backgroundTasks: async () => true, stopTask: async () => {} }, helpers, onError: error => { throw error; } });
  const frame = { type: 'tool_progress', uuid: 'progress', tool_use_id: 'agent-call', tool_name: 'Agent', parent_tool_use_id: null, elapsed_time_seconds: 0, subagent_type: 'general-purpose' };
  await bridge.handle({ ...frame, subagent_retry: { agent_id: 'agent-1', attempt: 1, max_retries: 10, retry_delay_ms: 100, error_status: 529, error_category: 'overloaded' } } as unknown as SDKMessage);
  const resolved = await bridge.handle(frame as unknown as SDKMessage);
  expect(resolved[0].data).toEqual({ type: 'agent_api_retry', resolved: true, agentId: 'agent-1', agentType: 'general-purpose' });
  bridge.close();
});

test('background task snapshots replace live membership without inventing a terminal outcome', async () => {
  const f = fixture();
  const bridge = createSdkTasks({ context: () => ({ taskRegistry: f.registry }), connection: { backgroundTasks: async () => true, stopTask: async () => {} }, helpers, onError: error => { throw error; } });
  await bridge.handle(event({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'shell', task_type: 'local_bash', description: 'Fixture task', run_id: 'run-1' }] }));
  expect(f.records.shell.isBackgrounded).toBe(true);
  await bridge.handle(event({ subtype: 'background_tasks_changed', tasks: [] }));
  expect(f.records.shell.isBackgrounded).toBe(false);
  expect(f.records.shell.status).toBe('running');
  await bridge.handle(event({ subtype: 'task_notification', task_id: 'shell', status: 'failed', output_file: '', summary: 'Failure' }));
  expect(f.records.shell.status).toBe('failed');
  expect(f.records.shell.isBackgrounded).toBe(true);
  bridge.close();
});

test('unrepresentable SDK task types fail explicitly before altering the original registry', async () => {
  const f = fixture();
  const original = f.registry.update;
  const bridge = createSdkTasks({ context: () => ({ taskRegistry: f.registry }), connection: { backgroundTasks: async () => true, stopTask: async () => {} }, helpers, onError: error => { throw error; } });
  await expect(bridge.handle(started('unknown', 'future_task'))).rejects.toThrow('future_task');
  expect(f.records).toEqual({});
  expect(f.registry.update).toBe(original);
  bridge.close();
});

test('task labels use the actual SDK tool input and MCP catalog metadata', async () => {
  const f = fixture();
  const bridge = createSdkTasks({ context: () => ({ taskRegistry: f.registry, options: {
    tools: [{ name: 'mcp__fixture__fetch', mcpInfo: { serverName: 'fixture', toolName: 'fetch' } }],
  } }), connection: { backgroundTasks: async () => true, stopTask: async () => {} }, helpers, onError: error => { throw error; } });
  await bridge.handle({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'sleep 20', description: 'Wait for fixture' } },
    { type: 'tool_use', id: 'call-mcp', name: 'mcp__fixture__fetch', input: {} },
  ] } } as unknown as SDKMessage);
  await bridge.handle(started('shell'));
  expect(f.records.shell.command).toBe('sleep 20');
  await bridge.handle(event({ subtype: 'task_started', task_id: 'mcp', task_type: 'mcp_task', description: 'fixture/fetch', tool_use_id: 'call-mcp' }));
  expect(f.records.mcp).toMatchObject({ serverName: 'fixture', toolName: 'fetch' });
  bridge.close();
});
