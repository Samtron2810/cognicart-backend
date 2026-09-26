/**
 * WhatsApp Marketing Campaigns and Customer Re-engagement Service
 * Powers audience segmentation, template variable interpolation, bulk broadcast dispatch, and abandoned order recovery
 */

const Campaign = require('../../models/Campaign');
const Order = require('../../models/Order');
const { isDbConnected } = require('../../config/db');
const customerService = require('../customers/customerService');
const orderService = require('../orders/orderService');
const businessService = require('../sellers/businessService');
const logger = require('../../utils/logger');

// In-Memory store for campaigns when MongoDB is offline
const memoryCampaigns = new Map();

function getWhatsAppService() {
  return require('../whatsapp/whatsappService');
}

function interpolateMessage(template, customer, business) {
  let msg = template || '';
  const customerName = (customer && customer.name) || 'Valued Customer';
  const businessName = (business && business.name) || 'Our Store';

  msg = msg.replace(/{{name}}/gi, customerName);
  msg = msg.replace(/{{customer_name}}/gi, customerName);
  msg = msg.replace(/{{store}}/gi, businessName);
  msg = msg.replace(/{{business_name}}/gi, businessName);

  return msg;
}

const campaignService = {
  /**
   * Filter and aggregate customers by segmentation criteria
   */
  async getSegmentCustomers(sellerId, segment = 'ALL') {
    if (!sellerId) throw new Error('Seller ID is required');

    const allCustomers = await customerService.list(sellerId);
    // Strict compliance: Filter out customers who opted out of marketing
    const optedIn = allCustomers.filter((c) => !c.marketingOptOut);

    const now = Date.now();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

    switch (segment.toUpperCase()) {
      case 'VIP':
        return optedIn.filter((c) => (c.totalOrders || 0) >= 2 || (c.totalSpent || 0) >= 30000);

      case 'INACTIVE':
        return optedIn.filter((c) => {
          if (!c.lastOrderAt) return true;
          const orderAge = now - new Date(c.lastOrderAt).getTime();
          return orderAge >= THIRTY_DAYS_MS;
        });

      case 'NEW':
        return optedIn.filter((c) => {
          const createdTime = new Date(c.createdAt || c.lastOrderAt || now).getTime();
          return now - createdTime <= SEVEN_DAYS_MS;
        });

      case 'ALL':
      default:
        return optedIn;
    }
  },

  /**
   * Create a new marketing broadcast campaign
   */
  async create(sellerId, payload) {
    if (!sellerId) throw new Error('Seller ID is required');

    if (!payload.title || !payload.title.trim()) {
      const err = new Error('Campaign title is required');
      err.statusCode = 400;
      throw err;
    }

    if (!payload.message || !payload.message.trim()) {
      const err = new Error('Campaign message content is required');
      err.statusCode = 400;
      throw err;
    }

    const segment = (payload.segment || 'ALL').toUpperCase();
    const targetCustomers = await this.getSegmentCustomers(sellerId, segment);

    const campaignData = {
      sellerId,
      title: payload.title.trim(),
      message: payload.message.trim(),
      segment,
      status: 'draft',
      stats: {
        totalRecipients: targetCustomers.length,
        sentCount: 0,
        failedCount: 0,
      },
      recipients: targetCustomers.map((c) => ({
        customerId: c.id,
        phone: c.phone,
        name: c.name,
        status: 'pending',
      })),
      metadata: payload.metadata || {},
    };

    if (isDbConnected()) {
      const campaign = await Campaign.create(campaignData);
      logger.info('Campaign created (DB):', { id: campaign._id.toString(), sellerId, segment });
      return campaign.toJSON();
    }

    const id = 'cmp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const now = new Date().toISOString();
    const memCampaign = {
      id,
      _id: id,
      ...campaignData,
      createdAt: now,
      updatedAt: now,
    };
    memoryCampaigns.set(id, memCampaign);
    logger.info('Campaign created (Memory):', { id, sellerId, segment });
    return memCampaign;
  },

  /**
   * List campaigns for a seller
   */
  async list(sellerId) {
    if (!sellerId) throw new Error('Seller ID is required');

    if (isDbConnected()) {
      const campaigns = await Campaign.find({ sellerId }).sort({ createdAt: -1 });
      return campaigns.map((c) => c.toJSON());
    }

    const list = Array.from(memoryCampaigns.values()).filter((c) => c.sellerId === sellerId);
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  },

  /**
   * Get single campaign by ID
   */
  async getById(id, sellerId) {
    if (isDbConnected()) {
      const campaign = await Campaign.findOne({ _id: id, sellerId });
      if (!campaign) {
        const err = new Error('Campaign not found');
        err.statusCode = 404;
        throw err;
      }
      return campaign.toJSON();
    }

    const campaign = memoryCampaigns.get(id);
    if (!campaign || campaign.sellerId !== sellerId) {
      const err = new Error('Campaign not found');
      err.statusCode = 404;
      throw err;
    }
    return campaign;
  },

  /**
   * Execute and broadcast marketing campaign to target segment
   */
  async sendCampaign(sellerId, campaignId) {
    const campaign = await this.getById(campaignId, sellerId);
    const business = await businessService.getBySellerId(sellerId);
    const targetCustomers = await this.getSegmentCustomers(sellerId, campaign.segment);

    const whatsappService = getWhatsAppService();
    let sentCount = 0;
    let failedCount = 0;
    const now = new Date();

    const updatedRecipients = [];

    for (const customer of targetCustomers) {
      const personalizedBody = interpolateMessage(campaign.message, customer, business);
      try {
        await whatsappService.sendOutbound({
          sellerId,
          to: customer.phone,
          body: personalizedBody,
        });

        sentCount++;
        updatedRecipients.push({
          customerId: customer.id,
          phone: customer.phone,
          name: customer.name,
          status: 'sent',
          sentAt: now,
        });
      } catch (err) {
        failedCount++;
        updatedRecipients.push({
          customerId: customer.id,
          phone: customer.phone,
          name: customer.name,
          status: 'failed',
          error: err.message,
        });
      }
    }

    const finalStatus = sentCount > 0 ? 'completed' : 'failed';
    const stats = {
      totalRecipients: targetCustomers.length,
      sentCount,
      failedCount,
    };

    if (isDbConnected()) {
      const updated = await Campaign.findByIdAndUpdate(
        campaignId,
        {
          $set: {
            status: finalStatus,
            sentAt: now,
            stats,
            recipients: updatedRecipients,
          },
        },
        { new: true }
      );
      logger.info('Campaign sent (DB):', { campaignId, sentCount, failedCount });
      return updated.toJSON();
    }

    campaign.status = finalStatus;
    campaign.sentAt = now.toISOString();
    campaign.stats = stats;
    campaign.recipients = updatedRecipients;
    campaign.updatedAt = now.toISOString();

    memoryCampaigns.set(campaignId, campaign);
    logger.info('Campaign sent (Memory):', { campaignId, sentCount, failedCount });
    return campaign;
  },

  /**
   * Automated Abandoned Order Recovery Engine
   * Finds unpaid pending orders and sends automated payment reminders with direct checkout links
   */
  async triggerAbandonedOrderReminders(sellerId, { ageMinutes = 0 } = {}) {
    if (!sellerId) throw new Error('Seller ID is required');

    const orders = await orderService.list(sellerId, { paymentStatus: 'Pending', status: 'Pending' });
    const business = await businessService.getBySellerId(sellerId);
    const storeName = (business && business.name) || 'Our Store';
    const whatsappService = getWhatsAppService();

    const now = Date.now();
    const thresholdMs = Number(ageMinutes) * 60 * 1000;
    const remindersSent = [];

    for (const order of orders) {
      const orderTime = new Date(order.createdAt).getTime();
      if (now - orderTime < thresholdMs) continue;

      // Check if customer opted out
      const customer = await customerService.findByPhone(order.customerPhone, sellerId);
      if (customer && customer.marketingOptOut) continue;

      const checkoutUrl = `${process.env.CLIENT_URL || 'https://checkout.paystack.com'}/pay?orderId=${order.id}`;

      const messageBody = [
        `⏰ *Incomplete Order Reminder*`,
        `Hello ${order.customerName || 'there'}, we noticed you left some items in your cart at *${storeName}*!`,
        ``,
        `*Order Reference:* #${order.id}`,
        `*Amount:* ₦${(order.total || 0).toLocaleString()}`,
        ``,
        `Your items are reserved for a limited time. You can complete your order securely here:`,
        `${checkoutUrl}`,
        ``,
        `If you need any assistance, reply directly to this message!`,
      ].join('\n');

      try {
        await whatsappService.sendOutbound({
          sellerId,
          to: order.customerPhone,
          body: messageBody,
        });

        remindersSent.push({
          orderId: order.id,
          customerPhone: order.customerPhone,
          amount: order.total,
          sentAt: new Date().toISOString(),
        });
      } catch (err) {
        logger.warn('Failed to send abandoned order reminder:', { orderId: order.id, error: err.message });
      }
    }

    logger.info('Abandoned order reminders triggered:', { sellerId, count: remindersSent.length });
    return {
      success: true,
      remindersSentCount: remindersSent.length,
      reminders: remindersSent,
    };
  },

  getMemoryStore() {
    return memoryCampaigns;
  },
};

module.exports = campaignService;
