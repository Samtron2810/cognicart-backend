/**
 * Per-Store Web Chat Transcript
 *
 * The widget on /store/:identifier must reopen showing the conversation the
 * buyer was already having with THAT store, and must start clean at a
 * different store.
 *
 * The compound unique key {sellerId, ownerKey} is what delivers both halves:
 * same buyer + same store finds a row, same buyer + different store does not.
 * Store isolation is therefore a property of the primary key rather than
 * something each query has to remember to filter on.
 *
 * `ownerKey` is a verified shopper id or a signed visitor id — always
 * server-established, never a value the client chose.
 */

const mongoose = require('mongoose');

const TRANSCRIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 60;

const chatMessageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true, maxlength: 4000 },
    // Quick-reply buttons offered alongside an assistant turn, so a restored
    // transcript still shows the menu the buyer was looking at.
    quickReplies: {
      type: [{ label: String, value: String, _id: false }],
      default: [],
    },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const webChatSessionSchema = new mongoose.Schema(
  {
    sellerId: { type: String, required: true },
    ownerKey: { type: String, required: true },
    messages: { type: [chatMessageSchema], default: [] },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Same buyer at the same store resumes; at another store this misses and a
// fresh transcript is created. The isolation requirement, enforced by index.
webChatSessionSchema.index({ sellerId: 1, ownerKey: 1 }, { unique: true });
webChatSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const WebChatSession = mongoose.model('WebChatSession', webChatSessionSchema);

module.exports = WebChatSession;
module.exports.TRANSCRIPT_TTL_MS = TRANSCRIPT_TTL_MS;
module.exports.MAX_MESSAGES = MAX_MESSAGES;
