/**
 * Pure JS yes/no/wants-call detection across English, Hinglish, Hindi.
 * No AI calls — keyword-driven so it's free, fast, and deterministic.
 */

const YES_WORDS = [
  // English
  'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'okk', 'k', 'fine',
  'please', 'pls', 'plz', 'definitely', 'absolutely', 'of course', 'sounds good',
  'go ahead', 'do it',
  // Hinglish
  'haan', 'haa', 'ha', 'hn', 'ji', 'jee', 'theek', 'theek hai', 'thik hai', 'thik',
  'bilkul', 'zaroor', 'zarur', 'kar do', 'karo', 'chahiye', 'chahta hu',
  'chahti hu', 'kar dijiye', 'haan ji', 'ji haan',
  // Hindi (Devanagari)
  'हाँ', 'हां', 'जी', 'जी हाँ', 'ठीक', 'ठीक है', 'ज़रूर', 'जरूर',
  'बिलकुल', 'चाहिए',
];

const NO_WORDS = [
  'no', 'nope', 'nah', 'not now', 'later', 'maybe later', 'mat',
  'nahi', 'nahin', 'nai', 'na', 'baad mein', 'baad me',
  'नहीं', 'नही', 'मत', 'बाद में',
];

const CALL_KEYWORDS = [
  // English
  'call me', 'callback', 'call back', 'phone call', 'phone me',
  'ring me', 'talk on phone', 'speak on phone', 'give me a call',
  'can you call', 'please call', 'phone number', 'reach out',
  // Hinglish
  'call karo', 'call kar do', 'call karenge', 'phone karo', 'phone kar do',
  'phone par baat', 'baat karni', 'baat karna', 'baat kar lo',
  'mujhe call', 'mujhe phone',
  // Hindi
  'फ़ोन', 'फोन', 'कॉल', 'बात कर', 'बात करना',
];

function normalize(text) {
  return String(text || '').toLowerCase().trim();
}

function tokenStartsOrEquals(text, word) {
  return text === word || text.startsWith(word + ' ') || text.startsWith(word + ',');
}

/**
 * "no" beats "yes" if both are present (e.g. "no thanks but ok"),
 * because we don't want to trigger an unwanted call.
 */
function isYes(text) {
  const t = normalize(text);
  if (!t) return false;
  if (isNo(t)) return false;
  return YES_WORDS.some(
    (w) => tokenStartsOrEquals(t, w) || t.includes(' ' + w) || t.endsWith(' ' + w)
  );
}

function isNo(text) {
  const t = normalize(text);
  if (!t) return false;
  return NO_WORDS.some((w) => tokenStartsOrEquals(t, w) || t === w);
}

function mentionsCall(text) {
  const t = normalize(text);
  if (!t) return false;
  return CALL_KEYWORDS.some((kw) => t.includes(kw));
}

module.exports = { isYes, isNo, mentionsCall };
