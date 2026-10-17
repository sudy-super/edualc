import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
delete process.env.BUN_OPTIONS;
const requests = [], parentModelRequests = [], blockedParentFetches = [];
let phase = 'setup';
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (request.method === 'HEAD') return new Response(null);
  if (!pathname.includes('/v1/messages')) return Response.json({});
  const body = await request.json();
  if (pathname.includes('count_tokens')) return Response.json({ input_tokens: 100 });
  requests.push({ phase, body });
  const id = `msg_completion_probe_${requests.length}`;
  const structuredTool = body.tools?.find(tool => tool.name === 'StructuredOutput');
  const structured = { title: 'LOCAL_STRUCTURED_OK' };
  const text = phase === 'title' ? '{"title":"LOCAL_TITLE_OK"}' : phase === 'structured' ? JSON.stringify(structured) : 'LOCAL_COMPLETION_OK';
  const content = structuredTool ? [{ type: 'tool_use', id: `tool_${requests.length}`, name: structuredTool.name, input: structured }] : [{ type: 'text', text }];
  const stopReason = structuredTool ? 'tool_use' : 'end_turn';
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  if (!body.stream) return Response.json({ id, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stopReason, usage });
  const block = content[0];
  const frames = [
    ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: structuredTool ? { ...block, input: {} } : { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: structuredTool ? { type: 'input_json_delta', partial_json: JSON.stringify(structured) } : { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
} });
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: server.url.origin, ANTHROPIC_API_KEY: 'sk-local-completion-fixture',
  ANTHROPIC_SMALL_FAST_MODEL: 'claude-sonnet-5', ANTHROPIC_MODEL: 'claude-sonnet-5',
  HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
});
for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_EXTRA_BODY']) delete process.env[key];
const actualFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (...args) => {
  const url = new URL(typeof args[0] === 'string' || args[0] instanceof URL ? args[0] : args[0].url);
  if (url.pathname.includes('/v1/messages')) {
    parentModelRequests.push({ phase, url: url.href });
    throw new Error('A parent process attempted model generation');
  }
  if (url.origin !== server.url.origin) {
    blockedParentFetches.push(url.origin + url.pathname);
    throw new Error('External fetch is disabled in this local probe');
  }
  return actualFetch(...args);
}, actualFetch);
const root = new URL('../vendor/claude-full/', import.meta.url);
let complete, auxiliary;
const result = { checks: [], requests, parentModelRequests, blockedParentFetches };
const timer = setTimeout(() => { console.error('Local completion probe timed out'); process.exit(1); }, 60000);
try {
  const config = await import(new URL('chunk-2jyw98bz.js', root).href);
  await config.Xht();
  complete = await import(new URL('../src/sdk-completion.ts', import.meta.url).href);
  auxiliary = await import(new URL('../src/sdk-auxiliary.ts', import.meta.url).href);
  phase = 'normal';
  const answer = await complete.sdkComplete({
    systemPrompt: ['SYSTEM_BLOCK_ONE_3941', 'SYSTEM_BLOCK_TWO_6208'],
    userPrompt: '/literal @not-a-file COMPLETION_PROMPT_7482',
    options: { querySource: 'local_completion_probe', maxOutputTokensOverride: 128, temperatureOverride: 0.25 },
  });
  assert.equal(answer.message.content.filter(block => block.type === 'text').map(block => block.text).join(''), 'LOCAL_COMPLETION_OK');
  const normal = requests.find(request => request.phase === 'normal').body;
  const systemText = JSON.stringify(normal.system);
  assert(systemText.includes('SYSTEM_BLOCK_ONE_3941') && systemText.includes('SYSTEM_BLOCK_TWO_6208'));
  assert(JSON.stringify(normal.messages).includes('/literal @not-a-file COMPLETION_PROMPT_7482'));
  assert.equal(normal.max_tokens, 128);
  assert.equal(normal.temperature, 0.25);
  assert.equal(normal.model, config.ple(config.VE()));
  assert(!normal.thinking || normal.thinking.type === 'disabled');
  result.checks.push('normal response, helper model, system blocks, literal prompt, token limit, temperature and disabled thinking');
  phase = 'structured';
  const structured = await complete.sdkComplete({
    systemPrompt: ['Return the requested JSON object.'], userPrompt: 'STRUCTURED_PROMPT_3917',
    outputFormat: { type: 'json_schema', schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } },
    options: { querySource: 'local_structured_probe' },
  });
  assert.deepEqual(JSON.parse(structured.message.content.find(block => block.type === 'text').text), { title: 'LOCAL_STRUCTURED_OK' });
  result.checks.push('SDK structured output converted to native JSON text');
  phase = 'title';
  assert.equal(await auxiliary.sdkGenerateTitle('Generate a title for the local model adapter probe'), 'LOCAL_TITLE_OK');
  result.checks.push('SDK generateSessionTitle control method');
  assert.equal(parentModelRequests.length, 0);
  result.checks.push('all model requests originate from SDK children');
  result.pass = true;
} catch (error) {
  result.error = error.stack ?? String(error);
  result.pass = false;
  console.error(result.error);
} finally {
  clearTimeout(timer);
  complete?.closeSdkCompletions(); auxiliary?.closeSdkAuxiliary();
  server.stop(true);
  mkdirSync(new URL('../test/artifacts/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../test/artifacts/sdk-completion-probe.json', import.meta.url), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify({ pass: result.pass, checks: result.checks, requests: requests.map(request => ({ phase: request.phase, model: request.body.model, tools: request.body.tools?.map(tool => tool.name), max_tokens: request.body.max_tokens })), parentModelRequests }));
process.exit(result.pass ? 0 : 1);
