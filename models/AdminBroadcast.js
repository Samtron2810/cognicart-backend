/**
 * Admin Broadcast Model
 *
 * Platform-owned bulk email to SELLERS. Deliberately separate from `Campaign`,
 * which is seller-owned, tenant-isolated (`sellerId` required) and Telegram
 * only - widening that model would weaken its isolation guarantee.
 *
 * Recipients are snapshotted onto the document when a send starts, so a signup
 * that happens mid-send cannot join a half-delivered audience, and a restart
 * can resume by re-reading rows still marked `pending`.
 */

const mongoose = require('mongoose');

const SEGMENTS = [
  'ALL_SELLERS',
  'VERIFIED',
  'UNVERIFIED',
  'ACTIVE',
  'SUSPENDED',
  'TELEGRAM_CONNECTED',
  'TELEGRAM_NOT_CONNECTED',
  'NO_PRODUCTS',
  'HAS_SALES',
  'NO_SALES',
  'NEW_SIGNUPS',
  'DORMANT',
  'ADMINS',
  'CUSTOM',
];

const recipientSchema = new mongoose.Schema(
  {
    userId: { type: String, default: '' },
    email: { type: String, required: true, trim: true, lowercase: true },
    businessName: { type: String, default: '' },
    // True when the address was typed in rather than resolved from an account.
    adHoc: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['pending', 'sent', 'failed', 'skipped'],
      default: 'pending',
    },
    sentAt: { type: Date, default: null },
    error: { type: String, default: '' },
  },
  { _id: false }
);

const adminBroadcastSchema = new mongoose.Schema(
  {
    subject: {
      type: String,
      required: [true, 'Subject is required'],
      trim: true,
      maxlength: [150, 'Subject cannot exceed 150 characters'],
    },
    body: {
      type: String,
      required: [true, 'Message body is required'],
      trim: true,
      maxlength: [5000, 'Message cannot exceed 5000 characters'],
    },
    preheader: { type: String, default: '', trim: true, maxlength: 150 },
    ctaLabel: { type: String, default: '', trim: true, maxlength: 60 },
    ctaUrl: { type: String, default: '', trim: true },

    segments: {
      type: [{ type: String, enum: SEGMENTS }],
      default: [],
    },
    // Window in days for NEW_SIGNUPS / DORMANT.
    segmentDays: { type: Number, default: 30, min: 1, max: 365 },
    /** Explicitly typed addresses (the chip input). */
    includeEmails: { type: [String], default: [] },
    /** Addresses removed from the resolved audience. */
    excludeEmails: { type: [String], default: [] },

    status: {
      type: String,
      enum: ['draft', 'sending', 'completed', 'failed'],
      default: 'draft',
      index: true,
    },
    recipients: { type: [recipientSchema], default: [] },
    stats: {
      total: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
    },

    // Audit trail: who mailed everyone.
    createdBy: { type: String, default: '' },
    createdByEmail: { type: String, default: '' },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id ? ret._id.toString() : ret.id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

adminBroadcastSchema.index({ createdAt: -1 });

const AdminBroadcast = mongoose.model('AdminBroadcast', adminBroadcastSchema);

module.exports = AdminBroadcast;
module.exports.SEGMENTS = SEGMENTS;
