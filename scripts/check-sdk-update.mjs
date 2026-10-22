#!/usr/bin/env node
// Candidate SDKs run only against a local API, with disposable settings and history.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

delete process.env.BUN_OPTIONS;
const embeddedBun = typeof Bun !== 'undefined';
const [sdkDirectory, executable] = process.argv.slice(2);
if (!sdkDirectory || !executable) {
  console.error('Usage: node scripts/check-sdk-update.mjs SDK_PACKAGE_DIRECTORY CLAUDE_CODE_EXECUTABLE');
  process.exit(2);
}
const temporary = await mkdtemp(join(tmpdir(), 'edualc-sdk-check-'));
const config = join(temporary, '.claude');
await mkdir(config);
const outputFile = join(temporary, 'approved.txt');
const checks = [], events = [], requests = [];
let phase = 'conversation', approvalCount = 0, toolSent = false, connection;
const controller = new AbortController();
const server = createServer(async (request, response) => {
  try {
    if (request.method === 'HEAD') { response.end(); return; }
    let raw = '';
    for await (const part of request) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    if (request.url.includes('count_tokens')) { response.setHeader('content-type', 'application/json'); response.end('{"input_tokens":100}'); return; }
    if (!request.url.split('?')[0].endsWith('/messages')) { response.setHeader('content-type', 'application/json'); response.end('{}'); return; }
    requests.push({ phase, model: body.model });
    if (phase === 'probe-auth') { response.statusCode = 401; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'fixture key rejected' } })); return; }
    const tool = phase === 'approval' && !toolSent;
    if (tool) toolSent = true;
    const text = phase === 'title' ? '{"title":"SDK_UPDATE_TITLE_OK"}' : phase === 'compact' ? 'The user asked to remember SDK_UPDATE_MEMORY_1769. Preserve that code.' : phase === 'side' ? 'SDK_UPDATE_SIDE_OK' : 'SDK_UPDATE_REPLY_OK';
    const content = tool ? [{ type: 'tool_use', id: 'tool_update_approval', name: 'Write', input: { file_path: outputFile, content: 'SDK_UPDATE_WRITE_OK' } }] : [{ type: 'text', text }];
    const id = `msg_update_${requests.length}`, stop_reason = tool ? 'tool_use' : 'end_turn';
    const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    if (!body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content, stop_reason, usage })); return; }
    const frames = [
      ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { ...content[0], input: {} } : { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(content[0].input) } : { type: 'text_delta', text } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    response.setHeader('content-type', 'text/event-stream');
    response.end(frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
  } catch (error) { response.statusCode = 500; response.end(String(error)); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const timer = setTimeout(() => { console.error('SDK compatibility check timed out'); controller.abort(); connection?.close(); process.exit(1); }, 90000);
let queued = [], wakeInput, waitResult;
async function* inputs() {
  while (!controller.signal.aborted) {
    if (!queued.length) await new Promise(done => { wakeInput = done; });
    if (queued.length) yield queued.shift();
  }
}
async function turn(text, clientComposed = true) {
  const result = new Promise((resolveResult, reject) => { waitResult = { resolve: resolveResult, reject }; });
  const uuid = randomUUID();
  queued.push({ type: 'user', uuid, parent_tool_use_id: null, message: { role: 'user', content: text }, ...(clientComposed ? { client_composed: true } : {}) });
  wakeInput?.(); wakeInput = undefined;
  const message = await result;
  assert.equal(message.subtype, 'success', JSON.stringify(message));
  assert((message.user_message_uuids ?? [message.user_message_uuid]).includes(uuid), 'SDK result did not identify the submitted prompt');
  return message;
}
let pump;
try {
  const sdk = embeddedBun
    ? await import(new URL('../src/sdk.ts', import.meta.url).href)
    : await import(pathToFileURL(join(resolve(sdkDirectory), 'sdk.mjs')).href);
  if (embeddedBun) {
    assert.equal(await realpath(process.env.EDUALC_SDK_PACKAGE), await realpath(sdkDirectory));
    const manifest = JSON.parse(await readFile(join(resolve(sdkDirectory), 'package.json'), 'utf8'));
    assert.equal(sdk.sdkVersion, manifest.version);
    assert.equal(await realpath(sdk.sdkExecutable()), await realpath(executable));
    assert.equal(sdk.query, (await import(pathToFileURL(join(await realpath(sdkDirectory), 'sdk.mjs')).href)).query);
    checks.push('TUI Bun runtime and SDK loader');
  }
  const environment = {
    PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary, SHELL: '/bin/sh',
    CLAUDE_CONFIG_DIR: config, CLAUDE_SECURESTORAGE_CONFIG_DIR: config,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    ANTHROPIC_API_KEY: 'sk-edualc-local-update-fixture',
    ANTHROPIC_MODEL: 'claude-sonnet-5', ANTHROPIC_SMALL_FAST_MODEL: 'claude-sonnet-5',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*',
  };
  // SDK merges env overrides onto its parent environment; explicitly remove inherited credentials.
  for (const name of Object.keys(process.env)) if (!(name in environment)) environment[name] = undefined;
  connection = sdk.query({ prompt: inputs(), options: {
    pathToClaudeCodeExecutable: resolve(executable), cwd: temporary,
    env: environment, settingSources: [], strictMcpConfig: true, mcpServers: {},
    settings: { disableAllHooks: true }, tools: ['Write'], permissionMode: 'default', allowDangerouslySkipPermissions: true,
    persistSession: true, includePartialMessages: true, model: 'claude-sonnet-5',
    perTaskStopAffordance: true,
    systemPrompt: 'Answer briefly. Use Write only when requested.', abortController: controller,
    canUseTool: async (name, input) => {
      assert.equal(name, 'Write'); assert.equal(input.file_path, outputFile);
      approvalCount++;
      return { behavior: 'allow', updatedInput: input };
    },
  } });
  pump = (async () => {
    try {
      for await (const message of connection) {
        events.push(message);
        if (message.type === 'result') { const waiter = waitResult; waitResult = undefined; waiter?.resolve(message); }
      }
      waitResult?.reject(new Error('SDK stream ended before a result'));
    } catch (error) { waitResult?.reject(error); throw error; }
  })();
  // Keep an early child exit from becoming an unhandled rejection while initialization is pending.
  pump.catch(() => {});
  await connection.initializationResult();
  assert.equal((await turn('Remember SDK_UPDATE_MEMORY_1769')).result, 'SDK_UPDATE_REPLY_OK');
  checks.push('conversation');
  const context = await connection.getContextUsage();
  for (const name of ['categories', 'gridRows', 'memoryFiles', 'mcpTools', 'agents']) assert(Array.isArray(context[name]), `Missing SDK context ${name}`);
  if (context.skills !== undefined) assert(Array.isArray(context.skills.skillFrontmatter), 'Missing SDK skill context');
  assert(Number.isFinite(context.totalTokens) && Number.isFinite(context.maxTokens));
  assert.equal(context.model, 'claude-sonnet-5');
  checks.push('getContextUsage with native rendering data');
  await connection.setPermissionMode('bypassPermissions');
  await connection.setPermissionMode('default');
  checks.push('native-authorized permission mode switching');
  assert.equal(typeof connection.stopTask, 'function');
  assert.equal(typeof connection.toggleMcpServer, 'function');
  assert.equal(typeof connection.reconnectMcpServer, 'function');
  assert.deepEqual(await connection.mcpServerStatus(), []);
  await connection.applyFlagSettings({ fastMode: false, autoCompactWindow: null });
  checks.push('SDK task stop and live session settings controls');
  const beforeCommands = requests.length;
  await turn('/goal clear', false);
  assert.equal(requests.length, beforeCommands);
  checks.push('goal clear without generation');
  phase = 'approval';
  await turn(`Write SDK_UPDATE_WRITE_OK to ${outputFile}`);
  assert.equal(approvalCount, 1);
  assert.equal(await readFile(outputFile, 'utf8'), 'SDK_UPDATE_WRITE_OK');
  checks.push('canUseTool and Write');
  phase = 'title';
  assert.equal(typeof connection.generateSessionTitle, 'function');
  assert.equal(await connection.generateSessionTitle('Remember the SDK compatibility verification code', { persist: false }), 'SDK_UPDATE_TITLE_OK');
  checks.push('generateSessionTitle');
  phase = 'side';
  assert.equal(typeof connection.askSideQuestion, 'function');
  assert.equal((await connection.askSideQuestion('What was the compatibility code?', {}))?.response, 'SDK_UPDATE_SIDE_OK');
  checks.push('askSideQuestion');
  phase = 'compact';
  await turn('/compact Keep SDK_UPDATE_MEMORY_1769', false);
  assert(events.some(message => message.type === 'system' && message.subtype === 'compact_boundary'));
  checks.push('compact boundary');
  const projects = join(config, 'projects');
  const historyFiles = [];
  async function findHistory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await findHistory(path);
      else if (entry.name.endsWith('.jsonl')) historyFiles.push(path);
    }
  }
  await findHistory(projects);
  const history = (await Promise.all(historyFiles.map(file => readFile(file, 'utf8')))).join('\n');
  assert(history.includes('SDK_UPDATE_MEMORY_1769'));
  assert(history.includes('compact_boundary'));
  checks.push('persisted conversation and compact history');
  phase = 'probe-auth';
  const probe = sdk.query({ prompt: 'Hi', options: {
    pathToClaudeCodeExecutable: resolve(executable), cwd: temporary,
    env: { ...environment, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1', CLAUDE_CODE_MAX_RETRIES: '0' },
    model: 'claude-sonnet-5', systemPrompt: [], verbatimPrompts: true, tools: [],
    settingSources: [], strictMcpConfig: true, mcpServers: {}, settings: { disableAllHooks: true },
    maxTurns: 1, persistSession: false, abortController: controller,
  } });
  try {
    let rejectedStatus;
    try {
      for await (const event of probe) if (event.type === 'assistant' || event.type === 'result') rejectedStatus = event.api_error_status ?? rejectedStatus;
    } catch (error) { if (rejectedStatus !== 401) throw error; }
    assert.equal(rejectedStatus, 401);
    checks.push('model probe API status preservation');
  } finally { probe.close(); }
  console.log(JSON.stringify({ pass: true, checks, requests: requests.length }));
} catch (error) {
  console.error(JSON.stringify({ pass: false, checks, error: error.stack ?? String(error) }));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  controller.abort(); wakeInput?.(); connection?.close();
  await pump?.catch(() => {});
  server.closeAllConnections(); await new Promise(done => server.close(done));
  await rm(temporary, { recursive: true, force: true });
}
if (embeddedBun) process.exit(process.exitCode ?? 0);
