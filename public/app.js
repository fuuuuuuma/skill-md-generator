import { QUESTIONS, buildPrompt, validateInput, SYSTEM_PROMPT } from './shared/prompt.mjs';

const $ = (id) => document.getElementById(id);

const el = {
  form: $('form'),
  guidedPane: $('guidedPane'),
  freeformPane: $('freeformPane'),
  freeText: $('freeText'),
  submitBtn: $('submitBtn'),
  resetBtn: $('resetBtn'),
  formError: $('formError'),
  modeNote: $('modeNote'),
  progress: $('progress'),
  progressMsg: $('progressMsg'),
  logBox: $('logBox'),
  log: $('log'),
  result: $('result'),
  checkBox: $('checkBox'),
  resultTitle: document.querySelector('.result-head h2'),
  skillName: $('skillName'),
  skillMd: $('skillMd'),
  extras: $('extras'),
  notesBox: $('notesBox'),
  writeBox: $('writeBox'),
  writeDir: $('writeDir'),
  writeDirPreview: $('writeDirPreview'),
  writeBtn: $('writeBtn'),
  writeMsg: $('writeMsg'),
};

const state = {
  mode: 'guided',
  canGenerate: false, // 裏で claude を起動できる環境か
  result: null,
  overwriteArmed: false,
};

// --------------------------------------------------------------- 画面の下地

function renderQuestions() {
  el.guidedPane.innerHTML = '';
  for (const q of QUESTIONS) {
    const label = document.createElement('label');
    label.className = 'field';
    label.innerHTML = `
      <span class="field-label">${escapeHtml(q.label)}${q.required ? '<span class="req">必須</span>' : ''}</span>
      <textarea id="q-${q.id}" rows="${q.rows}" placeholder="${escapeHtml(q.placeholder)}"></textarea>
      <span class="field-hint">${escapeHtml(q.hint)}</span>`;
    el.guidedPane.appendChild(label);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function collectInput() {
  if (state.mode === 'freeform') {
    return { mode: 'freeform', text: el.freeText.value };
  }
  const answers = {};
  for (const q of QUESTIONS) answers[q.id] = $(`q-${q.id}`).value;
  return { mode: 'guided', answers };
}

// --------------------------------------------- どちらの環境で開かれているか

async function detectEnvironment() {
  try {
    const res = await fetch('./api/health', { method: 'GET' });
    if (!res.ok) throw new Error('no');
    const info = await res.json();
    state.canGenerate = info.ok === true;
  } catch {
    state.canGenerate = false;
  }

  if (state.canGenerate) {
    el.modeNote.hidden = true;
    el.submitBtn.textContent = 'SKILL.md を作る';
  } else {
    el.modeNote.hidden = false;
    el.modeNote.innerHTML = `
      <h3>ここはお試し版です</h3>
      <p>
        生成は Claude Code の CLI を通して行うため、この公開ページの中では実行できません。
        ここでは <b>そのまま Claude Code に貼れるプロンプト</b> を組み立てます。
        できたものを Claude Code のチャットに貼れば、同じ SKILL.md が手に入ります。
      </p>
      <p>
        自分のパソコンで動かすと、コピーと書き出しまで自動で終わります。
        <code>node server.mjs</code> を実行して <code>http://127.0.0.1:7788</code> を開いてください。
      </p>`;
    el.submitBtn.textContent = '貼り付け用のプロンプトを作る';
  }
}

// ------------------------------------------------------------------ 生成

async function onSubmit(event) {
  event.preventDefault();
  el.formError.hidden = true;
  el.result.hidden = true;
  state.result = null;
  state.overwriteArmed = false;

  const input = collectInput();
  const check = validateInput(input);
  if (!check.ok) {
    el.formError.textContent = check.errors.join('\n');
    el.formError.hidden = false;
    return;
  }

  if (!state.canGenerate) {
    showPromptOnly(buildPrompt(input));
    return;
  }

  el.submitBtn.disabled = true;
  el.progress.hidden = false;
  el.log.textContent = '';
  el.progressMsg.textContent = '作っています…';

  try {
    await streamGenerate(input);
  } catch (err) {
    el.formError.textContent = err.message;
    el.formError.hidden = false;
    el.progress.hidden = true;
  } finally {
    el.submitBtn.disabled = false;
  }
}

function appendLog(text) {
  el.log.textContent += `${text}\n`;
  el.log.scrollTop = el.log.scrollHeight;
}

async function streamGenerate(input) {
  const res = await fetch('./api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok || !res.body) throw new Error(`サーバから応答がありません（${res.status}）。`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE は空行 2 つで 1 通。最後の不完全な塊は次の読み込みまで持ち越す。
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) handleEvent(parseEvent(chunk));
  }
}

function parseEvent(chunk) {
  let name = 'message';
  const dataLines = [];
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event: ')) name = line.slice(7).trim();
    else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
  }
  let data = null;
  try {
    data = JSON.parse(dataLines.join('\n'));
  } catch {
    data = null;
  }
  return { name, data };
}

function handleEvent({ name, data }) {
  if (!data) return;
  if (name === 'status') el.progressMsg.textContent = data.message;
  else if (name === 'log') appendLog(data.text);
  else if (name === 'done') {
    el.progress.hidden = true;
    showResult(data.result, data.validation);
  } else if (name === 'error') {
    el.progress.hidden = true;
    el.formError.textContent = data.message;
    el.formError.hidden = false;
    el.logBox.open = true;
  }
}

// ---------------------------------------------------------------- 結果表示

function showResult(result, validation) {
  state.result = result;
  el.resultTitle.textContent = 'SKILL.md';
  el.skillName.textContent = `${result.name}/SKILL.md`;
  el.skillMd.textContent = result.skillMd;

  renderCheck(validation);
  renderExtras(result.extraFiles || []);

  if (result.notes && result.notes.trim()) {
    el.notesBox.hidden = false;
    el.notesBox.textContent = result.notes.trim();
  } else {
    el.notesBox.hidden = true;
  }

  el.writeBox.hidden = !state.canGenerate;
  el.writeDirPreview.textContent = result.name;
  el.writeMsg.hidden = true;
  el.writeBtn.textContent = 'ここに書き出す';

  el.result.hidden = false;
  el.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showPromptOnly(prompt) {
  const full = [
    '以下の指示に従って SKILL.md を作ってください。',
    '',
    '## 守ってほしい書き方',
    SYSTEM_PROMPT,
    '',
    '---',
    '',
    prompt,
  ].join('\n');

  state.result = { name: 'skill', skillMd: full, extraFiles: [], notes: '' };
  el.resultTitle.textContent = 'Claude Code に貼るプロンプト';
  el.skillName.textContent = 'そのままコピーして貼ってください';
  el.skillMd.textContent = full;
  el.checkBox.innerHTML = '';
  el.extras.innerHTML = '';
  el.notesBox.hidden = true;
  el.writeBox.hidden = true;
  el.result.hidden = false;
  el.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderCheck(validation) {
  el.checkBox.innerHTML = '';
  if (!validation) return;

  const { errors = [], warnings = [] } = validation;
  const div = document.createElement('div');

  if (errors.length > 0) {
    div.className = 'check is-bad';
    div.innerHTML = `<b>直したほうがよい点が ${errors.length} 件あります。</b><ul>${errors
      .map((e) => `<li>${escapeHtml(e)}</li>`)
      .join('')}</ul>`;
  } else if (warnings.length > 0) {
    div.className = 'check is-warn';
    div.innerHTML = `<b>そのまま使えますが、${warnings.length} 件見ておくとよい点があります。</b><ul>${warnings
      .map((w) => `<li>${escapeHtml(w)}</li>`)
      .join('')}</ul>`;
  } else {
    div.className = 'check is-ok';
    div.textContent = '検査を通りました。そのまま使えます。';
  }
  el.checkBox.appendChild(div);
}

function renderExtras(files) {
  el.extras.innerHTML = '';
  for (const [i, f] of files.entries()) {
    const box = document.createElement('div');
    box.className = 'extra';
    box.innerHTML = `
      <div class="result-head">
        <h3>${escapeHtml(f.path)}</h3>
        <div class="result-meta">
          <button type="button" class="copy" data-copy="extra" data-index="${i}">コピー</button>
        </div>
      </div>
      <p class="extra-purpose">${escapeHtml(f.purpose || '')}</p>
      <pre class="code"><code></code></pre>`;
    box.querySelector('code').textContent = f.content;
    el.extras.appendChild(box);
  }
}

// ------------------------------------------------------------------ コピー

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // クリップボード API が使えないときの逃げ道。
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const before = button.textContent;
  button.textContent = 'コピーしました';
  button.classList.add('is-done');
  setTimeout(() => {
    button.textContent = before;
    button.classList.remove('is-done');
  }, 1600);
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('.copy');
  if (!button || !state.result) return;
  if (button.dataset.copy === 'skillMd') copyText(state.result.skillMd, button);
  else if (button.dataset.copy === 'extra') {
    const f = state.result.extraFiles[Number(button.dataset.index)];
    if (f) copyText(f.content, button);
  }
});

// -------------------------------------------------------------- 書き出し

async function onWrite() {
  if (!state.result) return;
  el.writeBtn.disabled = true;
  el.writeMsg.hidden = true;

  try {
    const res = await fetch('./api/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetDir: el.writeDir.value,
        name: state.result.name,
        skillMd: state.result.skillMd,
        extraFiles: state.result.extraFiles || [],
        overwrite: state.overwriteArmed,
      }),
    });
    const data = await res.json();

    if (res.ok && data.ok) {
      state.overwriteArmed = false;
      el.writeBtn.textContent = 'ここに書き出す';
      setMessage(`${data.written.length} 個のファイルを ${data.dir} に置きました。`, 'is-ok');
    } else if (data.needsOverwrite) {
      state.overwriteArmed = true;
      el.writeBtn.textContent = '上書きして書き出す';
      setMessage(data.error, 'is-bad');
    } else {
      setMessage(data.error || '書き出せませんでした。', 'is-bad');
    }
  } catch (err) {
    setMessage(err.message, 'is-bad');
  } finally {
    el.writeBtn.disabled = false;
  }
}

function setMessage(text, cls) {
  el.writeMsg.className = `write-msg ${cls}`;
  el.writeMsg.textContent = text;
  el.writeMsg.hidden = false;
}

// ------------------------------------------------------------------ 起動

function switchMode(mode) {
  state.mode = mode;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-on', tab.dataset.mode === mode);
  }
  el.guidedPane.hidden = mode !== 'guided';
  el.freeformPane.hidden = mode !== 'freeform';
  el.formError.hidden = true;
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => switchMode(tab.dataset.mode));
}

el.form.addEventListener('submit', onSubmit);
el.writeBtn.addEventListener('click', onWrite);
el.resetBtn.addEventListener('click', () => {
  for (const ta of document.querySelectorAll('textarea')) ta.value = '';
  el.formError.hidden = true;
  el.result.hidden = true;
});

renderQuestions();
switchMode('guided');
detectEnvironment();
