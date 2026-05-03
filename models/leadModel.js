const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema(
  {
    name: { type: String, default: '' },
    phone_number: { type: String, required: true, index: true },
    course_interest: { type: String, default: 'BTech' },
    branch: { type: String, default: '' },
    colleges_interested: { type: [String], default: [] },
    city: { type: String, default: '' },
    pcm_percentage: { type: String, default: '' },
    budget: { type: String, default: '' },
    admission_timeline: { type: String, default: '' },
    exam_status: { type: String, default: '' },
    lead_score: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW', ''], default: '' },
    probability: { type: Number, default: 0 },
    summary: { type: String, default: '' },
    language_mode: { type: String, enum: ['ENGLISH', 'HINGLISH', 'HINDI'], default: 'ENGLISH' },

    // --- Maturity / interest ---
    wants_call: { type: Boolean, default: false, index: true },
    call_requested_at: { type: Date },
    interest_score: { type: Number, default: 0, index: true },
    interest_level: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW', ''], default: '' },
    interest_signals: { type: [String], default: [] },
    is_mature: { type: Boolean, default: false, index: true },

    // --- Price inquiry (high-priority signal: student asked about cost/fees) ---
    price_inquiry: { type: Boolean, default: false, index: true },
    price_inquiry_at: { type: Date },
    price_inquiry_count: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

module.exports = mongoose.model('Lead', leadSchema);
