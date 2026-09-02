import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDescription,
  parseFrontmatter,
  isSafeRelativePath,
  validateSkill,
} from '../public/shared/validate.mjs';

const GOOD_DESC =
  'Premiere Pro の .xml を渡されたときに無音の部分を見つけてカットする。「無音カット」「ジェットカット」と言われたときにも使う。';

const goodSkill = (over = {}) => ({
  name: 'silence-cut',
  description: GOOD_DESC,
  skillMd: `---\nname: silence-cut\ndescription: ${GOOD_DESC}\n---\n\n# silence-cut\n\n本文。\n`,
  extraFiles: [],
  notes: '',
  ...over,
});

test('発動条件と具体名が入った description は通る', () => {
  const r = checkDescription(GOOD_DESC);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
});

test('空の description は落ちる', () => {
  assert.equal(checkDescription('').ok, false);
  assert.equal(checkDescription(undefined).ok, false);
});

test('発動条件が無い description は落ちる', () => {
  const r = checkDescription('Premiere Pro の .xml から無音部分を検出してカットします。');
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('発動条件')));
});

test('短すぎる description は落ちる', () => {
  const r = checkDescription('使うとき');
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('文字しかありません')));
});

test('長すぎる description は落ちる', () => {
  const r = checkDescription(`${'あ'.repeat(520)}のとき`);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('以内に収めて')));
});

test('効能だけの言い回しは警告になるが止めない', () => {
  const r = checkDescription('動画編集を効率化する便利なスキル。編集を頼まれたときに使う。');
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes('効能')));
});

test('具体的な手がかりが無いと警告が出る', () => {
  const r = checkDescription('話をまとめるように言われたときに、内容をまとめて返す。');
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes('具体的な手がかり')));
});

test('「このスキルは」で始まると警告が出る', () => {
  const r = checkDescription(`このスキルは${GOOD_DESC}`);
  assert.ok(r.warnings.some((w) => w.includes('このスキルは')));
});

test('frontmatter を取り出せる', () => {
  const r = parseFrontmatter('---\nname: foo\ndescription: "bar baz"\n---\n\n# hi\n');
  assert.equal(r.ok, true);
  assert.equal(r.fields.name, 'foo');
  assert.equal(r.fields.description, 'bar baz');
});

test('--- で始まらない SKILL.md は落ちる', () => {
  assert.equal(parseFrontmatter('# hi').ok, false);
  assert.equal(parseFrontmatter('---\nname: a\n').ok, false);
});

test('フォルダの外に出るパスは弾く', () => {
  assert.equal(isSafeRelativePath('references/a.md'), true);
  assert.equal(isSafeRelativePath('scripts/x/y.py'), true);
  assert.equal(isSafeRelativePath('../etc/passwd'), false);
  assert.equal(isSafeRelativePath('/etc/passwd'), false);
  assert.equal(isSafeRelativePath('a/../../b'), false);
  assert.equal(isSafeRelativePath('C:\\win'), false);
  assert.equal(isSafeRelativePath(''), false);
});

test('まともな一式は検査を通る', () => {
  const r = validateSkill(goodSkill());
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('name が kebab-case でないと落ちる', () => {
  const r = validateSkill(goodSkill({ name: 'Silence Cut' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('ハイフン')));
});

test('frontmatter の name と食い違うと落ちる', () => {
  const r = validateSkill(goodSkill({ name: 'other-name' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('食い違')));
});

test('本文が無いと落ちる', () => {
  const md = `---\nname: silence-cut\ndescription: ${GOOD_DESC}\n---\n`;
  const r = validateSkill(goodSkill({ skillMd: md }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('本文がありません')));
});

test('危ないパスの付随ファイルは落ちる', () => {
  const r = validateSkill(goodSkill({ extraFiles: [{ path: '../evil.md', content: 'x' }] }));
  assert.equal(r.ok, false);
});

test('付随ファイルの重複と空の中身は落ちる', () => {
  const r = validateSkill(
    goodSkill({
      extraFiles: [
        { path: 'references/a.md', content: 'x' },
        { path: 'references/a.md', content: '' },
      ],
    }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('重複')));
  assert.ok(r.errors.some((e) => e.includes('中身が空')));
});
