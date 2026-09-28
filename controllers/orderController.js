/**
 * Order Controller
 * Handles order checkout, idempotency verification, listing, and fulfillment status updates
 */

const orderService = require('../services/orders/orderService');
const manualOrderService = require('../services/orders/manualOrderService');
const businessService = require('../services/sellers/businessService');
const { buildOrderShare } = require('../utils/orderShare');

/**
 * @route   GET /api/orders
 * @desc    List orders for authenticated seller
 * @access  Private
 */
async function getOrders(req, res, next) {
  try {
    const { status, paymentStatus, source, sourceChannel, search, from, to } = req.query;
    const orders = await orderService.list(req.sellerId, {
      status,
      paymentStatus,
      source,
      sourceChannel,
      search,
      from,
      to,
    });
    res.status(200).json(orders);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   GET /api/orders/:id
 * @desc    Get order details by ID
 * @access  Private
 */
async function getOrderById(req, res, next) {
  try {
    const order = await orderService.getById(req.params.id, req.sellerId);
    res.status(200).json(order);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   POST /api/orders
 * @desc    Create a new order (with idempotency support)
 * @access  Public / Private
 */
async function createOrder(req, res, next) {
  try {
    // If authenticated, use req.sellerId; otherwise allow payload.sellerId for public storefront checkout.
    const sellerId = req.sellerId || req.body.sellerId;
    const idempotencyKey = req.headers['x-idempotency-key'] || req.body.idempotencyKey;

    // A client can never assert who the buyer is: shopperId comes from the
    // verified session only, and a verified buyer's phone overrides the payload
    // so orders cannot be stapled onto someone else's history.
    const payload = { ...req.body };
    delete payload.shopperId;

    if (req.shopper) {
      payload.shopperId = req.shopperId;
      payload.customer = { ...(payload.customer || {}), phone: req.shopper.phone };
      if (!payload.customer.name) payload.customer.name = req.shopper.name || 'Valued Customer';
      if (req.shopper.email) payload.customer.email = req.shopper.email;
    }

    const order = await orderService.create(sellerId, payload, idempotencyKey);
    res.status(201).json(order);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   PATCH /api/orders/:id or PATCH /api/orders/:id/status
 * @desc    Update order status
 * @access  Private
 */
async function updateOrderStatus(req, res, next) {
  try {
    const { orderStatus, status } = req.body;
    const targetStatus = orderStatus || status;

    if (!targetStatus) {
      return res.status(400).json({ success: false, message: 'orderStatus is required' });
    }

    const order = await orderService.updateStatus(req.params.id, req.sellerId, targetStatus);
    res.status(200).json(order);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   POST /api/orders/manual
 * @desc    Log an order taken by the seller on any external channel
 * @access  Private seller
 */
async function createManualOrder(req, res, next) {
  try {
    const enteredBy = req.user && (req.user.id || req.user._id);
    const order = await manualOrderService.create(req.sellerId, enteredBy, req.body);
    res.status(201).json(order);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   PATCH /api/orders/manual/:id
 * @desc    Correct seller-entered customer, item, delivery, or source details
 * @access  Private seller; automatic orders deliberately return 404
 */
async function updateManualOrder(req, res, next) {
  try {
    const order = await manualOrderService.update(req.params.id, req.sellerId, req.body);
    res.status(200).json(order);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   PATCH /api/orders/manual/:id/payment
 * @desc    Record cash/bank/POS payment for a manually entered order
 * @access  Private seller; cannot alter automatic order payment state
 */
async function updateManualOrderPayment(req, res, next) {
  try {
    const order = await manualOrderService.updatePayment(req.params.id, req.sellerId, req.body);
    res.status(200).json(order);
  } catch (error) {
    next(error);
  }
}

/** Seller order dashboard totals, grouped by source/status/payment. */
async function getOrderSummary(req, res, next) {
  try {
    const summary = await orderService.getSummary(req.sellerId, {
      from: req.query.from,
      to: req.query.to,
    });
    res.status(200).json(summary);
  } catch (error) {
    next(error);
  }
}

/**
 * Generate copyable text and an Ordaflow-style pre-filled wa.me link. This is
 * ordinary client-side sharing: no Meta API, token, webhook, or background send.
 */
async function getOrderShare(req, res, next) {
  try {
    const order = await orderService.getById(req.params.id, req.sellerId);
    const business = await businessService.getBySellerId(req.sellerId);
    const allowedVariants = ['confirmation', 'dispatch', 'payment_reminder'];
    const variant = allowedVariants.includes(req.query.variant) ? req.query.variant : 'confirmation';
    res.status(200).json(buildOrderShare(order, business || {}, variant));
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getOrders,
  getOrderById,
  createOrder,
  updateOrderStatus,
  createManualOrder,
  updateManualOrder,
  updateManualOrderPayment,
  getOrderSummary,
  getOrderShare,
};
