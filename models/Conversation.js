/**
 * Conversation Mongoose Model
 * Aggregates message threads between sellers and customer WhatsApp numbers
 */

const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema(
  {
    sellerId: {
      type: String,
      required: [true, 'Seller ID is required for tenant isolation'],
      index: true,
    },
    customerPhone: {
      type: String,
      required: true,
      index: true,
    },
    businessPhone: {
      type: String,
      default: '',
    },
    lastMessage: {
      type: String,
      default: '',
    },
    lastMessageAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    unreadCount: {
      type: Number,
      default: 0,
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

conversationSchema.index({ sellerId: 1, customerPhone: 1 }, { unique: true });
conversationSchema.index({ sellerId: 1, lastMessageAt: -1 });

const Conversation = mongoose.model('Conversation', conversationSchema);

module.exports = Conversation;
