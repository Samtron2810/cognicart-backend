/**
 * WhatsApp Marketing Campaigns and Customer Re-engagement Controller
 * Handles marketing campaigns, audience segments, broadcasts, and automated recovery
 */

const campaignService = require('../services/campaigns/campaignService');

const campaignController = {
  /**
   * @route   POST /api/campaigns
   * @desc    Create a new marketing broadcast campaign
   * @access  Private (Seller)
   */
  async createCampaign(req, res, next) {
    try {
      const campaign = await campaignService.create(req.sellerId, req.body);
      res.status(201).json(campaign);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/campaigns
   * @desc    List all campaigns for authenticated seller
   * @access  Private (Seller)
   */
  async listCampaigns(req, res, next) {
    try {
      const campaigns = await campaignService.list(req.sellerId);
      res.status(200).json(campaigns);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/campaigns/:id
   * @desc    Get detailed campaign statistics and recipient logs
   * @access  Private (Seller)
   */
  async getCampaign(req, res, next) {
    try {
      const campaign = await campaignService.getById(req.params.id, req.sellerId);
      res.status(200).json(campaign);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   POST /api/campaigns/:id/send
   * @desc    Broadcast campaign to target customer segment via WhatsApp
   * @access  Private (Seller)
   */
  async sendCampaign(req, res, next) {
    try {
      const result = await campaignService.sendCampaign(req.sellerId, req.params.id);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   GET /api/campaigns/segments/:segment/preview
   * @desc    Preview audience count and list for a segment (ALL, VIP, INACTIVE, NEW)
   * @access  Private (Seller)
   */
  async getSegmentPreview(req, res, next) {
    try {
      const { segment } = req.params;
      const customers = await campaignService.getSegmentCustomers(req.sellerId, segment);
      res.status(200).json({
        segment: segment.toUpperCase(),
        totalAudience: customers.length,
        customers: customers.map((c) => ({
          id: c.id,
          name: c.name,
          phone: c.phone,
          totalOrders: c.totalOrders,
          totalSpent: c.totalSpent,
          lastOrderAt: c.lastOrderAt,
        })),
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * @route   POST /api/campaigns/abandoned-orders/trigger
   * @desc    Trigger automated reminders to customers with unpaid/incomplete orders
   * @access  Private (Seller)
   */
  async triggerAbandonedReminders(req, res, next) {
    try {
      const ageMinutes = req.body.ageMinutes !== undefined ? Number(req.body.ageMinutes) : 0;
      const result = await campaignService.triggerAbandonedOrderReminders(req.sellerId, { ageMinutes });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },
};

module.exports = campaignController;
