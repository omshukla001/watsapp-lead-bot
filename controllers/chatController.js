const axios = require('axios');
const Session = require('../models/sessionModel');
const Lead = require('../models/leadModel');
const aiService = require('../services/aiService');
const { extractJSON, validateLead, scoreLead } = require('../utils/parser');
const { notifyNewLead } = require('../services/termuxNotify');
const { isYes, isNo, mentionsCall, mentionsPrice } = require('../services/maturityDetector');
const { isValidWhatsAppPhone } = require('../utils/phone');
const { score: scoreInterest } = require('../services/interestScorer');
const logger = require('../utils/logger');

// Fire-and-forget POST to the dashboard API so it can push-notify counsellors.
// Never blocks the WhatsApp reply; logs failures and moves on.
function pingDashboardWebhook(lead) {
  const url = process.env.DASHBOARD_API_URL;
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!url || !secret) return; // not configured — skip silently

  axios
    .post(`${url.replace(/\/$/, '')}/api/webhook/lead-mature`, lead, {
      headers: { 'X-Bot-Secret': secret, 'Content-Type': 'application/json' },
      timeout: 4000,
    })
    .then((res) => {
      logger.info(`Dashboard webhook OK [${lead.phone_number}] status=${res.status}`);
    })
    .catch((err) => {
      const status = err.response?.status;
      logger.warn(`Dashboard webhook failed [${lead.phone_number}]${status ? ' status=' + status : ''}: ${err.message}`);
    });
}

/**
 * Step machine (BTech-only):
 *   0 greeting
 *   1 college
 *   2 branch (CSE / IT / AIML / etc.)
 *   3 city
 *   4 12th PCM percentage
 *   5 entrance exam status
 *   6 admission timeline
 *   7 name
 *   8 call-ask
 *   9 complete
 */

const COLLEGE_OPTIONS = ['RVCE', 'BMSCE', 'PES', 'SRM', 'Other'];
const COLLEGE_SECTIONS = null; // no sections — short list

const BRANCH_OPTIONS = ['CSE', 'AI&ML', 'ECE', 'Mech', 'Not sure'];

const PCM_OPTIONS = ['90%+', '80–89%', '70–79%', 'Below 70%'];

const EXAM_OPTIONS = ['KCET/COMEDK', 'JEE', 'No'];

const TIMELINE_OPTIONS = {
  ENGLISH: ['Within 1 month', '1-3 months', '3-6 months', 'Just exploring'],
  HINGLISH: ['1 mahine mein', '1-3 mahine', '3-6 mahine', 'Bas explore kar raha'],
  HINDI: ['1 महीने में', '1-3 महीने', '3-6 महीने', 'अभी देख रहे हैं'],
};

const CALL_OPTIONS = {
  ENGLISH: ['Yes, call me', 'Not now'],
  HINGLISH: ['Haan, call kar do', 'Abhi nahi'],
  HINDI: ['हाँ, call कीजिए', 'अभी नहीं'],
};

function optionsForStep(step, lang) {
  switch (step) {
    case 1: return COLLEGE_OPTIONS;
    case 2: return BRANCH_OPTIONS;
    case 3: return PCM_OPTIONS;
    case 4: return EXAM_OPTIONS;
    case 5: return []; // NAME — free-text reply
    case 6: return CALL_OPTIONS[lang] || CALL_OPTIONS.ENGLISH;
    default: return [];
  }
}

function sectionsForStep(step) {
  return null; // short option lists — no need for sections
}

// Step 5 — sent after exam answer. Short result + ask for name as free text.
const RESULT_AND_NAME_QUESTIONS = {
  ENGLISH:
    'Great chances 👍\n' +
    "We'll guide you with best options & next steps.\n\n" +
    'What is your name?',
  HINGLISH:
    'Bahut acche chances 👍\n' +
    'Best options aur next steps guide karenge.\n\n' +
    'Aapka naam kya hai?',
  HINDI:
    'बहुत अच्छे chances 👍\n' +
    'Best options और next steps guide करेंगे।\n\n' +
    'आपका नाम क्या है?',
};

// Step 5 — sent after name is captured. Short call CTA.
const CALL_QUESTIONS = {
  ENGLISH:
    'Free 10-min call 📞\n\n' +
    'Check your exact chances?',
  HINGLISH:
    'Free 10-min call 📞\n\n' +
    'Sahi chances check karein?',
  HINDI:
    'Free 10-min call 📞\n\n' +
    'सही chances check करें?',
};

// 4-question funnel:
//   table[0] = entry hook   (sent on first turn before Q1)
//   table[1] = Q1 — college (with hook prepended on first turn)
//   table[2] = Q2 — branch  (free-text or numbered shortcut)
//   table[3] = Q3 — PCM     (preceded by "Limited seats" reinforcement)
//   table[4] = Q4 — exam
const FALLBACK_QUESTIONS = {
  ENGLISH: {
    0:
      'Hi 👋\n\n' +
      'Confused about BTech admission?\n\n' +
      'Get DIRECT ADMISSION in RVCE, BMSCE, PES, SRM — even with low rank.\n\n' +
      'Seats filling fast ⚠️',
    1: 'Which college?',
    2: 'Great choice 👍\nAny preferred branch?',
    3: 'Limited seats — checking your chances 👇\nYour 12th PCM %?',
    4: 'Any entrance exam?',
  },
  HINGLISH: {
    0:
      'Hi 👋\n\n' +
      'BTech admission ke liye confused ho?\n\n' +
      'RVCE, BMSCE, PES, SRM mein DIRECT ADMISSION pao — kam rank par bhi.\n\n' +
      'Seats jaldi bhar rahi hain ⚠️',
    1: 'Kaunsa college?',
    2: 'Bahut accha choice 👍\nKoi preferred branch?',
    3: 'Limited seats — chances check kar raha hoon 👇\nAapka 12th PCM %?',
    4: 'Koi entrance exam diya hai?',
  },
  HINDI: {
    0:
      'नमस्ते 👋\n\n' +
      'BTech admission को लेकर confused हैं?\n\n' +
      'RVCE, BMSCE, PES, SRM में DIRECT ADMISSION पाएँ — कम rank पर भी।\n\n' +
      'Seats जल्दी भर रही हैं ⚠️',
    1: 'कौन सा college?',
    2: 'बहुत अच्छी choice 👍\nकोई preferred branch?',
    3: 'Limited seats — chances check कर रहा हूँ 👇\nआपका 12th PCM %?',
    4: 'कोई entrance exam दिया है?',
  },
};

const LAST_AI_STEP = 4; // step 4 (exam) is the last funnel question
const NAME_STEP = 5;     // step 5 = result message + ask for name (free text)
const CALL_STEP = 6;     // step 6 = call CTA (yes/no)

// Sent when a customer messages AFTER they've already completed the funnel.
// Don't loop them through the questions again — just confirm the team will call.
const POST_COMPLETION_REMINDER = {
  ENGLISH: '✅ Got it. Our admission team will call you shortly. Anything urgent? Just share your preferred call time.',
  HINGLISH: '✅ Theek hai. Hamari admission team aapko jaldi hi call karegi. Urgent ho to call ka preferred time bata dijiye.',
  HINDI: '✅ ठीक है। हमारी admission team आपको जल्दी call करेगी। Urgent हो तो call का preferred time बता दीजिए।',
};

const PRICE_DEFLECTION = {
  ENGLISH:
    "📞 About fees — those depend on your category, branch, and seat type, so I won't quote a number here. " +
    "I've flagged you for a callback — our admission counsellor will call within 30 minutes with the exact figures. " +
    "Meanwhile, let's continue:",
  HINGLISH:
    "📞 Fees ke baare mein — woh aapki category, branch aur seat type pe depend karta hai, isliye main yahaan number nahi bata sakta. " +
    "Maine aapko callback ke liye flag kar diya hai — hamare admission counsellor 30 minute mein call karke exact figures bataenge. " +
    "Tab tak yeh continue karte hain:",
  HINDI:
    "📞 फीस के बारे में — यह आपकी category, branch और seat type पर निर्भर करता है, इसलिए main yahaan कोई number नहीं बता सकता। " +
    "मैंने आपको callback के लिए flag कर दिया है — हमारे admission counsellor 30 minute में call करके exact figures बताएंगे। " +
    "तब तक यह continue करते हैं:",
};

function captureFallbackAnswer(session, message) {
  const text = String(message || '').trim();
  if (!text) return;
  const step = session.current_step || 0;
  const p = session.partial_lead || {};
  switch (step) {
    case 1: {
      const cols = text.split(/,|&|\band\b/i).map((s) => s.trim()).filter(Boolean);
      p.colleges_interested = Array.from(new Set([...(p.colleges_interested || []), ...cols]));
      break;
    }
    case 2: p.branch = /^not sure$/i.test(text) ? '' : text; break;
    case 3: p.pcm_percentage = text; break;
    case 4: p.exam_status = text; break;
    case 5: p.name = text; break;
  }
  p.course_interest = 'BTech';
  session.partial_lead = p;
  session.markModified('partial_lead');
}

function buildCompletionReply(session, lead) {
  const lang = session.language_mode || 'ENGLISH';
  return {
    ENGLISH: '✅ Thanks! Our admission team will call you shortly to guide you on direct admission.',
    HINGLISH: '✅ Shukriya! Hamari admission team aapko jaldi hi call karegi aur direct admission ka process guide karegi.',
    HINDI: '✅ धन्यवाद! हमारी admission team आपको जल्दी call करेगी और direct admission process समझाएगी।',
  }[lang];
}

function mergePartialLead(base, extracted) {
  if (!extracted || typeof extracted !== 'object') return base;
  const merged = { ...base };
  if (extracted.name) merged.name = extracted.name;
  if (extracted.branch) merged.branch = extracted.branch;
  if (Array.isArray(extracted.colleges_interested) && extracted.colleges_interested.length) {
    merged.colleges_interested = Array.from(
      new Set([...(merged.colleges_interested || []), ...extracted.colleges_interested])
    );
  }
  if (extracted.city) merged.city = extracted.city;
  if (extracted.pcm_percentage) merged.pcm_percentage = extracted.pcm_percentage;
  if (extracted.budget) merged.budget = extracted.budget;
  if (extracted.admission_timeline) merged.admission_timeline = extracted.admission_timeline;
  if (extracted.exam_status) merged.exam_status = extracted.exam_status;
  merged.course_interest = 'BTech';
  return merged;
}

function buildFinalLead(session, aiLead) {
  const base = {
    name: session.partial_lead?.name || '',
    phone_number: session.phone_number,
    course_interest: 'BTech',
    branch: session.partial_lead?.branch || '',
    colleges_interested: session.partial_lead?.colleges_interested || [],
    city: session.partial_lead?.city || '',
    pcm_percentage: session.partial_lead?.pcm_percentage || '',
    budget: session.partial_lead?.budget || '',
    admission_timeline: session.partial_lead?.admission_timeline || '',
    exam_status: session.partial_lead?.exam_status || '',
    lead_score: '',
    probability: 0,
    summary: '',
  };

  const merged = { ...base, ...(aiLead || {}) };
  merged.phone_number = session.phone_number;
  merged.course_interest = 'BTech';

  const { lead } = validateLead(merged);
  // validateLead may strip unknown fields — re-attach the new ones explicitly
  lead.branch = merged.branch || '';
  lead.city = merged.city || '';
  lead.pcm_percentage = merged.pcm_percentage || '';

  if (!lead.lead_score || lead.probability <= 0) {
    const fb = scoreLead(lead);
    lead.lead_score = fb.lead_score;
    lead.probability = fb.probability;
  }

  if (!lead.summary) {
    const parts = [
      'Student interested in BTech',
      lead.branch ? `(${lead.branch})` : '',
      lead.colleges_interested.length ? `targeting ${lead.colleges_interested.join(', ')}` : '',
      lead.city ? `from ${lead.city}` : '',
      lead.pcm_percentage ? `12th PCM ${lead.pcm_percentage}` : '',
      lead.admission_timeline ? `, ${lead.admission_timeline}` : '',
      lead.exam_status ? `, exam: ${lead.exam_status}` : '',
    ];
    lead.summary = parts.filter(Boolean).join(' ').replace(/\s+,/g, ',').trim();
  }

  return lead;
}

function mapNumericReply(text, lastOptions) {
  const trimmed = String(text || '').trim();
  if (!lastOptions || lastOptions.length === 0) return trimmed;
  const m = trimmed.match(/^(\d{1,2})$/);
  if (!m) return trimmed;
  const idx = parseInt(m[1], 10) - 1;
  if (idx < 0 || idx >= lastOptions.length) return trimmed;
  return lastOptions[idx];
}

async function finalizeLead(session) {
  const finalLead = buildFinalLead(session, null);

  const interest = scoreInterest(session, { wants_call: session.wants_call });
  finalLead.wants_call = !!session.wants_call;
  finalLead.interest_score = interest.score;
  finalLead.interest_level = interest.level;
  finalLead.interest_signals = interest.signals;
  finalLead.is_mature = !!session.wants_call || interest.score >= 8;
  if (session.wants_call) finalLead.call_requested_at = new Date();

  // Carry price-inquiry signal onto the lead so the app can show the badge
  finalLead.price_inquiry = !!session.price_inquiry;
  finalLead.price_inquiry_at = session.price_inquiry_at || null;
  finalLead.price_inquiry_count = session.price_inquiry_count || 0;

  const reply = buildCompletionReply(session, finalLead);

  session.completed = true;
  session.current_step = 9;
  session.last_options = [];
  session.history.push({ role: 'assistant', content: reply });

  if (!isValidWhatsAppPhone(finalLead.phone_number)) {
    logger.warn(
      `⚠️  Lead phone "${finalLead.phone_number}" looks suspicious (not standard ` +
      `WhatsApp E.164). Saving anyway — investigate the JID source if this repeats.`
    );
  }
  try {
    await Lead.findOneAndUpdate(
      { phone_number: finalLead.phone_number },
      { ...finalLead, language_mode: session.language_mode },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    logger.error(`Lead save failed for ${finalLead.phone_number}: ${err.message}`);
  }

  console.log('\n======== NEW QUALIFIED LEAD ========');
  console.log(JSON.stringify(finalLead, null, 2));
  console.log('====================================\n');
  try { notifyNewLead(finalLead); } catch (_) {}
  pingDashboardWebhook(finalLead);

  try {
    await session.save();
  } catch (err) {
    logger.error(`Session save failed for ${session.phone_number}: ${err.message}`);
  }

  return {
    reply,
    options: [],
    optionSections: null,
    complete: true,
    language_mode: session.language_mode,
    current_step: session.current_step,
    lead: finalLead,
    is_mature: finalLead.is_mature,
  };
}

// How long the bot stays silent after a human types in WhatsApp.
const HUMAN_HANDOFF_MINUTES = parseInt(process.env.HUMAN_HANDOFF_MINUTES || '30', 10);

/**
 * Called by Baileys when the paired WhatsApp account sends a message that the
 * bot didn't generate (i.e. a human typed it directly). Bumps bot_paused_until
 * for that phone so subsequent customer messages get ignored by the bot.
 */
async function markHumanHandoff(phone_number, humanText) {
  const now = new Date();
  const session = await Session.findOne({ phone_number });
  const isFirstHandoff = !session?.last_human_message_at;

  if (!session) {
    // Counsellor messaged a number that has no prior session yet — create
    // placeholder so future customer messages know the counsellor is handling it.
    const ph = new Session({
      phone_number,
      language_mode: 'ENGLISH',
      current_step: -1,
      partial_lead: {},
      history: [{ role: 'human', content: humanText || '', at: now }],
      last_options: [],
      wants_call: false,
      bot_paused_until: new Date(now.getTime() + HUMAN_HANDOFF_MINUTES * 60_000),
      last_human_message_at: now,
    });
    await ph.save();
  } else {
    session.bot_paused_until = new Date(now.getTime() + HUMAN_HANDOFF_MINUTES * 60_000);
    session.last_human_message_at = now;
    session.history.push({ role: 'human', content: humanText || '', at: now });
    await session.save();
  }

  // First-time handoff — also update the Lead doc (if one exists) and ping
  // the dashboard so the app can flip the lead's status to "in progress".
  if (isFirstHandoff && isValidWhatsAppPhone(phone_number)) {
    try {
      const updated = await Lead.findOneAndUpdate(
        { phone_number },
        {
          $set: {
            // mirrors lead_states.status semantics from the dashboard
            interest_level: 'HIGH',
            is_mature: true,
          },
        },
        { new: true }
      );
      if (updated) {
        pingDashboardWebhook({
          phone_number,
          name: updated.name,
          colleges_interested: updated.colleges_interested,
          handoff: true,
          handoff_at: now.toISOString(),
          handoff_first_message: humanText || '',
        });
        logger.info(`📲 Counsellor handoff webhook fired [${phone_number}]`);
      }
    } catch (err) {
      logger.warn(`Handoff webhook update failed for ${phone_number}: ${err.message}`);
    }
  }
}

// Per-phone async queue: serializes message processing for the same user so
// rapid back-to-back messages can't double-write the session document.
const phoneLocks = new Map();

// Mid-funnel high-priority flag: customer said "call me" or asked about price
// BEFORE finishing the funnel. Upserts a partial Lead doc so the app shows it
// immediately as HOT, and pings the dashboard webhook for instant push.
// Idempotent — only fires the FIRST time wants_call transitions to true.
async function flagLeadWantsCallMidFunnel(session, reason) {
  const phone = session.phone_number;
  const partial = session.partial_lead || {};
  const update = {
    phone_number: phone,
    course_interest: 'BTech',
    name: partial.name || '',
    branch: partial.branch || '',
    colleges_interested: partial.colleges_interested || [],
    city: partial.city || '',
    pcm_percentage: partial.pcm_percentage || '',
    exam_status: partial.exam_status || '',
    admission_timeline: partial.admission_timeline || '',
    wants_call: true,
    is_mature: true,
    call_requested_at: new Date(),
    language_mode: session.language_mode || 'ENGLISH',
    price_inquiry: !!session.price_inquiry,
    price_inquiry_at: session.price_inquiry_at || null,
    price_inquiry_count: session.price_inquiry_count || 0,
    interest_level: 'HIGH',
    summary: `[Mid-funnel] Wants call — reason: ${reason}. Step ${session.current_step}.`,
  };

  if (!isValidWhatsAppPhone(phone)) {
    logger.warn(`⚠️  Skipping mid-funnel flag for invalid phone: "${phone}"`);
    return;
  }

  try {
    await Lead.findOneAndUpdate(
      { phone_number: phone },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    logger.info(`📞 Lead flagged HOT mid-funnel [${phone}] reason=${reason} step=${session.current_step}`);
    pingDashboardWebhook(update);
  } catch (err) {
    logger.error(`Mid-funnel lead flag failed for ${phone}: ${err.message}`);
  }
}

async function processMessage(phone_number, rawMessage) {
  const previous = phoneLocks.get(phone_number) || Promise.resolve();
  const next = previous
    .catch(() => {}) // never let a failed prior turn block the next one
    .then(() => processMessageInner(phone_number, rawMessage));

  phoneLocks.set(phone_number, next);

  try {
    return await next;
  } finally {
    if (phoneLocks.get(phone_number) === next) {
      phoneLocks.delete(phone_number);
    }
  }
}

async function processMessageInner(phone_number, rawMessage) {
  let session = await Session.findOne({ phone_number });

  // Human handoff: if a human typed in WhatsApp recently, stay silent.
  // Bumps last_user_message_at so follow-ups don't fire either.
  if (session && session.bot_paused_until && session.bot_paused_until > new Date()) {
    const minsLeft = Math.ceil((session.bot_paused_until - Date.now()) / 60000);
    logger.info(`🤐 Bot paused [${phone_number}] — human handling (${minsLeft}m left). Skipping reply.`);
    session.history.push({ role: 'user', content: rawMessage });
    session.last_user_message_at = new Date();
    session.followup_count = 0;
    session.last_followup_at = null;
    try { await session.save(); } catch (_) {}
    return { reply: '', options: [], complete: false, paused: true };
  }

  const isFirstTurn = !session;

  // First contact — send entry hook + Q1 directly (no language picker).
  if (!session) {
    const lang = 'ENGLISH';
    const table = FALLBACK_QUESTIONS[lang];
    const reply = `${table[0]}\n\n${table[1]}`;
    const options = optionsForStep(1, lang);
    session = new Session({
      phone_number,
      language_mode: lang,
      current_step: 1,
      partial_lead: {},
      history: [],
      last_options: options,
      wants_call: false,
    });
    session.history.push({ role: 'user', content: rawMessage });
    session.history.push({ role: 'assistant', content: reply });
    session.last_user_message_at = new Date();
    await session.save();
    logger.info(`New session [${phone_number}] — sent entry hook + Q1`);
    return {
      reply,
      options,
      optionSections: sectionsForStep(1),
      complete: false,
      language_mode: lang,
      current_step: 1,
      lead: null,
      is_mature: false,
    };
  }

  // NAME_STEP — capture user's free-text reply as their name, then ask call CTA.
  if (session.current_step === NAME_STEP) {
    const name = String(rawMessage || '').trim();
    session.history.push({ role: 'user', content: name });
    session.last_user_message_at = new Date();
    session.followup_count = 0;
    session.last_followup_at = null;
    if (name) {
      session.partial_lead = { ...(session.partial_lead || {}), name };
      session.markModified('partial_lead');
    }
    session.current_step = CALL_STEP;
    const lang = session.language_mode || 'ENGLISH';
    const reply = CALL_QUESTIONS[lang] || CALL_QUESTIONS.ENGLISH;
    const options = optionsForStep(CALL_STEP, lang);
    session.history.push({ role: 'assistant', content: reply });
    session.last_options = options;
    logger.info(
      `OUT [${phone_number}] (${lang}) step=${CALL_STEP} (name="${name}") -> ${reply.replace(/\n/g, ' | ')}`
    );
    await session.save();
    return {
      reply,
      options,
      optionSections: null,
      complete: false,
      language_mode: lang,
      current_step: CALL_STEP,
      lead: null,
      is_mature: false,
    };
  }

  // Map numeric reply ("1", "11", ...) to option text the bot offered last
  const message = mapNumericReply(rawMessage, session.last_options);
  if (message !== rawMessage) {
    logger.info(`Mapped option "${rawMessage}" -> "${message}"`);
  }

  session.history.push({ role: 'user', content: message });
  // User replied — reset follow-up cadence
  session.last_user_message_at = new Date();
  session.followup_count = 0;
  session.last_followup_at = null;
  logger.info(`IN  [${phone_number}] (${session.language_mode}) step=${session.current_step}: ${message}`);

  // Track whether wants_call was already true before this turn — only fire the
  // mid-funnel webhook the FIRST time it transitions to true.
  const wasWantsCallBefore = !!session.wants_call;
  let flagReason = null;

  if (mentionsCall(message)) {
    session.wants_call = true;
    if (!wasWantsCallBefore) flagReason = 'mentionsCall';
  }

  // Price inquiry — auto-flag for high-priority callback, never disclose price in chat
  const priceJustAsked = mentionsPrice(message);
  if (priceJustAsked) {
    session.wants_call = true;
    session.price_inquiry = true;
    session.price_inquiry_at = new Date();
    session.price_inquiry_count = (session.price_inquiry_count || 0) + 1;
    logger.info(`Price inquiry detected [${phone_number}]: "${message}" — auto-flagged for callback`);
    if (!wasWantsCallBefore && !flagReason) flagReason = 'priceInquiry';
  }

  // Fire mid-funnel HOT flag (lead → app + push notification) on first transition
  if (flagReason && session.current_step !== CALL_STEP) {
    await flagLeadWantsCallMidFunnel(session, flagReason);
  }

  // CALL_STEP — only finalize on explicit yes/no. Off-track input (price
  // questions, random questions) falls through to the AI/fallback below
  // which answers the question and re-asks the call CTA.
  if (session.current_step === CALL_STEP) {
    if (isYes(message)) {
      session.wants_call = true;
      return await finalizeLead(session);
    }
    if (isNo(message)) {
      session.wants_call = false;
      return await finalizeLead(session);
    }
    // Neither yes nor no — fall through to AI/fallback. AI will answer
    // the user's off-track question and the system re-asks the CTA.
  }

  let reply = '';
  let options = [];
  let optionSections = null;

  // Three modes — pick what the AI/fallback should do:
  //   completed=true   → support mode (answer questions, don't advance, don't re-finalize)
  //   CALL_STEP        → off-track at call CTA (answer + re-ask CTA, don't advance)
  //   normal funnel    → advance steps as usual
  const isPostCompletion = session.completed === true;
  const isCallStepOffTrack = session.current_step === CALL_STEP && !isPostCompletion;

  try {
    const rawAI = await aiService.runTurn(session, message);
    const parsed = extractJSON(rawAI);
    if (!parsed) throw new Error('AI returned non-JSON output');

    reply = String(parsed.reply || '').trim();

    if (isPostCompletion) {
      // AI answered the user's question. Don't advance, don't re-save lead.
      // Fallback to canned reminder if AI returned empty.
      if (!reply) reply = POST_COMPLETION_REMINDER[session.language_mode] || POST_COMPLETION_REMINDER.ENGLISH;
      options = [];
      optionSections = null;
    } else if (isCallStepOffTrack) {
      // AI answered off-track question; we re-append the call CTA so the user knows what to do.
      const callReply = CALL_QUESTIONS[session.language_mode] || CALL_QUESTIONS.ENGLISH;
      reply = reply ? `${reply}\n\n${callReply}` : callReply;
      options = optionsForStep(CALL_STEP, session.language_mode);
      optionSections = null;
    } else {
      // Normal funnel: advance step from AI output (clamped to prev or prev+1)
      const previousStep = session.current_step || 0;
      if (Number.isInteger(parsed.next_step)) {
        const proposed = parsed.next_step;
        const allowed = Math.min(Math.max(proposed, previousStep), previousStep + 1);
        if (proposed !== allowed) {
          logger.warn(`AI proposed next_step=${proposed} from prev=${previousStep}; clamped to ${allowed}`);
        }
        session.current_step = allowed;
      }
      session.partial_lead = mergePartialLead(session.partial_lead || {}, parsed.extracted);

      const finishedAllAIQs = parsed.complete === true || previousStep >= LAST_AI_STEP;
      if (finishedAllAIQs) {
        session.current_step = NAME_STEP;
        reply = RESULT_AND_NAME_QUESTIONS[session.language_mode] || RESULT_AND_NAME_QUESTIONS.ENGLISH;
        options = optionsForStep(NAME_STEP, session.language_mode);
      } else {
        options = optionsForStep(session.current_step, session.language_mode);
        optionSections = sectionsForStep(session.current_step);
      }
    }
  } catch (aiErr) {
    logger.error(`AI path failed: ${aiErr.message}. Falling back to scripted flow.`);
    const lang = session.language_mode || 'ENGLISH';

    if (isPostCompletion) {
      // No AI — just send the canned reminder
      reply = POST_COMPLETION_REMINDER[lang] || POST_COMPLETION_REMINDER.ENGLISH;
      options = [];
    } else if (isCallStepOffTrack) {
      // No AI — just re-ask the call question
      reply = CALL_QUESTIONS[lang] || CALL_QUESTIONS.ENGLISH;
      options = optionsForStep(CALL_STEP, lang);
    } else {
      const table = FALLBACK_QUESTIONS[lang] || FALLBACK_QUESTIONS.ENGLISH;
      const current = session.current_step || 0;
      captureFallbackAnswer(session, message);

      if (isFirstTurn) {
        reply = `${table[0]}\n\n${table[1]}`;
        session.current_step = 1;
        options = optionsForStep(1, lang);
        optionSections = sectionsForStep(1);
      } else if (current < LAST_AI_STEP) {
        const nextStep = current + 1;
        reply = table[nextStep];
        session.current_step = nextStep;
        options = optionsForStep(nextStep, lang);
        optionSections = sectionsForStep(nextStep);
      } else {
        session.current_step = NAME_STEP;
        reply = RESULT_AND_NAME_QUESTIONS[lang] || RESULT_AND_NAME_QUESTIONS.ENGLISH;
        options = optionsForStep(NAME_STEP, lang);
      }
    }
  }

  if (!reply) reply = FALLBACK_QUESTIONS[session.language_mode]?.[1] || 'Could you share a bit more?';

  // Prepend price deflection if user just asked about cost — never reveal numbers in chat
  if (priceJustAsked) {
    const deflection = PRICE_DEFLECTION[session.language_mode] || PRICE_DEFLECTION.ENGLISH;
    reply = `${deflection}\n\n${reply}`;
  }

  session.history.push({ role: 'assistant', content: reply });
  session.last_options = options;
  logger.info(
    `OUT [${phone_number}] (${session.language_mode}) step=${session.current_step} opts=[${options.join('|')}] -> ${reply.replace(/\n/g, ' | ')}`
  );

  await session.save();

  return {
    reply,
    options,
    optionSections,
    complete: false,
    language_mode: session.language_mode,
    current_step: session.current_step,
    lead: null,
    is_mature: false,
  };
}

async function handleMessage(req, res) {
  const { phone_number, message } = req.body || {};
  if (!phone_number || !message) {
    return res.status(400).json({ error: 'phone_number and message are required' });
  }
  try {
    const out = await processMessage(phone_number, message);
    return res.json(out);
  } catch (err) {
    logger.error(`handleMessage error: ${err.stack || err.message}`);
    return res.status(500).json({ error: 'Failed to process message' });
  }
}

module.exports = { handleMessage, processMessage, markHumanHandoff };
