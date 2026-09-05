import { QUESTIONS, SYSTEM_PROMPT, buildPrompt, validateInput } from './shared/prompt.mjs';
import { SKILL_OUTPUT_SCHEMA } from './shared/schema.mjs';
import { validateSkill, isSafeRelativePath } from './shared/validate.mjs';

const $ = (id) => document.getElementById(id);

/** ブラウザから直接 Claude を呼ぶときの設定。 */
const SDK = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.124.0/+esm';
const MODEL = 'claude-fable-5-1';
const KEY_STORAGE = 'skillgen.apiKey';

const state = {
  mode: 'guided',
  result: null,
  prompt: '',
  apiKey: '',
  controller: null,
};

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* --------------------------------------------------------------- 入力欄 */

for (const q of QUESTIONS) {
  const label = document.createElement('label');
  label.className = 'field';
  label.innerHTML = `
    <span class="field-label">${esc(q.label)}${q.required ? '<span class="req">必須</span>' : ''}</span>
    <textarea id="q-${q.id}" rows="${q.rows}" placeholder="${esc(q.placeholder)}"></textarea>
    <span class="field-hint">${esc(q.hint)}</span>`;
  $('guidedPane').appendChild(label);
}

function setMode(mode) {
  state.mode = mode;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-on', tab.dataset.mode === mode);
  }
  $('guidedPane').hidden = mode !== 'guided';
  $('freeformPane').hidden = mode !== 'freeform';
  $('formError').hidden = true;
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => setMode(tab.dataset.mode));
}

function collect() {
  if (state.mode === 'freeform') return { mode: 'freeform', text: $('freeText').value };
  const answers = {};
  for (const q of QUESTIONS) answers[q.id] = $(`q-${q.id}`).value;
  return { mode: 'guided', answers };
}

/* ------------------------------------------------------------- API キー */

function readStoredKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

function applyKey(key) {
  state.apiKey = key;
  const on = Boolean(key);
  $('keyState').textContent = on
    ? `設定済み（${key.slice(0, 7)}…${key.slice(-4)}）。このページの中で最後まで作ります。`
    : 'まだ設定されていません。';
  $('keyState').className = `key-state ${on ? 'on' : 'off'}`;
  $('submitBtn').textContent = on ? 'SKILL.md を作る' : '貼り付け用の指示文を作る';
  $('wayPaste').classList.toggle('is-on', !on);
  $('wayAuto').classList.toggle('is-on', on);
  if (on) $('apiKey').value = '';
}

$('saveKey').addEventListener('click', () => {
  const key = $('apiKey').value.trim();
  if (!key) return;
  try {
    localStorage.setItem(KEY_STORAGE, key);
  } catch {
    /* 保存できなくても、このページを開いている間は使える */
  }
  applyKey(key);
});

$('clearKey').addEventListener('click', () => {
  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* 消せなくても状態は落とす */
  }
  $('apiKey').value = '';
  applyKey('');
});

/* --------------------------------------------------------------- 生成 */

const ERROR_COPY = {
  401: 'API キーが受け付けられませんでした。キーを確かめて入れ直してください。',
  403: 'この API キーではこのモデルを使えません。Anthropic のコンソールで権限を確かめてください。',
  429: '短い時間に何度も頼みすぎました。1〜2 分おいてから、もう一度押してください。',
  529: 'Claude 側が混み合っています。少し待ってから、もう一度押してください。',
};

function describeError(err) {
  if (err && err.name === 'AbortError') return '';
  const status = err && err.status;
  if (status && ERROR_COPY[status]) return ERROR_COPY[status];
  if (status >= 500) return 'Claude 側で問題が起きました。少し待ってから、もう一度押してください。';
  if (err && /Failed to fetch|NetworkError|dynamically imported/i.test(String(err.message))) {
    return 'Claude に繋がりませんでした。通信を確かめるか、API キーを使わずに指示文をコピーする方法をお試しください。';
  }
  return `うまくいきませんでした：${(err && err.message) || err}`;
}

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('formError').hidden = true;
  $('result').hidden = true;

  const input = collect();
  const check = validateInput(input);
  if (!check.ok) {
    $('formError').textContent = check.errors.join('\n');
    $('formError').hidden = false;
    return;
  }

  const prompt = buildPrompt(input);
  if (!state.apiKey) {
    showPrompt(prompt);
    return;
  }
  await generate(prompt);
});

async function generate(prompt) {
  $('submitBtn').disabled = true;
  $('stopBtn').hidden = false;
  $('progress').hidden = false;
  $('progressMsg').textContent = 'Claude を呼んでいます…';
  $('log').textContent = '';
  $('counter').textContent = '';

  state.controller = new AbortController();

  try {
    const { default: Anthropic } = await import(SDK);
    const client = new Anthropic({ apiKey: state.apiKey, dangerouslyAllowBrowser: true });

    // 出力が長いので必ずストリームで受ける。非ストリームだと途中で切られる。
    const stream = client.messages.stream(
      {
        model: MODEL,
        max_tokens: 32000,
        // Fable 5.1 は thinking が常時オン。深さは effort で決める。
        output_config: {
          effort: 'high',
          format: { type: 'json_schema', schema: SKILL_OUTPUT_SCHEMA },
        },
        messages: [{ role: 'user', content: prompt }],
      },
      { signal: state.controller.signal },
    );

    stream.on('text', (_delta, snapshot) => {
      $('progressMsg').textContent = '書いています…';
      $('log').textContent = snapshot;
      $('counter').textContent = `${snapshot.length.toLocaleString('ja-JP')} 文字`;
      $('log').scrollTop = $('log').scrollHeight;
    });

    const message = await stream.finalMessage();

    if (message.stop_reason === 'refusal') {
      throw new Error('Claude がこの内容の作成を断りました。書き方を変えて、もう一度お試しください。');
    }

    const payload = message.parsed_output ?? parseFromText(message);
    if (!payload) {
      throw new Error('返ってきた下書きが途中で切れていました。回答を短くして、もう一度お試しください。');
    }

    $('progress').hidden = true;
    showResult(payload);
  } catch (err) {
    $('progress').hidden = true;
    const copy = describeError(err);
    if (copy) {
      $('formError').textContent = copy;
      $('formError').hidden = false;
    }
  } finally {
    $('submitBtn').disabled = false;
    $('stopBtn').hidden = true;
    state.controller = null;
  }
}

/** parsed_output が来なかったときに、本文から JSON を拾う逃げ道。 */
function parseFromText(message) {
  const text = (message.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

$('stopBtn').addEventListener('click', () => state.controller && state.controller.abort());

$('resetBtn').addEventListener('click', () => {
  for (const ta of document.querySelectorAll('textarea')) ta.value = '';
  $('formError').hidden = true;
  $('result').hidden = true;
});

/* ------------------------------------------------------------- 結果表示 */

function showResult(result) {
  state.result = result;
  state.prompt = '';
  $('handoff').hidden = true;
  $('resultTitle').textContent = 'SKILL.md';
  $('skillName').textContent = `${result.name || 'skill'}/SKILL.md`;
  $('skillMd').textContent = result.skillMd || '';

  renderCheck(validateSkill(result));
  renderExtras(result.extraFiles || []);

  const notes = (result.notes || '').trim();
  $('notesBox').hidden = !notes;
  $('notesBox').textContent = notes;

  $('result').hidden = false;
  $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showPrompt(prompt) {
  const full = [
    '以下の決まりに従って SKILL.md を作ってください。',
    '',
    SYSTEM_PROMPT,
    '',
    '---',
    '',
    prompt,
    '',
    'SKILL.md の全文と、必要なら references/ や scripts/ のファイルも書いてください。',
  ].join('\n');

  state.result = { name: 'skill', skillMd: full, extraFiles: [] };
  state.prompt = full;

  $('checkBox').replaceChildren();
  $('handoff').hidden = false;
  $('resultTitle').textContent = 'Claude に貼る指示文';
  $('skillName').textContent = 'コピーして貼ってください';
  $('skillMd').textContent = full;
  $('extras').replaceChildren();
  $('notesBox').hidden = true;

  $('result').hidden = false;
  $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderCheck(v) {
  const box = document.createElement('div');
  if (v.errors.length) {
    box.className = 'check is-bad';
    box.innerHTML = `<b>直したほうがよい点が ${v.errors.length} 件あります。</b><ul>${v.errors
      .map((e) => `<li>${esc(e)}</li>`)
      .join('')}</ul>`;
  } else if (v.warnings.length) {
    box.className = 'check is-warn';
    box.innerHTML = `<b>そのまま使えますが、${v.warnings.length} 件見ておくとよい点があります。</b><ul>${v.warnings
      .map((w) => `<li>${esc(w)}</li>`)
      .join('')}</ul>`;
  } else {
    box.className = 'check is-ok';
    box.textContent = '検査を通りました。そのまま使えます。';
  }
  $('checkBox').replaceChildren(box);
}

function renderExtras(files) {
  const nodes = [];
  for (const [i, f] of files.entries()) {
    if (!f || !isSafeRelativePath(f.path)) continue;
    const box = document.createElement('div');
    box.className = 'extra';
    box.innerHTML = `
      <div class="result-head">
        <h3>${esc(f.path)}</h3>
        <div class="result-meta">
          <button type="button" class="copy" data-copy="extra" data-index="${i}">コピー</button>
        </div>
      </div>
      <p class="extra-purpose">${esc(f.purpose || '')}</p>
      <pre class="code"><code></code></pre>`;
    box.querySelector('code').textContent = f.content;
    nodes.push(box);
  }
  $('extras').replaceChildren(...nodes);
}

/* --------------------------------------------------------------- コピー */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function flash(button, label) {
  const before = button.textContent;
  button.textContent = label;
  button.classList.add('is-done');
  setTimeout(() => {
    button.textContent = before;
    button.classList.remove('is-done');
  }, 1600);
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('.copy');
  if (!button || !state.result) return;
  if (button.dataset.copy === 'skillMd') {
    await copyText(state.result.skillMd);
    flash(button, 'コピーしました');
  } else if (button.dataset.copy === 'extra') {
    const f = state.result.extraFiles[Number(button.dataset.index)];
    if (f) {
      await copyText(f.content);
      flash(button, 'コピーしました');
    }
  }
});

async function handoff(url) {
  if (!state.prompt) return;
  await copyText(state.prompt);
  window.open(url, '_blank', 'noopener');
}

$('openClaude').addEventListener('click', () => handoff('https://claude.ai/new'));
$('openGpt').addEventListener('click', () => handoff('https://chatgpt.com/'));

/* ----------------------------------------------------------------- 起動 */

setMode('guided');
applyKey(readStoredKey());
