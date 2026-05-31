import { saveMeeting, getAllMeetings, getMeeting, deleteMeeting } from './db.js';
import { generateSummary } from './summary.js';

// ─── State ────────────────────────────────────────────────
const state = {
  worker: null,
  workerReady: false,
  currentMeeting: null,
  meetings: [],
  tab: 'summary',       // 'summary' | 'transcript'
  searchQuery: '',
};

// ─── Worker 初始化 ────────────────────────────────────────
function initWorker() {
  state.worker = new Worker('./worker.js', { type: 'module' });
  state.worker.onmessage = handleWorkerMessage;
  // 預先載入 medium 模型（中英夾雜最佳）
  state.worker.postMessage({ type: 'load', payload: { model: 'whisper-medium' } });
}

function handleWorkerMessage({ data }) {
  switch (data.type) {
    case 'loading':
      setStatus(data.message, false);
      break;

    case 'download_progress':
      setStatus(`下載模型 ${data.percent}%（${data.file}）`, false);
      document.querySelector('#progress-bar').style.width = data.percent + '%';
      break;

    case 'ready':
      state.workerReady = true;
      document.querySelector('#import-btn').disabled = false;
      document.querySelector('#model-status').textContent = '模型就緒';
      document.querySelector('#model-status').className = 'status-ready';
      document.querySelector('#progress-wrap').hidden = true;
      break;

    case 'transcribing':
      setStatus(data.message, false);
      break;

    case 'done':
      onTranscriptionDone(data.segments);
      break;

    case 'error':
      showError(data.message);
      showScreen('home');
      break;
  }
}

// ─── Audio 抽取 ───────────────────────────────────────────
async function extractAudio(file) {
  setStatus('抽取音訊...', false);
  const arrayBuffer = await file.arrayBuffer();

  const tmpCtx = new AudioContext();
  const decoded = await tmpCtx.decodeAudioData(arrayBuffer);
  await tmpCtx.close();

  // 重採樣到 16kHz（Whisper 標準）
  const TARGET_SR = 16000;
  const offCtx = new OfflineAudioContext(
    1,
    Math.ceil(decoded.duration * TARGET_SR),
    TARGET_SR
  );
  const src = offCtx.createBufferSource();
  src.buffer = decoded;
  // Mix down to mono
  const merger = offCtx.createChannelMerger(1);
  const gain = offCtx.createGain();
  gain.gain.value = 1 / decoded.numberOfChannels;
  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    const splitter = offCtx.createChannelSplitter(decoded.numberOfChannels);
    src.connect(splitter);
    splitter.connect(gain, ch, 0);
  }
  gain.connect(offCtx.destination);
  src.start(0);

  const resampled = await offCtx.startRendering();
  return resampled.getChannelData(0); // Float32Array
}

// ─── 匯入流程 ─────────────────────────────────────────────
async function handleFileSelect(file) {
  if (!file || !file.type.startsWith('video/')) {
    showError('請選擇影片檔案');
    return;
  }

  showScreen('processing');
  setStatus('讀取影片...', false);

  try {
    const audio = await extractAudio(file);

    const meeting = {
      id: crypto.randomUUID(),
      title: defaultTitle(),
      date: Date.now(),
      fileName: file.name,
      segments: [],
      summary: null,
    };
    state.currentMeeting = meeting;

    setStatus('送出語音辨識...', false);
    state.worker.postMessage(
      { type: 'transcribe', payload: { audio, language: 'zh' } },
      [audio.buffer]   // 轉移所有權，避免複製大陣列
    );
  } catch (err) {
    showError('影片讀取失敗：' + err.message);
    showScreen('home');
  }
}

async function onTranscriptionDone(segments) {
  const meeting = state.currentMeeting;
  if (!meeting) return;

  setStatus('整理摘要...', false);
  meeting.segments = segments;
  meeting.summary  = generateSummary(segments);

  await saveMeeting(meeting);
  state.meetings = await getAllMeetings();

  showMeeting(meeting);
}

// ─── 畫面切換 ─────────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(el => {
    el.hidden = el.id !== `screen-${name}`;
  });
}

function showMeeting(meeting) {
  state.currentMeeting = meeting;
  state.tab = 'summary';
  state.searchQuery = '';
  renderMeetingDetail(meeting);
  showScreen('detail');
}

// ─── Render: Home ─────────────────────────────────────────
function renderHome() {
  const list = document.querySelector('#meeting-list');
  const empty = document.querySelector('#empty-state');

  if (state.meetings.length === 0) {
    list.hidden = true;
    empty.hidden = false;
    return;
  }

  list.hidden = false;
  empty.hidden = true;
  list.innerHTML = state.meetings.map(m => {
    const date = new Date(m.date).toLocaleString('zh-TW', {
      month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    const preview = m.summary?.keyPoints?.[0] ?? m.segments?.[0]?.text ?? '—';
    return `
      <div class="card meeting-item" data-id="${m.id}">
        <div class="meeting-item-header">
          <span class="meeting-title">${escHtml(m.title)}</span>
          <button class="btn-delete" data-id="${m.id}" title="刪除">×</button>
        </div>
        <div class="meeting-date">${date}</div>
        <div class="meeting-preview">${escHtml(preview)}</div>
      </div>`;
  }).join('');
}

// ─── Render: Detail ──────────────────────────────────────
function renderMeetingDetail(meeting) {
  document.querySelector('#detail-title').textContent = meeting.title;

  // Tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === state.tab);
  });

  // 搜尋列只在逐字稿 tab 顯示
  document.querySelector('#search-bar').hidden = (state.tab !== 'transcript');

  if (state.tab === 'summary') {
    renderSummaryTab(meeting.summary);
  } else {
    renderTranscriptTab(meeting.segments);
  }
}

function renderSummaryTab(summary) {
  const el = document.querySelector('#tab-content');
  if (!summary) { el.innerHTML = '<p class="empty-msg">無摘要</p>'; return; }

  const section = (title, icon, items, cls = '') => {
    if (!items?.length) return '';
    const rows = items.map(t => `<li>${escHtml(t)}</li>`).join('');
    return `<div class="summary-section ${cls}">
      <div class="section-title">${icon} ${title}</div>
      <ul>${rows}</ul>
    </div>`;
  };

  const tags = (items) => {
    if (!items?.length) return '';
    const chips = items.map(t => `<span class="chip">${escHtml(t)}</span>`).join('');
    return `<div class="summary-section">
      <div class="section-title">🏷 關鍵詞</div>
      <div class="chips">${chips}</div>
    </div>`;
  };

  el.innerHTML =
    section('重點摘要',  '💡', summary.keyPoints)   +
    section('待辦事項',  '☑️', summary.actionItems, 'action') +
    section('決議',     '✅', summary.decisions,   'decision') +
    tags(summary.topics);
}

function renderTranscriptTab(segments) {
  const el = document.querySelector('#tab-content');
  const q  = state.searchQuery.trim().toLowerCase();

  const filtered = q
    ? segments.filter(s => s.text.toLowerCase().includes(q))
    : segments;

  if (!filtered.length) {
    el.innerHTML = '<p class="empty-msg">無內容</p>';
    return;
  }

  el.innerHTML = filtered.map(s => {
    const t   = fmtTime(s.start);
    const txt = q
      ? escHtml(s.text).replace(new RegExp(escRe(q), 'gi'),
          m => `<mark>${m}</mark>`)
      : escHtml(s.text);
    return `<div class="segment">
      <span class="seg-time">${t}</span>
      <span class="seg-text">${txt}</span>
    </div>`;
  }).join('');
}

// ─── Export ───────────────────────────────────────────────
function exportText(meeting) {
  const lines = [`# ${meeting.title}`, ''];
  const { summary, segments } = meeting;

  if (summary) {
    if (summary.keyPoints?.length) {
      lines.push('## 重點', ...summary.keyPoints.map(t => `• ${t}`), '');
    }
    if (summary.actionItems?.length) {
      lines.push('## 待辦事項', ...summary.actionItems.map(t => `- [ ] ${t}`), '');
    }
    if (summary.decisions?.length) {
      lines.push('## 決議', ...summary.decisions.map(t => `✓ ${t}`), '');
    }
  }

  lines.push('## 逐字稿', '');
  lines.push(...segments.map(s => `[${fmtTime(s.start)}] ${s.text}`));

  return lines.join('\n');
}

// ─── Event Binding ────────────────────────────────────────
function bindEvents() {
  // 匯入按鈕
  document.querySelector('#import-btn').addEventListener('click', () => {
    document.querySelector('#file-input').click();
  });
  document.querySelector('#file-input').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) handleFileSelect(file);
  });

  // 會議列表點擊
  document.querySelector('#meeting-list').addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('.btn-delete');
    if (deleteBtn) {
      if (!confirm('確定刪除這筆會議紀錄？')) return;
      await deleteMeeting(deleteBtn.dataset.id);
      state.meetings = await getAllMeetings();
      renderHome();
      return;
    }
    const item = e.target.closest('.meeting-item');
    if (item) {
      const meeting = await getMeeting(item.dataset.id);
      if (meeting) showMeeting(meeting);
    }
  });

  // 返回按鈕
  document.querySelector('#btn-back').addEventListener('click', async () => {
    state.meetings = await getAllMeetings();
    renderHome();
    showScreen('home');
  });

  // Tab 切換
  document.querySelector('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    renderMeetingDetail(state.currentMeeting);
  });

  // 搜尋（逐字稿）
  document.querySelector('#search-input').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    if (state.tab === 'transcript') {
      renderTranscriptTab(state.currentMeeting.segments);
    }
  });

  // 清除搜尋
  document.querySelector('#search-clear').addEventListener('click', () => {
    document.querySelector('#search-input').value = '';
    state.searchQuery = '';
    renderTranscriptTab(state.currentMeeting.segments);
  });

  // 編輯標題
  document.querySelector('#btn-edit-title').addEventListener('click', () => {
    const newTitle = prompt('編輯標題', state.currentMeeting.title);
    if (newTitle && newTitle.trim()) {
      state.currentMeeting.title = newTitle.trim();
      saveMeeting(state.currentMeeting);
      document.querySelector('#detail-title').textContent = state.currentMeeting.title;
    }
  });

  // 分享/匯出
  document.querySelector('#btn-share').addEventListener('click', async () => {
    const text = exportText(state.currentMeeting);
    if (navigator.share) {
      await navigator.share({ title: state.currentMeeting.title, text });
    } else {
      await navigator.clipboard.writeText(text);
      alert('已複製到剪貼簿');
    }
  });
}

// ─── Helpers ──────────────────────────────────────────────
function setStatus(msg, done) {
  document.querySelector('#processing-msg').textContent = msg;
}

function showError(msg) {
  alert(msg);
}

function defaultTitle() {
  return '會議 ' + new Date().toLocaleString('zh-TW', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtTime(sec) {
  if (!sec) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Boot ─────────────────────────────────────────────────
async function main() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  bindEvents();
  initWorker();

  state.meetings = await getAllMeetings();
  renderHome();
  showScreen('home');
}

main();
