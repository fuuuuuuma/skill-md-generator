#!/usr/bin/env node
/**
 * GitHub Pages 用の docs/ を public/ から同期する。
 *
 * 質問一覧・書き方の指示・検査ロジックは public/shared/ が唯一の正本。
 * docs/ にコピーを置くのは GitHub Pages が静的ファイルしか配れないからで、
 * 手で書き換えるとローカル版と静かにズレる。必ずこのスクリプトで更新する。
 *
 *   node tools/build-pages.mjs          同期する
 *   node tools/build-pages.mjs --check  ズレていたら終了コード 1（テスト用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/** public/ からそのまま持ってくるもの。左が元、右が写し先。 */
export const MIRRORED = [
  ['public/shared/prompt.mjs', 'docs/shared/prompt.mjs'],
  ['public/shared/schema.mjs', 'docs/shared/schema.mjs'],
  ['public/shared/validate.mjs', 'docs/shared/validate.mjs'],
  ['public/style.css', 'docs/style.css'],
];

const BANNER = '/* public/ から自動で写しています。直すときは元を直して node tools/build-pages.mjs */\n';

function bodyOf(text) {
  return text.startsWith(BANNER) ? text.slice(BANNER.length) : text;
}

/** @returns {{path: string, stale: boolean}[]} */
export function sync({ check = false } = {}) {
  const report = [];
  for (const [from, to] of MIRRORED) {
    const source = fs.readFileSync(path.join(ROOT, from), 'utf8');
    const want = BANNER + source;
    const dest = path.join(ROOT, to);
    const have = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
    const stale = bodyOf(have ?? '') !== source;
    report.push({ path: to, stale });
    if (stale && !check) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, want, 'utf8');
    }
  }
  return report;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const check = process.argv.includes('--check');
  const report = sync({ check });
  const stale = report.filter((r) => r.stale);
  if (check) {
    if (stale.length) {
      console.error('docs/ が public/ とズレています:');
      for (const r of stale) console.error(`  ${r.path}`);
      console.error('node tools/build-pages.mjs で直してください。');
      process.exit(1);
    }
    console.log('docs/ は public/ と一致しています。');
  } else {
    console.log(stale.length ? `更新: ${stale.map((r) => r.path).join(', ')}` : '変更なし。');
  }
}
