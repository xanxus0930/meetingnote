// ES module worker — iOS Safari 16.4+ 支援
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

env.allowLocalModels = false;
env.useBrowserCache  = true;   // 下載一次後 browser cache 永久保留

let transcriber = null;
let loadedModel  = null;

self.onmessage = async ({ data: { type, payload } }) => {
  switch (type) {
    case 'load':       await loadModel(payload.model); break;
    case 'transcribe': await transcribe(payload.audio); break;
  }
};

async function loadModel(model) {
  if (transcriber && loadedModel === model) {
    self.postMessage({ type: 'ready' });
    return;
  }
  try {
    self.postMessage({ type: 'status', text: `下載模型（首次約 ${model === 'whisper-small' ? '250' : '150'}MB）...` });

    transcriber = await pipeline(
      'automatic-speech-recognition',
      `Xenova/${model}`,
      {
        progress_callback: p => {
          if (p.status === 'downloading' && p.total) {
            self.postMessage({
              type: 'download',
              file: p.file,
              pct: Math.round((p.loaded / p.total) * 100),
            });
          }
        },
      }
    );
    loadedModel = model;
    self.postMessage({ type: 'ready' });
  } catch (e) {
    self.postMessage({ type: 'error', text: `模型載入失敗：${e.message}` });
  }
}

async function transcribe(audio) {
  try {
    self.postMessage({ type: 'status', text: '語音轉文字中…' });

    const result = await transcriber(audio, {
      language:          'zh',
      task:              'transcribe',
      chunk_length_s:    30,
      stride_length_s:   5,
      return_timestamps: true,
    });

    const segments = (result.chunks ?? [])
      .map(c => ({ start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? 0, text: c.text.trim() }))
      .filter(s => s.text);

    if (!segments.length && result.text?.trim()) {
      segments.push({ start: 0, end: 0, text: result.text.trim() });
    }

    self.postMessage({ type: 'done', segments });
  } catch (e) {
    self.postMessage({ type: 'error', text: `轉錄失敗：${e.message}` });
  }
}
