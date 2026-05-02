const express = require('express');
const Lead = require('../models/leadModel');
const Session = require('../models/sessionModel');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Permissive CORS for admin endpoints — the mobile app calls this from a
 * different origin. Runs BEFORE auth so preflight (OPTIONS) succeeds.
 */
router.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/**
 * Auth gate. Set ADMIN_PASSWORD in .env to enable. Accepts EITHER:
 *   - Browser:    Authorization: Basic <base64(":password")>
 *   - Mobile app: x-api-key: <password>
 * If ADMIN_PASSWORD is unset, the dashboard is open (dev only).
 */
function adminAuth(req, res, next) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return next();

  // Mobile / API clients
  const apiKey = req.headers['x-api-key'];
  if (apiKey && apiKey === expected) return next();

  // Browser
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const [, pass] = decoded.split(':');
    if (pass === expected) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="admin"');
  return res.status(401).send('Authentication required');
}

router.use(adminAuth);

/**
 * Build a Mongoose filter from query params: ?score=HIGH&since=2026-04-01&q=rohan
 */
function buildFilter(query) {
  const filter = {};
  if (query.mature === 'true' || query.mature === '1') {
    filter.is_mature = true;
  }
  if (query.wants_call === 'true' || query.wants_call === '1') {
    filter.wants_call = true;
  }
  if (query.score) {
    const scores = String(query.score).toUpperCase().split(',').filter(Boolean);
    if (scores.length) filter.lead_score = { $in: scores };
  }
  if (query.since) {
    const d = new Date(query.since);
    if (!isNaN(d.getTime())) filter.created_at = { $gte: d };
  }
  if (query.until) {
    const d = new Date(query.until);
    if (!isNaN(d.getTime())) filter.created_at = { ...(filter.created_at || {}), $lte: d };
  }
  if (query.q) {
    const re = new RegExp(String(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { name: re },
      { phone_number: re },
      { course_interest: re },
      { colleges_interested: re },
      { summary: re },
    ];
  }
  return filter;
}

/**
 * Mobile-friendly dashboard showing ONLY mature leads (wants_call OR
 * interest_score >= 8). Tap a phone to dial; tap WhatsApp to open chat.
 */
router.get('/mature', async (req, res) => {
  try {
    const leads = await Lead.find({ is_mature: true })
      .sort({ created_at: -1 })
      .limit(200)
      .lean();

    const cards = leads.map((l) => {
      const digits = (l.phone_number || '').replace(/\D/g, '');
      const colleges = (l.colleges_interested || []).join(', ') || '—';
      const signals = (l.interest_signals || []).join(' · ');
      const wantsCallBadge = l.wants_call
        ? '<span class="pill pill-call">📞 Wants call</span>'
        : '';
      const score = l.interest_score || 0;
      return `
        <div class="card">
          <div class="head">
            <div>
              <div class="name">${escapeHtml(l.name || 'Unknown')}</div>
              <div class="phone">${escapeHtml(l.phone_number || '')}</div>
            </div>
            <div class="score">${score}</div>
          </div>
          <div class="body">
            <div class="row"><span class="lbl">Branch</span><span>${escapeHtml(l.branch || '—')}</span></div>
            <div class="row"><span class="lbl">Colleges</span><span>${escapeHtml(colleges)}</span></div>
            <div class="row"><span class="lbl">City</span><span>${escapeHtml(l.city || '—')}</span></div>
            <div class="row"><span class="lbl">12th PCM</span><span>${escapeHtml(l.pcm_percentage || '—')}</span></div>
            <div class="row"><span class="lbl">Exam</span><span>${escapeHtml(l.exam_status || '—')}</span></div>
            <div class="row"><span class="lbl">Timeline</span><span>${escapeHtml(l.admission_timeline || '—')}</span></div>
            ${signals ? `<div class="signals">${escapeHtml(signals)}</div>` : ''}
            ${wantsCallBadge}
          </div>
          <div class="actions">
            <a class="btn btn-call" href="tel:${digits}">📞 Call</a>
            <a class="btn btn-wa" href="https://wa.me/${digits}" target="_blank">💬 WhatsApp</a>
          </div>
          <div class="ts">${new Date(l.created_at).toLocaleString()}</div>
        </div>`;
    }).join('');

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Mature Leads</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; padding-bottom: 40px; }
    header { position: sticky; top: 0; background: #1e293b; padding: 16px; border-bottom: 1px solid #334155; z-index: 10; }
    header h1 { margin: 0; font-size: 18px; }
    header .sub { font-size: 12px; color: #94a3b8; margin-top: 4px; }
    .stat { background: #047857; color: white; padding: 12px 16px; margin: 12px; border-radius: 10px; font-weight: 600; }
    .empty { padding: 60px 20px; text-align: center; color: #64748b; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; margin: 12px; padding: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
    .head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; }
    .name { font-size: 17px; font-weight: 600; color: white; }
    .phone { font-size: 13px; color: #94a3b8; margin-top: 2px; }
    .score { background: #f59e0b; color: #1e293b; font-weight: 700; font-size: 18px; padding: 8px 14px; border-radius: 999px; min-width: 44px; text-align: center; }
    .body { font-size: 14px; }
    .row { display: flex; padding: 4px 0; border-bottom: 1px dashed #334155; }
    .row:last-of-type { border: none; }
    .lbl { color: #94a3b8; min-width: 80px; font-size: 12px; text-transform: uppercase; }
    .signals { font-size: 11px; color: #94a3b8; margin-top: 8px; font-style: italic; }
    .pill { display: inline-block; font-size: 11px; padding: 4px 10px; border-radius: 999px; margin-top: 8px; font-weight: 600; }
    .pill-call { background: #dc2626; color: white; }
    .actions { display: flex; gap: 8px; margin-top: 12px; }
    .btn { flex: 1; text-align: center; padding: 12px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; }
    .btn-call { background: #16a34a; color: white; }
    .btn-wa { background: #25d366; color: white; }
    .ts { font-size: 11px; color: #64748b; margin-top: 8px; text-align: right; }
  </style>
</head>
<body>
  <header>
    <h1>🔥 Mature Leads</h1>
    <div class="sub">Students who asked for a call or showed strong interest</div>
  </header>
  <div class="stat">${leads.length} mature lead${leads.length === 1 ? '' : 's'}</div>
  ${leads.length === 0 ? '<div class="empty">No mature leads yet.<br><br>Mature = student asked for a call OR interest score ≥ 8.</div>' : cards}
</body>
</html>`);
  } catch (err) {
    logger.error(`/mature error: ${err.stack || err.message}`);
    res.status(500).send('Failed to load mature leads');
  }
});

/**
 * JSON API — for any downstream CRM / sheet integration.
 * Example: /admin/leads.json?score=HIGH,MEDIUM&since=2026-04-01
 */
router.get('/leads.json', async (req, res) => {
  try {
    const filter = buildFilter(req.query);
    const limit = Math.min(parseInt(req.query.limit || '500', 10), 5000);
    const leads = await Lead.find(filter).sort({ created_at: -1 }).limit(limit).lean();
    const summary = await Lead.aggregate([
      { $match: filter },
      { $group: { _id: '$lead_score', count: { $sum: 1 } } },
    ]);
    res.json({ count: leads.length, by_score: summary, leads });
  } catch (err) {
    logger.error(`leads.json error: ${err.message}`);
    res.status(500).json({ error: 'failed to load leads' });
  }
});

/**
 * CSV export for the sales team.
 */
router.get('/leads.csv', async (req, res) => {
  try {
    const filter = buildFilter(req.query);
    const leads = await Lead.find(filter).sort({ created_at: -1 }).lean();

    const headers = [
      'created_at', 'name', 'phone_number', 'course_interest',
      'colleges_interested', 'admission_timeline', 'exam_status',
      'lead_score', 'probability', 'language_mode', 'summary',
    ];
    const escape = (v) => {
      if (v === null || v === undefined) return '';
      const s = Array.isArray(v) ? v.join('; ') : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = leads.map((l) => headers.map((h) => escape(l[h])).join(','));
    const csv = [headers.join(','), ...rows].join('\n');

    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="leads-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    logger.error(`leads.csv error: ${err.message}`);
    res.status(500).send('failed to export');
  }
});

/**
 * HTML dashboard.
 */
router.get('/', async (req, res) => {
  try {
    const filter = buildFilter(req.query);
    const leads = await Lead.find(filter).sort({ created_at: -1 }).limit(500).lean();
    const totals = await Lead.aggregate([
      { $group: { _id: '$lead_score', count: { $sum: 1 } } },
    ]);
    const totalSessions = await Session.countDocuments();
    const completedSessions = await Session.countDocuments({ completed: true });

    const counts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    totals.forEach((t) => { if (t._id) counts[t._id] = t.count; });
    const grandTotal = counts.HIGH + counts.MEDIUM + counts.LOW;

    const score = (req.query.score || '').toUpperCase();
    const q = req.query.q || '';
    const since = req.query.since || '';

    const rows = leads.map((l) => `
      <tr class="row-${l.lead_score}">
        <td>${new Date(l.created_at).toLocaleString()}</td>
        <td><strong>${escapeHtml(l.name || '—')}</strong></td>
        <td><a href="https://wa.me/${(l.phone_number || '').replace(/\\D/g, '')}" target="_blank">${escapeHtml(l.phone_number)}</a></td>
        <td>${escapeHtml(l.course_interest || '—')}</td>
        <td>${escapeHtml((l.colleges_interested || []).join(', ') || '—')}</td>
        <td>${escapeHtml(l.admission_timeline || '—')}</td>
        <td>${escapeHtml(l.exam_status || '—')}</td>
        <td><span class="badge badge-${l.lead_score}">${l.lead_score}</span> ${(l.probability || 0).toFixed(2)}</td>
        <td class="lang">${l.language_mode || '—'}</td>
        <td class="summary">${escapeHtml(l.summary || '')}</td>
      </tr>
    `).join('');

    const exportQs = new URLSearchParams(req.query).toString();

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Lead Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; margin: 0; background: #f4f5f7; color: #1f2329; }
    header { background: #0b5cff; color: white; padding: 18px 24px; }
    header h1 { margin: 0; font-size: 20px; }
    header .sub { opacity: 0.85; font-size: 13px; margin-top: 4px; }
    .stats { display: flex; gap: 12px; padding: 16px 24px; flex-wrap: wrap; }
    .stat { background: white; border-radius: 8px; padding: 12px 16px; min-width: 120px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
    .stat .num { font-size: 24px; font-weight: 600; }
    .stat .label { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat.high .num { color: #047857; }
    .stat.medium .num { color: #b45309; }
    .stat.low .num { color: #6b7280; }
    form.filters { background: white; padding: 14px 24px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; border-top: 1px solid #e5e7eb; border-bottom: 1px solid #e5e7eb; }
    form.filters input, form.filters select { padding: 7px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; }
    form.filters button { padding: 7px 14px; border: none; border-radius: 6px; background: #0b5cff; color: white; font-weight: 500; cursor: pointer; }
    form.filters a { color: #0b5cff; text-decoration: none; font-size: 14px; margin-left: auto; }
    table { width: 100%; border-collapse: collapse; background: white; }
    th, td { padding: 10px 12px; text-align: left; font-size: 13px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
    th { background: #f9fafb; font-weight: 600; color: #374151; position: sticky; top: 0; }
    tr.row-HIGH { background: #f0fdf4; }
    tr.row-MEDIUM { background: #fffbeb; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
    .badge-HIGH { background: #d1fae5; color: #047857; }
    .badge-MEDIUM { background: #fef3c7; color: #92400e; }
    .badge-LOW { background: #f3f4f6; color: #4b5563; }
    .lang { font-size: 11px; color: #6b7280; }
    .summary { max-width: 360px; color: #4b5563; }
    .empty { padding: 60px; text-align: center; color: #6b7280; }
  </style>
</head>
<body>
  <header>
    <h1>Admission Leads</h1>
    <div class="sub">Showing leads collected by the WhatsApp bot. Click a phone number to open the chat in WhatsApp.</div>
  </header>

  <div class="stats">
    <div class="stat"><div class="num">${grandTotal}</div><div class="label">Total leads</div></div>
    <div class="stat high"><div class="num">${counts.HIGH}</div><div class="label">High intent</div></div>
    <div class="stat medium"><div class="num">${counts.MEDIUM}</div><div class="label">Medium</div></div>
    <div class="stat low"><div class="num">${counts.LOW}</div><div class="label">Low</div></div>
    <div class="stat"><div class="num">${completedSessions}/${totalSessions}</div><div class="label">Sessions completed</div></div>
  </div>

  <form class="filters" method="get">
    <select name="score">
      <option value="">All scores</option>
      <option value="HIGH" ${score === 'HIGH' ? 'selected' : ''}>HIGH only</option>
      <option value="HIGH,MEDIUM" ${score === 'HIGH,MEDIUM' ? 'selected' : ''}>HIGH + MEDIUM</option>
      <option value="MEDIUM" ${score === 'MEDIUM' ? 'selected' : ''}>MEDIUM only</option>
      <option value="LOW" ${score === 'LOW' ? 'selected' : ''}>LOW only</option>
    </select>
    <input type="text" name="q" placeholder="Search name, college, course…" value="${escapeHtml(q)}">
    <input type="date" name="since" value="${escapeHtml(since)}">
    <button type="submit">Filter</button>
    <a href="/admin/leads.csv?${exportQs}">⬇ Export CSV</a>
  </form>

  ${leads.length === 0 ? '<div class="empty">No leads match the current filters.</div>' : `
  <table>
    <thead>
      <tr>
        <th>Created</th><th>Name</th><th>Phone</th><th>Course</th><th>Colleges</th>
        <th>Timeline</th><th>Exam</th><th>Score</th><th>Lang</th><th>Summary</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`}
</body>
</html>`);
  } catch (err) {
    logger.error(`admin dashboard error: ${err.stack || err.message}`);
    res.status(500).send('Failed to load dashboard');
  }
});

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = router;
