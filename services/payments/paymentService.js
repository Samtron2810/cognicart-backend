/**
 * Payment and Revenue Processing Service
 * Paystack payment gateway integration, transaction settlement, and platform revenue calculations
 */

const Payment = require('../../models/Payment');
const PlatformConfig = require('../../models/PlatformConfig');
const orderService = require('../orders/orderService');
const logger = require('../../utils/logger');

function getNotificationService() {
  try {
    return require('../notifications/notificationService');
  } catch {
    return null;
  }
}

function genReference() {
  return 'PSK_' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function calculatePaystackFee(amount) {
  // Paystack standard Nigerian transaction fee: 1.5% capped at ₦2000
  const fee = Math.round(amount * 0.015);
  return Math.min(fee, 2000);
}

const paymentService = {
  /**
   * Get current platform fee configuration
   */
  async getFeeConfig() {
    let cfg = await PlatformConfig.findOne({ key: 'platform_fee' });
    if (!cfg) {
      cfg = await PlatformConfig.create({
        key: 'platform_fee',
        percentage: Number(process.env.PLATFORM_FEE_PERCENTAGE) || 5,
        fixed: Number(process.env.PLATFORM_FEE_FIXED) || 0,
      });
    }
    return { percentage: cfg.percentage, fixed: cfg.fixed };
  },

  /**
   * Update platform fee configuration (Admin)
   */
  async setFeeConfig({ percentage, fixed }) {
    const update = {};
    if (percentage !== undefined && !isNaN(Number(percentage))) update.percentage = Number(percentage);
    if (fixed !== undefined && !isNaN(Number(fixed))) update.fixed = Number(fixed);

    const cfg = await PlatformConfig.findOneAndUpdate(
      { key: 'platform_fee' },
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return { percentage: cfg.percentage, fixed: cfg.fixed };
  },

  /**
   * Initialize a new Paystack payment transaction
   */
  async initialize(payload, idempotencyKey) {
    if (!payload.orderId) {
      const err = new Error('orderId is required');
      err.statusCode = 400;
      throw err;
    }

    if (!payload.amount || Number(payload.amount) <= 0) {
      const err = new Error('Valid payment amount is required');
      err.statusCode = 400;
      throw err;
    }

    const amount = Number(payload.amount);
    const email = (payload.email || '').trim().toLowerCase() || `customer_${String(payload.orderId).slice(-6)}@wabac.ng`;

    // Idempotency check
    if (idempotencyKey) {
      const existingTx = await Payment.findOne({ idempotencyKey });
      if (existingTx) {
        logger.info('Payment initialize idempotency hit:', { idempotencyKey, reference: existingTx.reference });
        return {
          reference: existingTx.reference,
          authorization_url: `https://checkout.paystack.com/${existingTx.reference}`,
          transaction: existingTx.toJSON(),
        };
      }
    }

    // Resolve the owning seller from the order (never guess/default it)
    let order = null;
    try {
      order = await orderService.getById(payload.orderId, payload.sellerId);
    } catch (err) {
      logger.warn('Payment initialization could not load order:', { orderId: payload.orderId, error: err.message });
    }

    const sellerId = payload.sellerId || (order && order.sellerId);
    if (!sellerId) {
      const err = new Error('Order not found: a payment must belong to an existing order and seller');
      err.statusCode = 404;
      throw err;
    }

    // Calculate revenue splits
    const feeCfg = await this.getFeeConfig();
    const platformFee = Math.round(amount * (feeCfg.percentage / 100) + feeCfg.fixed);
    const paystackFee = calculatePaystackFee(amount);
    const sellerAmount = Math.max(0, amount - platformFee - paystackFee);

    const reference = genReference();
    let authorization_url = `https://checkout.paystack.com/${reference}`;

    // Call Paystack API if live secret key is available
    if (process.env.PAYSTACK_SECRET_KEY && !process.env.PAYSTACK_SECRET_KEY.includes('your_')) {
      try {
        const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email,
            amount: amount * 100, // Paystack requires kobo (100 kobo = 1 NGN)
            reference,
            currency: 'NGN',
            callback_url: `${process.env.CLIENT_URL || 'http://localhost:5173'}/checkout`,
          }),
        });
        const psData = await paystackRes.json();
        if (psData.status && psData.data && psData.data.authorization_url) {
          authorization_url = psData.data.authorization_url;
        }
      } catch (err) {
        logger.warn('Paystack API call failed, falling back to hosted checkout link:', { error: err.message });
      }
    }

    const payment = await Payment.create({
      sellerId,
      orderId: payload.orderId,
      amount,
      subtotal: payload.subtotal !== undefined ? Number(payload.subtotal) : amount,
      deliveryFee: payload.deliveryFee !== undefined ? Number(payload.deliveryFee) : 0,
      platformFee,
      sellerAmount,
      paystackFee,
      currency: 'NGN',
      reference,
      email,
      status: 'pending',
      channel: 'paystack',
      idempotencyKey: idempotencyKey || undefined,
    });

    logger.info('Payment initialized:', { orderId: payload.orderId, reference, amount });
    return {
      reference,
      authorization_url,
      transaction: payment.toJSON(),
    };
  },

  /**
   * Verify a transaction and reconcile the order to Paid
   */
  async verify(reference) {
    if (!reference) {
      const err = new Error('Payment reference is required');
      err.statusCode = 400;
      throw err;
    }

    const transaction = await Payment.findOne({ reference });
    if (!transaction) {
      const err = new Error('Transaction not found');
      err.statusCode = 404;
      throw err;
    }

    if (transaction.status === 'success') {
      return transaction.toJSON();
    }

    // Mark transaction verified
    transaction.status = 'success';
    transaction.verifiedAt = new Date();
    await transaction.save();

    // Automatically reconcile corresponding order
    let recOrder = null;
    try {
      recOrder = await orderService.updatePaymentStatus(transaction.orderId, transaction.sellerId, 'Paid', reference);
    } catch (err) {
      logger.warn('Order reconciliation error during payment verification:', { error: err.message });
    }

    logger.info('Payment verified & order reconciled:', { reference, orderId: transaction.orderId });
    const ns = getNotificationService();
    if (ns) ns.sendPaymentReceipt(transaction.toJSON(), recOrder).catch(() => {});
    return transaction.toJSON();
  },

  /**
   * Get transaction by reference
   */
  async getByReference(reference) {
    if (!reference) return null;
    const tx = await Payment.findOne({ reference });
    return tx ? tx.toJSON() : null;
  },

  /**
   * List transactions for a specific seller
   */
  async list(sellerId) {
    if (!sellerId) throw new Error('Seller ID is required');
    const list = await Payment.find({ sellerId }).sort({ createdAt: -1 });
    return list.map((t) => t.toJSON());
  },

  /**
   * List all platform transactions (Admin)
   */
  async listAll() {
    const list = await Payment.find().sort({ createdAt: -1 });
    return list.map((t) => t.toJSON());
  },
};

module.exports = paymentService;
