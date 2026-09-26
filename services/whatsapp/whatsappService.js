/**
 * WhatsApp Business Cloud API Integration Service
 * Manages seller WhatsApp onboarding, outbound messaging, webhook processing, and message threads
 */

const businessService = require('../sellers/businessService');
const customerService = require('../customers/customerService');
const webhookService = require('./webhookService');
const messageService = require('./messageService');
const aiService = require('../ai/aiService');
const Business = require('../../models/Business');
const { isDbConnected } = require('../../config/db');
const { sanitize, normalizePhone } = require('../../utils/validators');
const logger = require('../../utils/logger');

const memoryConfigs = new Map();

const whatsappService = {
  /**
   * Get WhatsApp configuration for seller
   */
  async getConfig(sellerId) {
    if (!sellerId) throw new Error('Seller ID is required');

    const business = await businessService.getBySellerId(sellerId);
    const memCfg = memoryConfigs.get(sellerId) || {};

    return {
      sellerId,
      businessPhone: (business && business.whatsappPhone) || memCfg.businessPhone || '',
      phoneNumberId: memCfg.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || 'pnid_' + sellerId.slice(-6),
      verifyToken: memCfg.verifyToken || process.env.WHATSAPP_VERIFY_TOKEN || 'verify_' + sellerId.slice(-6),
      accessToken: memCfg.accessToken ? '***configured***' : (process.env.WHATSAPP_ACCESS_TOKEN ? '***configured***' : ''),
      webhookUrl: `${process.env.CLIENT_URL || 'http://localhost:5000'}/api/whatsapp/webhook`,
      webhookVerified: !!memCfg.webhookVerified,
      connectedAt: (business && business.whatsappVerifiedAt) || memCfg.connectedAt || null,
      whatsappConnected: !!(business && business.whatsappConnected),
    };
  },

  /**
   * Connect seller WhatsApp Business Account
   */
  async connect(sellerId, payload) {
    const rawPhone = payload.businessPhone || payload.phone;
    if (!rawPhone) {
      const err = new Error('Business phone number is required');
      err.statusCode = 400;
      throw err;
    }

    const cleanPhone = normalizePhone(rawPhone) || rawPhone.trim();
    const now = new Date().toISOString();

    const config = {
      sellerId,
      businessPhone: cleanPhone,
      phoneNumberId: payload.phoneNumberId || 'pnid_' + sellerId.slice(-6),
      verifyToken: payload.verifyToken || 'verify_' + sellerId.slice(-6),
      accessToken: payload.accessToken || '',
      connectedAt: now,
      webhookVerified: true,
      updatedAt: now,
    };
    memoryConfigs.set(sellerId, config);

    // Update business profile
    await businessService.update(sellerId, {
      whatsappPhone: cleanPhone,
      whatsappConnected: true,
      whatsappVerifiedAt: now,
    });

    logger.info('WhatsApp connected for seller:', { sellerId, businessPhone: cleanPhone });
    return this.getConfig(sellerId);
  },

  /**
   * Disconnect seller WhatsApp Business Account
   */
  async disconnect(sellerId) {
    memoryConfigs.delete(sellerId);
    await businessService.update(sellerId, {
      whatsappConnected: false,
      whatsappVerifiedAt: null,
    });
    logger.info('WhatsApp disconnected for seller:', { sellerId });
    return { success: true, message: 'WhatsApp disconnected' };
  },

  /**
   * Send outbound message via WhatsApp Cloud API
   */
  async sendOutbound({ sellerId, to, body, businessPhone = '' }) {
    if (!to || !body) {
      const err = new Error('Recipient number ("to") and message "body" are required');
      err.statusCode = 400;
      throw err;
    }

    const cleanTo = normalizePhone(to) || to.trim();
    const cleanBody = sanitize(body, 4000);

    const memCfg = memoryConfigs.get(sellerId) || {};
    const phoneNumberId = memCfg.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken = memCfg.accessToken || process.env.WHATSAPP_ACCESS_TOKEN;

    // If live credentials exist, send via Meta Graph API
    if (phoneNumberId && accessToken) {
      try {
        const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanTo.replace('+', ''),
            type: 'text',
            text: { preview_url: false, body: cleanBody },
          }),
        });

        if (!res.ok) {
          const errData = await res.json();
          logger.warn('Meta WhatsApp API call failed:', errData);
        }
      } catch (err) {
        logger.error('WhatsApp API network error:', { error: err.message });
      }
    }

    // Record outbound message in transcript
    const msg = await messageService.saveMessage({
      sellerId,
      businessPhone: businessPhone || memCfg.businessPhone || '',
      customerPhone: cleanTo,
      direction: 'outbound',
      body: cleanBody,
      deterministic: false,
      status: 'sent',
    });

    return msg;
  },

  /**
   * Process incoming customer WhatsApp message
   */
  async handleIncoming(payload) {
    const parsed = webhookService.parseIncomingPayload(payload);
    if (!parsed) {
      const err = new Error('Invalid incoming WhatsApp message format');
      err.statusCode = 400;
      throw err;
    }

    const customerPhone = normalizePhone(parsed.from) || parsed.from.trim();
    const body = sanitize(parsed.body, 4000);
    const businessPhone = parsed.businessPhone ? normalizePhone(parsed.businessPhone) : '';

    // Identify target seller by business phone
    let sellerId = payload.sellerId;

    if (!sellerId && businessPhone) {
      if (isDbConnected()) {
        const biz = await Business.findOne({ whatsappPhone: businessPhone });
        if (biz) sellerId = biz.sellerId;
      } else {
        for (const [sId, cfg] of memoryConfigs.entries()) {
          if (cfg.businessPhone === businessPhone) {
            sellerId = sId;
            break;
          }
        }
      }
    }

    // Default fallback to first active seller if unassigned (sandbox / single tenant mode)
    if (!sellerId) {
      sellerId = 'seller_admin';
    }

    // 1. Record inbound message
    const inbound = await messageService.saveMessage({
      sellerId,
      businessPhone,
      customerPhone,
      direction: 'inbound',
      body,
      status: 'received',
    });

    // 2. Generate authoritative reply (AI agent with fallback to deterministic engine)
    let replyText = '';
    let toolCalls = null;
    let isDeterministic = false;

    const cleanLower = body.trim().toLowerCase();
    if (['stop', 'unsubscribe', 'optout', 'opt-out', 'cancel'].includes(cleanLower)) {
      await customerService.setOptOut(customerPhone, sellerId, true);
      const biz = await businessService.getBySellerId(sellerId);
      const store = (biz && biz.name) || 'Our Store';
      replyText = `You have been successfully unsubscribed from marketing messages from ${store}. You will still receive essential order updates. Text START anytime to re-subscribe.`;
      isDeterministic = true;
    } else if (['start', 'subscribe', 'unstop'].includes(cleanLower)) {
      await customerService.setOptOut(customerPhone, sellerId, false);
      const biz = await businessService.getBySellerId(sellerId);
      const store = (biz && biz.name) || 'Our Store';
      replyText = `Welcome back! You have been re-subscribed to marketing updates from ${store}.`;
      isDeterministic = true;
    } else {
      try {
        const aiRes = await aiService.chat({
          sellerId,
          customerPhone,
          body,
        });
        replyText = aiRes.reply;
        toolCalls = aiRes.toolCalls;
      } catch (err) {
        replyText = await webhookService.deterministicReply(sellerId, body);
        isDeterministic = true;
      }
    }

    // 3. Record outbound response
    const outbound = await messageService.saveMessage({
      sellerId,
      businessPhone,
      customerPhone,
      direction: 'outbound',
      body: replyText,
      deterministic: isDeterministic,
      toolCalls,
      status: 'sent',
    });

    logger.info('WhatsApp conversation exchange processed:', {
      sellerId,
      customerPhone,
      inboundLength: body.length,
      replyLength: replyText.length,
    });

    return {
      inbound,
      outbound,
      toolCalls,
    };
  },

  listMessages(sellerId, filters) {
    return messageService.listMessages(sellerId, filters);
  },

  getConversations(sellerId) {
    return messageService.getConversations(sellerId);
  },
};

module.exports = whatsappService;
