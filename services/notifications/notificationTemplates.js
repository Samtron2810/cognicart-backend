/**
 * Channel-neutral transactional notification templates.
 *
 * Each renderer returns both plain text (usable by Telegram/SMS) and escaped
 * HTML (for Brevo). Keeping content separate from transports prevents provider
 * markup or credentials from leaking into commerce services.
 */

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(value) {
  return `₦${(Number(value) || 0).toLocaleString('en-NG')}`;
}

function orderReference(order) {
  return order.reference || (order.orderNumber ? `#${String(order.orderNumber).padStart(5, '0')}` : `#${order.id}`);
}

function formatDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-NG');
}

function emailHtml({ preheader, heading, intro, rows = [], body = [], action, unsubscribeUrl = '' }) {
  const safeRows = rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:8px 12px;color:#64748b;font-size:14px">${escapeHtml(label)}</td>
          <td style="padding:8px 12px;color:#0f172a;font-size:14px;text-align:right"><strong>${escapeHtml(value)}</strong></td>
        </tr>`
    )
    .join('');
  const paragraphs = body
    .filter(Boolean)
    .map((line) => `<p style="margin:12px 0;color:#334155;line-height:1.6">${escapeHtml(line)}</p>`)
    .join('');
  const button = action && action.url
    ? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:12px 20px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600">${escapeHtml(action.label)}</a></p>`
    : '';

  // Marketing mail must carry a working one-click opt-out. Transactional
  // templates pass nothing here and render no footer.
  const footer = unsubscribeUrl
    ? `<p style="margin:18px 0 0;text-align:center;color:#94a3b8;font-size:12px;line-height:1.6">You are receiving this because you have a Chatstand seller account.<br /><a href="${escapeHtml(unsubscribeUrl)}" style="color:#64748b;text-decoration:underline">Unsubscribe from announcements</a></p>`
    : '';

  return `<!doctype html>
<html><body style="margin:0;background:#f8fafc;font-family:Arial,sans-serif">
  <span style="display:none;max-height:0;overflow:hidden">${escapeHtml(preheader || '')}</span>
  <div style="max-width:620px;margin:0 auto;padding:28px 16px">
    <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:28px">
      <h1 style="margin:0 0 12px;color:#0f172a;font-size:24px">${escapeHtml(heading)}</h1>
      <p style="margin:0 0 20px;color:#334155;line-height:1.6">${escapeHtml(intro || '')}</p>
      ${safeRows ? `<table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:8px">${safeRows}</table>` : ''}
      ${paragraphs}
      ${button}
    </div>
    ${footer}
  </div>
</body></html>`;
}

function orderConfirmation({ order, business, trackingUrl }) {
  const storeName = business.name || 'Our Store';
  const reference = orderReference(order);
  const itemLines = (order.items || []).map(
    (item) => `- ${item.name} x${item.quantity}: ${money(item.subtotal)}`
  );
  const text = [
    `Order confirmed - ${reference}`,
    `Hello ${order.customerName || 'Valued Customer'}, thank you for shopping with ${storeName}.`,
    '',
    ...itemLines,
    '',
    `Subtotal: ${money(order.subtotal)}`,
    `Delivery: ${money(order.deliveryFee)}`,
    `Total: ${money(order.total)}`,
    `Payment: ${order.paymentStatus}`,
    `Delivery address: ${order.deliveryAddress || 'Standard delivery'}`,
    ...(trackingUrl ? ['', `Track this order and see your history: ${trackingUrl}`] : []),
  ].join('\n');

  return {
    subject: `${reference} confirmed by ${storeName}`,
    text,
    html: emailHtml({
      preheader: `${reference} is confirmed`,
      heading: 'Order confirmed',
      intro: `Hello ${order.customerName || 'Valued Customer'}, thank you for shopping with ${storeName}.`,
      rows: [
        ['Order', reference],
        ['Items', (order.items || []).map((item) => `${item.name} ×${item.quantity}`).join(', ')],
        ['Subtotal', money(order.subtotal)],
        ['Delivery', money(order.deliveryFee)],
        ['Total', money(order.total)],
        ['Payment', order.paymentStatus],
        ['Deliver to', order.deliveryAddress || 'Standard delivery'],
      ],
      body: ['We are preparing your package and will keep you updated.'],
      action: trackingUrl ? { label: 'Track your order', url: trackingUrl } : null,
    }),
  };
}

function paymentReceipt({ payment, order, business }) {
  const storeName = business.name || 'Our Store';
  const reference = order ? orderReference(order) : `#${payment.orderId}`;
  const text = [
    `Payment received for ${reference}`,
    `We confirmed your payment of ${money(payment.amount)} to ${storeName}.`,
    `Transaction reference: ${payment.reference}`,
    `Date: ${formatDate(payment.verifiedAt || new Date())}`,
    '',
    'Your order is now being processed for dispatch.',
  ].join('\n');

  return {
    subject: `Payment received for ${reference}`,
    text,
    html: emailHtml({
      preheader: `Payment received for ${reference}`,
      heading: 'Payment received',
      intro: `Thank you. Your payment to ${storeName} has been confirmed.`,
      rows: [
        ['Order', reference],
        ['Amount', money(payment.amount)],
        ['Transaction', payment.reference],
        ['Date', formatDate(payment.verifiedAt || new Date())],
      ],
      body: ['Your order is now being processed for dispatch.'],
    }),
  };
}

function orderStatus({ order, business, status }) {
  const storeName = business.name || 'Our Store';
  const reference = orderReference(order);
  const explanations = {
    Confirmed: 'Your order has been reviewed and confirmed.',
    Processing: 'Your items are being packed carefully.',
    Shipped: 'Your package is on the way. The courier may contact you shortly.',
    Delivered: 'Your package has been marked as delivered. We hope you love your purchase.',
    Cancelled: 'Your order has been cancelled. Contact the store if you need help.',
  };
  const explanation = explanations[status] || `Your order status is now ${status}.`;

  return {
    subject: `${reference} is now ${status}`,
    text: [
      `Order update - ${reference}`,
      `Hello ${order.customerName || 'Valued Customer'},`,
      explanation,
      `Store: ${storeName}`,
      `Current status: ${status}`,
    ].join('\n'),
    html: emailHtml({
      preheader: `${reference} is now ${status}`,
      heading: 'Order update',
      intro: `Hello ${order.customerName || 'Valued Customer'}, ${explanation}`,
      rows: [
        ['Order', reference],
        ['Store', storeName],
        ['Current status', status],
      ],
    }),
  };
}

function buyerOtp({ code, expiresInMinutes = 10 }) {
  return {
    subject: 'Your buyer verification code',
    text: [
      `Your verification code is ${code}.`,
      `It expires in ${expiresInMinutes} minutes.`,
      'If you did not request this code, ignore this email.',
    ].join('\n'),
    html: emailHtml({
      preheader: `Your verification code is ${code}`,
      heading: 'Verify your identity',
      intro: 'Use this one-time code to access your order history.',
      rows: [['Verification code', code], ['Expires in', `${expiresInMinutes} minutes`]],
      body: ['If you did not request this code, you can safely ignore this email.'],
    }),
  };
}

function sellerWelcome({ businessName, code, expiresInMinutes = 10 }) {
  return {
    subject: 'Welcome to Chatstand 🎉 - your verification code',
    text: [
      `Hi ${businessName || 'there'}, welcome to Chatstand!`,
      'Your seller account is ready. Connect your Telegram bot, add products, and start selling.',
      ...(code
        ? [
            '',
            `Your email verification code is ${code}.`,
            `It expires in ${expiresInMinutes} minutes.`,
            'Enter it on the verification screen to unlock the full dashboard.',
          ]
        : []),
    ].join('\n'),
    html: emailHtml({
      preheader: code ? `Your verification code is ${code}` : 'Your Chatstand seller account is ready',
      heading: 'Welcome to Chatstand',
      intro: `Hi ${businessName || 'there'}, your seller account is ready. Connect your Telegram bot, add products, and start selling across Telegram and your storefront.`,
      rows: code
        ? [
            ['Verification code', code],
            ['Expires in', `${expiresInMinutes} minutes`],
          ]
        : [],
      body: code
        ? ['Enter this code on the verification screen to confirm your email and unlock the full dashboard.']
        : [],
    }),
  };
}

function sellerEmailVerification({ businessName, code, expiresInMinutes = 10 }) {
  return {
    subject: 'Your Chatstand verification code',
    text: [
      `Hi ${businessName || 'there'}, confirm your email to finish setting up your Chatstand account.`,
      `Your verification code is ${code}.`,
      `It expires in ${expiresInMinutes} minutes.`,
      'If you did not create this account, you can ignore this email.',
    ].join('\n'),
    html: emailHtml({
      preheader: `Your verification code is ${code}`,
      heading: 'Verify your email',
      intro: `Hi ${businessName || 'there'}, enter this one-time code to finish setting up your Chatstand account.`,
      rows: [
        ['Verification code', code],
        ['Expires in', `${expiresInMinutes} minutes`],
      ],
      body: ['If you did not create this account, you can safely ignore this email.'],
    }),
  };
}

function sellerPasswordReset({ businessName, resetUrl, expiresInMinutes = 30 }) {
  return {
    subject: 'Reset your Chatstand password',
    text: [
      `Hi ${businessName || 'there'}, we received a request to reset your Chatstand password.`,
      `Reset it here: ${resetUrl}`,
      `This link expires in ${expiresInMinutes} minutes.`,
      'If you did not request this, you can ignore this email — your password will stay the same.',
    ].join('\n'),
    html: emailHtml({
      preheader: 'Reset your password',
      heading: 'Reset your password',
      intro: `Hi ${businessName || 'there'}, we received a request to reset your Chatstand password.`,
      body: [`This link expires in ${expiresInMinutes} minutes.`, 'If you did not request this, you can ignore this email — your password will stay the same.'],
      action: { label: 'Reset password', url: resetUrl },
    }),
  };
}

/**
 * Platform -> seller announcement. The body is PLAIN TEXT by contract: it is
 * split into paragraphs and escaped by `emailHtml`, so a composer can never
 * inject markup into a message sent to the whole platform.
 */
function adminBroadcast({ businessName, subject, body, preheader = '', ctaLabel = '', ctaUrl = '', unsubscribeUrl = '' }) {
  const paragraphs = String(body || '')
    .split(/\n{2,}/)
    .map((block) => block.replace(/\n/g, ' ').trim())
    .filter(Boolean);

  return {
    subject: subject || 'An update from Chatstand',
    text: [
      `Hi ${businessName || 'there'},`,
      '',
      ...paragraphs,
      ...(ctaUrl ? ['', `${ctaLabel || 'Open'}: ${ctaUrl}`] : []),
      ...(unsubscribeUrl ? ['', `Unsubscribe from announcements: ${unsubscribeUrl}`] : []),
    ].join('\n'),
    html: emailHtml({
      preheader: preheader || paragraphs[0] || subject,
      heading: subject || 'An update from Chatstand',
      intro: `Hi ${businessName || 'there'},`,
      body: paragraphs,
      action: ctaUrl ? { label: ctaLabel || 'Open', url: ctaUrl } : null,
      unsubscribeUrl,
    }),
  };
}

function sellerPasswordChanged({ businessName }) {
  return {
    subject: 'Your Chatstand password was changed',
    text: [
      `Hi ${businessName || 'there'}, your Chatstand account password was just changed.`,
      'If this was not you, contact platform support immediately.',
    ].join('\n'),
    html: emailHtml({
      preheader: 'Your password was changed',
      heading: 'Password changed',
      intro: `Hi ${businessName || 'there'}, your Chatstand account password was just changed.`,
      body: ['If this was not you, contact platform support immediately.'],
    }),
  };
}

function sellerAccountStatus({ businessName, isActive }) {
  const heading = isActive ? 'Your account has been reactivated' : 'Your account has been suspended';
  const explanation = isActive
    ? 'You can log in and continue selling on Chatstand.'
    : 'Your dashboard access has been paused by the platform team. Contact support for more information.';
  return {
    subject: heading,
    text: [`Hi ${businessName || 'there'},`, explanation].join('\n'),
    html: emailHtml({
      preheader: heading,
      heading,
      intro: `Hi ${businessName || 'there'},`,
      body: [explanation],
    }),
  };
}

module.exports = {
  escapeHtml,
  money,
  orderReference,
  orderConfirmation,
  paymentReceipt,
  orderStatus,
  buyerOtp,
  adminBroadcast,
  sellerWelcome,
  sellerEmailVerification,
  sellerPasswordReset,
  sellerPasswordChanged,
  sellerAccountStatus,
};
