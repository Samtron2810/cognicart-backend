/**
 * Payment Controller
 * Handles Paystack payment checkout, webhook verification, and automated order reconciliation
 */

const paymentService = require('../services/payments/paymentService');
const logger = require('../utils/logger');
// Order model is pre-registered by orderService (required via paymentService dependency chain).
// These refs are used in paymentCallback to detect Telegram source for redirect routing.
const mongoose = require('mongoose');
function getOrderModel() { return mongoose.model('Order'); }
function getPaymentModel() { return mongoose.model('Payment'); }

/**
 * @route   POST /api/payments/initialize
 * @desc    Initialize a Paystack checkout transaction
 * @access  Public / Private
 */
async function initializePayment(req, res, next) {
  try {
    const sellerId = req.sellerId || req.body.sellerId;
    const idempotencyKey = req.headers['x-idempotency-key'] || req.body.idempotencyKey;

    const result = await paymentService.initialize(
      {
        ...req.body,
        sellerId,
      },
      idempotencyKey
    );

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   POST /api/payments/verify/:reference or GET /api/payments/verify/:reference
 * @desc    Verify transaction and automatically reconcile order status
 * @access  Public / Private
 */
async function verifyPayment(req, res, next) {
  try {
    const { reference } = req.params;
    const transaction = await paymentService.verify(reference);
    res.status(200).json(transaction);
  } catch (error) {
    next(error);
  }
}

/**
 * Browser return target used by both storefront and Telegram hosted checkout.
 * Verification happens server-to-server before the buyer is redirected home.
 *
 * - Storefront orders  → /checkout?payment=...&reference=...
 * - Telegram orders    → /checkout/done?payment=...&reference=...
 *   (lighter page, no cart/header/footer — works cleanly in Telegram mini browser)
 *
 * The reference is always forwarded so the frontend can call
 * GET /api/payments/verify/:reference as a safety net (idempotent).
 */
async function paymentCallback(req, res) {
  const reference = String(req.query.reference || req.query.trxref || '').trim();
  const client = String(process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');

  // Determine redirect path by order source before verifying.
  // Default to storefront path; switch to /checkout/done for Telegram.
  let returnPath = '/checkout';
  if (reference) {
    try {
      const payment = await getPaymentModel().findOne({ reference }).select('orderId').lean();
      if (payment) {
        const order = await getOrderModel().findById(payment.orderId).select('source').lean();
        if (order && order.source === 'telegram') returnPath = '/checkout/done';
      }
    } catch {
      // Non-critical: fall back to /checkout if lookup fails
    }
  }

  const target = new URL(returnPath, client);

  // Always include reference — frontend uses it for client-side safety-net verify.
  if (reference) target.searchParams.set('reference', reference);

  try {
    if (!reference) throw new Error('Payment reference is missing');
    const transaction = await paymentService.verify(reference);
    if (transaction.refundStatus === 'processed') target.searchParams.set('payment', 'refunded');
    else if (transaction.refundStatus === 'pending') target.searchParams.set('payment', 'refund_pending');
    else target.searchParams.set('payment', 'success');
  } catch (error) {
    logger.warn('Paystack callback verification failed:', { reference, error: error.message });
    target.searchParams.set('payment', 'failed');
  }
  return res.redirect(303, target.toString());
}

/**
 * @route   GET /api/payments/:reference
 * @desc    Retrieve transaction by reference
 * @access  Public / Private
 */
async function getPaymentByReference(req, res, next) {
  try {
    const transaction = await paymentService.getByReference(req.params.reference);
    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }
    res.status(200).json(transaction);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   GET /api/payments
 * @desc    List payment transactions for authenticated seller
 * @access  Private
 */
async function listTransactions(req, res, next) {
  try {
    const transactions = await paymentService.list(req.sellerId);
    res.status(200).json(transactions);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   POST /api/payments/webhook or POST /api/webhooks/paystack
 * @desc    Paystack Webhook listener for charge.success notifications
 * @access  Public (Signature protected)
 */
async function handlePaystackWebhook(req, res, next) {
  try {
    const event = req.body.event;
    const data = req.body.data;

    logger.info('Paystack webhook event received:', { event });

    await paymentService.processWebhook({ event, data });
    res.status(200).json({ success: true, message: 'WEBHOOK_PROCESSED' });
  } catch (error) {
    logger.error('Paystack webhook error:', { error: error.message });
    // A non-2xx response asks Paystack to retry instead of silently losing a
    // valid financial event during a transient database/provider failure.
    res.status(500).json({ success: false, message: 'Webhook processing failed' });
  }
}

module.exports = {
  initializePayment,
  verifyPayment,
  paymentCallback,
  getPaymentByReference,
  listTransactions,
  handlePaystackWebhook,
};
