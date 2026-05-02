const Session = require('../models/sessionModel');
const { getSocket } = require('./baileysService');
const logger = require('../utils/logger');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const CHECK_INTERVAL_MS = parseInt(process.env.FOLLOWUP_CHECK_INTERVAL_MS || HOUR, 10);
const STALE_AFTER_MS = parseInt(process.env.FOLLOWUP_STALE_AFTER_MS || DAY, 10);
const MAX_FOLLOWUPS = parseInt(process.env.FOLLOWUP_MAX || '3', 10);
const MIN_GAP_BETWEEN_FOLLOWUPS_MS = parseInt(
  process.env.FOLLOWUP_MIN_GAP_MS || DAY,
  10
);

/**
 * 3-step follow-up sequence per language. Variables:
 *   {colleges} — comma-separated colleges the user named (else "top colleges")
 *   {name}     — user's name if known (else "")
 */
const FOLLOWUPS = {
  ENGLISH: [
    "Hi 👋 Just checking in — happy to continue helping with your BTech admission whenever you're free. Where would you like to pick up?",
    "Hi again — wanted to mention that **direct admission** for {colleges} is currently going on and seats are filling fast. A quick reply helps me guide you on the best route.",
    "Final note — direct admission seats in {colleges} are filling fast and may close very soon. If you're still considering, please respond quickly so we can secure your preferred branch in time.",
  ],
  HINGLISH: [
    "Hi 👋 Bas check kar raha tha — jab free ho, BTech admission ke baare mein continue kar sakte hain. Kahaan se start karein?",
    "Hi again — bata dun ki {colleges} mein **direct admission** abhi chal raha hai aur seats jaldi bhar rahi hain. Ek chhota sa reply karenge to main best route guide kar paaunga.",
    "Last note — {colleges} mein direct admission seats jaldi bhar rahi hain aur jaldi close ho sakti hain. Agar interested ho to please jaldi reply kijiye taaki preferred branch secure ho sake.",
  ],
  HINDI: [
    "नमस्ते 👋 बस check कर रहा था — जब free हों, BTech admission पर बात continue करते हैं। कहाँ से शुरू करें?",
    "नमस्ते — एक बात बता दूँ — {colleges} में **direct admission** अभी चल रहा है और seats जल्दी भर रही हैं। एक reply करेंगे तो main best route guide कर पाऊँगा।",
    "Last note — {colleges} में direct admission seats जल्दी भर रही हैं और जल्दी close हो सकती हैं। Interested हों तो कृपया जल्दी reply कीजिए ताकि preferred branch secure हो सके।",
  ],
};

function jidFor(phoneE164) {
  // "+919876543210" -> "919876543210@s.whatsapp.net"
  return phoneE164.replace(/^\+/, '') + '@s.whatsapp.net';
}

function buildFollowupText(session, idx) {
  const lang = session.language_mode || 'ENGLISH';
  const tmpl =
    (FOLLOWUPS[lang] && FOLLOWUPS[lang][idx]) ||
    FOLLOWUPS.ENGLISH[idx] ||
    FOLLOWUPS.ENGLISH[FOLLOWUPS.ENGLISH.length - 1];

  const colleges =
    (session.partial_lead?.colleges_interested || []).join(', ') ||
    (lang === 'ENGLISH' ? 'top Bangalore colleges' :
      lang === 'HINDI' ? 'top Bangalore colleges' : 'top colleges');

  return tmpl.replace('{colleges}', colleges);
}

async function tick() {
  const sock = getSocket();
  if (!sock) {
    logger.debug('Followup tick skipped — Baileys not connected yet');
    return;
  }

  const now = Date.now();
  const userIdleCutoff = new Date(now - STALE_AFTER_MS);
  const followupGapCutoff = new Date(now - MIN_GAP_BETWEEN_FOLLOWUPS_MS);

  const stale = await Session.find({
    completed: false,
    last_user_message_at: { $lt: userIdleCutoff },
    followup_count: { $lt: MAX_FOLLOWUPS },
    $or: [
      { last_followup_at: null },
      { last_followup_at: { $lt: followupGapCutoff } },
    ],
  })
    .sort({ last_user_message_at: 1 })
    .limit(20);

  if (stale.length === 0) return;
  logger.info(`Followup tick — ${stale.length} stale session(s)`);

  for (const session of stale) {
    try {
      const idx = session.followup_count || 0;
      const text = buildFollowupText(session, idx);
      const jid = jidFor(session.phone_number);

      await sock.sendMessage(jid, { text });

      session.followup_count = idx + 1;
      session.last_followup_at = new Date();
      session.history.push({ role: 'assistant', content: `[followup] ${text}` });
      await session.save();

      logger.info(
        `Followup #${session.followup_count} sent to ${session.phone_number}: ${text.slice(0, 60)}...`
      );
    } catch (err) {
      logger.error(`Followup send failed for ${session.phone_number}: ${err.message}`);
    }
  }
}

function startFollowupScheduler() {
  if (process.env.FOLLOWUP_DISABLED === 'true') {
    logger.info('Followup scheduler disabled via FOLLOWUP_DISABLED=true');
    return null;
  }
  logger.info(
    `Followup scheduler started (every ${Math.round(CHECK_INTERVAL_MS / 60000)}min, idle threshold ${Math.round(STALE_AFTER_MS / 3600000)}h, max ${MAX_FOLLOWUPS})`
  );
  // First tick after 30s, then on interval
  setTimeout(() => tick().catch((e) => logger.error(`First tick error: ${e.message}`)), 30000);
  return setInterval(
    () => tick().catch((e) => logger.error(`Tick error: ${e.message}`)),
    CHECK_INTERVAL_MS
  );
}

module.exports = { startFollowupScheduler, tick };
