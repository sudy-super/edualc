import { loadNativeModule } from './claude';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { convertSdkMessages } from './sdk-events';

type Task = Record<string, any> & { id: string; type: string; status: string };
export interface TaskRegistry {
  register(task: Task): void;
  update(id: string, update: (task: Task) => Task): void;
  updateTranscript(id: string, update: (transcript: any) => any): void;
  get(id: string): Task | undefined;
  all(): Record<string, Task>;
}
export interface SdkTaskContext {
  taskRegistry: TaskRegistry;
  options?: { mainLoopModel?: string; tools?: { name: string; mcpInfo?: { serverName: string; toolName: string } }[] };
}
interface Helpers {
  base(id: string, type: string, description: string, toolUseId?: string): Task;
  agent(options: Record<string, unknown>): Task;
  progress(options: Record<string, unknown>): Record<string, unknown>;
  convert?(message: SDKMessage): any[];
  append?(messages: any[], message: any): any[];
}
interface Owner { registry: TaskRegistry; stop(snapshot: Task): void; background(snapshot: Task): void }
const owners = new Map<string, Set<Owner>>();
const supportedTypes = new Set(['local_agent', 'local_bash', 'mcp_task', 'local_workflow', 'monitor_mcp', 'monitor_ws', 'auto_mode_scan']);

export function sdkTaskCanBackground(task: Task): boolean | undefined {
  if (![...owners.get(task.id) ?? []].some(owner => owner.registry.get(task.id) === task)) return undefined;
  // 親のキー操作では子エージェント内部のツールまで個別に切り離さない。
  return ['local_agent', 'local_bash'].includes(task.type) && task.status === 'running' &&
    task.isBackgrounded === false && typeof task.toolUseId === 'string' &&
    (task.type !== 'local_bash' || task.agentId === undefined) && task.parentAgentId === undefined;
}

export function sdkBackgroundTask(task: Task | undefined, registry: TaskRegistry): boolean {
  if (!task || sdkTaskCanBackground(task) !== true) return false;
  const owner = [...owners.get(task.id) ?? []].find(owner => owner.registry.get(task.id) === task && registry.get(task.id) === task);
  if (!owner) return false;
  owner.background(task);
  return true;
}

// 本家の全 registry が共通で使う Hn から、store 更新前の実値を受け取る。
export function sdkTaskUpdated(id: string, before: Task, after: Task): void {
  if (after.status !== 'killed' || before.status === 'killed') return;
  for (const owner of owners.get(id) ?? []) if (owner.registry.get(id) === before) owner.stop(before);
}

async function nativeHelpers(): Promise<Helpers> {
  const [base, messages, events, tasks] = await Promise.all([
    loadNativeModule('chunk-38433sah.js'),
    loadNativeModule('chunk-hqtnbrjd.js'),
    loadNativeModule('chunk-1svntv7y.js'),
    loadNativeModule('chunk-tnpfcesk.js'),
  ]);
  return { base: base.nS, agent: messages.aco, progress: messages.YIt,
    convert: message => convertSdkMessages(message, events.Yot), append: tasks.pws };
}

export function createSdkTasks(options: {
  context(): SdkTaskContext;
  connection: Pick<Query, 'stopTask' | 'backgroundTasks'>;
  onError(error: Error): void;
  helpers?: () => Promise<Helpers>;
}) {
  const owned = new Map<string, { registry: TaskRegistry; runId?: string; owner: Owner }>();
  const stops = new Map<string, Promise<void>>();
  const backgrounds = new Map<string, Promise<void>>();
  const invocations = new Map<string, { name: string; input: Record<string, unknown> }>();
  const agentRetries = new Map<string, { agentId: string; agentType?: string }>();
  let closed = false;
  let applying = 0;
  function background(snapshot: Task): void {
    if (closed || backgrounds.has(snapshot.id)) return;
    const operation = options.connection.backgroundTasks(snapshot.toolUseId).then(matched => {
      if (!matched) throw new Error('The SDK has no matching foreground task');
    }).catch(error => {
      options.onError(new Error(`SDK task ${snapshot.id} could not be backgrounded: ${error instanceof Error ? error.message : String(error)}`));
    }).finally(() => { if (backgrounds.get(snapshot.id) === operation) backgrounds.delete(snapshot.id); });
    backgrounds.set(snapshot.id, operation);
  }
  function update(registry: TaskRegistry, id: string, transform: (task: Task) => Task): void {
    applying++;
    try { registry.update(id, transform); } finally { applying--; }
  }
  function stop(id: string, snapshot: Task): void {
    if (closed || applying || stops.has(id)) return;
    const operation = options.connection.stopTask(id).catch(error => {
      const registry = owned.get(id)?.registry;
      if (!closed && registry) update(registry, id, task => task.status === 'killed' ? snapshot : task);
      options.onError(new Error(`SDK task ${id} could not be stopped: ${error instanceof Error ? error.message : String(error)}`));
    }).finally(() => { if (stops.get(id) === operation) stops.delete(id); });
    stops.set(id, operation);
  }
  function release(id: string): void {
    const entry = owned.get(id);
    if (!entry) return;
    owned.delete(id);
    const entries = owners.get(id);
    entries?.delete(entry.owner);
    if (entries?.size === 0) owners.delete(id);
  }
  async function start(event: any): Promise<void> {
    const registry = options.context().taskRegistry;
    if (!registry) throw new Error('The original task registry is unavailable');
    const previous = owned.get(event.task_id);
    if (previous?.runId && event.run_id && event.run_id < previous.runId) return;
    const existing = registry.get(event.task_id);
    const invocation = event.tool_use_id ? invocations.get(event.tool_use_id) : undefined;
    const mcp = invocation && options.context().options?.tools?.find(tool => tool.name === invocation.name)?.mcpInfo;
    if (existing && !previous) throw new Error(`SDK task ID collides with an original task: ${event.task_id}`);
    if (previous && (!event.run_id || !previous.runId || previous.runId === event.run_id)) {
      update(registry, event.task_id, task => ({ ...task, description: event.description,
        ...(event.tool_use_id !== undefined && { toolUseId: event.tool_use_id }),
        ...(event.is_backgrounded !== undefined && { isBackgrounded: event.is_backgrounded }),
        ...(event.subagent_type !== undefined && { agentType: event.subagent_type }),
        ...(event.prompt !== undefined && { prompt: event.prompt }),
        ...(invocation?.input.command !== undefined && { command: invocation.input.command }),
        ...(mcp && { serverName: mcp.serverName, toolName: mcp.toolName }),
      }));
      return;
    }
    const type = event.task_type;
    if (typeof type !== 'string' || !type) throw new Error(`SDK task ${event.task_id} has no task type`);
    if (!supportedTypes.has(type)) throw new Error(`SDK task type ${type} cannot be represented by the original task controls`);
    const helpers = await (options.helpers ?? nativeHelpers)();
    if (closed) return;
    const controller = new AbortController();
    let task = type === 'local_agent'
      ? helpers.agent({ agentId: event.task_id, parentAgentId: event.parent_task_id, ownerAgentId: event.parent_task_id,
          spawnDepth: event.spawn_depth, description: event.description, prompt: event.prompt ?? '',
          selectedAgent: { agentType: event.subagent_type ?? 'general-purpose' },
          toolUseId: event.tool_use_id, abortController: controller })
      : helpers.base(event.task_id, type, event.description, event.tool_use_id);
    task = { ...task, status: 'running', isBackgrounded: event.is_backgrounded ?? true,
      skipTranscript: event.skip_transcript ?? event.ambient, sdkRunId: event.run_id,
      ...(type === 'local_bash' && { command: invocation?.input.command ?? event.description, lastReportedTotalLines: 0, shellCommand: null }),
      ...(['local_bash', 'monitor_mcp', 'monitor_ws'].includes(type) && { agentId: event.parent_task_id }),
      ...(type === 'mcp_task' && { serverName: event.description, toolName: event.description, mcpTaskId: event.task_id,
        mcpStatus: 'working', abortController: controller, ...(mcp && { serverName: mcp.serverName, toolName: mcp.toolName }) }),
      ...(type === 'local_workflow' && { workflowName: event.workflow_name, prompt: event.prompt ?? '', script: event.prompt ?? '',
        spawnerAgentId: event.parent_task_id, workflowProgress: [], logs: [], agentControllers: new Map(), agentCount: 0, totalTokens: 0, totalToolCalls: 0, progressVersion: 0 }),
      ...(type === 'monitor_mcp' && { server: event.description, tool: event.description }),
      ...(type === 'auto_mode_scan' && { abortController: controller }),
    };
    if (previous) release(event.task_id);
    const owner: Owner = { registry, stop: snapshot => stop(event.task_id, snapshot), background };
    owned.set(event.task_id, { registry, runId: event.run_id, owner });
    let entries = owners.get(event.task_id);
    if (!entries) owners.set(event.task_id, entries = new Set());
    entries.add(owner);
    registry.register(task);
  }
  async function handle(message: SDKMessage): Promise<Record<string, unknown>[]> {
    if (closed) return [];
    if (message.type === 'assistant' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) if (block.type === 'tool_use' &&
        (['Bash', 'PowerShell', 'Agent', 'Workflow'].includes(block.name) || block.name.startsWith('mcp__'))) {
        invocations.set(block.id, { name: block.name, input: block.input as Record<string, unknown> });
      }
    }
    if ((message.type === 'assistant' || message.type === 'user') && message.parent_tool_use_id) {
      const entry = [...owned.entries()].find(([id, ownedTask]) => ownedTask.registry.get(id)?.toolUseId === message.parent_tool_use_id);
      if (entry) {
        const helpers = await (options.helpers ?? nativeHelpers)();
        if (closed) return [];
        if (message.type === 'assistant' && typeof message.message.model === 'string') update(entry[1].registry, entry[0], task => ({ ...task, model: message.message.model }));
        if (!helpers.convert || !helpers.append) throw new Error('The original task transcript converters are unavailable');
        for (const row of helpers.convert(message)) entry[1].registry.updateTranscript(entry[0], transcript => ({ ...transcript,
          messages: helpers.append!(transcript.messages, row) }));
      }
      return [];
    }
    if (message.type === 'tool_progress') {
      const helpers = await (options.helpers ?? nativeHelpers)();
      if (closed) return [];
      const previousRetry = agentRetries.get(message.tool_use_id);
      if (message.subagent_retry) agentRetries.set(message.tool_use_id, { agentId: message.subagent_retry.agent_id, agentType: message.subagent_type });
      else if (previousRetry) agentRetries.delete(message.tool_use_id);
      return [helpers.progress({ toolUseID: message.uuid, parentToolUseID: message.parent_tool_use_id ?? message.tool_use_id,
        data: message.subagent_retry ? { type: 'agent_api_retry', agentType: message.subagent_type,
          agentId: message.subagent_retry.agent_id, attempt: message.subagent_retry.attempt,
          maxRetries: message.subagent_retry.max_retries, retryDelayMs: message.subagent_retry.retry_delay_ms,
          errorStatus: message.subagent_retry.error_status, errorCategory: message.subagent_retry.error_category }
        : previousRetry ? { type: 'agent_api_retry', resolved: true, ...previousRetry }
        : { type: 'tool_heartbeat', toolName: message.tool_name, elapsedTimeSeconds: message.elapsed_time_seconds },
      })];
    }
    if (message.type !== 'system') return [];
    if (message.subtype === 'background_tasks_changed') {
      const live = new Set(message.tasks.map(task => task.task_id));
      for (const [id, entry] of owned) if (!live.has(id)) update(entry.registry, id, task => task.isBackgrounded === false || !['running', 'pending'].includes(task.status) ? task : {
        ...task, isBackgrounded: false, sdkWasBackgrounded: task.isBackgrounded,
      });
      for (const task of message.tasks) await start({ ...task, is_backgrounded: true });
      // 集合から外れたタスクは実行中の表示から外し、完了・失敗の区別は終端通知で反映する。
      return [];
    }
    if (message.subtype === 'task_started') { await start(message); return []; }
    if (!['task_updated', 'task_progress', 'task_notification'].includes(message.subtype)) return [];
    const event = message as any;
    const entry = owned.get(event.task_id);
    if (!entry || (entry.runId && event.run_id && event.run_id < entry.runId)) return [];
    if (message.subtype === 'task_updated') update(entry.registry, event.task_id, task => ({ ...task,
      ...(event.patch.status !== undefined && { status: event.patch.status }),
      ...(event.patch.description !== undefined && { description: event.patch.description }),
      ...(event.patch.end_time !== undefined && { endTime: event.patch.end_time }),
      ...(event.patch.total_paused_ms !== undefined && { totalPausedMs: event.patch.total_paused_ms }),
      ...(event.patch.error !== undefined && { error: event.patch.error }),
      ...(event.patch.is_backgrounded !== undefined && { isBackgrounded: event.patch.is_backgrounded }),
    }));
    if (message.subtype === 'task_progress') {
      update(entry.registry, event.task_id, task => ({ ...task, progress: {
        ...task.progress, tokenCount: event.usage.total_tokens, toolUseCount: event.usage.tool_uses,
        lastActivity: event.last_tool_name, ...(event.summary !== undefined && { summary: event.summary }),
      }, ...(event.summary !== undefined && { statusMessage: event.summary }) }));
      entry.registry.updateTranscript(event.task_id, transcript => ({ ...transcript,
        progress: { tokenCount: event.usage.total_tokens, toolUseCount: event.usage.tool_uses } }));
    }
    if (message.subtype === 'task_notification') update(entry.registry, event.task_id, task => ({ ...task,
      status: event.status === 'stopped' ? 'killed' : event.status, endTime: task.endTime ?? Date.now(),
      ...(task.sdkWasBackgrounded !== undefined && { isBackgrounded: task.sdkWasBackgrounded }),
      notified: true, outputFile: event.output_file || task.outputFile,
      terminal: { summary: event.summary, output_file: event.output_file, resource_links: event.resource_links,
        ...(event.usage && { usage: { totalTokens: event.usage.total_tokens, toolUses: event.usage.tool_uses, durationMs: event.usage.duration_ms } }) },
    }));
    return [];
  }
  return { handle, async settled() { await Promise.all([...stops.values(), ...backgrounds.values()]); }, close() {
    if (closed) return;
    closed = true;
    invocations.clear();
    agentRetries.clear();
    for (const [id, entry] of owned) {
      update(entry.registry, id, task => ['running', 'pending'].includes(task.status) ? { ...task,
        status: 'killed', notified: true, endTime: Date.now(), terminal: { summary: 'SDK connection closed' } } : task);
      release(id);
    }
  } };
}
