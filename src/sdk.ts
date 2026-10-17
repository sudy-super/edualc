import type { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// 単一実行ファイルの Bun はパッケージ名を仮想ファイル内で探索するため、実ファイルを指定する。
// 起動中に更新されても、SDK と子プロセスの版が混在しないようリンクを解決する。
const sdkDirectory = realpathSync(process.env.EDUALC_SDK_PACKAGE ?? fileURLToPath(new URL('../node_modules/@anthropic-ai/claude-agent-sdk', import.meta.url)));
const sdkUrl = pathToFileURL(resolve(sdkDirectory, 'sdk.mjs'));
export const sdkVersion: string = JSON.parse(readFileSync(resolve(sdkDirectory, 'package.json'), 'utf8')).version;
export function sdkExecutable(): string {
  return resolve(sdkDirectory, `../claude-agent-sdk-${process.platform}-${process.arch}/claude${process.platform === 'win32' ? '.exe' : ''}`);
}
export const query: typeof sdkQuery = (await import(sdkUrl.href)).query;
