/**
 * Paystack payment lifecycle.
 *
 * Local payment/order state changes only after an authenticated Paystack API
 * verification. Pending checkout links are reused per order, and cancelled
 * orders automatically queue a refund if an already-open link is paid late.
 */

const crypto = require('crypto');
const Payment = require('../../models/Payment');
const PlatformConfig = require('../../models/PlatformConfig');
const orderService = require('../orders/orderService');
const paystackClient = require('./paystackClient');
const { isEmail } = require('../../utils/validators');
const logger = require('../../utils/logger');

function getNotificationService() {
  try {
    return require('../notifications/notificationService');
  } catch {
    return null;
  }
}

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function genReference() {
  return `PSK_${Date.now().toString(36).toUpperCase()}_${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
}

function calculatePaystackFee(amount) {
  return Math.min(Math.round(amount * 0.015), 2000);
}

function checkoutCallbackUrl() {
  const apiOrigin = String(process.env.API_PUBLIC_URL || '').replace(/\/$/, '');
  if (!/^https?:\/\//i.test(apiOrigin)) {
    throw httpError('API_PUBLIC_URL must be configured for secure payment callbacks', 503);
  }
  return `${apiOrigin}/api/payments/callback`;
}

function present(payment, extra = {}) {
  const json = typeof payment.toJSON === 'function' ? payment.toJSON() : payment;
  return {
    reference: json.reference,
    authorization_url: json.authorizationUrl || '',
    transaction: json,
    ...extra,
  };
}

async function assertCheckoutStillPayable(orderId, sellerId, payment) {
  const currentOrder = await orderService.getById(orderId, sellerId);
  if (currentOrder.orderStatus !== 'Cancelled' && !['Paid', 'Refunded'].includes(currentOrder.paymentStatus)) {
    return currentOrder;
  }

  await Payment.updateOne(
    { _id: payment._id, status: 'pending' },
    {
      $set: {
        status: 'abandoned',
        providerStatus: currentOrder.orderStatus === 'Cancelled' ? 'order_cancelled' : 'order_already_paid',
      },
    }
  );
  throw httpError(
    currentOrder.orderStatus === 'Cancelled'
      ? 'Order was cancelled while payment was being initialized'
      : 'Order was paid while payment was being initialized',
    409
  );
}

function validateProviderSuccess(transaction, data) {
  if (!data || String(data.reference || '') !== transaction.reference) {
    throw httpError('Paystack returned a mismatched transaction reference', 502);
  }
  if (String(data.status || '').toLowerCase() !== 'success') {
    throw httpError(`Payment is ${data.status || 'not successful'}`, 409);
  }

  const expectedAmount = Math.round(Number(transaction.amount) * 100);
  if (Number(data.amount) !== expectedAmount) {
    throw httpError('Verified payment amount does not match the order', 409);
  }
  if (String(data.currency || '').toUpperCase() !== String(transaction.currency || 'NGN').toUpperCase()) {
    throw httpError('Verified payment currency does not match the order', 409);
  }
}

async function queueCancelledOrderRefund(transaction, order) {
  const claimed = await Payment.findOneAndUpdate(
    {
      _id: transaction._id,
      refundStatus: { $in: ['none', 'failed', null] },
    },
    {
      $set: {
        refundStatus: 'pending',
        refundReason: 'Payment completed after order cancellation',
      },
    },
    { new: true }
  );
  if (!claimed) return Payment.findById(transaction._id);

  try {
    const refund = await paystackClient.createRefund({
      transaction: claimed.reference,
      amount: Math.round(Number(claimed.amount) * 100),
      currency: claimed.currency || 'NGN',
      customer_note: 'This order was cancelled before the payment completed.',
      merchant_note: `Automatic refund for cancelled order ${order.reference || order.id}`,
    });
    claimed.refundStatus = refund && refund.status === 'processed' ? 'processed' : 'pending';
    claimed.refundId = refund && refund.id ? String(refund.id) : '';
    await claimed.save();
    if (claimed.refundStatus === 'processed') {
      await orderService.updatePaymentStatus(order.id, order.sellerId, 'Refunded', claimed.reference);
    }
    logger.warn('Refund queued for late payment on cancelled order:', {
      orderId: order.id,
      reference: claimed.reference,
    });
  } catch (error) {
    await Payment.updateOne(
      { _id: claimed._id, refundStatus: 'pending' },
      { $set: { refundStatus: 'failed', refundReason: error.message } }
    );
    throw error;
  }
  return claimed;
}

const paymentService = {
  async getFeeConfig() {
    let config = await PlatformConfig.findOne({ key: 'platform_fee' });
    if (!config) {
      config = await PlatformConfig.create({
        key: 'platform_fee',
        percentage: Number(process.env.PLATFORM_FEE_PERCENTAGE) || 5,
        fixed: Number(process.env.PLATFORM_FEE_FIXED) || 0,
      });
    }
    return { percentage: config.percentage, fixed: config.fixed };
  },

  async setFeeConfig({ percentage, fixed }) {
    const update = {};
    if (percentage !== undefined && !Number.isNaN(Number(percentage))) update.percentage = Number(percentage);
    if (fixed !== undefined && !Number.isNaN(Number(fixed))) update.fixed = Number(fixed);
    const config = await PlatformConfig.findOneAndUpdate(
      { key: 'platform_fee' },
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return { percentage: config.percentage, fixed: config.fixed };
  },

  /** Initialize once per unpaid order; repeated PAY requests reuse the link. */
  async initialize(payload, idempotencyKey) {
    if (!payload.orderId) throw httpError('orderId is required');

    const order = await orderService.getById(payload.orderId, payload.sellerId);
    if (order.orderStatus === 'Cancelled') throw httpError('Cancelled orders cannot be paid', 409);
    if (order.paymentStatus === 'Paid') throw httpError('This order has already been paid', 409);
    if (order.paymentStatus === 'Refunded') throw httpError('This order has already been refunded', 409);

    const amount = Number(order.total);
    if (!Number.isFinite(amount) || amount <= 0) throw httpError('Order has an invalid total');
    if (payload.amount !== undefined && Number(payload.amount) !== amount) {
      throw httpError('Payment amount must match the authoritative order total', 409);
    }

    const email = String(payload.email || order.customerEmail || '').trim().toLowerCase();
    if (!isEmail(email)) throw httpError('A valid customer email is required for Paystack checkout');
    const sellerId = order.sellerId;

    if (idempotencyKey) {
      const idempotent = await Payment.findOne({ sellerId, idempotencyKey });
      if (idempotent) {
        if (idempotent.orderId !== order.id) throw httpError('Idempotency key belongs to another order', 409);
        if (idempotent.status === 'pending' && !idempotent.authorizationUrl) {
          throw httpError('Payment initialization is already in progress. Please try again.', 409);
        }
        if (idempotent.status === 'success') {
          const reconciled = await this.verify(idempotent.reference);
          return present(reconciled, { reused: true, alreadyPaid: true });
        }
      }
    }

    let existing = await Payment.findOne({ sellerId, orderId: order.id, status: 'pending' })
      .sort({ createdAt: -1 })
      .select('+accessCode');
    if (existing) {
      const ageMs = Date.now() - new Date(existing.createdAt || 0).getTime();
      if (!existing.authorizationUrl && ageMs < 60 * 1000) {
        throw httpError('Payment initialization is already in progress. Please try again.', 409);
      }

      let provider = null;
      try {
        provider = await paystackClient.verifyTransaction(existing.reference);
      } catch (error) {
        // Fail closed, but leave the known pending transaction intact so a
        // later retry can reuse it rather than creating another payable link.
        if (existing.authorizationUrl) {
          logger.warn('Could not refresh pending Paystack transaction:', {
            reference: existing.reference,
            error: error.message,
          });
          throw error;
        }
        existing.status = 'failed';
        existing.providerStatus = 'initialization_failed';
        await existing.save();
        existing = null;
      }

      if (existing && provider) {
        const providerStatus = String(provider.status || '').toLowerCase();
        existing.providerStatus = providerStatus;
        existing.lastVerifiedAt = new Date();
        if (providerStatus === 'success') {
          // Amount/currency validation failures deliberately escape this branch;
          // they must never be mistaken for a reason to reuse a compromised link.
          const reconciled = await this.reconcileVerified(existing, provider);
          return present(reconciled, { reused: true, alreadyPaid: true });
        }
        if (['failed', 'abandoned', 'reversed'].includes(providerStatus)) {
          existing.status = providerStatus === 'abandoned' ? 'abandoned' : 'failed';
          await existing.save();
          existing = null;
        } else if (existing.authorizationUrl) {
          await existing.save();
          await assertCheckoutStillPayable(order.id, sellerId, existing);
          return present(existing, { reused: true });
        } else {
          existing.status = 'failed';
          existing.providerStatus = 'missing_checkout_url';
          await existing.save();
          existing = null;
        }
      }
    }

    const fee = await this.getFeeConfig();
    const platformFee = Math.round(amount * (fee.percentage / 100) + fee.fixed);
    const paystackFee = calculatePaystackFee(amount);
    const sellerAmount = Math.max(0, amount - platformFee - paystackFee);
    const reference = genReference();

    let payment;
    try {
      payment = await Payment.create({
        sellerId,
        orderId: order.id,
        amount,
        subtotal: Number(order.subtotal),
        deliveryFee: Number(order.deliveryFee || 0),
        platformFee,
        sellerAmount,
        paystackFee,
        currency: 'NGN',
        reference,
        email,
        status: 'pending',
        channel: 'paystack',
        providerStatus: 'initializing',
        idempotencyKey: idempotencyKey || undefined,
      });
    } catch (error) {
      if (error && error.code === 11000) {
        const concurrent = await Payment.findOne({ sellerId, orderId: order.id, status: 'pending' });
        if (concurrent && concurrent.authorizationUrl) {
          await assertCheckoutStillPayable(order.id, sellerId, concurrent);
          return present(concurrent, { reused: true });
        }
        throw httpError('Payment initialization is already in progress. Please try again.', 409);
      }
      throw error;
    }

    try {
      const provider = await paystackClient.initializeTransaction({
        email,
        amount: Math.round(amount * 100),
        reference,
        currency: 'NGN',
        callback_url: checkoutCallbackUrl(),
        metadata: {
          orderId: order.id,
          sellerId,
          source: order.source,
        },
      });
      if (!provider || provider.reference !== reference || !provider.authorization_url) {
        throw httpError('Paystack returned an invalid initialization response', 502);
      }
      payment.authorizationUrl = provider.authorization_url;
      payment.accessCode = provider.access_code || '';
      payment.providerStatus = 'pending';
      await payment.save();
    } catch (error) {
      payment.status = 'failed';
      payment.providerStatus = 'initialization_failed';
      await payment.save();
      throw error;
    }

    // Recheck after the provider round-trip so a concurrent cancellation or
    // manual payment cannot receive a newly initialized hosted link.
    await assertCheckoutStillPayable(order.id, sellerId, payment);
    payment = await Payment.findById(payment._id);
    logger.info('Payment initialized:', { orderId: order.id, reference, amount });
    return present(payment);
  },

  /** Verify with Paystack before changing any local financial state. */
  async verify(reference) {
    if (!reference) throw httpError('Payment reference is required');
    const transaction = await Payment.findOne({ reference }).select('+accessCode');
    if (!transaction) throw httpError('Transaction not found', 404);
    // Always ask Paystack. This keeps callbacks and webhook retries authoritative
    // even if a prior local reconciliation stopped part-way through.
    const provider = await paystackClient.verifyTransaction(reference);
    validateProviderSuccess(transaction, provider);
    return this.reconcileVerified(transaction, provider);
  },

  async reconcileVerified(transaction, provider) {
    validateProviderSuccess(transaction, provider);
    const order = await orderService.getById(transaction.orderId, transaction.sellerId);
    if (Number(order.total) !== Number(transaction.amount)) {
      throw httpError('Local order total does not match the payment', 409);
    }

    const now = new Date();
    const claimed = await Payment.findOneAndUpdate(
      {
        _id: transaction._id,
        $or: [
          { status: { $ne: 'success' } },
          { providerTransactionId: { $in: ['', null] } },
        ],
      },
      {
        $set: {
          status: 'success',
          providerStatus: 'success',
          providerTransactionId: provider.id ? String(provider.id) : transaction.providerTransactionId,
          verifiedAt: transaction.verifiedAt || now,
          lastVerifiedAt: now,
        },
      },
      { new: true }
    );
    let reconciledPayment = claimed || await Payment.findById(transaction._id);
    if (!reconciledPayment) throw httpError('Transaction not found during reconciliation', 404);

    // Updating payment status and reading the resulting order in one operation
    // closes the cancellation race: whichever state wins determines whether a
    // receipt is sent or a refund is queued.
    let reconciledOrder = order;
    if (order.paymentStatus !== 'Refunded') {
      reconciledOrder = await orderService.updatePaymentStatus(
        reconciledPayment.orderId,
        reconciledPayment.sellerId,
        'Paid',
        reconciledPayment.reference
      );
    }

    if (reconciledOrder.orderStatus === 'Cancelled') {
      if (reconciledPayment.refundStatus === 'processed') {
        if (reconciledOrder.paymentStatus !== 'Refunded') {
          reconciledOrder = await orderService.updatePaymentStatus(
            reconciledPayment.orderId,
            reconciledPayment.sellerId,
            'Refunded',
            reconciledPayment.reference
          );
        }
      } else {
        const refundPayment = await queueCancelledOrderRefund(reconciledPayment, reconciledOrder);
        if (refundPayment) reconciledPayment = refundPayment;
      }
    } else if (claimed) {
      const notifications = getNotificationService();
      if (notifications) notifications.sendPaymentReceipt(reconciledPayment.toJSON(), reconciledOrder).catch(() => {});
    }

    logger.info('Paystack payment verified and reconciled:', {
      reference: reconciledPayment.reference,
      orderId: reconciledPayment.orderId,
    });
    return reconciledPayment.toJSON();
  },

  async abandonPendingForOrder(orderId, sellerId, reason = 'cancelled') {
    return Payment.updateMany(
      { orderId, sellerId, status: 'pending' },
      {
        $set: {
          status: 'abandoned',
          providerStatus: reason,
        },
      }
    );
  },

  async processWebhook(event = {}) {
    const type = String(event.event || '');
    const data = event.data || {};
    if (type === 'charge.success' && data.reference) return this.verify(data.reference);

    if (['refund.processed', 'refund.failed'].includes(type)) {
      const reference =
        data.transaction_reference ||
        (data.transaction && data.transaction.reference) ||
        data.reference ||
        '';
      if (!reference) return null;
      const transaction = await Payment.findOne({ reference });
      if (!transaction) return null;
      transaction.refundStatus = type === 'refund.processed' ? 'processed' : 'failed';
      if (data.id) transaction.refundId = String(data.id);
      await transaction.save();
      if (type === 'refund.processed') {
        await orderService.updatePaymentStatus(
          transaction.orderId,
          transaction.sellerId,
          'Refunded',
          transaction.reference
        );
      }
      return transaction.toJSON();
    }
    return null;
  },

  async getByReference(reference) {
    if (!reference) return null;
    const transaction = await Payment.findOne({ reference });
    return transaction ? transaction.toJSON() : null;
  },

  async list(sellerId) {
    if (!sellerId) throw new Error('Seller ID is required');
    const transactions = await Payment.find({ sellerId }).sort({ createdAt: -1 });
    return transactions.map((transaction) => transaction.toJSON());
  },

  async listAll() {
    const transactions = await Payment.find().sort({ createdAt: -1 });
    return transactions.map((transaction) => transaction.toJSON());
  },
};

module.exports = paymentService;
module.exports.validateProviderSuccess = validateProviderSuccess;
module.exports.checkoutCallbackUrl = checkoutCallbackUrl;
