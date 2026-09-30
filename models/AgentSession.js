/**
 * Durable conversational-commerce session state.
 *
 * The deterministic agent must survive process restarts and multi-instance
 * deployments. Sessions are tenant-scoped, carry only an opaque hashed key,
 * and expire automatically after a day of inactivity.
 */

const mongoose = require('mongoose');

const agentSessionSchema = new mongoose.Schema(
  {
    sellerId: {
      type: String,
      required: true,
    },
    sessionKey: {
      type: String,
      required: true,
    },
    state: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      select: false,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

agentSessionSchema.index({ sellerId: 1, sessionKey: 1 }, { unique: true });
agentSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const AgentSession = mongoose.model('AgentSession', agentSessionSchema);

module.exports = AgentSession;
