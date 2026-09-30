/**
 * AI Tool Access Guards
 *
 * Tools used to receive only the tenant (`sellerId`), which meant any
 * per-customer tool was scoped to "anything in this store" rather than
 * "anything belonging to the person in this conversation". Tools now also
 * receive a context describing the counterparty, and these helpers enforce it.
 */

const { normalizePhone } = require('../../utils/validators');

/**
 * Normalize a context/order phone for comparison.
 * Returns '' for placeholders such as 'anon_customer' so they can never match.
 */
function comparablePhone(value) {
  const raw = (value || '').toString().trim();
  if (!raw) return '';

  // Reject channel identifiers such as `telegram_user_123456789` and bare
  // numeric Telegram ids. A phone must carry an international prefix or a
  // Nigerian local/network prefix before normalization.
  if (!/^\+?[\d\s()\-]+$/.test(raw)) return '';
  const compact = raw.replace(/[\s()\-]/g, '');
  if (!compact.startsWith('+') && !compact.startsWith('0') && !compact.startsWith('234')) {
    return '';
  }
  const normalized = normalizePhone(raw) || raw;
  if (!/^\+\d{10,15}$/.test(normalized)) return '';
  return normalized;
}

/**
 * Build the execution context handed to every tool.
 *
 * @param {Object}  input
 * @param {string}  input.sellerId       tenant the conversation belongs to
 * @param {string}  input.customerPhone  counterparty in the conversation
 * @param {string}  [input.shopperId]    verified buyer identity, when known
 * @param {boolean} [input.trusted]      true only for a seller authenticated
 *                                       against their OWN tenant (dashboard /
 *                                       agent test console), where tenant-wide
 *                                       reads are legitimate
 */
function buildToolContext({
  sellerId,
  customerPhone,
  customerName = '',
  customerEmail = '',
  shopperId = null,
  channel = '',
  channelAccountId = '',
  channelUserId = '',
  channelUsername = '',
  trusted = false,
}) {
  return {
    sellerId,
    customerPhone: customerPhone || '',
    customerName,
    customerEmail,
    shopperId,
    channel,
    channelAccountId: String(channelAccountId || ''),
    channelUserId: String(channelUserId || ''),
    channelUsername,
    trusted: !!trusted,
  };
}

/**
 * True when the order belongs to the counterparty of this conversation.
 */
function ownsOrder(order, context = {}) {
  if (!order) return false;
  if (context.trusted) return true;

  // Channel identity is decisive for bot conversations. Never let a shared or
  // later-edited phone number override a Telegram user-id mismatch.
  if (context.channel && context.channelUserId) {
    return (
      order.channel === context.channel &&
      String(order.channelUserId || '') === String(context.channelUserId)
    );
  }

  // A verified shopperId is decisive. Never fall back to phone after an ID
  // mismatch: email-verified shoppers prove an exact contact pair, not global
  // ownership of every row that happens to carry the same phone number.
  if (context.shopperId) {
    return Boolean(order.shopperId) && String(order.shopperId) === String(context.shopperId);
  }

  const contextPhone = comparablePhone(context.customerPhone);
  const orderPhone = comparablePhone(order.customerPhone);

  return Boolean(contextPhone) && contextPhone === orderPhone;
}

/**
 * Enforce ownership. Deliberately reports "not found" rather than "forbidden"
 * so the agent cannot be used to probe which order IDs exist in a store.
 */
function requireOrderAccess(order, context, orderId) {
  if (!ownsOrder(order, context)) {
    const err = new Error(`Order not found: ${orderId}`);
    err.statusCode = 404;
    throw err;
  }
  return order;
}

module.exports = {
  buildToolContext,
  comparablePhone,
  ownsOrder,
  requireOrderAccess,
};
