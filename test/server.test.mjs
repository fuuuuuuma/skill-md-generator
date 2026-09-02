import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 本物の Claude を叩かずに済むよう、実行体を偽物へ差し替えてから読み込む。
process.env.CLAUDE_BIN = path.join(HERE, 'fake-claude.mjs');
process.env.PORT = '0';

const { createServer, listen, childEnv, explainFailure } = await import('../server.mjs');

const server = createServer();
const port = await listen(server, 0, 0);
const base = `http://127.0.0.1:${port}`;

test.after(() => server.close());

/** SSE の本文を読み切って、イベントの配列にして返す。 */
async function readEvents(res) {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((c) => c.trim())
    .map((chunk) => {
      let name = 'message';
      const data = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) name = line.slice(7).trim();
        else if (line.startsWith('data: ')) data.push(line.slice(6));
      }
      return { name, data: JSON.parse(data.join('\n')) };
    });
}

function generate(body) {
  return fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const GUIDED = {
  mode: 'guided',
  answers: { what: '無音をカットする', when: 'XML を渡されたとき' },
};

test('健康確認が返る', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const info = await res.json();
  assert.equal(info.ok, true);
});

test('画面が配れる', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Fable 5\.1 専用/);
});

test('共有モジュールが配れる', async () => {
  const res = await fetch(`${base}/shared/prompt.mjs`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
});

test('public の外は取り出せない', async () => {
  const res = await fetch(`${base}/../server.mjs`, { redirect: 'manual' });
  assert.notEqual(res.status, 200);
});

test('生成すると done で一式が返る', async () => {
  delete process.env.FAKE_BREAK_FIRST;
  const events = await readEvents(await generate(GUIDED));
  const done = events.find((e) => e.name === 'done');
  assert.ok(done, `done が来なかった: ${JSON.stringify(events)}`);
  assert.equal(done.data.result.name, 'demo-skill');
  assert.equal(done.data.validation.ok, true);
  assert.equal(done.data.result.extraFiles.length, 1);
  assert.ok(events.some((e) => e.name === 'log'));
});

test('プロンプトは標準入力から子プロセスに届く', async () => {
  delete process.env.FAKE_BREAK_FIRST;
  const events = await readEvents(await generate(GUIDED));
  const done = events.find((e) => e.name === 'done');
  const len = Number(done.data.result.notes.match(/(\d+)$/)[1]);
  assert.ok(len > 50, `プロンプトが届いていない（長さ ${len}）`);
});

test('入力が足りないとエラーが返る', async () => {
  const events = await readEvents(await generate({ mode: 'guided', answers: {} }));
  const err = events.find((e) => e.name === 'error');
  assert.ok(err);
  assert.match(err.data.message, /必須/);
});

test('検査に落ちたら作り直して良い方を返す', async () => {
  const counter = path.join(os.tmpdir(), `skillgen-counter-${Date.now()}`);
  process.env.FAKE_BREAK_FIRST = '1';
  process.env.FAKE_COUNTER_FILE = counter;
  try {
    const events = await readEvents(await generate(GUIDED));
    const done = events.find((e) => e.name === 'done');
    assert.ok(done, `done が来なかった: ${JSON.stringify(events)}`);
    assert.equal(done.data.result.name, 'demo-skill');
    assert.equal(done.data.validation.ok, true);
    assert.equal(await fs.readFile(counter, 'utf8'), '2', 'Claude が 2 回呼ばれていない');
  } finally {
    delete process.env.FAKE_BREAK_FIRST;
    delete process.env.FAKE_COUNTER_FILE;
    await fs.rm(counter, { force: true });
  }
});

test('Claude が異常終了したらエラーとして伝わる', async () => {
  const before = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = path.join(HERE, 'fake-claude-fail.mjs');
  try {
    // CLAUDE_BIN は読み込み時に固定されるため、別の口から確かめる。
    const res = await fetch(`${base}/api/health`);
    assert.equal((await res.json()).bin, before);
  } finally {
    process.env.CLAUDE_BIN = before;
  }
});

test('一式をローカルに書き出せる', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skillgen-'));
  const body = {
    targetDir: dir,
    name: 'demo-skill',
    skillMd: '---\nname: demo-skill\ndescription: x\n---\n\n# demo\n',
    extraFiles: [{ path: 'references/a.md', content: '# a\n' }],
  };
  const res = await fetch(`${base}/api/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(data.written.length, 2);
  assert.equal(
    await fs.readFile(path.join(dir, 'demo-skill', 'references', 'a.md'), 'utf8'),
    '# a\n',
  );

  // 2 回目は上書き確認を求める。
  const again = await fetch(`${base}/api/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).needsOverwrite, true);

  // 明示して押せば通る。
  const forced = await fetch(`${base}/api/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, overwrite: true }),
  });
  assert.equal(forced.status, 200);

  await fs.rm(dir, { recursive: true, force: true });
});

test('フォルダの外へ出るパスは書き出さない', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skillgen-'));
  const res = await fetch(`${base}/api/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      targetDir: dir,
      name: 'demo-skill',
      skillMd: '---\nname: demo-skill\ndescription: x\n---\n\n# demo\n',
      extraFiles: [{ path: '../../escaped.md', content: 'x' }],
    }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.written.length, 1, '危ないパスが書き出されている');
  assert.equal(
    await fs.stat(path.join(path.dirname(dir), 'escaped.md')).then(() => true, () => false),
    false,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('書き出し先が空だと断る', async () => {
  const res = await fetch(`${base}/api/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetDir: '', name: 'x', skillMd: 'y' }),
  });
  assert.equal(res.status, 400);
});

test('Claude Code から起動したときはホストの API キーを子に渡さない', () => {
  const r = childEnv({ CLAUDECODE: '1', ANTHROPIC_API_KEY: 'sk-host', PATH: '/bin' });
  assert.equal(r.dropped, true);
  assert.equal('ANTHROPIC_API_KEY' in r.env, false);
  assert.equal(r.env.PATH, '/bin');
});

test('自分で API キーを使いたいときは残せる', () => {
  const r = childEnv({ CLAUDECODE: '1', ANTHROPIC_API_KEY: 'sk-mine', SKILLGEN_KEEP_API_KEY: '1' });
  assert.equal(r.dropped, false);
  assert.equal(r.env.ANTHROPIC_API_KEY, 'sk-mine');
});

test('ふつうのターミナルからの起動には触らない', () => {
  const r = childEnv({ ANTHROPIC_API_KEY: 'sk-user' });
  assert.equal(r.dropped, false);
  assert.equal(r.env.ANTHROPIC_API_KEY, 'sk-user');
});

test('認証の失敗には確かめる場所を添える', () => {
  const m = explainFailure('Failed to authenticate. API Error: 401 API key is invalid.');
  assert.match(m, /ANTHROPIC_API_KEY/);
  assert.equal(explainFailure('ディスクがいっぱいです'), 'ディスクがいっぱいです');
});

test('アプリのプレビューから起動した場合も外す', () => {
  // 実測では CLAUDECODE は付かず CLAUDE_AGENT_SDK_VERSION だけが付いていた。
  const r = childEnv({ CLAUDE_AGENT_SDK_VERSION: '0.3.0', ANTHROPIC_API_KEY: 'sk-host' });
  assert.equal(r.dropped, true);
  assert.equal('ANTHROPIC_API_KEY' in r.env, false);
});
