// Lightweight heuristic language detector for ENGLISH / HINGLISH / HINDI.
// We only need this for the first 1-2 messages; after that we lock the mode.

const HINGLISH_TOKENS = [
  'hai', 'hain', 'kya', 'kaise', 'kaisa', 'kitna', 'kitni', 'nahi', 'nahin',
  'haan', 'mera', 'meri', 'mujhe', 'aap', 'aapka', 'aapki', 'chahiye', 'karna',
  'karunga', 'karungi', 'bhi', 'par', 'magar', 'lekin', 'abhi', 'pls', 'plz',
  'acha', 'achha', 'theek', 'thik', 'bata', 'batao', 'dekh', 'dekho', 'rha',
  'raha', 'rahi', 'rhe', 'rahe', 'hu', 'hoon', 'ho', 'toh', 'bas',
];

function hasDevanagari(text) {
  return /[ऀ-ॿ]/.test(text);
}

function countHinglishTokens(text) {
  const tokens = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (tokens.length === 0) return { hits: 0, ratio: 0 };
  const hits = tokens.filter((t) => HINGLISH_TOKENS.includes(t)).length;
  return { hits, ratio: hits / tokens.length };
}

/**
 * Classify a message as ENGLISH, HINGLISH, or HINDI.
 * @param {string} text raw user message
 * @returns {'ENGLISH'|'HINGLISH'|'HINDI'}
 */
function detectLanguage(text = '') {
  if (!text || !text.trim()) return 'ENGLISH';

  if (hasDevanagari(text)) {
    // If >40% of chars are Devanagari, treat as pure Hindi.
    const total = text.replace(/\s/g, '').length || 1;
    const devCount = (text.match(/[ऀ-ॿ]/g) || []).length;
    return devCount / total > 0.4 ? 'HINDI' : 'HINGLISH';
  }

  const { hits, ratio } = countHinglishTokens(text);
  if (hits >= 2 || ratio >= 0.15) return 'HINGLISH';
  return 'ENGLISH';
}

module.exports = { detectLanguage };
