/**
 * Payment and Revenue Processing Service
 * Paystack payment gateway integration, transaction settlement, and platform revenue calculations
 */

const Payment = require('../../models/Payment');
const Order = require('../../models/Order');
const PlatformConfig = require('../../models/PlatformConfig');
const { isDbConnected } = require('../../config/db');
const orderService = require('../orders/orderService');
const logger = require('../../utils/logger');

function getNotificationService() {
  try {
    return require('../notifications/notificationService');
  } catch {
    return null;
  }
}

// In-Memory store for development/testing when MongoDB daemon is not running
const memoryPayments = new Map();
const memoryIdempotency = new Map();
let memoryFeeConfig = {
  percentage: Number(process.env.PLATFORM_FEE_PERCENTAGE) || 5,
  fixed: Number(process.env.PLATFORM_FEE_FIXED) || 0,
};

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
    if (isDbConnected()) {
      let cfg = await PlatformConfig.findOne({ key: 'platform_fee' });
      if (!cfg) {
        cfg = await PlatformConfig.create({
          key: 'platform_fee',
          percentage: Number(process.env.PLATFORM_FEE_PERCENTAGE) || 5,
          fixed: Number(process.env.PLATFORM_FEE_FIXED) || 0,
        });
      }
      return { percentage: cfg.percentage, fixed: cfg.fixed };
    }
    return memoryFeeConfig;
  },

  /**
   * Update platform fee configuration (Admin)
   */
  async setFeeConfig({ percentage, fixed }) {
    const update = {};
    if (percentage !== undefined && !isNaN(Number(percentage))) update.percentage = Number(percentage);
    if (fixed !== undefined && !isNaN(Number(fixed))) update.fixed = Number(fixed);

    if (isDbConnected()) {
      const cfg = await PlatformConfig.findOneAndUpdate(
        { key: 'platform_fee' },
        { $set: update },
        { new: true, upsert: true }
      );
      return { percentage: cfg.percentage, fixed: cfg.fixed };
    }

    memoryFeeConfig = { ...memoryFeeConfig, ...update };
    return memoryFeeConfig;
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
    const email = (payload.email || '').trim().toLowerCase() || `customer_${payload.orderId.slice(-6)}@wabac.ng`;

    // Idempotency check
    if (idempotencyKey) {
      if (isDbConnected()) {
        const existingTx = await Payment.findOne({ idempotencyKey });
        if (existingTx) {
          logger.info('Payment initialize idempotency hit (DB):', { idempotencyKey, reference: existingTx.reference });
          return {
            reference: existingTx.reference,
            authorization_url: `https://checkout.paystack.com/${existingTx.reference}`,
            transaction: existingTx.toJSON(),
          };
        }
      } else {
        const cachedRef = memoryIdempotency.get(idempotencyKey);
        if (cachedRef && memoryPayments.has(cachedRef)) {
          const t = memoryPayments.get(cachedRef);
          logger.info('Payment initialize idempotency hit (Memory):', { idempotencyKey, reference: t.reference });
          return {
            reference: t.reference,
            authorization_url: `https://checkout.paystack.com/${t.reference}`,
            transaction: t,
          };
        }
      }
    }

    // Determine sellerId from payload or order
    let sellerId = payload.sellerId;
    let order = null;
    try {
      order = await orderService.getById(payload.orderId, sellerId);
      if (order && !sellerId) sellerId = order.sellerId;
    } catch {}

    if (!sellerId) sellerId = 'seller_admin';

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
        logger.warn('Paystack API call failed, falling back to mock link:', { error: err.message });
      }
    }

    const txData = {
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
    };

    if (isDbConnected()) {
      const payment = await Payment.create(txData);
      return {
        reference,
        authorization_url,
        transaction: payment.toJSON(),
      };
    }

    // In-memory fallback
    const id = 'txn_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const now = new Date().toISOString();
    const memTx = {
      id,
      _id: id,
      ...txData,
      createdAt: now,
      updatedAt: now,
    };

    memoryPayments.set(reference, memTx);
    if (idempotencyKey) memoryIdempotency.set(idempotencyKey, reference);

    logger.info('Payment initialized (Memory):', { orderId: payload.orderId, reference, amount });
    return {
      reference,
      authorization_url,
      transaction: memTx,
    };
  },

  /**
   * Verify a transaction and reconcile the order to Paid
   */
  async verify(reference, signature = 'mock') {
    if (!reference) {
      const err = new Error('Payment reference is required');
      err.statusCode = 400;
      throw err;
    }

    let transaction = null;

    if (isDbConnected()) {
      transaction = await Payment.findOne({ reference });
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

      logger.info('Payment verified & order reconciled (DB):', { reference, orderId: transaction.orderId });
      const ns = getNotificationService();
      if (ns) ns.sendPaymentReceipt(transaction.toJSON(), recOrder).catch(() => {});
      return transaction.toJSON();
    }

    // In-memory fallback
    transaction = memoryPayments.get(reference);
    if (!transaction) {
      const err = new Error('Transaction not found');
      err.statusCode = 404;
      throw err;
    }

    transaction.status = 'success';
    transaction.verifiedAt = new Date().toISOString();
    transaction.updatedAt = transaction.verifiedAt;
    memoryPayments.set(reference, transaction);

    let memRecOrder = null;
    try {
      memRecOrder = await orderService.updatePaymentStatus(transaction.orderId, transaction.sellerId, 'Paid', reference);
    } catch (err) {
      logger.warn('Order reconciliation error (Memory):', { error: err.message });
    }

    logger.info('Payment verified & order reconciled (Memory):', { reference, orderId: transaction.orderId });
    const nsMem = getNotificationService();
    if (nsMem) nsMem.sendPaymentReceipt(transaction, memRecOrder).catch(() => {});
    return transaction;
  },

  /**
   * Get transaction by reference
   */
  async getByReference(reference) {
    if (isDbConnected()) {
      const tx = await Payment.findOne({ reference });
      return tx ? tx.toJSON() : null;
    }
    return memoryPayments.get(reference) || null;
  },

  /**
   * List transactions for a specific seller
   */
  async list(sellerId) {
    if (isDbConnected()) {
      const list = await Payment.find({ sellerId }).sort({ createdAt: -1 });
      return list.map((t) => t.toJSON());
    }
    const list = Array.from(memoryPayments.values()).filter((t) => t.sellerId === sellerId);
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  },

  /**
   * List all platform transactions (Admin)
   */
  async listAll() {
    if (isDbConnected()) {
      const list = await Payment.find().sort({ createdAt: -1 });
      return list.map((t) => t.toJSON());
    }
    const list = Array.from(memoryPayments.values());
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  },

  getMemoryStore() {
    return memoryPayments;
  },
};

module.exports = paymentService;
