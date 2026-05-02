/**
 * Multi-signal interest scoring. Looks at the whole user-side conversation
 * and adds points for behavioural signals that imply real intent.
 *
 *   wants_call       +5
 *   specific budget  +3
 *   urgency words    +2
 *   named colleges   +2
 *   asks questions   +2
 *   long replies     +1
 *
 * Total → category:
 *   >= 8  HIGH
 *   4-7   MEDIUM
 *   <  4  LOW
 */

const URGENCY_WORDS = [
  'urgent', 'urgently', 'asap', 'immediately', 'soon', 'quickly',
  'this week', 'this month', 'next week',
  'jaldi', 'abhi', 'fauran', 'turant', 'kal tak', 'is hafte',
  'जल्दी', 'अभी', 'तुरंत',
];

const BUDGET_PATTERNS = [
  /\b\d+\s*(?:l|lac|lakh|lakhs|lacs)\b/i,
  /\b\d+\s*(?:cr|crore|crores)\b/i,
  /\brs\.?\s*\d{4,}/i,
  /\b₹\s*\d+/,
  /\binr\s*\d+/i,
];

const TOP_COLLEGES = [
  'rvce', 'r v college', 'r.v. college',
  'bmsce', 'bms college', 'b.m.s.',
  'pes', 'pesu', 'p.e.s.',
  'msrit', 'm s ramaiah', 'ramaiah',
  'rnsit', 'dsce', 'dayananda', 'mvj', 'sjbit', 'cmrit',
  'christ', 'jain', 'reva',
];

const QUESTION_HINTS = [
  '?',
  'what', 'when', 'how', 'which', 'how much', 'how many',
  'kya', 'kaise', 'kab', 'kitna', 'konsa', 'konsi', 'kahan',
  'क्या', 'कैसे', 'कब', 'कितना', 'कौन', 'कहाँ',
  'fee', 'fees', 'cost', 'price',  // common follow-up topics
  'admission process', 'cutoff', 'cut off',
];

function normalize(t) {
  return String(t || '').toLowerCase();
}

function userMessages(session) {
  return (session?.history || [])
    .filter((m) => m.role === 'user')
    .map((m) => m.content || '');
}

function score(session, opts = {}) {
  const wantsCall = !!opts.wants_call;
  const userText = userMessages(session);
  const joined = normalize(userText.join(' '));

  let total = 0;
  const signals = [];

  if (wantsCall) {
    total += 5;
    signals.push('wants_call');
  }

  if (BUDGET_PATTERNS.some((re) => re.test(joined))) {
    total += 3;
    signals.push('specific_budget');
  }

  if (URGENCY_WORDS.some((w) => joined.includes(w))) {
    total += 2;
    signals.push('urgency');
  }

  if (TOP_COLLEGES.some((c) => joined.includes(c))) {
    total += 2;
    signals.push('named_colleges');
  }

  if (QUESTION_HINTS.some((q) => joined.includes(q))) {
    total += 2;
    signals.push('asked_questions');
  }

  const lengths = userText.map((m) => m.length).filter((n) => n > 0);
  if (lengths.length > 0) {
    const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    if (avg >= 20) {
      total += 1;
      signals.push('detailed_replies');
    }
  }

  let level = 'LOW';
  if (total >= 8) level = 'HIGH';
  else if (total >= 4) level = 'MEDIUM';

  return { score: total, level, signals };
}

module.exports = { score };
