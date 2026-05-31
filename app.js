import { saveMeeting, getAllMeetings, getMeeting, deleteMeeting } from './db.js';
import { generateSummary } from './summary.js';

// ── State ────────────────────────────────────────────────
const S = {
  // 即時錄音
  recognition: null,
  recording: false,
  segments: [],
  interimText: '',
  startTime: null,
  timerInterval: null,
  // 影片匯入
  worker: null,
  workerReady: false,
  // 通用
  meetings: [],
  current: null,
  tab: 'summary',
  search: '',
};

// ── Whisper Worker (for video import) ────────────────────
function initWorker() {
  S.worker = new Worker('./worker.js', { type: 'module' });
  S.worker.onmessage = ({ data }) => {
    switch (data.type) {
      case 'status':
        setImportUI(data.text, null, true);
        break;
      case 'download':
        setImportUI(`下載模型 ${data.pct}%…`, data.pct, true);
        break;
      case 'ready':
        S.workerReady = true;
        $('btn-import').disabled = false;
        hideImportUI();
        // 模型剛載入完成，直接開啟檔案選擇
        $('file-input').click();
        break;
      case 'done':
        onVideoTranscribed(data.segments);
        break;
      case 'error':
        alert(data.text);
        hideImportUI();
        break;
    }
  };
  // 預先載入 whisper-small（背景下載，不擋 UI）
  S.worker.postMessage({ type: 'load', payload: { model: 'whisper-small' } });
}

function setImportUI(msg, pct, show) {
  const el = $('import-status');
  el.hidden = !show;
  $('import-msg').textContent = msg;
  if (pct !== null) $('import-bar').style.width = pct + '%';
}
function hideImportUI() { $('import-status').hidden = true; }

// ── Audio extraction from video ───────────────────────────
async function extractAudio(file) {
  setImportUI('抽取音訊…', null, true);
  const buf = await file.arrayBuffer();
  const tmpCtx = new AudioContext();
  const decoded = await tmpCtx.decodeAudioData(buf);
  await tmpCtx.close();

  const TARGET = 16000;
  const offCtx = new OfflineAudioContext(
    1, Math.ceil(decoded.duration * TARGET), TARGET
  );
  const src   = offCtx.createBufferSource();
  const gain  = offCtx.createGain();
  gain.gain.value = 1 / decoded.numberOfChannels;
  src.buffer = decoded;
  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    const sp = offCtx.createChannelSplitter(decoded.numberOfChannels);
    src.connect(sp);
    sp.connect(gain, ch, 0);
  }
  gain.connect(offCtx.destination);
  src.start(0);

  const resampled = await offCtx.startRendering();
  return resampled.getChannelData(0);
}

async function handleVideoImport(file) {
  if (!file) return;
  $('btn-import').disabled = true;
  try {
    const audio = await extractAudio(file);
    setImportUI('送出語音辨識…', null, true);
    S.worker.postMessage(
      { type: 'transcribe', payload: { audio } },
      [audio.buffer]
    );
    // 暫存 title 用
    S._pendingTitle = defaultTitle() + '（錄影）';
  } catch (e) {
    alert('影片讀取失敗：' + e.message);
    $('btn-import').disabled = false;
    hideImportUI();
  }
}

async function onVideoTranscribed(segments) {
  $('btn-import').disabled = false;
  hideImportUI();
  if (!segments.length) { alert('未偵測到語音'); return; }

  const meeting = {
    id:       crypto.randomUUID(),
    title:    S._pendingTitle ?? defaultTitle(),
    date:     Date.now(),
    segments,
    summary:  generateSummary(segments),
  };
  await saveMeeting(meeting);
  S.meetings = await getAllMeetings();
  renderHome();
  showMeeting(meeting);
}

// ── SpeechRecognition setup ───────────────────────────────
function initSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    document.getElementById('screen-home').hidden = true;
    document.getElementById('unsupported').style.display = 'block';
    return false;
  }

  const r = new SR();
  r.continuous      = true;
  r.interimResults  = true;
  r.lang            = 'zh-TW';   // 中文主語言；Safari 仍會辨識英文詞

  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      if (result.isFinal) {
        const text = result[0].transcript.trim();
        if (text) {
          const elapsed = (Date.now() - S.startTime) / 1000;
          S.segments.push({ start: elapsed, end: elapsed, text });
        }
      } else {
        interim += result[0].transcript;
      }
    }
    S.interimText = interim;
    renderLiveBox();
  };

  r.onerror = (e) => {
    // 'no-speech' 是正常的沉默，不報錯
    if (e.error === 'no-speech') return;
    if (e.error === 'not-allowed') {
      alert('請允許麥克風權限：設定 → Safari → 麥克風');
      stopRecording();
    }
  };

  // iOS 在靜音後會自動 end；continuous=true 時重啟維持錄音
  r.onend = () => {
    if (S.recording) r.start();
  };

  S.recognition = r;
  return true;
}

// ── Record ────────────────────────────────────────────────
function startRecording() {
  S.segments   = [];
  S.interimText = '';
  S.startTime  = Date.now();
  S.recording  = true;

  S.recognition.start();

  // Timer
  S.timerInterval = setInterval(() => {
    const sec = Math.floor((Date.now() - S.startTime) / 1000);
    $('rec-timer').textContent = fmtTime(sec);
  }, 500);

  $('btn-record').classList.add('recording');
  $('btn-record').classList.remove('stopped');
  $('rec-label').textContent = '錄音中… 點麥克風停止';
  $('live-box').innerHTML = '';
}

async function stopRecording() {
  if (!S.recording) return;
  S.recording = false;

  S.recognition.stop();
  clearInterval(S.timerInterval);

  $('btn-record').classList.remove('recording');
  $('btn-record').classList.add('stopped');
  $('rec-label').textContent = '點麥克風開始錄音';
  $('rec-timer').textContent = '00:00';

  if (S.segments.length === 0) {
    $('live-box').innerHTML = '<span style="color:var(--text3);font-size:13px">沒有偵測到語音</span>';
    return;
  }

  const meeting = {
    id:       crypto.randomUUID(),
    title:    defaultTitle(),
    date:     Date.now(),
    segments: S.segments,
    summary:  generateSummary(S.segments),
  };

  await saveMeeting(meeting);
  S.meetings = await getAllMeetings();
  renderHome();
  showMeeting(meeting);
}

// ── Live box ──────────────────────────────────────────────
function renderLiveBox() {
  const box = $('live-box');
  const confirmed = S.segments.map(s => escH(s.text)).join(' ');
  const interim   = S.interimText ? `<span class="interim">${escH(S.interimText)}</span>` : '';
  box.innerHTML = confirmed + (confirmed && interim ? ' ' : '') + interim;
  box.scrollTop = box.scrollHeight;
}

// ── Screens ───────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => {
    el.hidden = el.id !== id;
  });
}

function showMeeting(meeting) {
  S.current = meeting;
  S.tab     = 'summary';
  S.search  = '';
  $('detail-title').textContent = meeting.title;
  renderDetail();
  showScreen('screen-detail');
}

// ── Home render ───────────────────────────────────────────
function renderHome() {
  const list  = $('meeting-list');
  const empty = $('empty');

  if (!S.meetings.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  list.innerHTML = S.meetings.map(m => {
    const d = new Date(m.date).toLocaleString('zh-TW', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const preview = m.summary?.keyPoints?.[0] ?? m.segments?.[0]?.text ?? '—';
    return `<div class="card meeting-row" data-id="${m.id}">
      <div class="meeting-row-header">
        <span class="meeting-row-title">${escH(m.title)}</span>
        <button class="btn-x" data-del="${m.id}">×</button>
      </div>
      <div class="meeting-row-date">${d} · ${m.segments.length} 段</div>
      <div class="meeting-row-preview">${escH(preview)}</div>
    </div>`;
  }).join('');
}

// ── Detail render ─────────────────────────────────────────
function renderDetail() {
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === S.tab);
  });

  if (S.tab === 'summary') renderSummary();
  else renderTranscript();
}

function renderSummary() {
  const sum = S.current?.summary;
  if (!sum) { $('tab-body').innerHTML = '<p class="empty-msg">無摘要</p>'; return; }

  const section = (title, icon, items, cls = '') => {
    if (!items?.length) return '';
    return `<div class="s-section ${cls}">
      <div class="s-title">${icon} ${title}</div>
      <ul>${items.map(t => `<li>${escH(t)}</li>`).join('')}</ul>
    </div>`;
  };

  const tags = (items) => {
    if (!items?.length) return '';
    return `<div class="s-section">
      <div class="s-title">🏷 關鍵詞</div>
      <div class="chips">${items.map(t => `<span class="chip">${escH(t)}</span>`).join('')}</div>
    </div>`;
  };

  $('tab-body').innerHTML =
    section('重點摘要',  '💡', sum.keyPoints) +
    section('待辦事項',  '☑️', sum.actionItems, 'action') +
    section('決議',      '✅', sum.decisions,   'decision') +
    tags(sum.topics);
}

function renderTranscript() {
  const segs = S.current?.segments ?? [];
  const q    = S.search.toLowerCase();

  const filtered = q ? segs.filter(s => s.text.toLowerCase().includes(q)) : segs;

  const searchBar = `<div class="search-row">
    <span>🔍</span>
    <input id="search-input" type="search" placeholder="搜尋逐字稿" value="${escH(S.search)}">
    <button class="btn-clear" id="btn-clear">✕</button>
  </div>`;

  const rows = filtered.length
    ? filtered.map(s => {
        const txt = q
          ? escH(s.text).replace(new RegExp(escRe(q), 'gi'), m => `<mark>${m}</mark>`)
          : escH(s.text);
        return `<div class="seg"><span class="seg-t">${fmtTime(s.start)}</span><span class="seg-tx">${txt}</span></div>`;
      }).join('')
    : '<p class="empty-msg">無符合結果</p>';

  $('tab-body').innerHTML = searchBar + rows;

  $('search-input')?.addEventListener('input', e => {
    S.search = e.target.value;
    renderTranscript();
  });
  $('btn-clear')?.addEventListener('click', () => {
    S.search = '';
    renderTranscript();
  });
}

// ── Export ────────────────────────────────────────────────
function exportText(m) {
  const lines = [`# ${m.title}`, ''];
  const { summary: s, segments } = m;
  if (s) {
    if (s.keyPoints?.length)   lines.push('## 重點',    ...s.keyPoints.map(t=>`• ${t}`),   '');
    if (s.actionItems?.length) lines.push('## 待辦',    ...s.actionItems.map(t=>`- [ ] ${t}`), '');
    if (s.decisions?.length)   lines.push('## 決議',    ...s.decisions.map(t=>`✓ ${t}`),   '');
  }
  lines.push('## 逐字稿', '', ...segments.map(s=>`[${fmtTime(s.start)}] ${s.text}`));
  return lines.join('\n');
}

// ── Events ────────────────────────────────────────────────
function bindEvents() {
  $('btn-record').addEventListener('click', () => {
    S.recording ? stopRecording() : startRecording();
  });

  $('btn-import').addEventListener('click', () => {
    if (!S.worker) {
      // 第一次點：初始化 worker 並開始下載模型
      $('btn-import').disabled = true;
      initWorker();
      return;
    }
    if (!S.workerReady) {
      // 模型還在下載
      return;
    }
    $('file-input').click();
  });
  $('file-input').addEventListener('change', e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) handleVideoImport(f);
  });

  $('meeting-list').addEventListener('click', async e => {
    const del  = e.target.closest('[data-del]');
    const item = e.target.closest('[data-id]');
    if (del) {
      if (!confirm('確定刪除？')) return;
      await deleteMeeting(del.dataset.del);
      S.meetings = await getAllMeetings();
      renderHome();
      return;
    }
    if (item && !del) {
      const m = await getMeeting(item.dataset.id);
      if (m) showMeeting(m);
    }
  });

  $('btn-back').addEventListener('click', async () => {
    S.meetings = await getAllMeetings();
    renderHome();
    showScreen('screen-home');
  });

  $('tabs').addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    S.tab = btn.dataset.tab;
    S.search = '';
    renderDetail();
  });

  $('btn-edit').addEventListener('click', () => {
    const t = prompt('編輯標題', S.current.title);
    if (t?.trim()) {
      S.current.title = t.trim();
      saveMeeting(S.current);
      $('detail-title').textContent = S.current.title;
    }
  });

  $('btn-share').addEventListener('click', async () => {
    const text = exportText(S.current);
    if (navigator.share) {
      await navigator.share({ title: S.current.title, text }).catch(() => {});
    } else {
      await navigator.clipboard.writeText(text);
      alert('已複製到剪貼簿');
    }
  });
}

// ── Helpers ───────────────────────────────────────────────
const $ = id => document.getElementById(id);

function fmtTime(sec) {
  if (!sec) return '00:00';
  return `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(Math.floor(sec%60)).padStart(2,'0')}`;
}

function escH(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

function defaultTitle() {
  return '會議 ' + new Date().toLocaleString('zh-TW', {
    month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit',
  });
}

// ── Boot ──────────────────────────────────────────────────
async function main() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  if (!initSpeech()) return;
  // worker 延遲載入：第一次點「匯入錄影」時才初始化
  bindEvents();
  S.meetings = await getAllMeetings();
  renderHome();
}

main();
