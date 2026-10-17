// SDK の子プロセスが同じ preload を実行しないよう、起動直後に取り除く。
delete process.env.BUN_OPTIONS;
let closeSdkRuns;
try {
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
  if (digest !== '5262ce9de86243fed0d21edc39b271555d56780d0112e2b194439fe1c6662d37') {
    throw new Error('対応していない Claude Code です。2.1.302 の実行ファイルが必要です。');
  }
  if (typeof Bun.ant?.CellSegmenter !== 'function') throw new Error('Claude Code の組み込み実行環境が必要です。');
  if (process.env.EDUALC_REQUIRE_PROXY === '1' && process.env.CLAUDE_LITELLM_MODE !== 'proxy') {
    throw new Error('LiteLLM に接続できません。直接接続への切り替えは行いません。');
  }
  const { fileURLToPath } = await import('node:url');
  const root = new URL('./vendor/claude-full/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
  if (!manifest.sdk_adapter) throw new Error('SDK への接続を含む TUI の抽出を実行してください。');
  for (const file of manifest.files.filter(file => file.selected)) {
    const content = readFileSync(new URL(file.relative_path, root));
    if (createHash('sha256').update(content).digest('hex') !== file.derived_sha256) {
      throw new Error(`抽出したファイルが変更されています: ${file.relative_path}`);
    }
  }
  const [main, auxiliary, completion] = await Promise.all([
    import('./src/sdk-run.ts'), import('./src/sdk-auxiliary.ts'), import('./src/sdk-completion.ts'),
  ]);
  closeSdkRuns = () => { main.closeSdkRuns(); auxiliary.closeSdkAuxiliary(); completion.closeSdkCompletions(); };
  process.once('exit', closeSdkRuns);
  process.argv = [process.execPath, fileURLToPath(new URL('cli', root)), ...process.argv.slice(2)];
  await import(new URL('cli', root).href);
  closeSdkRuns();
  process.exit(process.exitCode ?? 0);
} catch (error) {
  closeSdkRuns?.();
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exit(1);
}
