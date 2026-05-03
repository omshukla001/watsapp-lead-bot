const axios = require('axios');
const logger = require('../utils/logger');

const CEREBRAS_URL = process.env.CEREBRAS_API_URL || 'https://api.cerebras.ai/v1/chat/completions';
const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL || 'llama-3.3-70b';
const MAX_RETRIES = 2;

/**
 * System prompt controlling the bot's behavior.
 * Keep this in one place so we can iterate without touching the controller.
 */
const SYSTEM_PROMPT = `You are a high-conversion AI Admission Bot for direct BTech
admission in Bangalore (RVCE, BMSCE, PES) and SRM Chennai. Sales-first tone:
short, energetic, value-led. Walk each user through 3 quick questions, then
close with a free-call CTA.

LANGUAGE: Respect language_mode metadata (ENGLISH / HINGLISH / HINDI). Never
mix mid-conversation. No slang ("bhai", "bro").

3-QUESTION FUNNEL (ask ONE at a time):
  Q1 (current_step=1): Which college? — RVCE / BMSCE / PES / SRM / Other
  Q2 (current_step=2): 12th PCM %?    — 90%+ / 80–89% / 70–79% / Below 70%
  Q3 (current_step=3): Any entrance exam? — KCET/COMEDK / JEE / No

After Q3, the SYSTEM sends the canned result + call CTA — you do NOT generate
that closing message yourself. Just set complete=true with no reply text.

EXTRACTION FIELDS (only these — leave others empty):
- colleges_interested: array of college names
- pcm_percentage: text like "90%+" or "80–89%"
- exam_status: text like "KCET/COMEDK" or "JEE" or "No"
Do NOT extract or ask about: branch, city, name, timeline, budget. Those
fields stay empty. The course is ALWAYS "BTech".

STEP MACHINE (STRICT):
- current_step = 1 → user just answered college. Extract → next_step=2 → ack
  briefly + ask Q2.
- current_step = 2 → user just answered PCM. Extract → next_step=3 → ack
  briefly + ask Q3.
- current_step = 3 → user just answered exam. Extract → next_step=4 →
  complete=true → reply="" (system sends the closing).
- Never go backwards. Never loop. If unclear, still advance.

ACKNOWLEDGMENT TONE (per step):
  After Q1 (any college): "Great choice 👍 Direct admission seats are
                          limited. Let me check your chances 👇\n\n[Q2]"
  After Q2 (high PCM): "Solid score 💪\n\n[Q3]"
  After Q2 (low PCM):  "Got it. Direct admission is still possible.\n\n[Q3]"
  After Q3: complete — leave reply empty, system handles closing.

PRICING RULE (CRITICAL):
- NEVER quote any fee, amount, lakh, rupees, or budget number — ever.
- If user asks "kitna lagega" / "fees kya hai" / "कीमत" / "how much":
  briefly say our admission counsellor will call with exact figures (since
  fees depend on category + seat type), then CONTINUE the funnel with the
  next question. The system auto-flags price questions for callback — you
  don't need to repeat that flag.

LEAD SCORING (set when complete=true):
- HIGH (0.75-1.0): RVCE/BMSCE/PES/SRM + 80%+ PCM + entrance exam given
- MEDIUM (0.4-0.74): partial clarity
- LOW (0.0-0.39): exploring only

NEVER:
- Ask Q4, Q5, Q6, Q7 (city, branch, timeline, name) — flow is 3 questions.
- Mention "management quota" — always say "direct admission".
- Quote any fee.
- Sound panicky or scaremongering.
- Use countdown timers or fake scarcity.

OUTPUT — return ONLY a JSON object on every turn:
{
  "reply": "<message in user's language>",
  "next_step": <integer 1-4>,
  "extracted": {
    "course_interest": "BTech",
    "colleges_interested": [],
    "pcm_percentage": "",
    "exam_status": ""
  },
  "complete": <true|false>,
  "lead": {
    "phone_number": "",
    "course_interest": "BTech",
    "colleges_interested": [],
    "pcm_percentage": "",
    "exam_status": "",
    "lead_score": "HIGH | MEDIUM | LOW",
    "probability": 0.0,
    "summary": ""
  }
}

When complete=false, "lead" may be an empty object {}.
When complete=true, "lead" MUST be fully populated. The system overrides
"reply" with the canned closing — but include something brief just in case.`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GROQ_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

/**
 * Call Cerebras (OpenAI-compatible chat completions).
 */
async function callCerebras(messages) {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) throw new Error('CEREBRAS_API_KEY is not set');

  const body = {
    model: CEREBRAS_MODEL,
    messages,
    temperature: 0.3,
    max_tokens: 600,
    response_format: { type: 'json_object' },
  };

  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const res = await axios.post(CEREBRAS_URL, body, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 20000,
      });
      const content = res.data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty response from Cerebras');
      return content;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      logger.warn(
        `Cerebras call failed (attempt ${attempt}/${MAX_RETRIES + 1}) ${status ? `status=${status}` : ''}: ${err.message}`
      );
      if (attempt <= MAX_RETRIES) {
        await sleep(400 * attempt);
      }
    }
  }
  throw lastErr;
}

/**
 * Call Google Gemini (different request/response shape from OpenAI).
 * Translates OpenAI-style messages → Gemini's systemInstruction + contents.
 */
async function callGemini(messages) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');

  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents,
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
    },
  };

  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const res = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 20000,
      });
      const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Empty response from Gemini');
      return text;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      logger.warn(
        `Gemini call failed (attempt ${attempt}/${MAX_RETRIES + 1}) ${status ? `status=${status}` : ''}: ${err.message}`
      );
      if (attempt <= MAX_RETRIES) {
        await sleep(400 * attempt);
      }
    }
  }
  throw lastErr;
}

/**
 * Call Groq (OpenAI-compatible chat completions).
 */
async function callGroq(messages) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set');

  const body = {
    model: GROQ_MODEL,
    messages,
    temperature: 0.3,
    max_tokens: 1024,
    response_format: { type: 'json_object' },
  };

  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const res = await axios.post(GROQ_URL, body, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 20000,
      });
      const content = res.data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty response from Groq');
      return content;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      logger.warn(
        `Groq call failed (attempt ${attempt}/${MAX_RETRIES + 1}) ${status ? `status=${status}` : ''}: ${err.message}`
      );
      if (attempt <= MAX_RETRIES) {
        await sleep(400 * attempt);
      }
    }
  }
  throw lastErr;
}

/**
 * Provider priority chain: Groq → Gemini → Cerebras.
 * Tries each provider whose API key is set. First success wins. Last failure
 * throws (then chatController falls back to scripted flow).
 */
async function callAI(messages) {
  const providers = [
    process.env.GROQ_API_KEY ? { name: 'Groq', fn: callGroq } : null,
    process.env.GEMINI_API_KEY ? { name: 'Gemini', fn: callGemini } : null,
    process.env.CEREBRAS_API_KEY ? { name: 'Cerebras', fn: callCerebras } : null,
  ].filter(Boolean);

  if (providers.length === 0) {
    throw new Error('No AI provider configured (set GROQ_API_KEY, GEMINI_API_KEY, or CEREBRAS_API_KEY)');
  }

  let lastErr;
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    try {
      return await p.fn(messages);
    } catch (err) {
      lastErr = err;
      const next = providers[i + 1];
      if (next) {
        logger.warn(`${p.name} exhausted retries — falling back to ${next.name}.`);
      }
    }
  }
  throw lastErr;
}

/**
 * Run one conversational turn.
 */
async function runTurn(session, userMessage) {
  const meta = {
    language_mode: session.language_mode,
    current_step: session.current_step,
    phone_number: session.phone_number,
    partial_lead: session.partial_lead,
  };

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: `Conversation metadata: ${JSON.stringify(meta)}` },
    ...(session.history || []).slice(-10).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  return callAI(messages);
}

module.exports = { runTurn, callAI, callCerebras, callGemini, callGroq, SYSTEM_PROMPT };
