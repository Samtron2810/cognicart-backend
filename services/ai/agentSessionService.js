/**
 * Persistent state adapter for deterministic commerce conversations.
 */

const crypto = require('crypto');
const AgentSession = require('../../models/AgentSession');
const { comparablePhone } = require('./toolGuards');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function hashScope(scope) {
  return crypto.createHash('sha256').update(String(scope)).digest('hex');
}

/**
 * Resolve a stable, non-guessable storage key from server-established identity.
 * Anonymous callers without a verified/session identity deliberately remain
 * stateless so unrelated visitors can never share a checkout draft.
 */
function resolveSessionKey({
  conversationKey = '',
  channel = '',
  channelAccountId = '',
  channelUserId = '',
  shopperId = null,
  customerPhone = '',
} = {}) {
  let scope = String(conversationKey || '').trim();
  if (!scope && channel && channelUserId) {
    scope = `${channel}:${channelAccountId || 'account'}:${channelUserId}`;
  }
  if (!scope && shopperId) scope = `shopper:${shopperId}`;
  if (!scope) {
    const phone = comparablePhone(customerPhone);
    if (phone) scope = `phone:${phone}`;
  }
  return scope ? hashScope(scope) : '';
}

const agentSessionService = {
  SESSION_TTL_MS,
  resolveSessionKey,

  async load(sellerId, sessionKey) {
    if (!sellerId || !sessionKey) return {};
    const session = await AgentSession.findOne({ sellerId, sessionKey }).select('+state');
    if (!session) return {};
    if (session.expiresAt.getTime() <= Date.now()) {
      await AgentSession.deleteOne({ _id: session._id });
      return {};
    }
    return session.state && typeof session.state === 'object' ? { ...session.state } : {};
  },

  async save(sellerId, sessionKey, state) {
    if (!sellerId || !sessionKey) return state;
    const cleanState = state && typeof state === 'object' ? state : {};
    cleanState.updatedAt = new Date().toISOString();
    await AgentSession.findOneAndUpdate(
      { sellerId, sessionKey },
      {
        $set: {
          state: cleanState,
          expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    return cleanState;
  },

  async clear(sellerId, sessionKey) {
    if (!sellerId || !sessionKey) return;
    await AgentSession.deleteOne({ sellerId, sessionKey });
  },
};

module.exports = agentSessionService;
