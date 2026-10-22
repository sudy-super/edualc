# edualc

Claude CodeのTUIを使い、会話をClaude Agent SDKで実行します。
設定と会話履歴はClaude Codeと共有し、認証には専用のAPIキーを使います。

## Quick start

Apple Silicon搭載のmacOS向けです。Claude Codeのネイティブ版 (2.1.302以降) と初回設定、Node.jsとnpm、Python 3.11以上、jqが必要です。バイナリ内の接続箇所を検証し、対応できない構造では導入を中止します。

```sh
git clone https://github.com/sudy-super/edualc.git
cd edualc
npm ci --omit=optional
mkdir -p ~/.edualc
chmod 700 ~/.edualc
touch ~/.edualc/settings.json
chmod 600 ~/.edualc/settings.json
open -e ~/.edualc/settings.json
```

`~/.edualc/settings.json`に専用APIキーを設定します。既存の設定は残してください。

```json
{"env":{"ANTHROPIC_API_KEY":"自分のAPIキー"}}
```

```sh
npm run install:local
export PATH="$HOME/.local/bin:$PATH"
edualc
```

`~/.local/bin`をPATHに追加してください。会話の再開は`edualc --resume`、SDKの更新は`edualc update`です。
