// Find and (optionally) delete leads/sessions whose phone_number is not a
// valid WhatsApp E.164 number. These typically come from dashboard seed
// scripts or test webhooks that ran against production by accident.
//
// Default mode is DRY-RUN (lists matches, deletes nothing).
// Pass --apply as the first arg to actually delete.
//
//   node scripts/cleanup-fake-leads.js          # dry-run, just print
//   node scripts/cleanup-fake-leads.js --apply  # actually delete

require('dotenv').config();
const mongoose = require('mongoose');
const Lead = require('../models/leadModel');
const Session = require('../models/sessionModel');

const APPLY = process.argv.includes('--apply');

function isValidWhatsAppPhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  return /^\+[1-9]\d{9,12}$/.test(phone);
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  console.log(`\nMode: ${APPLY ? '🔴 APPLY (will delete)' : '🟡 DRY-RUN (no changes)'}\n`);

  const allLeads = await Lead.find({}, 'phone_number name created_at').lean();
  const fakeLeads = allLeads.filter((l) => !isValidWhatsAppPhone(l.phone_number));

  console.log(`Total leads: ${allLeads.length}`);
  console.log(`Valid (real WhatsApp): ${allLeads.length - fakeLeads.length}`);
  console.log(`Fake / invalid phone: ${fakeLeads.length}\n`);

  if (fakeLeads.length === 0) {
    console.log('Nothing to clean up. ✅\n');
    await mongoose.disconnect();
    return;
  }

  console.log('Fake leads found:');
  fakeLeads.forEach((l, i) => {
    console.log(
      `  [${i + 1}] phone=${JSON.stringify(l.phone_number).padEnd(20)} ` +
      `name=${JSON.stringify(l.name || '').padEnd(22)} ` +
      `created=${l.created_at?.toISOString()}`
    );
  });

  const fakePhones = fakeLeads.map((l) => l.phone_number);

  // Also find matching sessions (so we don't leave orphans)
  const fakeSessions = await Session.find(
    { phone_number: { $in: fakePhones } },
    'phone_number current_step completed'
  ).lean();
  console.log(`\nMatching fake sessions: ${fakeSessions.length}`);

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to actually delete.\n');
    await mongoose.disconnect();
    return;
  }

  const leadResult = await Lead.deleteMany({ phone_number: { $in: fakePhones } });
  const sessResult = await Session.deleteMany({ phone_number: { $in: fakePhones } });
  console.log(`\n✅ Deleted ${leadResult.deletedCount} leads and ${sessResult.deletedCount} sessions.\n`);

  await mongoose.disconnect();
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
