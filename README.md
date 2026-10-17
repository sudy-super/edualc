# edualc

edualc は、この Mac の Claude Code 2.1.302 から元の TUI (端末上の操作画面) を抽出し、会話の実行部分を Claude Agent SDK に接続しています。
会話画面、入力欄、Markdown、差分表示、承認画面、メニューには元のコードを使っています。

## 起動

作業するフォルダーへ移動して起動します。
この PC の既存の LiteLLM 接続設定を使います。

```sh
cd ~/作業フォルダー
edualc
```

アプリのフォルダーからは `npm start` でも起動できます。
元の CLI の引数を渡せます。

```sh
edualc --model claude-opus-5
edualc --resume SESSION_ID
```

`/model`、`/config`、`/help` などのメニューも元の実装です。
LiteLLM を介さず通常の Claude Code の接続設定を使う場合は `bin/edualc-direct` を起動します。

LiteLLM 用のコマンドは `~/.litellm/claude-launch.sh` を呼び出します。
同スクリプトが直接接続を選んだ場合は、送信前にエラーで終了します。
インストール済みの実行ファイルと起動スクリプトは変更していません。

リポジトリは `~/Documents/edualc`、実行用ファイルは `~/.local/share/edualc/versions/2.1.302/` に置きます。
Claude Code と同じ配置にし、`~/.local/bin/edualc` は実行用ファイルの `bin/edualc` へリンクします。
実行用ファイルはリポジトリから独立したコピーです。
描画には、引き続き本家の `~/.local/share/claude/versions/2.1.302` を使います。
SDK の子プロセスには、更新処理で取得した、その SDK に対応する実行ファイルを使います。

初回のインストールはリポジトリで `npm run install:local` を実行します。
同じバージョンのインストール先が既にある場合は、上書きせず終了します。

## SDK の更新

`edualc update` で npm の `latest` を確認し、SDK を更新します。
候補の SDK と対応実行ファイルを `~/.local/share/edualc/sdk/versions/<SDKのバージョン>/` にインストールし、配布情報の SHA-256 と動作を検証します。
固定版 TUI の Bun から SDK を読み込み、模擬 API で会話、承認とファイル作成、タイトル生成、補助質問、圧縮、履歴保存を確認します。
検証に成功した版だけを `sdk/current` へ設定し、次回起動から使います。
実行中の会話は、開始時に選んだ版を使い続けます。
失敗した候補へは切り替えず、エラーを表示します。
TUI の自動更新は行いません。

定期実行や起動時の更新確認は行いません。

```sh
edualc update
```

現在選ばれている SDK の版と検証結果は `~/.local/share/edualc/sdk/current/verified.json` にあります。
リポジトリの依存関係に固定した SDK は開発時の型とテスト用です。インストール済み edualc は上記の更新対象を読み込みます。

## 認証と共有設定

edualc 専用の API キーは `~/.edualc/settings.json` に設定します。

```json
{
  "env": {
    "ANTHROPIC_API_KEY": "自分の API キー"
  }
}
```

このファイルから読むのは API キーだけです。
`CLAUDE_CONFIG_DIR` は変更せず、Claude Code と同じ設定、会話履歴、skills、plugins、statusline.sh、mods を参照します。
API キー以外の `settings.json` の設定、接続先、モデルも本家と共有します。
コピーや同期は行いません。

起動時に専用の API キーを渡し、OAuth トークンなどの認証用環境変数を除きます。
本家の `apiKeyHelper` は edualc では使わず、資格情報の保存先だけを既存の `CLAUDE_SECURESTORAGE_CONFIG_DIR` で `~/.edualc` に指定します。
専用キーが未設定なら起動を中止します。
本家の設定に含まれるアカウント表示などの情報は引き続き共有されますが、API 呼び出しの認証には edualc のキーを使います。

## 構成

SDK は内部で Claude Code を画面なしの子プロセスとして起動します。
そのため元の TUI を親プロセスで動かし、会話実行と補助処理の接続箇所を SDK へ差し替えています。
SDK の子プロセスには、SDK と一緒に配布される対応版の Claude Code を指定しています。
親プロセスでは、抽出した CLI の起動、設定の読み込み、承認、画面側の履歴処理も使っています。

抽出した 2,695 ファイルは `vendor/claude-full/` にあります。
ファイルの参照先と実行開始の待機処理を調整したうえで、会話実行、圧縮、タイトル生成、補助質問などの接続箇所を変更しています。
変更箇所は抽出スクリプトに列挙し、それ以外のソースが変わっていないことを検証します。
画面のコンポーネントには変更を加えていません。
元の著作権表記も保持しています。

接続処理は次のファイルにあります。

- `src/sdk.ts`: SDK の読み込み。
- `src/sdk-run.ts`: 会話、承認、中断、履歴の再開、利用量の受け渡し。
- `src/sdk-events.ts`: 子エージェントの進捗を元の表示形式へ変換。
- `src/sdk-compact.ts`: `/compact` を主会話の SDK へ送信し、SDK が返した要約と保持対象を元の表示処理へ渡す。
- `src/sdk-auxiliary.ts`: SDK の `generateSessionTitle` と `askSideQuestion` へ接続。
- `src/sdk-completion.ts`: 元の単発生成を SDK の `query` へ接続。
- `src/sdk-fork.ts`: 会話の振り返りなどに必要な履歴を、元の変換関数と SDK の既存の再開機能で別の SDK セッションへ渡す。

SDK 標準の設定読み込みを使います。
主会話の SDK セッションは標準の履歴保存を有効にし、SDK が保存した履歴を、抽出した Claude Code の履歴読み込み関数で取得します。
SDK の公開の `getSessionMessages` は画面向けの内部添付情報を返さないため、同じ保存ファイルを Claude Code の読み込み処理へ渡します。
画面側の会話と SDK 側の会話は、別のセッション ID で保存されます。
親の TUI と SDK の子プロセスがそれぞれ設定を読むため、設定された MCP サーバーには二重に接続する場合があります。
`/compact` の圧縮処理とタイトル生成、`/btw` の補助質問は SDK 側で実行します。
会話の振り返り、名前案などの生成も SDK の `query` へ接続しています。
画面、メニュー、コマンドの表示、保存処理は元のコードを使い、圧縮や生成のアルゴリズムは再実装していません。
タイトル生成と補助質問のメソッドは、この版の SDK 実装に存在しますが、公開の TypeScript 型には含まれていません。

描画には独自の `Bun.ant.CellSegmenter` が必要なため、元の実行ファイルに組み込まれた Bun で起動します。
対応する実行ファイルと抽出後の各ファイルは SHA-256 で検証し、不一致なら起動を拒否します。
この構成はインストール済みの 2.1.302 に依存します。

## 抽出コードを使う箇所

| 処理 | 抽出コードと接続箇所 |
|---|---|
| 会話画面、入力欄、Markdown、差分表示、メニュー | [TUI 本体](vendor/claude-full/chunk-bpv43c1t.js) |
| 端末の描画とキー入力 | [描画](vendor/claude-full/chunk-174fh6cj.js)、[入力](vendor/claude-full/chunk-tdpa6qc1.js) |
| CLI の起動と設定の読み込み | [bootstrap.mjs](bootstrap.mjs) から [抽出した CLI](vendor/claude-full/cli) を起動 |
| ツールの承認画面 | [sdk-run.ts](src/sdk-run.ts) から Claude Code 側の承認処理を呼ぶ |
| 会話履歴の保存・読み込みと入力の形式変換 | [sdk-run.ts](src/sdk-run.ts)、[sdk-fork.ts](src/sdk-fork.ts) から抽出した履歴処理を呼ぶ |
| 圧縮結果の表示 | [sdk-compact.ts](src/sdk-compact.ts) から抽出した表示関数を呼ぶ |

会話、圧縮、タイトル生成、補助質問の実行先は SDK です。
表示や保存に必要な形式の受け渡しを追加し、画面や圧縮・生成処理は独自に作っていません。

## 抽出と検証

```sh
cd ~/Documents/edualc
npm ci --omit=optional
npm run extract
npm run check
npm test
npm run test:tui
```

`npm test` は接続処理の単体テスト、抽出処理のテスト、元のソースとの比較を実行します。
`npm run test:tui` はモデルへ送信せず、同じモデル一覧を指定して元の Claude Code と SDK 接続版の画面全体を厳密比較します。
抽出結果の記録は `vendor/claude-full/manifest.json`、ソース比較の結果は [evidence/full-source-comparison.json](evidence/full-source-comparison.json) にあります。

実接続では、抽出した画面での応答と Write 承認によるファイル作成、SDK による圧縮と圧縮後の会話、`/btw` の補助質問を確認しています。
新規会話からの検証では、同じ SDK 子プロセスで会話と圧縮が完了し、TUI の親からの直接モデル送信は検知されませんでした。
記録は [evidence/sdk-ui-validation.json](evidence/sdk-ui-validation.json) にあります。
検証記録は [tasks/todo.md](tasks/todo.md) にあります。
