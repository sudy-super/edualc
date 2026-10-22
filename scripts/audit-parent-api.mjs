// 検証用: SDK の子ではなく、TUI の親からモデルへ直接送信したら記録して失敗させる。
import { appendFileSync, mkdirSync } from 'node:fs';
const artifact = new URL('../test/artifacts/parent-api-audit.jsonl', import.meta.url);
mkdirSync(new URL('../test/artifacts/', import.meta.url), { recursive: true });
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, receiver, args) {
    const value = args[0];
    const url = new URL(typeof value === 'string' ? value : value instanceof URL ? value.href : value.url);
    if (/\/(messages(?:\/count_tokens)?|chat\/completions|(?:stream)?[gG]enerateContent|invoke(?:-with-response-stream)?)\/?$/.test(url.pathname)) {
      appendFileSync(artifact, `${JSON.stringify({ at: new Date().toISOString(), path: url.pathname })}\n`);
      throw new Error(`The TUI parent attempted a model request outside the Agent SDK: ${url.pathname}`);
    }
    return Reflect.apply(target, receiver, args);
  },
});
const { pathToFileURL } = await import('node:url');
await import(process.env.EDUALC_AUDIT_APP_ROOT ? pathToFileURL(`${process.env.EDUALC_AUDIT_APP_ROOT}/bootstrap.mjs`).href : '../bootstrap.mjs');
