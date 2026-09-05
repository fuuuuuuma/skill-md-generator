import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sync, MIRRORED } from '../tools/build-pages.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('docs/ が public/ とズレていない', () => {
  const stale = sync({ check: true }).filter((r) => r.stale);
  assert.deepEqual(
    stale.map((r) => r.path),
    [],
    'node tools/build-pages.mjs で同期してください',
  );
});

test('写し先が元と 1 バイトも違わない', () => {
  for (const [from, to] of MIRRORED) {
    const source = read(from);
    const copy = read(to);
    assert.ok(copy.endsWith(source), `${to} の中身が ${from} と違います`);
  }
});

test('公開ページが共通部分だけを読んでいる', () => {
  const app = read('docs/app.js');
  // 質問や検査を公開ページ側で書き直すとローカル版と挙動が割れる。
  assert.match(app, /from '\.\/shared\/prompt\.mjs'/);
  assert.match(app, /from '\.\/shared\/validate\.mjs'/);
  assert.doesNotMatch(app, /const QUESTIONS\s*=/);
  assert.doesNotMatch(app, /function checkDescription/);
});

test('公開ページに鍵が焼き込まれていない', () => {
  for (const f of ['docs/app.js', 'docs/index.html']) {
    assert.doesNotMatch(read(f), /sk-ant-[A-Za-z0-9]/, `${f} に API キーらしき文字列があります`);
  }
});

test('SDK の読み込み先が版で固定されている', () => {
  const app = read('docs/app.js');
  const m = app.match(/@anthropic-ai\/sdk@(\d+\.\d+\.\d+)/);
  assert.ok(m, 'SDK の版が固定されていません（@latest は使わない）');
});

test('使うモデルは Fable 5.1', () => {
  assert.match(read('docs/app.js'), /claude-fable-5-1/);
});
