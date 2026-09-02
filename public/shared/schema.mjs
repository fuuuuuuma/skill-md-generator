/**
 * Claude CLI の --json-schema に渡す構造化出力の型。
 *
 * これを渡すと Claude は自由文ではなくこの形の JSON を返すことを強制され、
 * 結果メッセージの structured_output にパース済みオブジェクトが入る。
 * つまり「``` で囲まれた本文を正規表現で切り出す」という壊れやすい処理が要らなくなる。
 *
 * 厳密モードで弾かれないよう、全プロパティを required に入れ
 * additionalProperties は false に固定する。
 */
export const SKILL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'スキル名。半角小文字とハイフンのみ（kebab-case）、64文字以内。',
    },
    description: {
      type: 'string',
      description:
        'frontmatter の description。「何をするか」と「どんなときに発動するか」を一文に含める。',
    },
    skillMd: {
      type: 'string',
      description:
        'SKILL.md の全文。--- で挟んだ frontmatter から始まり、本文が続く完全な Markdown。',
    },
    extraFiles: {
      type: 'array',
      description:
        '付随ファイル。本文に入れると長すぎる参考資料は references/ 配下、繰り返し実行する処理は scripts/ 配下に置く。不要なら空配列。',
      items: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'スキルフォルダからの相対パス。例: references/format.md, scripts/check.py',
          },
          content: { type: 'string', description: 'そのファイルの中身の全文。' },
          purpose: { type: 'string', description: 'このファイルが要る理由を一行で。' },
        },
        required: ['path', 'content', 'purpose'],
        additionalProperties: false,
      },
    },
    notes: {
      type: 'string',
      description:
        '使う人へのひとこと。置き場所、事前に必要なもの、気をつける点など。無ければ空文字。',
    },
  },
  required: ['name', 'description', 'skillMd', 'extraFiles', 'notes'],
  additionalProperties: false,
};
