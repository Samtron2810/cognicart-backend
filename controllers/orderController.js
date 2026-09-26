/**
 * Order Controller
 * Handles order checkout, idempotency verification, listing, and fulfillment status updates
 */

const orderService = require('../services/orders/orderService');

/**
 * @route   GET /api/orders
 * @desc    List orders for authenticated seller
 * @access  Private
 */
async function getOrders(req, res, next) {
  try {
    const { status, paymentStatus, search } = req.query;
    const orders = await orderService.list(req.sellerId, { status, paymentStatus, search });
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
    // If authenticated, use req.sellerId; otherwise allow payload.sellerId (e.g. from public checkout / WhatsApp)
    const sellerId = req.sellerId || req.body.sellerId;
    const idempotencyKey = req.headers['x-idempotency-key'] || req.body.idempotencyKey;

    const order = await orderService.create(sellerId, req.body, idempotencyKey);
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

module.exports = {
  getOrders,
  getOrderById,
  createOrder,
  updateOrderStatus,
};
