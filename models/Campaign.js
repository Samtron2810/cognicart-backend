/**
 * Marketing Campaign Mongoose Model
 * Manages broadcast campaigns, audience segmentation, and recipient delivery metrics
 */

const mongoose = require('mongoose');

const recipientSchema = new mongoose.Schema(
  {
    customerId: { type: String },
    phone: { type: String, required: true },
    name: { type: String, default: '' },
    status: {
      type: String,
      enum: ['pending', 'sent', 'failed'],
      default: 'pending',
    },
    sentAt: { type: Date, default: null },
    error: { type: String, default: '' },
  },
  { _id: false }
);

const campaignSchema = new mongoose.Schema(
  {
    sellerId: {
      type: String,
      required: [true, 'Seller ID is required for tenant isolation'],
      index: true,
    },
    title: {
      type: String,
      required: [true, 'Campaign title is required'],
      trim: true,
      maxlength: [150, 'Title cannot exceed 150 characters'],
    },
    message: {
      type: String,
      required: [true, 'Campaign message content is required'],
      trim: true,
      maxlength: [2000, 'Message cannot exceed 2000 characters'],
    },
    segment: {
      type: String,
      enum: ['ALL', 'VIP', 'INACTIVE', 'NEW', 'CUSTOM'],
      default: 'ALL',
      index: true,
    },
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'sending', 'completed', 'failed'],
      default: 'draft',
      index: true,
    },
    scheduledAt: {
      type: Date,
      default: null,
    },
    sentAt: {
      type: Date,
      default: null,
    },
    stats: {
      totalRecipients: { type: Number, default: 0 },
      sentCount: { type: Number, default: 0 },
      failedCount: { type: Number, default: 0 },
    },
    recipients: {
      type: [recipientSchema],
      default: [],
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
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

campaignSchema.index({ sellerId: 1, createdAt: -1 });

const Campaign = mongoose.model('Campaign', campaignSchema);

module.exports = Campaign;
