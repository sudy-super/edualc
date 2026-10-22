import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.EDUALC_APP_ROOT ?? resolve(import.meta.dir, '..');
const { sdkSystemMessage, sdkRetractions, convertSdkMessages, syncSdkModel } = await import(pathToFileURL(resolve(root, 'src/sdk-events.ts')).href);
const native = await import('file:///$bunfs/root/chunk-1svntv7y.js');
const messages = await import('file:///$bunfs/root/chunk-hqtnbrjd.js');
const uuid = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const wire = (index, text, extra = {}) => ({ type: 'assistant', uuid: uuid(index), session_id: 'fixture', parent_tool_use_id: null,
  message: { id: `msg_${index}`, role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text }], stop_reason: 'end_turn' }, ...extra });
const base = { type: 'system', original_model: 'claude-opus-5', fallback_model: 'claude-sonnet-5',
  session_id: 'fixture', trigger: 'refusal', direction: 'retry', scope: 'session',
  request_id: 'fixture-request', api_refusal_category: 'fixture-category', api_refusal_explanation: 'fixture-explanation',
  refused_user_message_uuid: uuid(1), retracted_message_uuids: [uuid(2)], saw_cyber_refusal: true,
  original_model_name: 'Opus 5', persisted_as_default: false, choice: 'cancelled' };
const frames = [
  { ...base, subtype: 'model_refusal_fallback', uuid: uuid(3), content: 'REFUSAL_SWITCH_573192' },
  { ...base, subtype: 'model_refusal_no_fallback', uuid: uuid(4), content: 'REFUSAL_STOP_651823' },
  { ...base, subtype: 'model_consent_fallback', uuid: uuid(5), content: 'CONSENT_SWITCH_823761' },
];
if (process.env.EDUALC_VERIFY_OUTPUT_UI === '1') {
  await import(pathToFileURL(resolve(root, 'bootstrap.mjs')).href);
  const { createSdkRun } = await import(pathToFileURL(resolve(root, 'src/sdk-run.ts')).href);
  const { appendFileSync } = await import('node:fs');
  const record = value => { if (process.env.EDUALC_OUTPUT_MODEL_FILE) appendFileSync(process.env.EDUALC_OUTPUT_MODEL_FILE, JSON.stringify(value) + '\n'); };
  let fixtureTurns = 0;
  const bridge = createSdkRun({ queryFactory: ({ prompt, options }) => { record({ type: 'init', model: options.model }); return Object.assign((async function* () {
    for await (const input of prompt) {
      if (++fixtureTurns > 1) {
        yield wire(20, 'SECOND_OUTPUT_TURN_816293');
        yield { type: 'result', subtype: 'success', is_error: false, result: 'SECOND_OUTPUT_TURN_816293', duration_api_ms: 0, modelUsage: {}, session_id: 'fixture', user_message_uuid: input.uuid };
        continue;
      }
      yield wire(2, 'RETRACTED_OUTPUT_719382');
      yield wire(6, 'REPLACEMENT_OUTPUT_619283', { supersedes: [uuid(2)] });
      yield frames[0];
      yield frames[1];
      yield frames[2];
      yield { type: 'tool_use_summary', summary: 'TOOL_SUMMARY_INTERNAL_918273', preceding_tool_use_ids: ['fixture-tool'], uuid: uuid(7), session_id: 'fixture' };
      yield { type: 'result', subtype: 'success', is_error: false, result: 'REPLACEMENT_OUTPUT_619283', duration_api_ms: 0, modelUsage: {}, session_id: 'fixture', user_message_uuid: input.uuid };
    }
  })(), { close() {}, async interrupt() {}, async setModel(model) { record({ type: 'setModel', model }); }, async setPermissionMode() {} }); } });
  const key = Symbol.for('edualc.sdk');
  globalThis[key] = Object.freeze({ ...globalThis[key], sdkRun: async function* (params) {
    const terminal = yield* bridge.run(params);
    setTimeout(async () => {
    await messages.Ou(); await messages._Fn();
    const transcript = await messages.UZ(messages.Cf(params.toolUseContext.session.id), { keepAllLeaves: true });
    const rows = messages.twr([...transcript.messages.values()]);
    record({ type: 'history', hasRetracted: rows.some(row => JSON.stringify(row).includes('RETRACTED_OUTPUT_719382')),
      hasReplacement: rows.some(row => JSON.stringify(row).includes('REPLACEMENT_OUTPUT_619283')),
      model: params.toolUseContext.getAppState().mainLoopModel });
    }, 300);
    return terminal;
  } });
  process.once('exit', () => bridge.close());
} else {
  for (const [index, name] of ['pxn', 'fxn', 'Jot'].entries()) {
    const actual = await sdkSystemMessage(frames[index]);
    const expected = native[name](frames[index]);
    assert.deepEqual({ ...actual, timestamp: '' }, { ...expected, timestamp: '' });
  }
  const selection = await import('file:///$bunfs/root/chunk-hdxpvbx1.js');
  const modelRules = await import('file:///$bunfs/root/chunk-2jyw98bz.js');
  await modelRules.Xht();
  const beforeOverride = selection.gc();
  let state = { mainLoopModel: 'claude-opus-5', mainLoopModelForSession: 'claude-opus-5', fastMode: true };
  const context = { options: { mainLoopModel: 'claude-opus-5', availabilityFallback: undefined },
    getAppState: () => state, setAppState: update => { state = update(state); } };
  assert.equal(await syncSdkModel({ ...frames[0], scope: 'local' }, context), undefined);
  assert.equal(state.mainLoopModel, 'claude-opus-5');
  assert.equal(await syncSdkModel({ ...frames[0], subtype: 'model_fallback' }, context), undefined);
  assert.equal(state.mainLoopModel, 'claude-opus-5', 'Availability switches keep the configured primary model');
  const fast = modelRules.$o() ? modelRules.LI('claude-sonnet-5', true) : true;
  assert.equal(await syncSdkModel(frames[0], context), 'claude-sonnet-5');
  assert.equal(state.mainLoopModel, 'claude-sonnet-5');
  assert.equal(state.mainLoopModelForSession, null);
  assert.equal(state.fastMode, fast);
  assert.equal(context.options.mainLoopModel, 'claude-sonnet-5');
  assert.equal(selection.gc(), 'claude-sonnet-5');
  assert.equal(selection.o2().previousAppStateModel, 'claude-opus-5');
  assert.equal(selection.o2().previousModelForSession, 'claude-opus-5');
  assert.equal(await syncSdkModel({ ...frames[0], direction: 'revert', fallback_model: 'claude-opus-5' }, context), 'claude-opus-5');
  assert.equal(selection.o2(), undefined);
  assert.equal(state.mainLoopModel, 'claude-opus-5');
  assert.equal(await syncSdkModel({ ...frames[2], fallback_model: 'claude-opus-5' }, context), 'claude-opus-5');
  assert.equal(state.mainLoopModel, 'claude-opus-5');
  assert.equal(selection.gc(), 'claude-opus-5');
  selection.aye(); selection.Bp(beforeOverride);
  const summary = await sdkSystemMessage({ type: 'tool_use_summary', summary: 'summary text', preceding_tool_use_ids: ['fixture-tool'] });
  assert.equal(summary.summary, 'summary text');
  assert.deepEqual(summary.precedingToolUseIds, ['fixture-tool']);
  assert.equal(summary.type, 'tool_use_summary');
  let displayed = false;
  messages.udt(summary, { onMessage() { displayed = true; } });
  assert.equal(displayed, false, 'The original event consumer intentionally keeps tool summaries out of the transcript');
  const old = native.Yot([wire(2, 'discard me')])[0];
  const replacement = convertSdkMessages(wire(6, 'keep me', { supersedes: [uuid(2)] }), native.Yot)[0];
  assert.deepEqual(replacement.supersedesUuids, [uuid(2)]);
  const retired = await sdkRetractions(wire(6, 'keep me', { supersedes: [uuid(2), uuid(6)] }), [old, replacement, old]);
  assert.equal(retired.length, 1);
  assert.equal(retired[0].type, 'tombstone');
  assert.equal(retired[0].message, old);
  assert.equal((await sdkRetractions(frames[0], [old]))[0].message, old);
  assert.deepEqual(await sdkRetractions(wire(6, 'keep me', { supersedes: ['missing'] }), [old]), []);
  assert.deepEqual(await sdkRetractions(wire(6, 'keep me', { supersedes: [uuid(6)] }), [replacement]), []);
  const split = { ...old, uuid: uuid(20), message: { ...old.message, content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }] } };
  const aliases = messages.cf([split]);
  const removedSplit = await sdkRetractions(wire(21, 'replacement', { supersedes: aliases.map(row => row.uuid) }), [split]);
  assert.equal(removedSplit[0].message, split);

  const tool = native.Yot([{ ...wire(8, ''), message: { ...wire(8, '').message, content: [{ type: 'tool_use', id: 'old-tool', name: 'Read', input: {} }] } }])[0];
  const retiredTool = await sdkRetractions(wire(9, 'replacement', { supersedes: [uuid(8)] }), [tool]);
  assert.deepEqual(retiredTool[1], { type: 'set_in_progress_tool_use_ids', op: { action: 'remove', ids: ['old-tool'] } });
  const { createServer } = await import('node:http');
  const { mkdtemp, rm, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const fixtureHome = await mkdtemp(join(tmpdir(), 'edualc-real-summary-'));
  let issued = false, requestCount = 0, fixturePhase = 'summary';
  const file = join(fixtureHome, 'write.txt');
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = body ? JSON.parse(body) : {};
    if (!request.url.split('?')[0].endsWith('/messages')) { response.setHeader('content-type', 'application/json'); response.end('{}'); return; }
    requestCount++;
    const tool = fixturePhase === 'summary' && !issued; issued = true;
    const content = tool ? { type: 'tool_use', id: 'summary_write', name: 'Write', input: { file_path: file, content: 'SUMMARY_WRITE_OK' } } : { type: 'text', text: 'REAL_SDK_SUMMARY_573192' };
    const stop_reason = fixturePhase === 'refusal' ? 'refusal' : tool ? 'tool_use' : 'end_turn';
    const message = { id: `msg_summary_${requestCount}`, type: 'message', role: 'assistant', model: input.model, content: [content], stop_reason, usage: { input_tokens: 20, output_tokens: 5 } };
    if (!input.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(message)); return; }
    const frames = [
      ['message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { ...content, input: {} } : { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } : { type: 'text_delta', text: content.text } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason, ...(fixturePhase === 'refusal' ? { stop_details: { type: 'refusal', category: 'fixture_refusal', explanation: 'local fixture' } } : {}) }, usage: { output_tokens: 5 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    response.setHeader('content-type', 'text/event-stream');
    response.end(frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const sdk = await import(pathToFileURL(resolve(root, 'src/sdk.ts')).href);
  const environment = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
  Object.assign(environment, { PATH: process.env.PATH, HOME: fixtureHome, TMPDIR: fixtureHome,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: 'sk-local-summary-fixture',
    CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', NO_PROXY: '*' });
  const connection = sdk.query({ prompt: 'Write the fixture file.', options: {
    cwd: fixtureHome, pathToClaudeCodeExecutable: sdk.sdkExecutable(), env: environment,
    settingSources: [], strictMcpConfig: true, mcpServers: {}, settings: { disableAllHooks: true },
    tools: ['Write'], model: 'claude-sonnet-5', permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    persistSession: false, systemPrompt: 'Use Write when asked, then answer briefly.',
  } });
  const timeout = setTimeout(() => connection.close(), 30000);
  try {
    const emitted = [];
    for await (const event of connection) if (event.type === 'tool_use_summary') emitted.push(event);
    assert.equal(await readFile(file, 'utf8'), 'SUMMARY_WRITE_OK');
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].summary, 'REAL_SDK_SUMMARY_573192');
    assert.deepEqual(emitted[0].preceding_tool_use_ids, ['summary_write']);
    const converted = await sdkSystemMessage(emitted[0]);
    assert.deepEqual(converted.precedingToolUseIds, ['summary_write']);
    assert.equal(converted.summary, 'REAL_SDK_SUMMARY_573192');
    assert.equal(requestCount, 3);
    fixturePhase = 'refusal';
    const refused = sdk.query({ prompt: 'Benign refusal fixture.', options: {
      cwd: fixtureHome, pathToClaudeCodeExecutable: sdk.sdkExecutable(),
      env: { ...environment, _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1', CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL: '1' },
      settingSources: [], strictMcpConfig: true, mcpServers: {}, settings: { disableAllHooks: true },
      tools: [], model: 'claude-opus-5', persistSession: false, systemPrompt: 'Answer briefly.',
    } });
    const refusalEvents = [];
    try {
      try { for await (const event of refused) if (event.type === 'system' && event.subtype === 'model_refusal_no_fallback') refusalEvents.push(event); }
      catch (error) { assert.equal(refusalEvents.length, 1, `The SDK must emit the refusal outcome before its error: ${error}`); }
      assert.equal(refusalEvents.length, 1);
      const convertedRefusal = await sdkSystemMessage(refusalEvents[0]);
      assert.equal(convertedRefusal.subtype, 'model_refusal_no_fallback');
      assert.equal(convertedRefusal.originalModel, 'claude-opus-5');
      assert.equal(convertedRefusal.apiRefusalCategory, 'fixture_refusal');
      assert.equal(convertedRefusal.apiRefusalExplanation, 'local fixture');
    } finally { refused.close(); }

  } finally {
    clearTimeout(timeout); connection.close(); server.closeAllConnections();
    await new Promise(done => server.close(done)); await rm(fixtureHome, { recursive: true, force: true });
  }
  console.log('PASS: original refusal/consent converters, original tool-summary consumer, supersedes tombstones and in-flight tool removal; actual SDK emits and converts local Write summary and refusal exhaustion');
  process.exit(0);
}
