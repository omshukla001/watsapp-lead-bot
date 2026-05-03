const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    // 'user' = lead's WhatsApp message
    // 'assistant' = bot's reply
    // 'human' = counsellor typed manually in WhatsApp (handoff)
    // 'system' = internal notes
    role: { type: String, enum: ['user', 'assistant', 'system', 'human'], required: true },
    content: { type: String, required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const sessionSchema = new mongoose.Schema(
  {
    phone_number: { type: String, required: true, unique: true, index: true },
    language_mode: { type: String, enum: ['ENGLISH', 'HINGLISH', 'HINDI'], default: 'ENGLISH' },
    // 0 greet, 1 college, 2 branch, 3 city, 4 PCM%, 5 exam, 6 timeline, 7 name, 8 call, 9 done
    current_step: { type: Number, default: 0 },
    partial_lead: {
      name: { type: String, default: '' },
      course_interest: { type: String, default: 'BTech' },
      branch: { type: String, default: '' },
      colleges_interested: { type: [String], default: [] },
      city: { type: String, default: '' },
      pcm_percentage: { type: String, default: '' },
      budget: { type: String, default: '' },
      admission_timeline: { type: String, default: '' },
      exam_status: { type: String, default: '' },
    },
    history: { type: [messageSchema], default: [] },
    completed: { type: Boolean, default: false },

    last_options: { type: [String], default: [] },
    wants_call: { type: Boolean, default: false },

    // Price-inquiry tracking (set by mentionsPrice detection)
    price_inquiry: { type: Boolean, default: false },
    price_inquiry_at: { type: Date },
    price_inquiry_count: { type: Number, default: 0 },

    // Follow-up tracking
    last_user_message_at: { type: Date, default: Date.now, index: true },
    last_followup_at: { type: Date },
    followup_count: { type: Number, default: 0 },

    // Human handoff — when set in the future, processMessage skips this session
    // so the bot doesn't talk over the counsellor. Set automatically when a
    // fromMe message that the bot didn't send arrives via Baileys.
    bot_paused_until: { type: Date },
    last_human_message_at: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Session', sessionSchema);
