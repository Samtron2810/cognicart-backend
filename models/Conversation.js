/**
 * Channel Conversation Model
 * Aggregates seller/customer threads independently of the transport adapter.
 */

const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema(
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
    // Seller-side Telegram bot id and customer-side Telegram user id.
    channelAccountId: { type: String, default: '', trim: true },
    channelUserId: { type: String, required: true, trim: true },
    channelUsername: { type: String, default: '', trim: true },
    customerName: { type: String, default: '', trim: true },

    // Phone is progressively attached after Telegram contact sharing.
    customerPhone: { type: String, default: '', index: true },

    lastMessage: { type: String, default: '' },
    lastMessageAt: { type: Date, default: Date.now, index: true },
    unreadCount: { type: Number, default: 0 },
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

conversationSchema.index(
  { sellerId: 1, channel: 1, channelUserId: 1 },
  { unique: true }
);
conversationSchema.index({ sellerId: 1, lastMessageAt: -1 });

const Conversation = mongoose.model('Conversation', conversationSchema);

module.exports = Conversation;
