import type { Options, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
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
function readAuthentication(environment: NodeJS.ProcessEnv): { env?: NodeJS.ProcessEnv; apiKeyHelper?: string } {
  const path = environment.EDUALC_AUTH_SETTINGS_FILE;
  if (!path) return {};
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof settings.env?.ANTHROPIC_API_KEY !== 'string' || !settings.env.ANTHROPIC_API_KEY) {
    throw new Error('edualc 専用 API キーが設定されていません。');
  }
  return { ...settings, env: { ...settings.env,
    ANTHROPIC_CUSTOM_HEADERS: [environment.ANTHROPIC_CUSTOM_HEADERS, settings.env.ANTHROPIC_CUSTOM_HEADERS]
      .filter(value => typeof value === 'string' && value.length > 0).join('\n'),
  } };
}
// 別の起動や--versionが共通ファイルを書き換えても、実行中の認証は変えない。
const launchAuthentication = readAuthentication(process.env);
function authentication(environment: NodeJS.ProcessEnv): { env?: NodeJS.ProcessEnv; apiKeyHelper?: string } {
  return environment === process.env ? launchAuthentication : readAuthentication(environment);
}
export function sdkSettings(settings: Record<string, any> = {}, environment: NodeJS.ProcessEnv = process.env): Options['settings'] {
  const auth = authentication(environment);
  return { ...settings, apiKeyHelper: '', ...((settings.env || auth.env) ? { env: { ...settings.env, ...auth.env } } : {}) };
}
export function sdkEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // SDK の子が、外側のバックグラウンドセッションの状態や再開 ID を書き換えないようにする。
  return {
    ...environment, ...authentication(environment).env,
    BUN_OPTIONS: undefined, CLAUDE_JOB_DIR: undefined, CLAUDE_CODE_SESSION_KIND: undefined,
    CLAUDE_BG_BACKEND: undefined, CLAUDE_BG_RENDEZVOUS_SOCK: undefined,
    CLAUDE_BG_RV_AUTH: undefined, CLAUDE_BG_SOCKET_TOKENS_PATH: undefined,
  };
}
export const query: typeof sdkQuery = (await import(sdkUrl.href)).query;
