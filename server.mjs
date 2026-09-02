#!/usr/bin/env node
/**
 * SKILL.md ジェネレーター（ローカル用サーバ）
 *
 * 画面から受け取った説明をプロンプトに組み立て、裏で Claude CLI を起動し、
 * 生成の様子を SSE で画面へ流し、出来上がった SKILL.md 一式を返す。
 *
 * 127.0.0.1 だけで待ち受ける。ファイル書き出しの口を持つため、
 * 同じネットワークの別の機械から触れないようにするのは必須。
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { SKILL_OUTPUT_SCHEMA } from './public/shared/schema.mjs';
import { SYSTEM_PROMPT, buildPrompt, buildRetryPrompt, validateInput } from './public/shared/prompt.mjs';
import { validateSkill, isSafeRelativePath } from './public/shared/validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');

const HOST = '127.0.0.1';
const BASE_PORT = Number(process.env.PORT || 7788);
const PORT_TRIES = 20;

/** 差し替え可能にしておくと、本物を叩かずにテストが書ける。 */
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const MODEL = process.env.SKILLGEN_MODEL || 'fable';

/** 生成 1 回あたりの上限。超えたら子プロセスを止める。 */
const GENERATE_TIMEOUT_MS = Number(process.env.SKILLGEN_TIMEOUT_MS || 10 * 60 * 1000);

/**
 * 生成に道具は要らない。全部落とすと読み込む定義が減り、
 * 1 回あたりの費用と待ち時間がはっきり下がる（実測 $1.71 → $0.49、6.9 秒 → 3.0 秒）。
 */
const DISALLOWED_TOOLS = [
  'Bash', 'BashOutput', 'KillShell', 'Edit', 'Write', 'Read', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'NotebookEdit', 'Task', 'Agent', 'TodoWrite', 'SlashCommand',
].join(' ');

/**
 * 子プロセスへ渡す環境変数を決める。
 *
 * Claude Code の中からこのサーバを起動すると、ホストのセッション用の
 * ANTHROPIC_API_KEY が環境に入っている。子の claude はそれを本物の鍵とみなして使い、
 * 401 で落ちる（実測）。利用者本人のログインではないので、その場合だけ外す。
 * 自分の API キーで動かしたいときは SKILLGEN_KEEP_API_KEY=1 を付ける。
 */
export function childEnv(source = process.env) {
  const env = { ...source };
  // どの変数が入るかは起動のされ方で違う。実測では、アプリのプレビューから
  // 起動した場合 CLAUDECODE は付かず CLAUDE_AGENT_SDK_VERSION だけが付く。
  const launchedByClaudeCode =
    env.CLAUDECODE === '1' ||
    Boolean(env.CLAUDE_CODE_ENTRYPOINT) ||
    Boolean(env.CLAUDE_AGENT_SDK_VERSION);
  if (launchedByClaudeCode && env.ANTHROPIC_API_KEY && env.SKILLGEN_KEEP_API_KEY !== '1') {
    delete env.ANTHROPIC_API_KEY;
    return { env, dropped: true };
  }
  return { env, dropped: false };
}

/** 認証まわりの失敗は原因が分かりにくいので、確かめる場所まで書いて返す。 */
export function explainFailure(message) {
  if (/401|authenticate|api key|unauthorized/i.test(message)) {
    return `${message}
Claude CLI が認証できていません。ターミナルで claude を一度起動してログイン状態を確かめてください。
環境変数 ANTHROPIC_API_KEY に古い値が残っていると、ログイン済みでもこの失敗になります。`;
  }
  return message;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------- Claude 起動

/**
 * Claude CLI を 1 回走らせ、構造化出力を受け取る。
 * @param {string} prompt
 * @param {(text: string) => void} onLog  途中経過を画面へ流すための呼び出し
 * @param {AbortSignal} signal
 * @returns {Promise<object>} structured_output
 */
function runClaude(prompt, onLog, signal) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--model', MODEL,
      '--safe-mode',
      '--strict-mcp-config',
      '--permission-mode', 'dontAsk',
      '--system-prompt', SYSTEM_PROMPT,
      '--disallowed-tools', DISALLOWED_TOOLS,
      '--output-format', 'stream-json',
      '--verbose',
      '--json-schema', JSON.stringify(SKILL_OUTPUT_SCHEMA),
    ];

    const { env, dropped } = childEnv();
    if (dropped) {
      onLog('ホスト側の ANTHROPIC_API_KEY を外して起動します（claude 自身のログインを使います）。');
    }
    const child = spawn(CLAUDE_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'], env });

    let settled = false;
    let structured = null;
    let resultError = null;
    let stdoutRest = '';
    let stderrBuf = '';

    const timer = setTimeout(() => {
      onLog(`${Math.round(GENERATE_TIMEOUT_MS / 1000)} 秒を超えたので中止します。`);
      child.kill('SIGKILL');
    }, GENERATE_TIMEOUT_MS);

    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      err ? reject(err) : resolve(value);
    };

    // Claude CLI はプロンプトを引数ではなく標準入力から受け取らせる。
    // 引数で渡すと長い本文で取りこぼす。
    child.stdin.on('error', () => {});
    child.stdin.end(prompt, 'utf8');

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutRest += chunk;
      const lines = stdoutRest.split('\n');
      stdoutRest = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          continue;
        }
        handleMessage(msg);
      }
    });

    function handleMessage(msg) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        onLog(`Claude を起動しました（モデル: ${msg.model || MODEL}）。`);
        return;
      }
      if (msg.type === 'assistant') {
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text' && block.text.trim()) {
            onLog(block.text.trim().slice(0, 400));
          } else if (block.type === 'tool_use') {
            onLog('出力をまとめています…');
          }
        }
        return;
      }
      if (msg.type === 'result') {
        if (msg.is_error) {
          resultError = explainFailure(String(msg.result || msg.subtype || '生成に失敗しました。'));
          return;
        }
        structured = msg.structured_output ?? null;
        if (!structured && typeof msg.result === 'string') {
          try {
            structured = JSON.parse(msg.result);
          } catch {
            resultError = '結果を JSON として読み取れませんでした。';
          }
        }
        if (typeof msg.total_cost_usd === 'number') {
          onLog(`今回の費用: $${msg.total_cost_usd.toFixed(3)} / ${Math.round((msg.duration_ms ?? 0) / 100) / 10} 秒`);
        }
      }
    }

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      stderrBuf += c;
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
    });

    child.on('error', (err) => {
      finish(
        new Error(
          err.code === 'ENOENT'
            ? `Claude CLI（${CLAUDE_BIN}）が見つかりません。claude が使える状態か確認してください。`
            : `Claude CLI を起動できませんでした: ${err.message}`,
        ),
      );
    });

    child.on('close', (code) => {
      if (resultError) return finish(new Error(resultError));
      if (structured) return finish(null, structured);
      if (code !== 0) {
        return finish(
          new Error(
            explainFailure(
              `Claude CLI が異常終了しました（終了コード ${code}）。${stderrBuf.trim().slice(-500)}`,
            ),
          ),
        );
      }
      finish(new Error('Claude から結果が返りませんでした。'));
    });
  });
}

// ------------------------------------------------------------------ SSE 応答

function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  return {
    send(event, data) {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (!res.writableEnded) res.end();
    },
  };
}

async function handleGenerate(req, res) {
  const input = await readJson(req);
  const stream = openStream(res);
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  const log = (text) => stream.send('log', { text });

  try {
    const inputCheck = validateInput(input);
    if (!inputCheck.ok) {
      stream.send('error', { message: inputCheck.errors.join('\n') });
      return stream.close();
    }

    const basePrompt = buildPrompt(input);
    stream.send('status', { message: '内容を Claude に渡しています…' });

    let payload = await runClaude(basePrompt, log, controller.signal);
    let check = validateSkill(payload);

    if (!check.ok) {
      log(`検査で ${check.errors.length} 件見つかったので作り直します。`);
      for (const e of check.errors) log(`・${e}`);
      stream.send('status', { message: '指摘を伝えて作り直しています…' });
      const retryPrompt = buildRetryPrompt(basePrompt, check.errors);
      const retried = await runClaude(retryPrompt, log, controller.signal);
      const retryCheck = validateSkill(retried);
      // 作り直しても直らなかったときは、良くなった方を採用して警告付きで返す。
      if (retryCheck.ok || retryCheck.errors.length < check.errors.length) {
        payload = retried;
        check = retryCheck;
      }
    }

    stream.send('done', { result: payload, validation: check });
  } catch (err) {
    stream.send('error', { message: err.message });
  } finally {
    stream.close();
  }
}

// ------------------------------------------------------- ローカルへの書き出し

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function handleWrite(req, res) {
  const body = await readJson(req);
  const rawDir = typeof body?.targetDir === 'string' ? body.targetDir.trim() : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const skillMd = typeof body?.skillMd === 'string' ? body.skillMd : '';
  const extraFiles = Array.isArray(body?.extraFiles) ? body.extraFiles : [];

  if (rawDir === '') return sendJson(res, 400, { error: '書き出し先を入れてください。' });
  if (name === '') return sendJson(res, 400, { error: 'スキル名がありません。' });
  if (skillMd.trim() === '') return sendJson(res, 400, { error: 'SKILL.md の中身がありません。' });

  const parent = path.resolve(expandHome(rawDir));
  if (!path.isAbsolute(parent)) {
    return sendJson(res, 400, { error: '書き出し先は絶対パスで入れてください。' });
  }

  const skillDir = path.join(parent, name);
  const exists = await fs
    .stat(skillDir)
    .then(() => true)
    .catch(() => false);
  if (exists && body?.overwrite !== true) {
    return sendJson(res, 409, {
      error: `${skillDir} は既にあります。上書きしてよければ、もう一度押してください。`,
      needsOverwrite: true,
      path: skillDir,
    });
  }

  try {
    await fs.mkdir(skillDir, { recursive: true });
    const written = [];

    await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillMd, 'utf8');
    written.push(path.join(skillDir, 'SKILL.md'));

    for (const f of extraFiles) {
      if (!isSafeRelativePath(f?.path)) continue;
      const dest = path.join(skillDir, f.path);
      // path.join の後にもう一度、スキルフォルダの中に収まっているかを確かめる。
      if (!dest.startsWith(skillDir + path.sep)) continue;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, String(f.content ?? ''), 'utf8');
      written.push(dest);
    }

    return sendJson(res, 200, { ok: true, dir: skillDir, written });
  } catch (err) {
    return sendJson(res, 500, { error: `書き出せませんでした: ${err.message}` });
  }
}

// ----------------------------------------------------------------- 下ごしらえ

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2_000_000) {
        reject(new Error('送られてきた内容が大きすぎます。'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

export function createServer() {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/api/generate') return await handleGenerate(req, res);
      if (req.method === 'POST' && req.url === '/api/write') return await handleWrite(req, res);
      if (req.method === 'GET' && req.url === '/api/health') {
        return sendJson(res, 200, { ok: true, model: MODEL, bin: CLAUDE_BIN });
      }
      if (req.method === 'GET') return await serveStatic(req, res);
      res.writeHead(405).end('Method not allowed');
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.end();
    }
  });

  // 既定のままだと、生成が終わる前に Node 側が接続を切ってしまう。
  // requestTimeout の既定 300 秒は生成 1 回より短いことがあり、
  // keepAliveTimeout の既定 5 秒はブラウザの接続使い回しを落とす。
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 120_000;
  server.timeout = 0;
  return server;
}

export function listen(server, basePort = BASE_PORT, tries = PORT_TRIES) {
  return new Promise((resolve, reject) => {
    let port = basePort;
    let left = tries;
    const attempt = () => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && left-- > 0) {
          port += 1;
          attempt();
        } else {
          reject(err);
        }
      });
      // port 0 を渡すと OS が空きを割り当てるので、実際に開いた番号を返す。
      server.listen(port, HOST, () => resolve(server.address().port));
    };
    attempt();
  });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const server = createServer();
  const port = await listen(server);
  console.log(`SKILL.md ジェネレーターを起動しました: http://${HOST}:${port}`);
  console.log(`使うモデル: ${MODEL} / Claude CLI: ${CLAUDE_BIN}`);
}
