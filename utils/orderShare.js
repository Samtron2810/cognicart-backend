/**
 * Order Share Composer
 *
 * Turns an order into a ready-to-send message plus a wa.me deep link.
 *
 * This is deliberately NOT the WhatsApp Cloud API. No Meta app, no access
 * token, no App Review, no per-conversation billing. The seller taps the link
 * and their own ordinary WhatsApp opens with the summary already typed, which
 * is how the overwhelming majority of Nigerian merchants actually message
 * their customers. The same composed text is returned separately so it can be
 * copied to the clipboard or pushed down any other channel (Telegram, SMS).
 */

const { normalizePhone } = require('./validators');

const NAIRA = '\u20a6';

/** Format kobo-free naira amounts with thousands separators. */
function money(amount) {
  const value = Number(amount) || 0;
  return `${NAIRA}${value.toLocaleString('en-NG')}`;
}

function formatDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-NG', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

/**
 * wa.me requires bare international digits: no plus sign, no spaces.
 * Returns '' when the number cannot be dialled internationally.
 */
function toWaDigits(phone) {
  const normalized = normalizePhone(phone || '');
  const digits = normalized.replace(/\D/g, '');
  return digits.length >= 10 ? digits : '';
}

/**
 * Build the customer-facing order summary.
 *
 * @param {object} order   Order JSON (as returned by orderService)
 * @param {object} business Seller business record (optional)
 * @param {string} variant 'confirmation' | 'dispatch' | 'payment_reminder'
 */
function buildOrderMessage(order, business = {}, variant = 'confirmation') {
  if (!order) return '';

  const storeName = business.name || 'our store';
  const firstName = (order.customerName || '').trim().split(/\s+/)[0] || 'there';
  const reference = order.reference || (order.orderNumber ? `#${order.orderNumber}` : order.id || '');

  const lines = [];

  if (variant === 'dispatch') {
    lines.push(`Hi ${firstName}, good news - your order ${reference} is on its way.`);
  } else if (variant === 'payment_reminder') {
    lines.push(`Hi ${firstName}, a quick reminder about your order ${reference}.`);
  } else {
    lines.push(`Hi ${firstName}, your order has been confirmed. Here is your summary:`);
  }

  lines.push('');
  if (reference) lines.push(`Order: ${reference}`);

  const items = Array.isArray(order.items) ? order.items : [];
  if (items.length) {
    lines.push('');
    lines.push('Items:');
    for (const item of items) {
      lines.push(`- ${item.name} x${item.quantity}: ${money(item.subtotal)}`);
    }
  }

  lines.push('');
  if (order.deliveryFee) {
    lines.push(`Subtotal: ${money(order.subtotal)}`);
    lines.push(`Delivery: ${money(order.deliveryFee)}`);
  }
  lines.push(`Total: ${money(order.total)}`);
  lines.push(`Payment: ${order.paymentStatus === 'Paid' ? 'Paid - thank you' : 'Not yet paid'}`);

  if (order.deliveryAddress) {
    lines.push(`Deliver to: ${order.deliveryAddress}`);
  }

  const expected = formatDate(order.expectedDeliveryDate);
  if (expected) lines.push(`Expected: ${expected}`);

  lines.push('');
  lines.push(`Thank you for ordering from ${storeName}.`);

  return lines.join('\n');
}

/**
 * Compose the share payload for an order.
 *
 * @returns {{message: string, whatsappUrl: string, phone: string, canSend: boolean}}
 */
function buildOrderShare(order, business = {}, variant = 'confirmation') {
  const message = buildOrderMessage(order, business, variant);
  const digits = toWaDigits(order && order.customerPhone);

  return {
    message,
    phone: digits ? `+${digits}` : '',
    // Empty phone still yields a usable link: WhatsApp prompts for a contact
    whatsappUrl: digits
      ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}`
      : `https://wa.me/?text=${encodeURIComponent(message)}`,
    canSend: Boolean(digits),
  };
}

module.exports = {
  money,
  toWaDigits,
  buildOrderMessage,
  buildOrderShare,
};
