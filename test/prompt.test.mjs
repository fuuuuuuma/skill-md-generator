import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUESTIONS,
  buildPrompt,
  buildRetryPrompt,
  validateInput,
  SYSTEM_PROMPT,
} from '../public/shared/prompt.mjs';

test('必須の質問が空だと弾かれる', () => {
  const r = validateInput({ mode: 'guided', answers: { what: 'XML を読む' } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('どんなときに発動')));
});

test('必須が埋まっていれば通る', () => {
  const r = validateInput({
    mode: 'guided',
    answers: { what: 'XML を読む', when: 'XML を渡されたとき' },
  });
  assert.deepEqual(r, { ok: true, errors: [] });
});

test('自由記述が短すぎると弾かれる', () => {
  assert.equal(validateInput({ mode: 'freeform', text: '作って' }).ok, false);
  assert.equal(
    validateInput({ mode: 'freeform', text: 'XML を渡したら無音を切ってくれるスキルが欲しい' }).ok,
    true,
  );
});

test('知らない入力方式は弾く', () => {
  const r = validateInput({ mode: 'telepathy' });
  assert.equal(r.ok, false);
});

test('回答した内容がそのままプロンプトに載る', () => {
  const prompt = buildPrompt({
    mode: 'guided',
    answers: { what: '無音をカットする', when: 'XML を渡されたとき', rules: '原本を上書きしない' },
  });
  assert.match(prompt, /無音をカットする/);
  assert.match(prompt, /原本を上書きしない/);
  assert.match(prompt, /未回答の項目/);
});

test('全部埋めたら未回答の節は出ない', () => {
  const answers = Object.fromEntries(QUESTIONS.map((q) => [q.id, `${q.id} の回答`]));
  const prompt = buildPrompt({ mode: 'guided', answers });
  assert.doesNotMatch(prompt, /未回答の項目/);
});

test('自由記述はそのまま本文に入る', () => {
  const text = 'Premiere の XML から無音を切りたい。原本は触らない。';
  assert.match(buildPrompt({ mode: 'freeform', text }), new RegExp('原本は触らない'));
});

test('入力が不正なら buildPrompt は投げる', () => {
  assert.throws(() => buildPrompt({ mode: 'guided', answers: {} }));
});

test('作り直し用のプロンプトに指摘が載る', () => {
  const p = buildRetryPrompt('もとの本文', ['name が空です。', 'description が短い。']);
  assert.match(p, /もとの本文/);
  assert.match(p, /- name が空です。/);
});

test('書き方の指示に肝心の決まりが入っている', () => {
  assert.match(SYSTEM_PROMPT, /kebab-case/);
  assert.match(SYSTEM_PROMPT, /references\//);
  assert.match(SYSTEM_PROMPT, /確認を取る/);
});
