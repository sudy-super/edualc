import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = process.env.EDUALC_APP_ROOT ?? resolve(import.meta.dir, '..');
const { claudeRoot } = await import(pathToFileURL(resolve(root, 'src/claude.ts')).href);
const { eCt } = await import(new URL('chunk-gwtdnfbz.js', claudeRoot).href);
const urlDialogs = [];
let urlWaitingClosed = false;
const urlHandler = eCt({}, { serverName: 'fixture', requestDialog: async (descriptor, payload, options) => {
  urlDialogs.push({ kind: descriptor.kind, payload });
  if (descriptor.kind === 'mcp_elicitation') return { action: 'accept' };
  await new Promise(done => options.signal.addEventListener('abort', done, { once: true }));
  urlWaitingClosed = true;
  return 'dismiss';
}, runElicitationHooks: async () => undefined, runElicitationResultHooks: async (_server, result) => result });
assert.deepEqual(await urlHandler.handle({ params: { mode: 'url', message: 'Fixture URL input',
  url: 'http://127.0.0.1/', elicitationId: 'url-fixture-1' } }, { signal: new AbortController().signal }), { action: 'accept' });
assert.deepEqual(urlDialogs.map(dialog => dialog.kind), ['mcp_elicitation', 'mcp_elicitation_waiting']);
assert.equal(urlDialogs[0].payload.userConfirmsCompletion, undefined);
assert.equal(urlHandler.complete('url-fixture-1'), true);
await new Promise(done => setTimeout(done, 0));
assert.equal(urlWaitingClosed, true);
const { toInternal } = await import(pathToFileURL(resolve(root, 'src/sdk-run.ts')).href);
const { sdkSubagentProgress, sdkSystemMessage } = await import(pathToFileURL(resolve(root, 'src/sdk-events.ts')).href);
const fallback = await toInternal({ type: 'system', subtype: 'model_fallback', trigger: 'model_not_found',
  original_model: 'claude-opus-5', fallback_model: 'claude-sonnet-5', content: 'FIXTURE_MODEL_FALLBACK_82179',
  uuid: '00000000-0000-4000-8000-000000000012', session_id: 'fixture' });
assert.equal(fallback.type, 'system');
assert.equal(fallback.subtype, 'model_fallback');
assert.equal(fallback.originalModel, 'claude-opus-5');
assert.equal(fallback.fallbackModel, 'claude-sonnet-5');
assert.equal(fallback.content, 'FIXTURE_MODEL_FALLBACK_82179');
assert.equal(fallback.level, 'warning');
assert.equal(fallback.uuid, '00000000-0000-4000-8000-000000000012');
assert.equal(await sdkSystemMessage({ type: 'system', subtype: 'init' }), undefined);
const retry = await toInternal({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10,
  retry_delay_ms: 5000, error_status: 529, error: 'overloaded',
  no_response: { waited_ms: 1000, retry_wait_ms: 5000 },
  uuid: '00000000-0000-4000-8000-000000000013', session_id: 'fixture' });
assert.equal(retry.subtype, 'api_error');
assert.equal(retry.retryAttempt, 2);
assert.equal(retry.maxRetries, 10);
assert.equal(retry.retryInMs, 5000);
assert.equal(retry.error.status, 529);
assert.equal(retry.error.message, 'overloaded');
assert.equal(retry.error.formatted, 'overloaded');
assert.equal(retry.error.requestId, undefined);
assert.equal(retry.error.connection, null);
assert.deepEqual(retry.error.noResponse, { waitedMs: 1000, retryWaitMs: 5000 });
assert.equal(retry.uuid, '00000000-0000-4000-8000-000000000013');
const connectionRetry = await toInternal({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10,
  retry_delay_ms: 500, error_status: null, error: 'unknown', session_id: 'fixture' });
assert.equal(connectionRetry.error.status, undefined);
assert.equal(connectionRetry.error.noResponse, null);
assert.equal(typeof connectionRetry.uuid, 'string');

const user = { type: 'user', session_id: 'fixture', parent_tool_use_id: null, uuid: '00000000-0000-4000-8000-000000000001', message: { role: 'user', content: [{ type: 'text', text: 'SKILL_INTERNAL_BODY' }] } };
assert.equal((await toInternal({ ...user, isSynthetic: true })).isMeta, true);
assert.equal((await toInternal(user)).isMeta, undefined);
const replay = await toInternal({ ...user, isReplay: true });
assert.equal(replay.isReplay, true);
assert.equal(replay.isVisibleInTranscriptOnly, true);
const result = { type: 'user', session_id: 'fixture', parent_tool_use_id: 'agent-call', tool_use_result: { file: { filePath: '/fixture', numLines: 1, content: 'contents' } }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-fixture', content: 'contents' }] } };
const progress = await sdkSubagentProgress(result);
assert.equal(progress.length, 1);
assert.deepEqual(progress[0].data.message.toolUseResult, result.tool_use_result);
assert.equal(progress[0].parentToolUseID, 'agent-call');
const { createSdkAuxiliary } = await import(pathToFileURL(resolve(root, 'src/sdk-auxiliary.ts')).href);
let closed = false;
const controls = createSdkAuxiliary({
  getConnection: async () => { throw new Error('Unexpected main connection'); },
  queryFactory: () => ({
    generateSessionTitle: async () => { throw new Error('fixture title failure'); },
    askSideQuestion: async () => null,
    close() { closed = true; },
  }),
});
assert.equal(await controls.generateTitle('A deliberately failed fixture title'), null);
assert.equal(closed, true);
console.log('PASS: native converters retain synthetic, command replay, and child tool metadata; title failure uses native logging and returns null');
process.exit(0);
