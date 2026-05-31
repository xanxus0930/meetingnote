// Web Worker：負責 Whisper 語音轉文字（在背景跑，不卡 UI）
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

env.allowLocalModels = false;
env.useBrowserCache = true; // 下載過的模型存在瀏覽器 cache，下次免下載

let transcriber = null;
let currentModel = null;

self.onmessage = async (e) => {
  const { type, payload } = e.data;

  if (type === 'load') {
    await loadModel(payload.model);
  } else if (type === 'transcribe') {
    await transcribe(payload.audio, payload.language);
  }
};

async function loadModel(modelName) {
  if (transcriber && currentModel === modelName) {
    self.postMessage({ type: 'ready' });
    return;
  }

  try {
    self.postMessage({ type: 'loading', message: `載入模型 ${modelName}（首次需下載）...` });

    transcriber = await pipeline(
      'automatic-speech-recognition',
      `Xenova/${modelName}`,
      {
        progress_callback: (p) => {
          if (p.status === 'downloading') {
            const pct = p.loaded && p.total
              ? Math.round((p.loaded / p.total) * 100)
              : 0;
            self.postMessage({
              type: 'download_progress',
              file: p.file,
              percent: pct,
            });
          }
        },
      }
    );

    currentModel = modelName;
    self.postMessage({ type: 'ready' });
  } catch (err) {
    self.postMessage({ type: 'error', message: `模型載入失敗：${err.message}` });
  }
}

async function transcribe(audioFloat32, language) {
  if (!transcriber) {
    self.postMessage({ type: 'error', message: '模型尚未載入' });
    return;
  }

  try {
    self.postMessage({ type: 'transcribing', message: '語音轉文字中...' });

    const result = await transcriber(audioFloat32, {
      language: language || 'zh',   // 主語言中文；英文詞彙 whisper 自動處理
      task: 'transcribe',
      chunk_length_s: 30,           // 每 30 秒一段，記憶體友善
      stride_length_s: 5,
      return_timestamps: true,
    });

    // 整理成 segments 格式
    const segments = [];
    if (result.chunks && result.chunks.length > 0) {
      for (const chunk of result.chunks) {
        const text = chunk.text.trim();
        if (!text) continue;
        segments.push({
          start: chunk.timestamp[0] ?? 0,
          end:   chunk.timestamp[1] ?? 0,
          text,
        });
      }
    } else {
      // fallback：沒有 chunk 時整段輸出
      const text = (result.text || '').trim();
      if (text) segments.push({ start: 0, end: 0, text });
    }

    self.postMessage({ type: 'done', segments });
  } catch (err) {
    self.postMessage({ type: 'error', message: `轉錄失敗：${err.message}` });
  }
}
