// Quick diagnostic: print the latest leads + sessions so you can verify
// what phone_number values are actually stored in MongoDB.
// Run from project root with:  node scripts/check-leads.js

require('dotenv').config();
const mongoose = require('mongoose');
const Lead = require('../models/leadModel');
const Session = require('../models/sessionModel');

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });

  const leadCount = await Lead.countDocuments();
  const sessionCount = await Session.countDocuments();
  console.log(`\nTotals → leads: ${leadCount} | sessions: ${sessionCount}\n`);

  const leads = await Lead.find({}).sort({ created_at: -1 }).limit(5).lean();
  if (leads.length === 0) {
    console.log('(no leads yet — finalize a conversation through Q1-Q7 first)');
  } else {
    console.log('Last 5 leads (newest first):');
    leads.forEach((l, i) => {
      console.log(`\n[${i + 1}]`);
      console.log(`  phone_number  : ${JSON.stringify(l.phone_number)}`);
      console.log(`  name          : ${JSON.stringify(l.name)}`);
      console.log(`  branch        : ${JSON.stringify(l.branch)}`);
      console.log(`  colleges      : ${JSON.stringify(l.colleges_interested)}`);
      console.log(`  city          : ${JSON.stringify(l.city)}`);
      console.log(`  wants_call    : ${l.wants_call}`);
      console.log(`  is_mature     : ${l.is_mature}`);
      console.log(`  price_inquiry : ${l.price_inquiry}`);
      console.log(`  language      : ${l.language_mode}`);
      console.log(`  created_at    : ${l.created_at?.toISOString()}`);
    });
  }

  console.log('\nLast 3 sessions (any state):');
  const sessions = await Session.find({}).sort({ updatedAt: -1 }).limit(3).lean();
  sessions.forEach((s, i) => {
    console.log(`\n[${i + 1}]`);
    console.log(`  phone_number       : ${JSON.stringify(s.phone_number)}`);
    console.log(`  current_step       : ${s.current_step}`);
    console.log(`  language_mode      : ${s.language_mode}`);
    console.log(`  completed          : ${s.completed}`);
    console.log(`  bot_paused_until   : ${s.bot_paused_until || '—'}`);
  });

  await mongoose.disconnect();
  console.log('\nDone.\n');
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
