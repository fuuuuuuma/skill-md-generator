/**
 * 生成された SKILL.md 一式を、目視の前に機械で検査する。
 * ブラウザからも Node からも読める純粋なモジュール。
 *
 * errors が 1 つでもあれば作り直しの対象。warnings は表示するだけで止めない。
 * 検査を厳しくしすぎると作り直しが増えて費用がかさむので、
 * 「構造として壊れている」ものだけを errors にしている。
 */

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const DESC_MIN = 20;
const DESC_MAX = 500;
const DESC_LONG = 300;

/** 「いつ発動するか」を示す語。これが無い description はまず呼ばれない。 */
const TRIGGER_PATTERNS = [
  /とき/, /時に/, /たら/, /なら/, /場合/, /際に/, /際は/,
  /言われ/, /頼まれ/, /依頼/, /求められ/, /渡され/, /指示され/, /使う/,
  /\buse when\b/i, /\bwhen\b/i, /\btrigger/i,
];

/** 効能だけを述べていて、発動条件の役に立たない語。 */
const VAGUE_PATTERNS = [
  /便利/, /効率(化|的|よく|良く)/, /簡単に/, /素早く/, /手軽に/,
  /快適/, /役立/, /サポートします/, /最適化します/, /改善します/,
];

/** 他のスキルと区別できる具体的な手がかり。拡張子・コマンド・英数字・カタカナ・数値。 */
const SPECIFIC_PATTERNS = [
  /\.[a-z0-9]{1,5}\b/i,        // .xml .md .py などの拡張子
  /\/[a-z][a-z0-9-]{2,}/i,      // /cut のようなスラッシュコマンド
  /[A-Za-z][A-Za-z0-9+#.-]{2,}/, // Premiere, YouTube などの英字語
  /[ァ-ヴー]{3,}/,               // カタカナの固有名詞
  /\d/,                          // 数値
];

function anyMatch(patterns, text) {
  return patterns.some((re) => re.test(text));
}

function matched(patterns, text) {
  return patterns.filter((re) => re.test(text));
}

/**
 * description が「発動条件」として機能するかを判定する。
 *
 * Claude はこの一行だけを見てスキルを起動するかどうか決めるため、
 * ここが緩いと作ったスキルが呼ばれない／関係ない場面で暴発する。
 *
 * @param {string} description  生成された frontmatter の description
 * @returns {{ok: boolean, reasons: string[], warnings: string[]}}
 */
export function checkDescription(description) {
  const reasons = [];
  const warnings = [];

  if (typeof description !== 'string' || description.trim() === '') {
    return { ok: false, reasons: ['description が空です。'], warnings: [] };
  }

  const text = description.trim();

  if (text.length < DESC_MIN) {
    reasons.push(
      `description が ${text.length} 文字しかありません。何をするかと、いつ発動するかの両方を入れると ${DESC_MIN} 文字は超えます。`,
    );
  }
  if (text.length > DESC_MAX) {
    reasons.push(
      `description が ${text.length} 文字あります。${DESC_MAX} 文字以内に収めてください。詳しい説明は本文へ移します。`,
    );
  } else if (text.length > DESC_LONG) {
    warnings.push(
      `description が ${text.length} 文字とやや長めです。発動条件に関係ない説明が混ざっていないか確認してください。`,
    );
  }

  if (!anyMatch(TRIGGER_PATTERNS, text)) {
    reasons.push(
      '発動条件が書かれていません。「〜のとき」「〜と言われたら」「〜を渡されたとき」のように、いつ起動してほしいかを入れてください。',
    );
  }

  if (!anyMatch(SPECIFIC_PATTERNS, text)) {
    warnings.push(
      '扱うファイル・コマンド・固有名詞・数値といった具体的な手がかりがありません。他のスキルと区別がつかず、誤って起動する恐れがあります。',
    );
  }

  const vague = matched(VAGUE_PATTERNS, text);
  if (vague.length > 0) {
    warnings.push(
      `「便利」「効率化」のような効能だけの言い回しが入っています（${vague.length} 箇所）。発動条件の判断材料にならないので、具体的な場面の記述に置き換えられないか見てください。`,
    );
  }

  if (/^(この|本)スキル/.test(text)) {
    warnings.push(
      '「このスキルは〜」で始まっています。主語を省いて動作から書き出すと、同じ文字数でより多くの発動条件を入れられます。',
    );
  }

  return { ok: reasons.length === 0, reasons, warnings };
}

/**
 * SKILL.md 冒頭の frontmatter を取り出す。
 * @param {string} md
 * @returns {{ok: boolean, fields: Record<string,string>, error?: string}}
 */
export function parseFrontmatter(md) {
  if (typeof md !== 'string') {
    return { ok: false, fields: {}, error: 'SKILL.md が文字列ではありません。' };
  }
  const text = md.replace(/^﻿/, '');
  if (!text.startsWith('---')) {
    return { ok: false, fields: {}, error: 'SKILL.md が --- で始まっていません。' };
  }
  const end = text.indexOf('\n---', 3);
  if (end === -1) {
    return { ok: false, fields: {}, error: 'frontmatter の閉じの --- が見つかりません。' };
  }
  const body = text.slice(text.indexOf('\n') + 1, end);
  const fields = {};
  for (const line of body.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (m) fields[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return { ok: true, fields };
}

/**
 * 付随ファイルの置き場所として安全な相対パスかを判定する。
 * スキルフォルダの外へ書き出せてしまう指定を弾く。
 * @param {string} p
 * @returns {boolean}
 */
export function isSafeRelativePath(p) {
  if (typeof p !== 'string' || p.trim() === '') return false;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  if (p.includes('\\')) return false;
  const parts = p.split('/');
  if (parts.some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  return true;
}

/**
 * 生成結果一式を検査する。
 * @param {{name?: string, description?: string, skillMd?: string, extraFiles?: Array}} payload
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateSkill(payload) {
  const errors = [];
  const warnings = [];

  if (!payload || typeof payload !== 'object') {
    return { ok: false, errors: ['生成結果が空です。'], warnings: [] };
  }

  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  if (name === '') {
    errors.push('name が空です。');
  } else {
    if (!NAME_RE.test(name)) {
      errors.push(`name「${name}」は半角小文字・数字・ハイフンだけで書いてください。`);
    }
    if (name.length > NAME_MAX) {
      errors.push(`name が ${name.length} 文字あります。${NAME_MAX} 文字以内にしてください。`);
    }
  }

  const desc = checkDescription(payload.description);
  errors.push(...desc.reasons);
  warnings.push(...desc.warnings);

  const md = typeof payload.skillMd === 'string' ? payload.skillMd : '';
  if (md.trim() === '') {
    errors.push('SKILL.md の本文が空です。');
  } else {
    const fm = parseFrontmatter(md);
    if (!fm.ok) {
      errors.push(fm.error);
    } else {
      if (!fm.fields.name) errors.push('SKILL.md の frontmatter に name がありません。');
      if (!fm.fields.description) {
        errors.push('SKILL.md の frontmatter に description がありません。');
      }
      if (name && fm.fields.name && fm.fields.name !== name) {
        errors.push(
          `frontmatter の name「${fm.fields.name}」と、フォルダ名にする name「${name}」が食い違っています。`,
        );
      }
      const afterFm = md.slice(md.indexOf('\n---', 3) + 4).trim();
      if (afterFm === '') errors.push('frontmatter の後に本文がありません。');
    }
    const lineCount = md.split('\n').length;
    if (lineCount > 500) {
      warnings.push(
        `SKILL.md が ${lineCount} 行あります。500 行を超える分は references/ へ切り出すのが目安です。`,
      );
    }
  }

  const files = Array.isArray(payload.extraFiles) ? payload.extraFiles : [];
  const seen = new Set();
  for (const f of files) {
    if (!f || typeof f !== 'object') {
      errors.push('付随ファイルの形式が壊れています。');
      continue;
    }
    if (!isSafeRelativePath(f.path)) {
      errors.push(`付随ファイルのパス「${f.path}」は使えません。スキルフォルダ内の相対パスにしてください。`);
      continue;
    }
    if (f.path === 'SKILL.md') {
      errors.push('付随ファイルに SKILL.md は入れられません。本体は skillMd に入れてください。');
    }
    if (seen.has(f.path)) errors.push(`付随ファイルのパス「${f.path}」が重複しています。`);
    seen.add(f.path);
    if (typeof f.content !== 'string' || f.content.trim() === '') {
      errors.push(`付随ファイル「${f.path}」の中身が空です。`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
