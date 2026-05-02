const { exec } = require('child_process');
const logger = require('../utils/logger');

/**
 * Termux:API helpers — only run when the bot is on Termux AND the user has
 * installed both `termux-api` (pkg) and the Termux:API app (F-Droid / Play).
 * If termux-* binaries aren't on PATH the calls just no-op silently.
 */

const ENABLED = process.env.TERMUX_NOTIFY !== 'false';

function run(cmd) {
  if (!ENABLED) return;
  exec(cmd, { timeout: 5000 }, (err) => {
    if (err && err.code !== 127) {
      // 127 = command not found (not on Termux) — ignore quietly
      logger.debug(`termux cmd failed: ${err.message}`);
    }
  });
}

function shellEscape(s) {
  return `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;
}

/**
 * Show an Android notification when a qualified lead is captured.
 * @param {object} lead
 */
function notifyNewLead(lead) {
  if (!lead) return;

  const isMature = !!lead.is_mature;
  const wantsCall = !!lead.wants_call;

  const tag = wantsCall ? '🔥 HOT — wants a call' : isMature ? '⭐ MATURE' : 'New';
  const title = `${tag}: ${lead.name || lead.phone_number || 'unknown'}`;
  const body =
    `${lead.course_interest || ''} | ${(lead.colleges_interested || []).join(', ') || '—'}\n` +
    `${lead.admission_timeline || ''} | interest ${lead.interest_score || 0}`;

  run(
    `termux-notification --title ${shellEscape(title)} --content ${shellEscape(body)} --priority ${isMature ? 'max' : 'high'} --vibrate ${isMature ? '500,200,500,200,500' : '300'} --id lead-${Date.now()}`
  );

  // Vibration pattern: long for wants-call, medium for mature, short otherwise
  if (wantsCall) {
    run('termux-vibrate -d 1500');
  } else if (isMature) {
    run('termux-vibrate -d 800');
  } else {
    run('termux-vibrate -d 250');
  }
}

function notifyStartup() {
  run(
    `termux-notification --title 'WhatsApp Lead Bot' --content 'Bot is online and listening' --id lead-bot-status`
  );
}

module.exports = { notifyNewLead, notifyStartup };
