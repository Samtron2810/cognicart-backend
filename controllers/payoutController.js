/**
 * Seller Payouts and Settlements Controller
 * Handles bank account verification, withdrawal requests, and balance inquiry
 */

const payoutService = require('../services/payouts/payoutService');

const payoutController = {
  /**
   * @route   GET /api/payouts/balance
   * @desc    Get seller's current available settlement balance and withdrawal history totals
   * @access  Private (Seller)
   */
  async getBalance(req, res, next) {
    try {
      const balance = await payoutService.getBalance(req.sellerId);
      res.status(200).json(balance);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   POST /api/payouts/resolve-account
   * @desc    Verify bank account number against bank code
   * @access  Private (Seller)
   */
  async resolveAccount(req, res, next) {
    try {
      const { accountNumber, bankCode } = req.body;
      const result = await payoutService.resolveAccount({ accountNumber, bankCode });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   POST /api/payouts/request
   * @desc    Request withdrawal of available funds to bank account
   * @access  Private (Seller)
   */
  async requestPayout(req, res, next) {
    try {
      const payout = await payoutService.requestPayout(req.sellerId, req.body);
      res.status(201).json(payout);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/payouts
   * @desc    List payout history for authenticated seller
   * @access  Private (Seller)
   */
  async listPayouts(req, res, next) {
    try {
      const payouts = await payoutService.listBySeller(req.sellerId);
      res.status(200).json(payouts);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/admin/payouts
   * @desc    List all platform payout requests across all sellers
   * @access  Private (Admin)
   */
  async adminListPayouts(req, res, next) {
    try {
      const payouts = await payoutService.listAll();
      res.status(200).json(payouts);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   PATCH /api/admin/payouts/:id/process
   * @desc    Approve or reject a seller payout request
   * @access  Private (Admin)
   */
  async adminProcessPayout(req, res, next) {
    try {
      const { id } = req.params;
      const { status, rejectionReason } = req.body;
      const updated = await payoutService.processPayout(id, { status, rejectionReason });
      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  },
};

module.exports = payoutController;
