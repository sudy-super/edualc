import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = process.env.EDUALC_APP_ROOT ?? resolve(import.meta.dir, '..');
const { claudeRoot } = await import(pathToFileURL(resolve(root, 'src/claude.ts')).href);
const { createSdkTasks, sdkTaskUpdated, sdkTaskCanBackground, sdkBackgroundTask } = await import(pathToFileURL(resolve(root, 'src/sdk-tasks.ts')).href);
globalThis[Symbol.for('edualc.sdk')] = { ...globalThis[Symbol.for('edualc.sdk')], sdkTaskUpdated, sdkTaskCanBackground, sdkBackgroundTask };
const { dh } = await import(new URL('chunk-tnpfcesk.js', claudeRoot).href);
const { rrt } = await import(new URL('chunk-nmzacz4p.js', claudeRoot).href);
let state = { tasks: {}, transcripts: {}, runningSubagents: 0 };
const setState = change => { state = change(state); };
const registry = dh(() => state, setState);
const uiRegistry = dh(() => state, setState);
assert.notEqual(registry, uiRegistry);
const originalUpdate = registry.update;
const stopped = [];
const bridge = createSdkTasks({ context: () => ({ taskRegistry: registry, options: { mainLoopModel: 'claude-sonnet-4-5' } }),
  connection: { stopTask: async id => { stopped.push(id); }, backgroundTasks: async () => true }, onError: error => { throw error; } });
for (const [id, type] of [['b11111111', 'local_bash'], ['a11111111', 'local_agent'], ['k11111111', 'mcp_task'], ['w11111111', 'local_workflow'], ['m11111111', 'monitor_mcp'], ['s11111111', 'monitor_ws']]) {
  await bridge.handle({ type: 'system', subtype: 'task_started', task_id: id, task_type: type, description: `Fixture ${type}`,
    is_backgrounded: true, tool_use_id: `tool-${id}`, uuid: crypto.randomUUID(), session_id: 'fixture' });
  assert.equal(registry.get(id).status, 'running');
  if (type === 'local_agent') {
    assert.equal(registry.get(id).model, undefined);
    await bridge.handle({ type: 'assistant', parent_tool_use_id: `tool-${id}`, session_id: 'fixture', uuid: crypto.randomUUID(),
      message: { id: 'msg-child', role: 'assistant', model: 'claude-child-fixture', content: [{ type: 'text', text: 'CHILD_TASK_TRANSCRIPT_843291' }] } });
    assert.equal(registry.get(id).model, 'claude-child-fixture');
    assert.equal(registry.getTranscript(id).messages[0].message.content[0].text, 'CHILD_TASK_TRANSCRIPT_843291');
  }
  const taskType = rrt(type);
  assert.ok(taskType?.kill, `Native stop handler missing: ${type}`);
  await taskType.kill(id, uiRegistry, setState);
  await bridge.settled();
  assert.equal(registry.get(id).status, 'killed');
  assert.ok(stopped.includes(id), `Native ${type} stop did not reach SDK control`);
}
registry.register({ id: 'b22222222', type: 'local_bash', status: 'running', description: 'Original task' });
await rrt('local_bash').kill('b22222222', registry, setState);
assert.ok(!stopped.includes('b22222222'));
bridge.close();
assert.equal(registry.update, originalUpdate);
console.log('PASS two original registries sharing one store connect six native task stop handlers to SDK stop; original tasks remain independent');
process.exit(0);
