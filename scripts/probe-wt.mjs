import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
delete process.env.BUN_OPTIONS;
const root = new URL('../vendor/claude-full/', import.meta.url);
const config = await import(new URL('chunk-2jyw98bz.js', root).href);
await config.Xht();
const { wT } = await import(new URL('chunk-hqtnbrjd.js', root).href);
const entry = (type, value) => ({ type, uuid: randomUUID(), timestamp: new Date().toISOString(), ...value });
const messages = [
  entry('user', { message: { role: 'user', content: 'USER_SENTINEL' } }),
  entry('user', { isMeta: true, message: { role: 'user', content: '<system-reminder>HOOK_META_SENTINEL</system-reminder>' } }),
  entry('attachment', { attachment: { type: 'hook_additional_context', content: ['HOOK_ATTACHMENT_SENTINEL'], hookName: 'UserPromptSubmit' } }),
  entry('attachment', { attachment: { type: 'relevant_memories', memories: [{ path: '/tmp/probe-memory.md', content: 'MEMORY_ATTACHMENT_SENTINEL', mtimeMs: Date.now() }] } }),
];
const cases = [];
try {
  for (const model of [undefined, 'claude-opus-5']) {
    const normalized = wT(messages, [], model);
    cases.push({ model: model ?? '(omitted)', normalized });
  }
  writeFileSync(new URL('../test/artifacts/wt-probe.json', import.meta.url), JSON.stringify(cases, null, 2));
  console.log(JSON.stringify(cases));
} catch (error) { console.error(error); process.exitCode = 1; }
process.exit(process.exitCode ?? 0);
