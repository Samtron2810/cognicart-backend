/**
 * Multi-Seller Order Group Controller
 * Checkout for a basket spanning several stores, and its single payment.
 */

const orderGroupService = require('../services/orders/orderGroupService');
const groupPaymentService = require('../services/payments/groupPaymentService');

const orderGroupController = {
  /**
   * @route   POST /api/orders/group
   * @desc    Create one parent order plus a sub-order per seller
   * @access  Public (guest checkout) / optional buyer session
   */
  async create(req, res, next) {
    try {
      const group = await orderGroupService.create(req.body, {
        shopperId: req.shopperId || null,
        idempotencyKey: req.headers['x-idempotency-key'] || req.body.idempotencyKey,
      });
      res.status(201).json(group);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   POST /api/orders/group/:id/pay
   * @desc    Start one Paystack transaction covering the whole group
   * @access  Public
   */
  async initializePayment(req, res, next) {
    try {
      const result = await groupPaymentService.initialize(req.params.id, { email: req.body.email });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/orders/group/:id
   * @desc    Buyer's view of their own group, with every sub-order
   * @access  Public with ownership proof (buyer session or matching email)
   */
  async getForBuyer(req, res, next) {
    try {
      const group = await orderGroupService.getForBuyer(req.params.id, {
        shopperId: req.shopperId || null,
        email: req.query.email,
      });
      res.status(200).json(group);
    } catch (error) {
      next(error);
    }
  },
};

module.exports = orderGroupController;
