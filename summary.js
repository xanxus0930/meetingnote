// 純離線摘要：關鍵詞偵測 + 統計，不需要 LLM
export function generateSummary(segments) {
  const lines = segments.map(s => s.text);
  const allText = lines.join(' ');
  return {
    keyPoints:   extractKeyPoints(lines),
    actionItems: extractByPatterns(lines, ACTION_PATTERNS, 8),
    decisions:   extractByPatterns(lines, DECISION_PATTERNS, 5),
    topics:      extractTopics(allText),
  };
}

// ─── 規則庫 ──────────────────────────────────────────────
const ACTION_PATTERNS = [
  // 中文
  /需要.{2,30}/,
  /請.{1,20}(負責|確認|處理|跟進|回覆|安排|準備|提供|發送)/,
  /要.{1,20}(確認|準備|處理|完成|發送|回覆|跟進)/,
  /記得.{2,20}/,
  /待辦.{1,30}/,
  /下次.{2,30}/,
  /follow[\s-]?up/i,
  /action\s*item/i,
  // 英文
  /need\s+to\s+.{3,40}/i,
  /will\s+.{3,40}/i,
  /should\s+.{3,40}/i,
  /must\s+.{3,40}/i,
  /(?:to[\s-]?do|todo)[:\s].{3,40}/i,
];

const DECISION_PATTERNS = [
  /決定.{2,40}/,
  /確認.{2,40}/,
  /同意.{2,40}/,
  /決議.{2,40}/,
  /通過.{2,40}/,
  /agreed/i,
  /decided/i,
  /confirmed/i,
  /approved/i,
  /we['']?ll\s+go\s+with/i,
];

// ─── 抽取函式 ────────────────────────────────────────────
function extractByPatterns(lines, patterns, maxCount) {
  const results = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const pattern of patterns) {
      const m = trimmed.match(pattern);
      if (m) {
        const snippet = m[0].trim();
        if (snippet.length > 4 && !results.includes(trimmed)) {
          results.push(trimmed);
        }
        break;
      }
    }
    if (results.length >= maxCount) break;
  }
  return results;
}

function extractKeyPoints(lines) {
  const NOISE = new Set(['嗯', '啊', '喔', '對', '好', 'ok', 'yeah', 'um', 'uh', 'hmm']);

  const scored = lines
    .map(l => l.trim())
    .filter(l => {
      if (l.length < 12 || l.length > 150) return false;
      const first = l.slice(0, 2).toLowerCase();
      return !NOISE.has(first) && !NOISE.has(l[0]);
    })
    .map(l => {
      let score = 0;
      if (/\d/.test(l)) score += 2;
      if (/[月週天號%$]/.test(l)) score += 1;
      const keywords = ['問題', '原因', '結果', '方案', '目標', '預算', '時間',
                        'issue', 'solution', 'goal', 'budget', 'deadline', 'schedule'];
      for (const kw of keywords) {
        if (l.toLowerCase().includes(kw)) score++;
      }
      return { text: l, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(x => x.text);

  return scored;
}

function extractTopics(allText) {
  const STOP = new Set([
    '的', '了', '是', '在', '有', '我', '你', '他', '她', '它',
    '這', '那', '都', '也', '就', '和', '與', '或', '但', '把',
    '被', '很', '還', '只', '已', '嗯', '啊', '喔', '好', '對',
    'the', 'a', 'an', 'is', 'are', 'was', 'be', 'to', 'of',
    'and', 'or', 'but', 'in', 'on', 'at', 'for', 'with', 'it',
    'ok', 'yeah', 'um', 'uh', 'so', 'we', 'i', 'you', 'he',
  ]);

  const freq = {};

  // CJK 二字詞
  const cjk = allText.replace(/[^一-鿿]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) {
    const bigram = cjk[i] + cjk[i + 1];
    if (!STOP.has(bigram[0]) && !STOP.has(bigram[1])) {
      freq[bigram] = (freq[bigram] || 0) + 1;
    }
  }

  // 英文單字（3 字母以上）
  const englishWords = allText.match(/[a-zA-Z]{3,}/g) || [];
  for (const w of englishWords) {
    const lower = w.toLowerCase();
    if (!STOP.has(lower)) freq[lower] = (freq[lower] || 0) + 1;
  }

  return Object.entries(freq)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}
