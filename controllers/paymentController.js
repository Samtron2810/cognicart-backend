/**
 * Payment Controller
 * Handles Paystack payment checkout, webhook verification, and automated order reconciliation
 */

const paymentService = require('../services/payments/paymentService');
const logger = require('../utils/logger');

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
    const signature = req.headers['x-paystack-signature'] || 'mock';

    const transaction = await paymentService.verify(reference, signature);
    res.status(200).json(transaction);
  } catch (error) {
    next(error);
  }
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

    if (event === 'charge.success' && data && data.reference) {
      await paymentService.verify(data.reference, 'webhook');
    }

    res.status(200).json({ success: true, message: 'WEBHOOK_PROCESSED' });
  } catch (error) {
    logger.error('Paystack webhook error:', { error: error.message });
    res.status(200).json({ success: false, message: error.message });
  }
}

module.exports = {
  initializePayment,
  verifyPayment,
  getPaymentByReference,
  listTransactions,
  handlePaystackWebhook,
};
