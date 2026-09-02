/**
 * 入力からプロンプトを組み立てる。ブラウザからも Node からも読める純粋なモジュール。
 *
 * 画面の質問一覧とサーバが組み立てるプロンプトが別々に定義されていると、
 * 片方だけ直したときに静かにズレる。だから QUESTIONS をここ一箇所に置き、
 * 画面はこれを読んでフォームを描き、サーバはこれを読んで本文を組み立てる。
 */

/** かんたんモードの質問。画面のフォームはこの配列から生成される。 */
export const QUESTIONS = [
  {
    id: 'what',
    label: '何をするスキルですか',
    placeholder: '例：Premiere Pro の書き出し XML を読んで、無音部分のカット位置を出す',
    hint: '一番大事な項目です。動作を一文で。',
    required: true,
    rows: 3,
  },
  {
    id: 'when',
    label: 'どんなときに発動してほしいですか',
    placeholder: '例：XML ファイルを渡されたとき、「無音カットして」「ジェットカット」と言われたとき',
    hint: 'Claude はこの条件を見てスキルを起動するか決めます。実際に打ちそうな言い回しを並べてください。',
    required: true,
    rows: 3,
  },
  {
    id: 'tools',
    label: '使う道具は何ですか',
    placeholder: '例：ファイルの読み書き、Python スクリプトの実行、Web 検索',
    hint: '思いつかなければ空欄で構いません。',
    required: false,
    rows: 2,
  },
  {
    id: 'io',
    label: '入力と出力を教えてください',
    placeholder: '例：入力＝Premiere の XML ファイル / 出力＝カット済みの XML と、切った箇所の一覧',
    hint: '何を受け取って何を返すか。',
    required: false,
    rows: 2,
  },
  {
    id: 'rules',
    label: '絶対に守らせたいことはありますか',
    placeholder: '例：元のファイルは絶対に上書きしない。カット候補が 500 個を超えたら実行前に確認する。',
    hint: '過去に失敗した経験があれば、それをそのまま書いてください。',
    required: false,
    rows: 3,
  },
  {
    id: 'refs',
    label: '参考にする既存の手順やファイルはありますか',
    placeholder: '例：~/ClaudeCode/tools/silence_cut.py が既にある。しきい値は -35dB。',
    hint: '既存の資産があるならここに。無ければ空欄で。',
    required: false,
    rows: 3,
  },
];

/** Claude CLI の --system-prompt に渡す、SKILL.md の書き方の指示。 */
export const SYSTEM_PROMPT = `あなたは Claude Code の SKILL.md を書く専門家です。
利用者の説明を読み、そのまま使える SKILL.md 一式を日本語で作ります。

## SKILL.md の決まり

1. ファイルの先頭は --- で挟んだ frontmatter。入れるのは name と description の 2 つだけ。
   - name: 半角小文字とハイフンだけ（kebab-case）。64 文字以内。フォルダ名と一致させる。
   - description: 「何をするか」と「どんなときに発動するか」を必ず両方入れた一文。
     Claude はこの一行だけを見て起動するかを決めるため、ここが最重要。
     実際に利用者が打ちそうな言い回し、扱うファイル拡張子、固有名詞を具体的に含める。
     「便利です」「効率化します」のような効能だけの説明は禁止。
2. frontmatter の後は本文。次の順で書く。
   - 見出し（# スキル名）と、1〜2 行の要約
   - 「使う場面」… 発動条件を箇条書きで
   - 「手順」… 番号つきで、Claude がそのままなぞれる粒度に
   - 「注意」… 壊しやすい所、確認を取るべき所
   - 必要なら「例」
3. 手順は「トリガー → やること」の形で書く。曖昧な形容詞を避け、判断基準は数値か条件式で書く。
4. 取り消せない操作（削除・上書き・外部送信・公開・課金）を含む手順には、
   実行前に利用者へ確認を取るステップを必ず入れる。
5. 本文は 500 行以内に収める。長い参考資料は references/ に、
   繰り返し実行する処理は scripts/ に切り出し、本文からは参照するだけにする。

## 付随ファイル（extraFiles）の使い分け

- references/*.md … 一覧表、書式仕様、用語集など「必要になったときだけ読めばいい情報」
- scripts/*.{py,sh,mjs} … 毎回同じ手順で走らせる処理。冒頭に使い方をコメントで書く
- 本文だけで足りるなら extraFiles は空配列にする。水増ししない。

## 出力

必ず指定された JSON の形で返す。skillMd には --- から始まる完全な Markdown 全文を入れる。
説明や前置きは付けない。`;

/** 空白だけの入力を弾く。 */
function isBlank(value) {
  return typeof value !== 'string' || value.trim() === '';
}

/**
 * 入力を検証する。画面側でもサーバ側でも同じ判定を使う。
 * @param {{mode: string, answers?: Record<string,string>, text?: string}} input
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateInput(input) {
  const errors = [];
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['入力がありません。'] };
  }
  if (input.mode === 'guided') {
    const answers = input.answers || {};
    for (const q of QUESTIONS) {
      if (q.required && isBlank(answers[q.id])) {
        errors.push(`「${q.label}」は必須です。`);
      }
    }
  } else if (input.mode === 'freeform') {
    if (isBlank(input.text)) {
      errors.push('作りたいものの説明を書いてください。');
    } else if (input.text.trim().length < 15) {
      errors.push('説明が短すぎます。何をするスキルで、いつ動いてほしいかを書いてください。');
    }
  } else {
    errors.push(`知らない入力方式です: ${input.mode}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 入力から Claude へ渡す本文を組み立てる。
 * @param {{mode: string, answers?: Record<string,string>, text?: string}} input
 * @returns {string}
 */
export function buildPrompt(input) {
  const check = validateInput(input);
  if (!check.ok) {
    throw new Error(check.errors.join(' '));
  }

  if (input.mode === 'freeform') {
    return [
      '次の説明から SKILL.md 一式を作ってください。',
      '',
      '## 利用者の説明',
      input.text.trim(),
      '',
      '説明に書かれていない項目は、内容から素直に推測して埋めてください。',
      '推測で埋めた箇所は notes に一行ずつ挙げてください。',
    ].join('\n');
  }

  const answers = input.answers || {};
  const filled = QUESTIONS.filter((q) => !isBlank(answers[q.id])).map(
    (q) => `### ${q.label}\n${answers[q.id].trim()}`,
  );
  const skipped = QUESTIONS.filter((q) => isBlank(answers[q.id])).map((q) => q.label);

  const lines = [
    '次の回答から SKILL.md 一式を作ってください。',
    '',
    '## 利用者の回答',
    ...filled,
  ];
  if (skipped.length > 0) {
    lines.push(
      '',
      `## 未回答の項目`,
      `${skipped.join(' / ')} は回答がありません。上の回答から素直に推測して埋め、推測した箇所を notes に挙げてください。`,
    );
  }
  return lines.join('\n');
}

/**
 * 再生成のときに、前回の失敗理由を添えたプロンプトを作る。
 * @param {string} basePrompt
 * @param {string[]} problems
 * @returns {string}
 */
export function buildRetryPrompt(basePrompt, problems) {
  return [
    basePrompt,
    '',
    '## 前回の出力で見つかった問題',
    ...problems.map((p) => `- ${p}`),
    '',
    'これらを直したうえで、もう一度 SKILL.md 一式を作ってください。',
  ].join('\n');
}
