#!/usr/bin/env node
// 本物の Claude CLI の代わりに使う偽の実行体。
// stream-json と同じ形の行を吐くので、サーバ側の読み取りをそのまま試せる。
// FAKE_COUNTER_FILE を渡すと呼び出し回数を数え、1 回目だけ壊れた出力を返す
// ＝作り直しの経路を試せる。
import fs from 'node:fs';

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (stdin += c));
process.stdin.on('end', () => {
  const counterFile = process.env.FAKE_COUNTER_FILE;
  let call = 1;
  if (counterFile) {
    call = (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) : 0) + 1;
    fs.writeFileSync(counterFile, String(call));
  }

  const broken = process.env.FAKE_BREAK_FIRST === '1' && call === 1;
  const name = broken ? 'Bad Name' : 'demo-skill';
  const description = broken
    ? 'べんり'
    : 'Premiere Pro の .xml を渡されたときに無音の部分を見つけてカットする。「無音カット」と言われたときにも使う。';

  const payload = {
    name,
    description,
    skillMd: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n本文です。\n`,
    extraFiles: [{ path: 'references/format.md', content: '# 形式\n', purpose: '書式の一覧' }],
    notes: broken ? '' : `受け取ったプロンプトの長さ: ${stdin.length}`,
  };

  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  out({ type: 'system', subtype: 'init', model: 'fake-model' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: '下書きしています' }] } });
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.01,
    duration_ms: 1234,
    result: JSON.stringify(payload),
    structured_output: payload,
  });
  process.exit(0);
});
