/**
 * Campaign Service
 * Telegram broadcasts to customers who have initiated a seller's bot.
 */

const mongoose = require('mongoose');
const Campaign = require('../../models/Campaign');
const Customer = require('../../models/Customer');
const telegramService = require('../telegram/telegramService');
const orderService = require('../orders/orderService');
const businessService = require('../sellers/businessService');
const { sanitize } = require('../../utils/validators');
const logger = require('../../utils/logger');

function wait(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function segmentQuery(sellerId, segment) {
  const query = { sellerId, marketingOptOut: false };
  const now = new Date();
  if (segment === 'VIP') {
    query.$or = [{ totalOrders: { $gte: 2 } }, { totalSpent: { $gte: 30000 } }];
  }
  if (segment === 'INACTIVE') {
    query.$or = [
      { lastOrderAt: null },
      { lastOrderAt: { $lt: new Date(now.getTime() - 30 * 86400000) } },
    ];
  }
  if (segment === 'NEW') query.createdAt = { $gte: new Date(now.getTime() - 7 * 86400000) };
  return query;
}

function interpolateMessage(template, recipient, business) {
  const name = recipient.name || 'Valued Customer';
  const store = business.name || 'Our Store';
  return String(template || '')
    .replace(/{{name}}|{{customer_name}}/gi, name)
    .replace(/{{store}}|{{business_name}}/gi, store);
}

function telegramIdentity(customer) {
  return (customer.identities || []).find(
    (identity) => identity.channel === 'telegram' && identity.externalId
  );
}

async function resolveTelegramRecipients(sellerId, segment, customCustomerIds = []) {
  const query = segmentQuery(sellerId, segment);
  query.identities = { $elemMatch: { channel: 'telegram', externalId: { $ne: '' } } };
  if (segment === 'CUSTOM') {
    if (!customCustomerIds.length) return [];
    query._id = { $in: customCustomerIds };
  }

  const customers = await Customer.find(query);
  const unique = new Map();
  for (const customer of customers) {
    const identity = telegramIdentity(customer);
    if (!identity || unique.has(identity.externalId)) continue;
    unique.set(identity.externalId, {
      customerId: customer._id.toString(),
      channel: 'telegram',
      channelUserId: String(identity.externalId),
      handle: identity.handle || '',
      phone: customer.phone || '',
      name: customer.name || identity.displayName || '',
      status: 'pending',
    });
  }
  return [...unique.values()];
}

const campaignService = {
  async create(sellerId, payload = {}) {
    if (!sellerId) throw new Error('Seller ID is required');
    if (!String(payload.title || '').trim()) {
      const error = new Error('Campaign title is required');
      error.statusCode = 400;
      throw error;
    }
    if (!String(payload.message || '').trim()) {
      const error = new Error('Campaign message content is required');
      error.statusCode = 400;
      throw error;
    }
    const channel = String(payload.channel || 'telegram').toLowerCase();
    if (channel !== 'telegram') {
      const err = new Error('Campaign channel must be telegram');
      err.statusCode = 400;
      throw err;
    }

    const segment = String(payload.segment || 'ALL').toUpperCase();
    if (!['ALL', 'VIP', 'INACTIVE', 'NEW', 'CUSTOM'].includes(segment)) {
      const error = new Error('Invalid campaign segment');
      error.statusCode = 400;
      throw error;
    }
    const customIds = payload.customerIds || payload.customCustomerIds || [];
    const recipients = await resolveTelegramRecipients(sellerId, segment, customIds);

    const campaign = await Campaign.create({
      sellerId,
      title: sanitize(payload.title, 150),
      message: sanitize(payload.message, 2000),
      channel,
      segment,
      status: payload.scheduledAt ? 'scheduled' : 'draft',
      scheduledAt: payload.scheduledAt || null,
      recipients,
      stats: { totalRecipients: recipients.length, sentCount: 0, failedCount: 0 },
      metadata: payload.metadata || {},
    });
    return campaign.toJSON();
  },

  async list(sellerId, filters = {}) {
    const query = { sellerId };
    if (filters.status) query.status = filters.status;
    if (filters.segment) query.segment = filters.segment;
    if (filters.channel) query.channel = filters.channel;
    const campaigns = await Campaign.find(query).sort({ createdAt: -1 });
    return campaigns.map((campaign) => campaign.toJSON());
  },

  async getById(id, sellerId) {
    if (!id || !mongoose.isValidObjectId(id)) {
      const error = new Error('Campaign not found');
      error.statusCode = 404;
      throw error;
    }
    const campaign = await Campaign.findOne({ _id: id, sellerId });
    if (!campaign) {
      const error = new Error('Campaign not found');
      error.statusCode = 404;
      throw error;
    }
    return campaign.toJSON();
  },

  async getSegmentCustomers(sellerId, segment = 'ALL') {
    const query = segmentQuery(sellerId, String(segment).toUpperCase());
    query.identities = { $elemMatch: { channel: 'telegram', externalId: { $ne: '' } } };
    const customers = await Customer.find(query).sort({ createdAt: -1 });
    return customers.map((customer) => customer.toJSON());
  },

  async sendCampaign(sellerId, id) {
    await this.getById(id, sellerId);
    const campaign = await Campaign.findOne({ _id: id, sellerId });
    if (campaign.status === 'sending' || campaign.status === 'completed') {
      const error = new Error('Campaign has already been sent');
      error.statusCode = 409;
      throw error;
    }
    if (!campaign.recipients.length) {
      campaign.status = 'failed';
      await campaign.save();
      const error = new Error(
        campaign.channel === 'telegram'
          ? 'No eligible Telegram recipients have started this bot or all have opted out'
          : 'No eligible campaign recipients'
      );
      error.statusCode = 400;
      throw error;
    }

    campaign.status = 'sending';
    campaign.stats.sentCount = 0;
    campaign.stats.failedCount = 0;
    await campaign.save();

    const configuredDelay = process.env.TELEGRAM_BROADCAST_DELAY_MS;
    const delayMs = configuredDelay === undefined ? 40 : Math.max(Number(configuredDelay) || 0, 0);
    const business = (await businessService.getBySellerId(sellerId)) || {};

    for (const recipient of campaign.recipients) {
      try {
        const personalizedMessage = interpolateMessage(campaign.message, recipient, business);
        await telegramService.sendOutbound({
          sellerId,
          to: recipient.channelUserId,
          body: personalizedMessage,
          customerPhone: recipient.phone,
          channelUsername: recipient.handle,
          customerName: recipient.name,
          deterministic: true,
        });
        await wait(delayMs); // ~25 messages/sec by default, below Telegram's global limit.
        recipient.status = 'sent';
        recipient.sentAt = new Date();
        recipient.error = '';
        campaign.stats.sentCount += 1;
      } catch (error) {
        recipient.status = 'failed';
        recipient.error = sanitize(error.message, 300);
        campaign.stats.failedCount += 1;
        logger.warn('Campaign recipient delivery failed:', {
          campaignId: campaign.id,
          sellerId,
          channel: campaign.channel,
          recipient: recipient.channelUserId || recipient.phone,
          error: error.message,
        });
      }
      await campaign.save();
    }

    campaign.status = campaign.stats.sentCount > 0 ? 'completed' : 'failed';
    campaign.sentAt = new Date();
    await campaign.save();
    return campaign.toJSON();
  },

  async triggerAbandonedOrderReminders(sellerId, { ageMinutes = 0 } = {}) {
    if (!sellerId) throw new Error('Seller ID is required');
    const orders = await orderService.list(sellerId, {
      paymentStatus: 'Pending',
      status: 'Pending',
      source: 'telegram',
    });
    const business = (await businessService.getBySellerId(sellerId)) || {};
    const thresholdMs = Math.max(Number(ageMinutes) || 0, 0) * 60000;
    const reminders = [];

    for (const order of orders) {
      if (!order.channelUserId || Date.now() - new Date(order.createdAt).getTime() < thresholdMs) continue;
      const customer = await Customer.findOne({
        sellerId,
        identities: {
          $elemMatch: { channel: 'telegram', externalId: String(order.channelUserId) },
        },
      });
      if (!customer || customer.marketingOptOut) continue;

      const orderUrl = `${String(process.env.CLIENT_URL || '').replace(/\/$/, '')}/orders/${order.id}`;
      const body = [
        'Incomplete order reminder',
        `Hello ${order.customerName || 'there'}, your order with ${business.name || 'our store'} is still awaiting payment.`,
        `Reference: ${order.reference || order.id}`,
        `Amount: ₦${Number(order.total || 0).toLocaleString('en-NG')}`,
        orderUrl.startsWith('http') ? `Continue securely: ${orderUrl}` : '',
        'Reply here if you need help.',
      ].filter(Boolean).join('\n');

      try {
        await telegramService.sendOutbound({
          sellerId,
          to: order.channelUserId,
          body,
          customerPhone: order.customerPhone,
          channelUsername: order.channelUsername,
          customerName: order.customerName,
          deterministic: true,
        });
        reminders.push({ orderId: order.id, channelUserId: order.channelUserId, sentAt: new Date().toISOString() });
      } catch (error) {
        logger.warn('Telegram abandoned-order reminder failed:', {
          sellerId,
          orderId: order.id,
          error: error.message,
        });
      }
    }

    return { success: true, remindersSentCount: reminders.length, reminders };
  },

  resolveTelegramRecipients,
};

module.exports = campaignService;
