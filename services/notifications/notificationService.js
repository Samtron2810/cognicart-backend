/**
 * Transactional Notification Service
 *
 * Commerce events are rendered once and dispatched through a channel adapter.
 * Storefront events use Brevo email and bot-originated orders use the
 * registered Telegram transport through the same provider-neutral boundary.
 */

const Customer = require('../../models/Customer');
const businessService = require('../sellers/businessService');
const dispatcher = require('./notificationDispatcher');
const templates = require('./notificationTemplates');
const { isEmail } = require('../../utils/validators');
const logger = require('../../utils/logger');

const EVENTS = Object.freeze({
  ORDER_CREATED: 'order.created',
  PAYMENT_RECEIVED: 'payment.received',
  ORDER_STATUS_CHANGED: 'order.status_changed',
  BUYER_OTP: 'buyer.otp',
  SELLER_WELCOME: 'seller.welcome',
  SELLER_EMAIL_VERIFICATION: 'seller.email_verification',
  SELLER_PASSWORD_RESET: 'seller.password_reset',
  SELLER_PASSWORD_CHANGED: 'seller.password_changed',
  SELLER_ACCOUNT_STATUS: 'seller.account_status',
  ADMIN_BROADCAST: 'admin.broadcast',
});

function normalizedEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!isEmail(email)) return '';
  // Payment initialization previously fabricated addresses for Paystack when a
  // buyer supplied none. They are valid syntax but can never receive mail.
  if (email.endsWith('@wabac.ng')) return '';
  return email;
}

async function resolveOrderEmail(order, payment = null) {
  const direct = normalizedEmail(order && order.customerEmail);
  if (direct) return direct;

  const paymentEmail = normalizedEmail(payment && payment.email);
  if (paymentEmail) return paymentEmail;

  if (!order || !order.customerId || !order.sellerId) return '';
  try {
    const customer = await Customer.findOne({ _id: order.customerId, sellerId: order.sellerId }).select('email');
    return normalizedEmail(customer && customer.email);
  } catch (error) {
    logger.warn('Could not resolve notification email from customer profile:', {
      orderId: order.id,
      error: error.message,
    });
    return '';
  }
}

function replyToFor(business) {
  const email = normalizedEmail(business && business.email);
  return email ? { email, name: business.name || '' } : undefined;
}

function skipped(event, reason) {
  return { delivered: false, event, reason };
}

async function dispatchEmail({ event, to, toName, business, rendered, tags = [] }) {
  if (!to) return skipped(event, 'destination_missing');
  return dispatcher.dispatch({
    event,
    channel: 'email',
    to,
    toName,
    replyTo: replyToFor(business),
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    tags: ['transactional', event.replace(/\./g, '-')].concat(tags),
  });
}

const notificationService = {
  EVENTS,

  /** Storefront order confirmation + single-use buyer tracking link. */
  async sendOrderConfirmation(order) {
    if (!order) return skipped(EVENTS.ORDER_CREATED, 'order_missing');
    if (order.source === 'manual') return skipped(EVENTS.ORDER_CREATED, 'manual_order');

    // Telegram-originated orders intentionally do not fall back to email: the
    // bot transport owns that conversation and identity.
    if (order.source === 'telegram') {
      return dispatcher.dispatch({
        event: EVENTS.ORDER_CREATED,
        channel: 'telegram',
        to: order.channelUserId,
        order,
      });
    }

    try {
      const email = await resolveOrderEmail(order);
      if (!email) return skipped(EVENTS.ORDER_CREATED, 'destination_missing');
      if (!dispatcher.canSend('email')) return skipped(EVENTS.ORDER_CREATED, 'transport_not_configured');

      const business = (await businessService.getBySellerId(order.sellerId)) || {};
      let trackingUrl = '';

      try {
        const shopperAuthService = require('../shop/shopperAuthService');
        const magic = await shopperAuthService.createMagicLink({
          phone: order.customerPhone,
          email,
          sellerId: order.sellerId,
          orderId: order.id,
        });
        trackingUrl = magic.url;
      } catch (error) {
        logger.warn('Could not attach tracking link to order email:', {
          orderId: order.id,
          error: error.message,
        });
      }

      return dispatchEmail({
        event: EVENTS.ORDER_CREATED,
        to: email,
        toName: order.customerName,
        business,
        rendered: templates.orderConfirmation({ order, business, trackingUrl }),
      });
    } catch (error) {
      logger.warn('Failed to prepare order confirmation:', {
        orderId: order.id,
        error: error.message,
      });
      return skipped(EVENTS.ORDER_CREATED, 'preparation_failed');
    }
  },

  /** Paystack-verified payment receipt. */
  async sendPaymentReceipt(payment, order) {
    if (!payment) return skipped(EVENTS.PAYMENT_RECEIVED, 'payment_missing');
    if (order && order.source === 'manual') return skipped(EVENTS.PAYMENT_RECEIVED, 'manual_order');

    if (order && order.source === 'telegram') {
      return dispatcher.dispatch({
        event: EVENTS.PAYMENT_RECEIVED,
        channel: 'telegram',
        to: order.channelUserId,
        payment,
        order,
      });
    }

    try {
      const email = await resolveOrderEmail(order, payment);
      if (!email) return skipped(EVENTS.PAYMENT_RECEIVED, 'destination_missing');
      const sellerId = payment.sellerId || (order && order.sellerId);
      const business = (await businessService.getBySellerId(sellerId)) || {};

      return dispatchEmail({
        event: EVENTS.PAYMENT_RECEIVED,
        to: email,
        toName: order && order.customerName,
        business,
        rendered: templates.paymentReceipt({ payment, order, business }),
      });
    } catch (error) {
      logger.warn('Failed to prepare payment receipt:', {
        reference: payment.reference,
        error: error.message,
      });
      return skipped(EVENTS.PAYMENT_RECEIVED, 'preparation_failed');
    }
  },

  /** Fulfilment transition (Confirmed, Processing, Shipped, Delivered, etc.). */
  async sendOrderStatusUpdate(order, newStatus) {
    if (!order) return skipped(EVENTS.ORDER_STATUS_CHANGED, 'order_missing');
    if (order.source === 'manual') return skipped(EVENTS.ORDER_STATUS_CHANGED, 'manual_order');

    if (order.source === 'telegram') {
      return dispatcher.dispatch({
        event: EVENTS.ORDER_STATUS_CHANGED,
        channel: 'telegram',
        to: order.channelUserId,
        order,
        status: newStatus,
      });
    }

    try {
      const email = await resolveOrderEmail(order);
      if (!email) return skipped(EVENTS.ORDER_STATUS_CHANGED, 'destination_missing');
      const business = (await businessService.getBySellerId(order.sellerId)) || {};

      return dispatchEmail({
        event: EVENTS.ORDER_STATUS_CHANGED,
        to: email,
        toName: order.customerName,
        business,
        rendered: templates.orderStatus({ order, business, status: newStatus }),
      });
    } catch (error) {
      logger.warn('Failed to prepare order status notification:', {
        orderId: order.id,
        status: newStatus,
        error: error.message,
      });
      return skipped(EVENTS.ORDER_STATUS_CHANGED, 'preparation_failed');
    }
  },

  /** Buyer login code sent only to a previously associated email address. */
  async sendBuyerOtp({ email, code, expiresInMinutes = 10 }) {
    const to = normalizedEmail(email);
    if (!to) return skipped(EVENTS.BUYER_OTP, 'destination_missing');

    return dispatchEmail({
      event: EVENTS.BUYER_OTP,
      to,
      business: {},
      rendered: templates.buyerOtp({ code, expiresInMinutes }),
      tags: ['authentication'],
    });
  },

  /** Sent once, right after a seller account is created. Carries the signup OTP. */
  async sendSellerWelcome({ email, businessName, code = '', expiresInMinutes = 10 }) {
    const to = normalizedEmail(email);
    if (!to) return skipped(EVENTS.SELLER_WELCOME, 'destination_missing');

    return dispatchEmail({
      event: EVENTS.SELLER_WELCOME,
      to,
      toName: businessName,
      business: {},
      rendered: templates.sellerWelcome({ businessName, code, expiresInMinutes }),
      tags: ['seller-lifecycle'],
    });
  },

  /** Verify-email one-time code for a seller account. */
  async sendSellerEmailVerification({ email, businessName, code, expiresInMinutes = 10 }) {
    const to = normalizedEmail(email);
    if (!to) return skipped(EVENTS.SELLER_EMAIL_VERIFICATION, 'destination_missing');

    return dispatchEmail({
      event: EVENTS.SELLER_EMAIL_VERIFICATION,
      to,
      toName: businessName,
      business: {},
      rendered: templates.sellerEmailVerification({ businessName, code, expiresInMinutes }),
      tags: ['authentication'],
    });
  },

  /** Forgot-password reset link for a seller account. */
  async sendSellerPasswordReset({ email, businessName, resetUrl, expiresInMinutes = 30 }) {
    const to = normalizedEmail(email);
    if (!to) return skipped(EVENTS.SELLER_PASSWORD_RESET, 'destination_missing');

    return dispatchEmail({
      event: EVENTS.SELLER_PASSWORD_RESET,
      to,
      toName: businessName,
      business: {},
      rendered: templates.sellerPasswordReset({ businessName, resetUrl, expiresInMinutes }),
      tags: ['authentication'],
    });
  },

  /** Security notice after a successful password change/reset. */
  async sendSellerPasswordChanged({ email, businessName }) {
    const to = normalizedEmail(email);
    if (!to) return skipped(EVENTS.SELLER_PASSWORD_CHANGED, 'destination_missing');

    return dispatchEmail({
      event: EVENTS.SELLER_PASSWORD_CHANGED,
      to,
      toName: businessName,
      business: {},
      rendered: templates.sellerPasswordChanged({ businessName }),
      tags: ['authentication'],
    });
  },

  /** Admin suspended/reactivated a seller account. */
  async sendSellerAccountStatus({ email, businessName, isActive }) {
    const to = normalizedEmail(email);
    if (!to) return skipped(EVENTS.SELLER_ACCOUNT_STATUS, 'destination_missing');

    return dispatchEmail({
      event: EVENTS.SELLER_ACCOUNT_STATUS,
      to,
      toName: businessName,
      business: {},
      rendered: templates.sellerAccountStatus({ businessName, isActive }),
      tags: ['seller-lifecycle'],
    });
  },

  /**
   * Platform announcement to a seller. This is the only MARKETING email in the
   * service: callers must have already filtered out `marketingOptOut` accounts
   * and must pass an unsubscribe link for every real account.
   */
  async sendAdminBroadcast({ email, businessName, subject, body, preheader, ctaLabel, ctaUrl, unsubscribeUrl }) {
    const to = normalizedEmail(email);
    if (!to) return skipped(EVENTS.ADMIN_BROADCAST, 'destination_missing');

    return dispatchEmail({
      event: EVENTS.ADMIN_BROADCAST,
      to,
      toName: businessName,
      business: {},
      rendered: templates.adminBroadcast({
        businessName,
        subject,
        body,
        preheader,
        ctaLabel,
        ctaUrl,
        unsubscribeUrl,
      }),
      tags: ['broadcast'],
    });
  },

  // Exposed for focused transport tests; commerce callers should use the
  // event-specific methods above.
  dispatcher,
  resolveOrderEmail,
};

module.exports = notificationService;
