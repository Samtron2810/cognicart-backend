/**
 * WhatsApp Message Mongoose Model
 * Stores full bidirectional chat transcripts, delivery states, and AI tool logs
 */

const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    sellerId: {
      type: String,
      required: [true, 'Seller ID is required for tenant isolation'],
      index: true,
    },
    businessPhone: {
      type: String,
      default: '',
    },
    customerPhone: {
      type: String,
      required: true,
      index: true,
    },
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
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
    status: {
      type: String,
      enum: ['sent', 'delivered', 'read', 'received'],
      default: 'received',
    },
    deterministic: {
      type: Boolean,
      default: false,
    },
    toolCalls: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
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

messageSchema.index({ sellerId: 1, customerPhone: 1, timestamp: -1 });

const Message = mongoose.model('Message', messageSchema);

module.exports = Message;
