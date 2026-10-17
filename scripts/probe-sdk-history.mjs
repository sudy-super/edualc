import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

delete process.env.BUN_OPTIONS;
const local = process.env.CLAUDE_SDK_HISTORY_LOCAL === '1';
if (!local && process.env.CLAUDE_LITELLM_MODE !== 'proxy') throw new Error('The history probe requires the existing LiteLLM wrapper.');
const requests = [];
let server;
if (local) {
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method === 'HEAD') return new Response(null);
    const body = await request.json();
    if (new URL(request.url).pathname.includes('count_tokens')) return Response.json({ input_tokens: 10 });
    if (new URL(request.url).pathname !== '/v1/messages') return Response.json({});
    requests.push(body);
    const id = `msg_fixture_${requests.length}`;
    const text = requests.length === 1 ? 'ACK' : 'PROBE_RESUMED';
    const frames = [
      ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    return new Response(frames.map(([event, value]) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
}
const root = new URL('../', import.meta.url);
const artifacts = new URL('test/artifacts/', root);
const cwd = new URL('test/artifacts/sdk-history-work/', root).pathname;
mkdirSync(cwd, { recursive: true });
const sdk = await import(new URL('node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', root).href);
const parentId = randomUUID();
const nonce = `memory-${randomUUID()}`;
const marker = `QUESTION_${randomUUID().replaceAll('-', '')}`;
const evidence = { parentId, checks: [], events: [] };
const common = {
  pathToClaudeCodeExecutable: process.execPath,
  cwd, model: 'claude-opus-5', settingSources: [], tools: [],
  systemPrompt: 'Answer the requested exact text. Do not use tools.',
  env: { ...process.env, BUN_OPTIONS: undefined },
  canUseTool: async () => ({ behavior: 'deny', message: 'This probe needs no tools.' }),
  maxTurns: 1,
};
if (local) Object.assign(common.env, {
  ANTHROPIC_BASE_URL: server.url.origin, ANTHROPIC_API_KEY: 'sk-sdk-history-fixture', ANTHROPIC_AUTH_TOKEN: undefined,
  ANTHROPIC_CUSTOM_HEADERS: undefined, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*',
});

async function turn(prompt, options) {
  const controller = new AbortController();
  const connection = sdk.query({ prompt, options: { ...common, ...options, abortController: controller } });
  const timer = setTimeout(() => controller.abort(), 120000);
  let result, assistant;
  try {
    for await (const message of connection) {
      evidence.events.push({ sessionId: message.session_id, type: message.type, subtype: message.subtype });
      if (message.type === 'assistant') assistant = message;
      if (message.type === 'result') {
        result = message;
        if (message.is_error) throw new Error(JSON.stringify(message.errors ?? message.result));
      }
    }
    if (!result || !assistant) throw new Error('SDK did not return an assistant and a result');
    return { result, assistant };
  } finally { clearTimeout(timer); connection.close(); }
}

function locateSession(id) {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
  const candidates = readdirSync(projects, { recursive: true }).filter(path => path.endsWith(`${id}.jsonl`));
  if (candidates.length !== 1) throw new Error(`Expected one probe transcript, found ${candidates.length}`);
  return join(projects, candidates[0]);
}

try {
  const first = await turn(`The project codename is ${nonce}. Reply only ACK.`, { sessionId: parentId });
  const source = locateSession(parentId);
  const records = readFileSync(source, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const lastAssistant = records.findLast(record => record.type === 'assistant');
  const lastUser = records.findLast(record => record.type === 'user');
  if (!lastAssistant || !lastUser) throw new Error('Persisted fixture lacks the first turn');
  const prompt = `Ticket ${marker}: What is the project codename? Reply only with the codename.`;
  records.push({ ...lastUser, uuid: randomUUID(), parentUuid: lastAssistant.uuid, timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } });
  const fixture = new URL('sdk-history-parent.jsonl', artifacts);
  writeFileSync(fixture, records.map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 });
  const before = createHash('sha256').update(readFileSync(fixture)).digest('hex');
  const childId = randomUUID();
  const resumed = await turn(prompt, {
    resume: fixture.pathname, forkSession: true, sessionId: childId,
    resumeSessionAt: lastAssistant.uuid, persistSession: false,
  });
  const after = createHash('sha256').update(readFileSync(fixture)).digest('hex');
  let matched;
  if (local) {
    const sent = requests.at(-1).messages;
    const textOf = message => typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    const markerTurns = sent.filter(message => message.role === 'user' && textOf(message).includes(marker)).length;
    const historyPresent = sent.some(message => message.role === 'user' && textOf(message).includes(nonce));
    evidence.checks.push({ kind: 'captured_api_history', requestCount: requests.length, markerTurns, historyPresent, roles: sent.map(message => message.role) });
    matched = markerTurns === 1 && historyPresent;
  } else matched = resumed.result.result.trim() === nonce;
  evidence.checks.push({ kind: 'fork_truncation', childId, parentUnchanged: before === after, result: resumed.result.result, expected: local ? '(captured API history)' : nonce, matched, cutoff: lastAssistant.uuid });
  evidence.usage = { parent: first.result.modelUsage, fork: resumed.result.modelUsage, parentApiMs: first.result.duration_api_ms, forkApiMs: resumed.result.duration_api_ms, storedCostState: records.findLast(record => record.type === 'cost-state') };
  if (before !== after || !matched) throw new Error('Forked history was duplicated, lost, or changed the parent fixture');
  evidence.firstAssistantUuid = first.assistant.uuid;
  evidence.parentFixture = fixture.pathname;
  evidence.passed = true;
  console.log('PASS: fork+resumeSessionAt preserves history, excludes the pending prompt and leaves the parent unchanged');
} catch (error) {
  evidence.passed = false;
  evidence.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  server?.stop(true);
  writeFileSync(new URL(local ? 'sdk-history-probe-local.json' : 'sdk-history-probe.json', artifacts), JSON.stringify(evidence, null, 2));
}
process.exit(process.exitCode ?? 0);
