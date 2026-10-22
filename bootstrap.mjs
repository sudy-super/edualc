// SDK の子プロセスに preload を引き継がせない。
const preloadOptions = process.env.BUN_OPTIONS;
delete process.env.BUN_OPTIONS;
try {
  const { readFileSync, realpathSync } = await import('node:fs');
  if (typeof Bun.ant?.CellSegmenter !== 'function') throw new Error('Claude Code の組み込み実行環境が必要です。');
  if (process.env.EDUALC_REQUIRE_PROXY === '1' && process.env.CLAUDE_LITELLM_MODE !== 'proxy') {
    throw new Error('LiteLLM に接続できません。直接接続への切り替えは行いません。');
  }
  const manifest = JSON.parse(readFileSync(new URL('./native/manifest.json', import.meta.url), 'utf8'));
  if (manifest.schema_version !== 2 || manifest.engine !== 'sdk' || !manifest.symbols || !manifest.sdk_adapter || realpathSync(process.execPath) !== manifest.native_binary) {
    throw new Error('SDK 接続版の実行ファイルを生成・インストールしてください。');
  }
  const { fileURLToPath } = await import('node:url');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const runtimeLauncher = fileURLToPath(new URL('./bin/edualc-runtime', import.meta.url));
  const [main, auxiliary, completion, compact, fork, tasks] = await Promise.all([
    import('./src/sdk-run.ts'), import('./src/sdk-auxiliary.ts'), import('./src/sdk-completion.ts'),
    import('./src/sdk-compact.ts'), import('./src/sdk-fork.ts'), import('./src/sdk-tasks.ts'),
  ]);
  // 本家の import/export を変えず、差し替えた関数本体から呼び出す。
  globalThis[Symbol.for('edualc.sdk')] = Object.freeze({
    originals: new Map(),
    sdkRun: main.sdkRun, alignSdkHistory: main.alignSdkHistory, sdkContextUsage: main.sdkContextUsage,
    sdkGoalCleared: main.sdkGoalCleared, sdkApplySettings: main.sdkApplySettings,
    sdkTaskUpdated: tasks.sdkTaskUpdated, sdkTaskCanBackground: tasks.sdkTaskCanBackground,
    sdkBackgroundTask: tasks.sdkBackgroundTask,
    sdkMcpChanged: main.sdkMcpChanged, sdkMcpReconnect: main.sdkMcpReconnect,
    sdkGenerateTitle: auxiliary.sdkGenerateTitle, sdkSideQuestion: auxiliary.sdkSideQuestion,
    sdkComplete: completion.sdkComplete, sdkModelProbe: completion.sdkModelProbe, sdkToolFreeFork: fork.sdkToolFreeFork,
    sdkCompactCall: compact.sdkCompactCall, sdkCompactManually: compact.sdkCompactManually,
    // 本家の自己再起動時だけ SDK 接続を読み直す。外部コマンドには継承しない。
    relaunchEnvironment: () => ({ BUN_OPTIONS: preloadOptions }),
    runtimeLaunch: () => ({ cmd: runtimeLauncher, prefixArgs: [], target: manifest.native_binary }),
    backgroundRoot: () => join(homedir(), '.edualc'),
  });
  process.once('exit', () => { main.closeSdkRuns(); auxiliary.closeSdkAuxiliary(); completion.closeSdkCompletions(); });
  // preload の終了後、本家のコンパイル済み CLI が通常どおり起動する。
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exit(1);
}
