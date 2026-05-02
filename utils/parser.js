// Helpers for pulling structured JSON out of LLM responses and validating it.

const REQUIRED_FIELDS = [
  'name',
  'phone_number',
  'course_interest',
  'colleges_interested',
  'budget',
  'admission_timeline',
  'exam_status',
  'lead_score',
  'probability',
  'summary',
];

/**
 * Extract the first JSON object from an arbitrary string.
 * Strips markdown fences and stray prose before/after the object.
 */
function extractJSON(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let text = raw.trim();
  // Strip ```json ... ``` or ``` ... ``` fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (_) {
    return null;
  }
}

/**
 * Validate that the parsed lead object has all required fields and sane types.
 * Returns { ok, errors, lead } — lead is normalized if ok.
 */
function validateLead(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') {
    return { ok: false, errors: ['not an object'], lead: null };
  }

  for (const f of REQUIRED_FIELDS) {
    if (!(f in obj)) errors.push(`missing field: ${f}`);
  }

  const lead = {
    name: String(obj.name || ''),
    phone_number: String(obj.phone_number || ''),
    course_interest: String(obj.course_interest || ''),
    colleges_interested: Array.isArray(obj.colleges_interested)
      ? obj.colleges_interested.map(String)
      : [],
    budget: String(obj.budget || ''),
    admission_timeline: String(obj.admission_timeline || ''),
    exam_status: String(obj.exam_status || ''),
    lead_score: ['HIGH', 'MEDIUM', 'LOW'].includes(obj.lead_score) ? obj.lead_score : '',
    probability: Number.isFinite(Number(obj.probability)) ? Number(obj.probability) : 0,
    summary: String(obj.summary || ''),
  };

  if (lead.probability < 0 || lead.probability > 1) {
    errors.push('probability out of range [0,1]');
  }

  return { ok: errors.length === 0, errors, lead };
}

/**
 * Deterministic scorer as a safety net when the AI hallucinates or skips scoring.
 * Mirrors the prompt's HIGH/MEDIUM/LOW bands.
 */
function scoreLead(lead) {
  // Budget intentionally excluded — we don't ask for it.
  let signals = 0;
  if (lead.course_interest) signals++;
  if (lead.colleges_interested && lead.colleges_interested.length > 0) signals++;
  if (lead.admission_timeline) {
    const t = lead.admission_timeline.toLowerCase();
    if (/(month|week|soon|immediate|2026|2025|this year|next month|june|july|august)/.test(t)) signals++;
  }
  if (lead.exam_status) signals++;
  if (lead.name) signals++;

  // Out of 5 signals
  if (signals >= 4) return { lead_score: 'HIGH', probability: 0.85 };
  if (signals >= 2) return { lead_score: 'MEDIUM', probability: 0.6 };
  return { lead_score: 'LOW', probability: 0.3 };
}

module.exports = { extractJSON, validateLead, scoreLead, REQUIRED_FIELDS };
