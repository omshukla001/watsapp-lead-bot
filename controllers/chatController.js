const Session = require('../models/sessionModel');
const Lead = require('../models/leadModel');
const aiService = require('../services/aiService');
const { detectLanguage } = require('../services/languageService');
const { extractJSON, validateLead, scoreLead } = require('../utils/parser');
const { notifyNewLead } = require('../services/termuxNotify');
const { isYes, isNo, mentionsCall } = require('../services/maturityDetector');
const { score: scoreInterest } = require('../services/interestScorer');
const logger = require('../utils/logger');

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

// Top 10 Bangalore engineering colleges (separated from SRM Chennai per request)
const BLR_TOP_10 = [
  'RVCE',
  'BMSCE',
  'PES University',
  'MSRIT',
  'Dayananda Sagar',
  'RNSIT',
  'NMIT',
  'CMRIT',
  'BMSIT',
  'SJBIT',
];

const COLLEGE_OPTIONS = [
  ...BLR_TOP_10,
  'SRM Chennai',
  'Multiple colleges',
  'Other',
];

// Sectioned for WhatsApp list message — keeps Bangalore separate from SRM Chennai
const COLLEGE_SECTIONS = [
  { title: 'Top 10 Bangalore', items: BLR_TOP_10 },
  { title: 'Other Cities', items: ['SRM Chennai'] },
  { title: 'More', items: ['Multiple colleges', 'Other'] },
];

const BRANCH_OPTIONS = [
  'Computer Science (CSE)',
  'Information Technology (IT)',
  'AI & Machine Learning',
  'Data Science',
  'Electronics & Communication (ECE)',
  'Electrical (EEE)',
  'Mechanical',
  'Civil',
  'Other',
];

const CITY_OPTIONS = [
  'Bangalore',
  'Hyderabad',
  'Chennai',
  'Mumbai',
  'Delhi NCR',
  'Pune',
  'Kolkata',
  'Other',
];

const PCM_OPTIONS = [
  '95-100%',
  '90-94%',
  '85-89%',
  '80-84%',
  '70-79%',
  '60-69%',
  'Below 60%',
  'Awaiting result',
];

const EXAM_OPTIONS = ['KCET', 'COMEDK', 'JEE', 'Multiple exams', 'None yet'];

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
    case 3: return CITY_OPTIONS;
    case 4: return PCM_OPTIONS;
    case 5: return EXAM_OPTIONS;
    case 6: return TIMELINE_OPTIONS[lang] || TIMELINE_OPTIONS.ENGLISH;
    case 7: return [];
    case 8: return CALL_OPTIONS[lang] || CALL_OPTIONS.ENGLISH;
    default: return [];
  }
}

function sectionsForStep(step) {
  if (step === 1) return COLLEGE_SECTIONS;
  return null;
}

const CALL_QUESTIONS = {
  ENGLISH: 'Last thing — would you like our admission team to give you a quick call about next steps?',
  HINGLISH: 'Aakhri baat — kya aap chahte ho hamari admission team aapko ek quick call kare aur next steps samjhaye?',
  HINDI: 'आख़िरी बात — क्या आप चाहेंगे कि हमारी admission team आपको call करके next steps समझाए?',
};

const FALLBACK_QUESTIONS = {
  ENGLISH: {
    0: "Hi 👋 I'm here to help you with **direct admission** for BTech in top Bangalore colleges (RVCE, BMSCE, PES, MSRIT, etc.) and SRM Chennai. I'll ask a few quick questions so I can guide you on the best route.",
    1: 'Which college are you most interested in?',
    2: 'Which BTech branch are you planning for?',
    3: 'Which city are you from?',
    4: 'What was your 12th PCM (Physics, Chemistry, Maths) percentage?',
    5: 'Have you appeared for any entrance exams like KCET, COMEDK, or JEE?',
    6: 'When are you planning to take admission?',
    7: 'Please share your name so I can note your details.',
  },
  HINGLISH: {
    0: 'Hi 👋 Main yahaan hoon **direct admission** ke liye — BTech mein Bangalore ke top colleges (RVCE, BMSCE, PES, MSRIT) aur SRM Chennai ke liye. Kuch quick questions poochhunga taaki main best route guide kar sakun.',
    1: 'Aap kis college mein interested ho?',
    2: 'Kaunsi BTech branch lena chahte ho?',
    3: 'Aap kis sheher se ho?',
    4: 'Aapka 12th PCM (Physics, Chemistry, Maths) percentage kya tha?',
    5: 'Kya aapne KCET, COMEDK ya JEE jaisa entrance exam diya hai?',
    6: 'Admission kab tak lena chahte ho?',
    7: 'Apna naam share kar dijiye.',
  },
  HINDI: {
    0: 'नमस्ते 👋 मैं यहाँ हूँ **direct admission** के लिए — BTech में Bangalore के top colleges (RVCE, BMSCE, PES, MSRIT) और SRM Chennai के लिए। कुछ छोटे सवाल पूछूँगा ताकि best route guide कर सकूँ।',
    1: 'आप किस college में interested हैं?',
    2: 'कौन सी BTech branch करना चाहते हैं?',
    3: 'आप किस शहर से हैं?',
    4: 'आपका 12th PCM (Physics, Chemistry, Maths) percentage क्या था?',
    5: 'क्या आपने KCET, COMEDK या JEE जैसा entrance exam दिया है?',
    6: 'Admission कब तक लेना चाहते हैं?',
    7: 'कृपया अपना नाम बता दीजिए।',
  },
};

const LAST_AI_STEP = 7; // step 7 (name) is the last question the AI handles
const CALL_STEP = 8;

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
    case 2: p.branch = text; break;
    case 3: p.city = text; break;
    case 4: p.pcm_percentage = text; break;
    case 5: p.exam_status = text; break;
    case 6: p.admission_timeline = text; break;
    case 7: {
      const m = text.match(/(?:my name is|i am|name[: ]+)?\s*([A-Za-z][A-Za-z\s.'-]{1,40})$/i);
      p.name = (m && m[1] ? m[1] : text).trim();
      break;
    }
  }
  p.course_interest = 'BTech';
  session.partial_lead = p;
  session.markModified('partial_lead');
}

function buildCompletionReply(session, lead) {
  const lang = session.language_mode || 'ENGLISH';
  const cols = (lead.colleges_interested || []).join(', ') || 'your shortlisted colleges';
  const hasColleges = (lead.colleges_interested || []).length > 0;

  const band = {
    ENGLISH: {
      HIGH: 'You have a strong profile. We can guide you with the best possible admission routes.',
      MEDIUM: 'You have a decent profile. With the right guidance, we can help you shortlist suitable colleges.',
      LOW: "You're still exploring, which is completely fine. I can help you understand the admission process and options.",
    },
    HINGLISH: {
      HIGH: 'Aapka profile strong hai. Hum best admission routes guide kar sakte hain.',
      MEDIUM: 'Aapka profile decent hai. Sahi guidance ke saath hum suitable colleges shortlist karne mein madad karenge.',
      LOW: 'Aap abhi explore kar rahe ho, koi baat nahi. Main admission process aur options samajhne mein help kar sakta hoon.',
    },
    HINDI: {
      HIGH: 'आपकी profile strong है। हम best admission routes में guide करेंगे।',
      MEDIUM: 'आपकी profile decent है। सही guidance के साथ हम suitable colleges shortlist करने में मदद करेंगे।',
      LOW: 'आप अभी explore कर रहे हैं, कोई बात नहीं। मैं admission process और options समझने में मदद कर सकता हूँ।',
    },
  }[lang][lead.lead_score] || '';

  const callConfirm = lead.wants_call
    ? {
        ENGLISH: '📞 Perfect — our admission team will reach out shortly.',
        HINGLISH: '📞 Perfect — hamari admission team jaldi hi aapko call karegi.',
        HINDI: '📞 बढ़िया — हमारी admission team जल्दी ही आपको call करेगी।',
      }[lang]
    : '';

  const mgmtLine = hasColleges
    ? {
        ENGLISH: `We can help you with **direct admission** in ${cols} — our team will guide you on the exact process.`,
        HINGLISH: `Hum ${cols} mein **direct admission** mein madad kar sakte hain — hamari team aapko exact process guide karegi.`,
        HINDI: `हम ${cols} में **direct admission** में मदद कर सकते हैं — हमारी team आपको exact process guide करेगी।`,
      }[lang]
    : {
        ENGLISH: 'Our admission team can guide you through **direct admission** options in top colleges.',
        HINGLISH: 'Hamari admission team aapko top colleges mein **direct admission** options guide karegi.',
        HINDI: 'हमारी admission team आपको top colleges में **direct admission** options guide करेगी।',
      }[lang];

  const branchUrgency = (lead.branch || '').toLowerCase();
  const isPremiumBranch =
    branchUrgency.includes('cse') ||
    branchUrgency.includes('computer') ||
    branchUrgency.includes('ai') ||
    branchUrgency.includes('ml') ||
    branchUrgency.includes('data science') ||
    branchUrgency.includes('information technology');

  const branchPart = lead.branch ? ` ${lead.branch}` : '';

  const urgencyLine = isPremiumBranch
    ? {
        ENGLISH: `🚨 Direct admission for ${cols}${branchPart} is going on RIGHT NOW and seats are filling fast — premium branches like CSE / AI-ML close within days. Please make a quick decision so we can lock your spot before it's gone.`,
        HINGLISH: `🚨 ${cols}${branchPart} mein direct admission abhi chal raha hai aur seats jaldi bhar rahi hain — CSE / AI-ML jaisi premium branches kuch din mein hi close ho jaati hain. Please jaldi decision lijiye taaki hum aapka spot lock kar saken.`,
        HINDI: `🚨 ${cols}${branchPart} में direct admission अभी चल रहा है और seats जल्दी भर रही हैं — CSE / AI-ML जैसी premium branches कुछ ही दिनों में close हो जाती हैं। कृपया जल्दी decision लीजिए ताकि हम आपका spot lock कर सकें।`,
      }[lang]
    : {
        ENGLISH: `🚨 Direct admission for ${cols} is going on RIGHT NOW and seats are filling fast every week. Please make a quick decision so we can secure your preferred branch.`,
        HINGLISH: `🚨 ${cols} mein direct admission abhi chal raha hai aur seats har hafte jaldi bhar rahi hain. Please quick decision lijiye taaki hum aapki preferred branch secure kar saken.`,
        HINDI: `🚨 ${cols} में direct admission अभी चल रहा है और seats हर हफ़्ते जल्दी भर रही हैं। कृपया quick decision लीजिए ताकि हम आपकी preferred branch secure कर सकें।`,
      }[lang];

  return [band, callConfirm, mgmtLine, urgencyLine].filter(Boolean).join('\n');
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

  const reply = buildCompletionReply(session, finalLead);

  session.completed = true;
  session.current_step = 9;
  session.last_options = [];
  session.history.push({ role: 'assistant', content: reply });

  await Lead.findOneAndUpdate(
    { phone_number: finalLead.phone_number },
    { ...finalLead, language_mode: session.language_mode },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // eslint-disable-next-line no-console
  console.log('\n======== NEW QUALIFIED LEAD ========');
  console.log(JSON.stringify(finalLead, null, 2));
  console.log('====================================\n');
  notifyNewLead(finalLead);

  await session.save();

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

async function processMessage(phone_number, rawMessage) {
  let session = await Session.findOne({ phone_number });
  const isFirstTurn = !session;

  if (!session) {
    session = new Session({
      phone_number,
      language_mode: detectLanguage(rawMessage),
      current_step: 0,
      partial_lead: {},
      history: [],
      last_options: [],
      wants_call: false,
    });
  } else if (session.history.length <= 1) {
    session.language_mode = detectLanguage(rawMessage) || session.language_mode;
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

  if (mentionsCall(message)) {
    session.wants_call = true;
  }

  // Step 8: explicit answer to call question -> finalize
  if (session.current_step === CALL_STEP) {
    if (isYes(message)) session.wants_call = true;
    else if (isNo(message)) session.wants_call = false;
    return await finalizeLead(session);
  }

  let reply = '';
  let options = [];
  let optionSections = null;

  try {
    const rawAI = await aiService.runTurn(session, message);
    const parsed = extractJSON(rawAI);
    if (!parsed) throw new Error('AI returned non-JSON output');

    reply = String(parsed.reply || '').trim();
    const previousStep = session.current_step || 0;
    if (Number.isInteger(parsed.next_step)) session.current_step = parsed.next_step;
    session.partial_lead = mergePartialLead(session.partial_lead || {}, parsed.extracted);

    const finishedAllAIQs = parsed.complete === true || previousStep >= LAST_AI_STEP;

    if (finishedAllAIQs) {
      if (!session.partial_lead.name) {
        const m = String(message).match(/(?:my name is|i am|name[: ]+)?\s*([A-Za-z][A-Za-z\s.'-]{1,40})$/i);
        if (m && m[1]) {
          session.partial_lead.name = m[1].trim();
          session.markModified('partial_lead');
        }
      }
      session.current_step = CALL_STEP;
      reply = CALL_QUESTIONS[session.language_mode] || CALL_QUESTIONS.ENGLISH;
      options = optionsForStep(CALL_STEP, session.language_mode);
    } else {
      options = optionsForStep(session.current_step, session.language_mode);
      optionSections = sectionsForStep(session.current_step);
    }
  } catch (aiErr) {
    logger.error(`AI path failed: ${aiErr.message}. Falling back to scripted flow.`);
    const table = FALLBACK_QUESTIONS[session.language_mode] || FALLBACK_QUESTIONS.ENGLISH;
    const current = session.current_step || 0;

    captureFallbackAnswer(session, message);

    if (isFirstTurn) {
      reply = `${table[0]}\n\n${table[1]}`;
      session.current_step = 1;
      options = optionsForStep(1, session.language_mode);
      optionSections = sectionsForStep(1);
    } else if (current < LAST_AI_STEP) {
      const nextStep = current + 1;
      reply = table[nextStep];
      session.current_step = nextStep;
      options = optionsForStep(nextStep, session.language_mode);
      optionSections = sectionsForStep(nextStep);
    } else {
      session.current_step = CALL_STEP;
      reply = CALL_QUESTIONS[session.language_mode] || CALL_QUESTIONS.ENGLISH;
      options = optionsForStep(CALL_STEP, session.language_mode);
    }
  }

  if (!reply) reply = FALLBACK_QUESTIONS[session.language_mode]?.[1] || 'Could you share a bit more?';

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

module.exports = { handleMessage, processMessage };
