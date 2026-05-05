// Manual end-to-end test for the new scripted flow.
// Usage: node scripts/test-flow.js
//
// Walks a synthetic conversation through processMessage(), prints each turn,
// and verifies the final Lead has name + colleges + pcm + exam + wants_call.

require('dotenv').config();
// Force scripted path — disable AI providers for deterministic test.
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.CEREBRAS_API_KEY;

const mongoose = require('mongoose');
const Session = require('../models/sessionModel');
const Lead = require('../models/leadModel');
const { processMessage } = require('../controllers/chatController');

const TEST_PHONE = '+10000000001';

function pad(s, n) {
  s = String(s);
  return s + ' '.repeat(Math.max(0, n - s.length));
}

async function turn(label, userMsg) {
  console.log(`\n--- ${label} ---`);
  console.log(`USER: ${userMsg}`);
  const out = await processMessage(TEST_PHONE, userMsg);
  console.log(`BOT [step=${out.current_step}] [opts=${JSON.stringify(out.options)}]`);
  console.log(out.reply);
  return out;
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });

  // Clean any prior test data so the session starts fresh.
  await Session.deleteMany({ phone_number: TEST_PHONE });
  await Lead.deleteMany({ phone_number: TEST_PHONE });
  console.log(`Cleaned prior test data for ${TEST_PHONE}\n`);

  // 1. First contact → entry hook + Q1 (college)
  const t1 = await turn('Turn 1: first contact', 'Hi');
  if (t1.current_step !== 1) throw new Error(`expected step=1, got ${t1.current_step}`);
  if (!t1.reply.includes('Confused about BTech')) throw new Error('entry hook missing');
  if (!t1.reply.includes('Which college?')) throw new Error('Q1 missing');

  // 2. Pick college → ask BRANCH (step 2)
  const t2 = await turn('Turn 2: pick college via "1"', '1');
  if (t2.current_step !== 2) throw new Error(`expected step=2 (BRANCH), got ${t2.current_step}`);
  if (!t2.reply.includes('Great choice') || !t2.reply.includes('preferred branch')) {
    throw new Error('branch prompt missing');
  }
  if (!t2.options.includes('CSE')) throw new Error('branch options missing CSE');

  // 3. Pick branch via "1" → CSE → ask PCM (step 3)
  const t3 = await turn('Turn 3: pick branch via "1"', '1');
  if (t3.current_step !== 3) throw new Error(`expected step=3 (PCM), got ${t3.current_step}`);
  if (!t3.reply.includes('Limited seats') || !t3.reply.includes('PCM')) {
    throw new Error('PCM prompt with seats preface missing');
  }

  // 4. Pick PCM → ask EXAM (step 4)
  const t4 = await turn('Turn 4: pick PCM via "2"', '2');
  if (t4.current_step !== 4) throw new Error(`expected step=4 (EXAM), got ${t4.current_step}`);
  if (!t4.reply.includes('Any entrance exam')) throw new Error('exam prompt missing');

  // 5. Pick exam → ask TIMELINE (step 5)
  const t5 = await turn('Turn 5: pick exam via "1"', '1');
  if (t5.current_step !== 5) throw new Error(`expected step=5 (TIMELINE), got ${t5.current_step}`);
  if (!t5.reply.toLowerCase().includes('admission')) throw new Error('timeline prompt missing');
  if (!t5.options.includes('Within 1 month')) throw new Error('timeline options missing');

  // 6. Pick timeline → advance to NAME (step 6)
  const t6 = await turn('Turn 6: pick timeline via "2"', '2');
  if (t6.current_step !== 6) throw new Error(`expected step=6 (NAME), got ${t6.current_step}`);
  if (!t6.reply.includes('Great chances')) throw new Error('result line missing');
  if (!t6.reply.includes('What is your name?')) throw new Error('name prompt missing');
  if (t6.options.length !== 0) throw new Error(`NAME_STEP should have no options, got ${JSON.stringify(t6.options)}`);

  // 7. Provide name → advance to CALL (step 7)
  const t7 = await turn('Turn 7: give name', 'Om Shukla');
  if (t7.current_step !== 7) throw new Error(`expected step=7 (CALL), got ${t7.current_step}`);
  if (!t7.reply.includes('Free 10-min call')) throw new Error('CTA missing');
  if (!t7.reply.includes('Check your exact chances')) throw new Error('CTA tagline missing');
  if (t7.options.length !== 2) throw new Error(`expected 2 options, got ${JSON.stringify(t7.options)}`);

  // 8. Yes → finalize
  const t8 = await turn('Turn 8: yes to call', '1');
  if (!t8.complete) throw new Error('expected complete=true');
  if (!t8.lead) throw new Error('expected lead in result');

  // Verify Mongo state
  const lead = await Lead.findOne({ phone_number: TEST_PHONE });
  if (!lead) throw new Error('Lead not saved in Mongo');
  console.log('\n--- Final Lead in Mongo ---');
  console.log(JSON.stringify({
    name: lead.name,
    phone_number: lead.phone_number,
    colleges_interested: lead.colleges_interested,
    branch: lead.branch,
    pcm_percentage: lead.pcm_percentage,
    exam_status: lead.exam_status,
    admission_timeline: lead.admission_timeline,
    wants_call: lead.wants_call,
    is_mature: lead.is_mature,
    interest_level: lead.interest_level,
  }, null, 2));

  const checks = [
    ['name === "Om Shukla"', lead.name === 'Om Shukla'],
    ['phone matches', lead.phone_number === TEST_PHONE],
    ['colleges_interested has RVCE', lead.colleges_interested.includes('RVCE')],
    ['branch === "CSE"', lead.branch === 'CSE'],
    ['pcm_percentage === "80–89%"', lead.pcm_percentage === '80–89%'],
    ['exam_status === "KCET/COMEDK"', lead.exam_status === 'KCET/COMEDK'],
    ['admission_timeline === "1-3 months"', lead.admission_timeline === '1-3 months'],
    ['wants_call === true', lead.wants_call === true],
  ];

  console.log('\n--- Assertions ---');
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) failed++;
  }

  // Cleanup test artifacts
  await Session.deleteMany({ phone_number: TEST_PHONE });
  await Lead.deleteMany({ phone_number: TEST_PHONE });

  await mongoose.disconnect();
  if (failed > 0) {
    console.error(`\n${failed} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log('\nALL CHECKS PASSED ✅');
  process.exit(0);
})().catch((e) => {
  console.error('TEST ERROR:', e.stack || e.message);
  process.exit(2);
});
