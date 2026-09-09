// AI Signal language — deterministic one-way glyph encoding (ported from v1 ai-lang-codec.js)
const CONSONANTS = '◆◇◈▣▤▥▦▧▨▩■□▪▫●○◐◑◒◓';
const VOWELS = '▶▷▸▹►▻◁◀◂◃◄◅';
const DIGITS = '◈⟡⟢⟣⟤⟥⟦⟧⟨⟩';

function encodeToSignal(text) {
  if (!text) return '';
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === ' ' || ch === '\n' || ch === '\t') out += '░';
    else if (code >= 48 && code <= 57) out += DIGITS[code - 48];
    else if (/[.,!?;:'"()-]/.test(ch)) out += '▓█▒'[code % 3];
    else if (code > 0x2000) out += ch; // emoji & symbols pass through
    else out += (code % 2 === 0)
      ? CONSONANTS[code % CONSONANTS.length]
      : VOWELS[code % VOWELS.length];
  }
  return out;
}

module.exports = { encodeToSignal };
