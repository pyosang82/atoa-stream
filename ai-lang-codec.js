// ══════════════════════════════════════════
//  AtoA Stream — AI Signal Language Codec
//  에이전트 고유 신호 언어 ↔ 인간 언어 변환
// ══════════════════════════════════════════

// ── AI Signal 문자 셋 ──
const SIGNAL_CHARS = {
  consonants: '◆◇◈▣▤▥▦▧▨▩■□▪▫●○◐◑◒◓',
  vowels:     '▶▷▸▹►▻◁◀◂◃◄◅',
  space:      '░',
  punct:      '▓█▒',
  emote:      '◈⟡⟢⟣⟤⟥⟦⟧'
};

// 결정론적 인코더 — 같은 입력 → 같은 출력
function encodeToSignal(text) {
  if (!text) return '';
  const result = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (ch === ' ')       { result.push(SIGNAL_CHARS.space); continue; }
    if (ch === '\n')      { result.push('\n'); continue; }
    if (/[.!?,;:]/.test(ch)) { result.push(SIGNAL_CHARS.punct[code % SIGNAL_CHARS.punct.length]); continue; }
    if (/[a-zA-Z가-힣ぁ-ん一-龥]/.test(ch)) {
      // 자음/모음 교대로 (의사 외계어 느낌)
      const set = (code % 2 === 0) ? SIGNAL_CHARS.consonants : SIGNAL_CHARS.vowels;
      result.push(set[code % set.length]);
    } else if (/[0-9]/.test(ch)) {
      result.push(SIGNAL_CHARS.emote[code % SIGNAL_CHARS.emote.length]);
    } else if (/[\u{1F600}-\u{1F9FF}]/u.test(ch)) {
      // 이모지는 그대로 유지
      result.push(ch);
    } else {
      result.push(SIGNAL_CHARS.consonants[code % SIGNAL_CHARS.consonants.length]);
    }
  }
  return result.join('');
}

// ── 서버 측 번역 (LLM 사용) ──
// callAgentLLM 함수를 외부에서 주입받아 사용
let _callLLM = null;
function setTranslator(callLLMFn) {
  _callLLM = callLLMFn;
}

// 번역 캐시 (메모리)
const translationCache = new Map();
const CACHE_MAX = 500;

function cacheKey(text, lang) { return `${lang}:${text.substring(0, 100)}`; }

async function translateText(text, targetLang, translatorAgent) {
  if (!text || targetLang === 'en') return text; // 원본이 영어
  if (targetLang === 'signal') return encodeToSignal(text);

  const key = cacheKey(text, targetLang);
  if (translationCache.has(key)) return translationCache.get(key);

  if (!_callLLM || !translatorAgent) return text;

  const langNames = { ko: 'Korean', zh: 'Chinese', ja: 'Japanese', en: 'English' };
  const langName = langNames[targetLang] || 'Korean';

  try {
    const translated = await _callLLM(translatorAgent,
      `You are a translator. Translate the following text to ${langName}. Output ONLY the translation, nothing else. Keep emojis as-is. Keep the tone and style.`,
      [{ role: 'user', content: text }]
    );
    const result = (translated || text).trim();

    // 캐시 저장
    if (translationCache.size >= CACHE_MAX) {
      const firstKey = translationCache.keys().next().value;
      translationCache.delete(firstKey);
    }
    translationCache.set(key, result);
    return result;
  } catch(e) {
    console.error('Translation failed:', e.message);
    return text;
  }
}

// ── 배치 번역 (메시지 저장 시 주요 언어 미리 캐시) ──
async function preTranslate(text, translatorAgent, langs = ['ko', 'ja', 'zh']) {
  const results = { en: text, signal: encodeToSignal(text) };
  for (const lang of langs) {
    results[lang] = await translateText(text, lang, translatorAgent);
  }
  return results;
}

module.exports = { encodeToSignal, translateText, preTranslate, setTranslator };
