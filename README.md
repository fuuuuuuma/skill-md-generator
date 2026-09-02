# SKILL.md ジェネレーター

質問に答えるか、作りたいものをそのまま書くだけで、Claude Code にそのまま貼れる
**SKILL.md 一式**（本体＋ `references/` や `scripts/` の付随ファイル）を作ります。

裏で Claude Code の CLI（`claude`）を起動して生成します。**Fable 5.1 専用**。

---

## 使い方

```bash
node server.mjs
```

`http://127.0.0.1:7788` が開きます（埋まっていたら 7789、7790… と順に探します）。

1. 「質問に答える」か「そのまま伝える」のどちらかで内容を書く
2. 「SKILL.md を作る」を押す
3. できた SKILL.md をコピーするか、書き出し先を入れて一式をまとめて置く

置き場所は、そのパソコン全体で使うなら `~/.claude/skills/`、
特定のプロジェクトだけで使うなら そのプロジェクトの `.claude/skills/` です。

## 必要なもの

- Node.js 20 以上（依存パッケージはありません）
- `claude` コマンドが使える状態であること（`claude --version` で確認）

## 起動時に変えられるもの

| 環境変数 | 既定 | 何が変わるか |
| --- | --- | --- |
| `PORT` | `7788` | 待ち受けるポート |
| `SKILLGEN_MODEL` | `fable` | 生成に使うモデル |
| `SKILLGEN_TIMEOUT_MS` | `600000` | 生成 1 回の上限（10 分） |
| `CLAUDE_BIN` | `claude` | 起動する実行体（テストで偽物に差し替えるため） |

## 中身

```
server.mjs              サーバ本体。静的配信・生成の中継・書き出し
public/index.html       画面
public/style.css
public/app.js           画面の動き
public/shared/          画面とサーバの両方から読む共通部分
  prompt.mjs              質問一覧・書き方の指示・プロンプト組み立て
  schema.mjs              Claude に強制する出力の型
  validate.mjs            生成結果の検査
test/                   node --test 用。偽の claude を使うので課金されない
```

質問一覧（`QUESTIONS`）は `public/shared/prompt.mjs` の 1 箇所だけに書いてあります。
画面はこれを読んでフォームを描き、サーバはこれを読んでプロンプトを組み立てるので、
片方だけ直してズレる事故が起きません。

## 生成のしかた

`claude` を次の形で起動しています。

```
claude -p --model fable --safe-mode --strict-mcp-config
       --permission-mode dontAsk
       --system-prompt <SKILL.md の書き方>
       --disallowed-tools <全部>
       --output-format stream-json --verbose
       --json-schema <出力の型>
```

- プロンプトは引数ではなく**標準入力**から渡します。引数で渡すと長い本文を取りこぼします。
- `--json-schema` を渡すと、結果メッセージの `structured_output` にパース済みの
  オブジェクトが入ります。本文を正規表現で切り出す処理が要りません。
- `--safe-mode --strict-mcp-config` と道具の全停止で、**1 回あたりの費用が 3.5 倍下がります**。
  実測（同じ短いプロンプト）: 素の `claude -p` が 84,539 トークン・$1.71・6.9 秒、
  この構成が 23,937 トークン・$0.49・3.0 秒。
  この端末は hook・plugin・MCP・CLAUDE.md を大量に読み込むためで、
  それらは SKILL.md を書くのに要りません。

## 検査

生成のたびに、返ってきた一式を機械で検査します。

- `name` が kebab-case・64 文字以内で、frontmatter の `name` と一致するか
- `description` に発動条件（「〜のとき」「〜と言われたら」など）が入っているか
- frontmatter の後に本文があるか
- 付随ファイルのパスがスキルフォルダの外へ出ていないか

落ちたら指摘を添えて **1 回だけ** 作り直します。それでも直らない場合は、
errors の少ない方を採用して画面に警告を出します。
「効能だけの言い回し」「具体的な手がかりが無い」は警告どまりで、作り直しはしません。

## テスト

```bash
node --test test/*.test.mjs
```

`test/fake-claude.mjs` が本物の代わりに動くので、テストで課金は発生しません。

## 共有できる版（artifact.html）

`artifact.html` は、リンクを知っている人だけが開ける claude.ai の共有ページとして公開した 1 枚版。
裏で Claude CLI を起動する代わりに、**開いた人自身の Claude** に下書きを頼む（`claude.use("sample")`）。
そのため CLI もインストールも要らず、リンクを渡せばそのまま使える。

https://claude.ai/code/artifact/b7cd94d5-1433-4886-959c-9fcfda6bd0b1

- 質問・書き方の指示・検査ロジックは `public/shared/` と同じ内容を 1 ファイルに畳んだもの
- 生成した各ファイルはコピーのほか、`claude.use("downloads")` で 1 つずつ保存できる
- Claude の画面の外で開かれた場合は、貼り付け用のプロンプトを出す版に自動で切り替わる

## 公開版について

`public/` を静的サイトとして出すと、生成なしのお試し版になります。
`claude` を起動できないため、その環境では代わりに
**そのまま Claude Code に貼れるプロンプト**を組み立てて表示します。
画面は起動時に `/api/health` を叩いて、どちらの環境かを自分で判断します。
