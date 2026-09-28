/**
 * Channel Message Model
 * Stores bidirectional Telegram transcripts, delivery state, and AI logs.
 */

const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    sellerId: {
      type: String,
      required: [true, 'Seller ID is required for tenant isolation'],
      index: true,
    },
    channel: {
      type: String,
      enum: ['telegram'],
      default: 'telegram',
      required: true,
      index: true,
    },
    channelAccountId: { type: String, default: '', trim: true },
    channelUserId: { type: String, required: true, trim: true, index: true },
    channelUsername: { type: String, default: '', trim: true },
    customerName: { type: String, default: '', trim: true },

    // Telegram message id used to absorb webhook retries safely.
    providerMessageId: { type: String, trim: true },
    providerUpdateId: { type: String, trim: true },

    // Phone is progressively attached after Telegram contact sharing.
    customerPhone: { type: String, default: '', index: true },

    direction: {
      type: String,
      enum: ['inbound', 'outbound'],
      required: true,
      index: true,
    },
    body: {
      type: String,
      required: true,
      maxlength: [4000, 'Message body cannot exceed 4000 characters'],
    },
    timestamp: { type: Date, default: Date.now, index: true },
    status: {
      type: String,
      enum: ['sent', 'delivered', 'read', 'received', 'failed'],
      default: 'received',
    },
    deterministic: { type: Boolean, default: false },
    toolCalls: { type: mongoose.Schema.Types.Mixed, default: null },
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

messageSchema.index({ sellerId: 1, channel: 1, channelUserId: 1, timestamp: -1 });
messageSchema.index(
  { channel: 1, channelAccountId: 1, channelUserId: 1, providerMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerMessageId: { $type: 'string' } },
  }
);

const Message = mongoose.model('Message', messageSchema);

module.exports = Message;
