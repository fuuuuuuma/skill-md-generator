# SKILL.md ジェネレーター

質問に答えるか、作りたいものをそのまま書くだけで、Claude Code に置ける
**SKILL.md 一式**（本体＋ `references/` や `scripts/` の付随ファイル）を作るローカル Web アプリです。

裏で Claude Code の CLI（`claude`）を起動して生成します。**依存パッケージはありません。**

## 何が出てくるか

3 つの質問にこう答えると、

| 質問 | 答えた内容 |
| --- | --- |
| 何をするスキルですか | Premiere Pro の書き出し XML を読んで、無音の区間を見つけてカット位置の一覧を出す |
| どんなときに発動してほしいですか | `.xml` ファイルを渡されたとき、「無音カットして」「ジェットカット」と言われたとき |
| 絶対に守らせたいことはありますか | 元の XML は絶対に上書きしない。カット候補が 500 を超えたら実行前に確認する。 |

`premiere-silence-cut/` として次の 3 ファイルが出ます（実際の出力・1 分 56 秒・$0.97）。

```
premiere-silence-cut/
├── SKILL.md                      本体
├── scripts/detect_silence.py     XML 解析 → ffmpeg 無音検出 → CSV 出力（230 行）
└── references/xmeml-format.md    XMEML の構造と調整表（60 行・必要なときだけ読む資料）
```

SKILL.md の冒頭はこうなります。

```markdown
---
name: premiere-silence-cut
description: Premiere Pro の書き出し XML（FCP7/XMEML 形式の .xml）を解析し、参照メディアの
  無音区間を ffmpeg で検出してジェットカット用のカット位置一覧（CSV）を作る。.xml ファイルを
  渡されたときや「無音カットして」「ジェットカット」と言われたときに使う。
---

## 使う場面

- 利用者から `.xml` ファイル（ルート要素が `<xmeml>` のもの）を渡されたとき
- 「無音カットして」「ジェットカットして」「無音区間を探して」「間を詰めたい」と言われたとき
```

「絶対に守らせたいこと」に書いた内容は、手順と注意の両方へ落ちます。

```markdown
- **元の XML は絶対に上書きしない。** 書き込み・移動・リネームも一切しない。
- **カット候補が 500 件を超えたら、出力前に必ず利用者へ確認する。**
```


---

## はじめかた

```bash
git clone https://github.com/fuuuuuuma/skill-md-generator.git
cd skill-md-generator
node server.mjs
```

`http://127.0.0.1:7788` が開きます（埋まっていたら 7789、7790… と順に探します）。

1. 「質問に答える」か「そのまま伝える」のどちらかで内容を書く
2. 「SKILL.md を作る」を押す
3. できた SKILL.md をコピーするか、書き出し先を入れて一式をまとめて置く

置き場所は、そのパソコン全体で使うなら `~/.claude/skills/`、
特定のプロジェクトだけで使うなら そのプロジェクトの `.claude/skills/` です。

### 必要なもの

- Node.js 20 以上
- `claude` コマンドが使える状態であること（`claude --version` で確認）

サーバは `127.0.0.1` だけで待ち受けます。生成した一式をフォルダへ書き出す口を持つため、
同じネットワークの別の機械からは触れないようにしてあります。

### 起動時に変えられるもの

| 環境変数 | 既定 | 何が変わるか |
| --- | --- | --- |
| `PORT` | `7788` | 待ち受けるポート |
| `SKILLGEN_MODEL` | `fable` | 生成に使うモデル（`opus`、`sonnet` なども指定できます） |
| `SKILLGEN_TIMEOUT_MS` | `600000` | 生成 1 回の上限（10 分） |
| `SKILLGEN_KEEP_API_KEY` | 未設定 | `1` にすると `ANTHROPIC_API_KEY` を子プロセスへそのまま渡します |
| `CLAUDE_BIN` | `claude` | 起動する実行体（テストで偽物に差し替えるため） |

出力は日本語です。英語で書かせたい場合は `public/shared/prompt.mjs` の `SYSTEM_PROMPT` を差し替えてください。

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
artifact.html           claude.ai の共有ページ用に 1 枚へ畳んだ版（後述）
test/                   node --test 用。偽の claude を使うので課金されない
```

質問一覧（`QUESTIONS`）は `public/shared/prompt.mjs` の 1 箇所だけに書いてあります。
画面はこれを読んでフォームを描き、サーバはこれを読んでプロンプトを組み立てるので、
片方だけ直してズレる事故が起きません。質問を足したいときもここだけ触れば済みます。

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

作りながら実測して分かったことを、そのまま置いておきます。

- **プロンプトは引数ではなく標準入力から渡します。** 引数で渡すと長い本文を取りこぼします。
- **`--json-schema` を渡すと、結果メッセージの `structured_output` にパース済みのオブジェクトが入ります。**
  本文を正規表現で切り出す処理が要りません。`--output-format stream-json` は `--verbose` が必須です。
- **`--safe-mode --strict-mcp-config` と道具の全停止で、1 回あたりの費用が下がります。**
  同じ短いプロンプトでの実測で、素の `claude -p` が 84,539 トークン・$1.71・6.9 秒、
  この構成が 23,937 トークン・$0.49・3.0 秒でした。差の正体は、hook・plugin・MCP サーバ・
  CLAUDE.md といった環境側の読み込みです。文章を書かせるだけなら、そのどれも要りません。
  **差の大きさは環境によって変わります**（拡張を入れていない環境なら差は小さくなります）。
- **Claude Code の中からこのサーバを起動すると、子の `claude` が 401 で落ちることがあります。**
  ホストのセッション用 `ANTHROPIC_API_KEY` が環境に入っていて、子がそれを本物の鍵として
  使ってしまうためです。`server.mjs` の `childEnv()` がその場合だけ鍵を外します。
  自分の API キーで動かしたいときは `SKILLGEN_KEEP_API_KEY=1` を付けてください。

## 検査

生成のたびに、返ってきた一式を機械で検査します。

- `name` が kebab-case・64 文字以内で、frontmatter の `name` と一致するか
- `description` に発動条件（「〜のとき」「〜と言われたら」など）が入っているか
- frontmatter の後に本文があるか
- 付随ファイルのパスがスキルフォルダの外へ出ていないか

落ちたら指摘を添えて **1 回だけ** 作り直します。それでも直らない場合は、
errors の少ない方を採用して画面に警告を出します。
「効能だけの言い回し」「具体的な手がかりが無い」は警告どまりで、作り直しはしません。
厳しくしすぎると作り直しのたびに費用がかかるので、構造として壊れているものだけを落としています。

判定の中身は `public/shared/validate.mjs` の `checkDescription()` にあります。
基準が肌に合わなければ、そこだけ書き換えてください。

## テスト

```bash
node --test test/*.test.mjs
```

44 件。`test/fake-claude.mjs` が本物の `claude` の代わりに動くので、テストで課金は発生しません。

## claude.ai の共有ページとして配る（artifact.html）

`artifact.html` は、`server.mjs` を使わずに動く 1 枚版です。
裏で CLI を起動する代わりに、**開いた人自身の Claude** に下書きを頼みます
（claude.ai の Artifact が持つ `claude.use("sample")`）。
Claude Code から次のように publish すると、リンクを知っている人だけが開けるページになります。

```
capabilities: { sample: {}, downloads: true }
```

- 質問・書き方の指示・検査ロジックは `public/shared/` と同じ内容を 1 ファイルに畳んだものです
- 生成した各ファイルはコピーのほか、`claude.use("downloads")` で 1 つずつ保存できます
- Claude の画面の外で開かれた場合は、貼り付け用のプロンプトを出す版へ自動で切り替わります

## `public/` だけを静的配信した場合

`claude` を起動できないので、生成の代わりに
**そのまま Claude Code に貼れるプロンプト**を組み立てて表示します。
画面は起動時に `/api/health` を叩いて、どちらの環境かを自分で判断します。

## ライセンス

MIT。[LICENSE](LICENSE) を参照してください。
