/**
 * Telegram Commerce Adapter
 *
 * Owns bot onboarding, webhook/polling update handling, contact linking,
 * channel transcripts, and the handoff into the existing AI commerce engine.
 */

const crypto = require('crypto');
const Business = require('../../models/Business');
const businessService = require('../sellers/businessService');
const customerService = require('../customers/customerService');
const messageService = require('../messaging/messageService');
const aiService = require('../ai/aiService');
const telegramApi = require('./telegramApi');
const { sanitize } = require('../../utils/validators');
const logger = require('../../utils/logger');

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function contactKeyboard() {
  return {
    keyboard: [[{ text: 'Share phone number', request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
    input_field_placeholder: 'Share your number to place an order',
  };
}

function removeKeyboard() {
  return { remove_keyboard: true };
}

function displayName(from = {}) {
  return sanitize([from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Telegram customer', 100);
}

function isOwnedContact(contact, senderId) {
  return !!contact && String(contact.user_id || '') === String(senderId || '');
}

function parseUpdate(update = {}) {
  if (update.callback_query) {
    const callback = update.callback_query;
    const message = callback.message || {};
    return {
      updateId: update.update_id,
      providerMessageId: `callback:${callback.id}`,
      callbackQueryId: callback.id,
      from: callback.from || {},
      chat: message.chat || { id: callback.from && callback.from.id, type: 'private' },
      body: callback.data || '',
      contact: null,
      timestamp: new Date(),
    };
  }

  const message = update.message || update.edited_message;
  if (!message || !message.from || !message.chat) return null;
  return {
    updateId: update.update_id,
    providerMessageId: String(message.message_id),
    from: message.from,
    chat: message.chat,
    body: message.text || message.caption || (message.contact ? '[Phone number shared]' : ''),
    contact: message.contact || null,
    timestamp: message.date ? new Date(Number(message.date) * 1000) : new Date(),
  };
}

function webhookUrl(botId, explicit = '') {
  const configured = String(explicit || process.env.API_PUBLIC_URL || '').replace(/\/$/, '');
  if (!configured) return '';
  if (configured.includes('/webhooks/telegram/')) return configured;
  return `${configured}/webhooks/telegram/${botId}`;
}

function validateWebhookUrl(url) {
  if (!url) throw httpError('Set API_PUBLIC_URL for Telegram webhook mode');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw httpError('Telegram webhook URL is invalid');
  }
  const localDev = ['localhost', '127.0.0.1'].includes(parsed.hostname) && process.env.NODE_ENV !== 'production';
  if (parsed.protocol !== 'https:' && !localDev) {
    throw httpError('Telegram webhooks require an HTTPS URL');
  }
}

async function getBusinessWithTelegram(sellerId) {
  const business = await businessService.getWithSecrets(sellerId);
  if (!business || !business.telegramConnected || !business.telegramBotToken) {
    throw httpError('Telegram bot is not connected', 409);
  }
  return business;
}

const telegramService = {
  parseUpdate,
  isOwnedContact,
  contactKeyboard,

  async getConfig(sellerId) {
    const business = await businessService.requireBySellerId(sellerId);
    const secrets = await businessService.getWithSecrets(sellerId);
    const connected = !!(business.telegramConnected && secrets && secrets.telegramBotToken);
    const url = business.telegramWebhookUrl || (business.telegramBotId ? webhookUrl(business.telegramBotId) : '');
    return {
      sellerId,
      connected,
      botId: business.telegramBotId || '',
      botUsername: business.telegramBotUsername || '',
      botUrl: business.telegramBotUsername ? `https://t.me/${business.telegramBotUsername}` : '',
      token: connected ? '***configured***' : '',
      webhookSecret: connected && secrets.telegramWebhookSecret ? '***configured***' : '',
      webhookUrl: url,
      webhookVerified: !!business.telegramWebhookVerified,
      mode: business.telegramWebhookVerified ? 'webhook' : connected ? 'polling' : 'disconnected',
      connectedAt: business.telegramConnectedAt || null,
    };
  },

  async connect(sellerId, payload = {}) {
    if (!sellerId) throw httpError('Seller ID is required');
    await businessService.requireBySellerId(sellerId);
    const token = String(payload.botToken || payload.token || '').trim();
    if (!token) throw httpError('Telegram bot token is required');

    // getMe is both validation and the authoritative source of bot identity.
    const bot = await telegramApi.getMe(token);
    if (!bot || !bot.id || !bot.is_bot) throw httpError('Token does not belong to a Telegram bot');
    const botId = String(bot.id);

    const owner = await Business.findOne({ telegramBotId: botId, sellerId: { $ne: sellerId } });
    if (owner) throw httpError('This Telegram bot is already connected to another seller', 409);

    const secret = String(payload.webhookSecret || crypto.randomBytes(32).toString('base64url')).trim();
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
      throw httpError('Webhook secret must use only A-Z, a-z, 0-9, underscore, or hyphen');
    }

    const requestedMode = payload.mode || (webhookUrl(botId, payload.webhookUrl) ? 'webhook' : 'polling');
    if (!['webhook', 'polling'].includes(requestedMode)) {
      throw httpError('mode must be webhook or polling');
    }
    if (requestedMode === 'polling' && process.env.NODE_ENV === 'production') {
      throw httpError('Telegram polling mode is only available outside production');
    }

    const targetWebhookUrl = requestedMode === 'webhook'
      ? webhookUrl(botId, payload.webhookUrl)
      : '';
    if (requestedMode === 'webhook') {
      validateWebhookUrl(targetWebhookUrl);
      await telegramApi.setWebhook(token, {
        url: targetWebhookUrl,
        secret_token: secret,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: payload.dropPendingUpdates === true,
      });
    } else {
      await telegramApi.deleteWebhook(token, {
        drop_pending_updates: payload.dropPendingUpdates === true,
      });
    }

    await Business.findOneAndUpdate(
      { sellerId },
      {
        $set: {
          telegramBotId: botId,
          telegramBotUsername: bot.username || '',
          telegramBotToken: token,
          telegramWebhookSecret: secret,
          telegramWebhookUrl: targetWebhookUrl,
          telegramConnected: true,
          telegramConnectedAt: new Date(),
          telegramWebhookVerified: requestedMode === 'webhook',
        },
      },
      { new: true, runValidators: true }
    );

    logger.info('Telegram bot connected:', { sellerId, botId, mode: requestedMode });
    return this.getConfig(sellerId);
  },

  async disconnect(sellerId) {
    const business = await businessService.getWithSecrets(sellerId);
    if (business && business.telegramBotToken) {
      try {
        await telegramApi.deleteWebhook(business.telegramBotToken, { drop_pending_updates: false });
      } catch (error) {
        logger.warn('Could not delete Telegram webhook during disconnect:', { sellerId, error: error.message });
      }
    }

    await Business.updateOne(
      { sellerId },
      {
        $set: {
          telegramConnected: false,
          telegramConnectedAt: null,
          telegramWebhookVerified: false,
          telegramWebhookUrl: '',
          telegramBotUsername: '',
        },
        $unset: {
          telegramBotId: 1,
          telegramBotToken: 1,
          telegramWebhookSecret: 1,
        },
      }
    );
    return { success: true, message: 'Telegram bot disconnected' };
  },

  async sendOutbound({
    sellerId,
    to,
    body,
    replyMarkup,
    token,
    botId,
    customerPhone = '',
    channelUsername = '',
    customerName = '',
    deterministic = false,
    toolCalls = null,
  }) {
    if (!sellerId || !to || !body) throw httpError('sellerId, recipient, and body are required');
    let business = null;
    if (!token) {
      business = await getBusinessWithTelegram(sellerId);
      token = business.telegramBotToken;
      botId = business.telegramBotId;
    }

    const cleanBody = sanitize(body, 4000);
    const results = await telegramApi.sendText(token, {
      chatId: String(to),
      text: cleanBody,
      replyMarkup,
      disableWebPagePreview: false,
    });
    const last = results[results.length - 1] || {};

    return messageService.saveMessage({
      sellerId,
      channel: 'telegram',
      channelAccountId: String(botId || (business && business.telegramBotId) || ''),
      channelUserId: String(to),
      channelUsername,
      customerName,
      customerPhone,
      direction: 'outbound',
      body: cleanBody,
      providerMessageId: last.message_id ? String(last.message_id) : undefined,
      deterministic,
      toolCalls,
      status: 'sent',
    });
  },

  async handleUpdate({ business, update }) {
    const parsed = parseUpdate(update);
    if (!parsed) return { ignored: true, reason: 'unsupported_update' };
    if (parsed.chat.type && parsed.chat.type !== 'private') {
      return { ignored: true, reason: 'private_chats_only' };
    }

    const sellerId = business.sellerId;
    const botId = String(business.telegramBotId);
    const token = business.telegramBotToken;
    const userId = String(parsed.from.id);
    const username = parsed.from.username || '';
    const name = displayName(parsed.from);

    if (parsed.callbackQueryId) {
      await telegramApi.answerCallbackQuery(token, parsed.callbackQueryId).catch(() => {});
    }

    const duplicate = await messageService.findProviderMessage({
      channel: 'telegram',
      channelAccountId: botId,
      channelUserId: userId,
      providerMessageId: parsed.providerMessageId,
    });
    if (duplicate) return { duplicate: true, inbound: duplicate };

    const history = await messageService.getRecentHistory(sellerId, {
      channel: 'telegram',
      channelUserId: userId,
      limit: 8,
    });

    let customer = await customerService.upsertChannelIdentity(sellerId, {
      channel: 'telegram',
      externalId: userId,
      handle: username,
      displayName: name,
    });

    const inbound = await messageService.saveMessage({
      sellerId,
      channel: 'telegram',
      channelAccountId: botId,
      channelUserId: userId,
      channelUsername: username,
      customerName: name,
      customerPhone: customer.phone || '',
      direction: 'inbound',
      body: sanitize(parsed.body || '[Unsupported message]', 4000),
      providerMessageId: parsed.providerMessageId,
      providerUpdateId: parsed.updateId,
      timestamp: parsed.timestamp,
      status: 'received',
    });
    if (inbound.duplicate) return { duplicate: true, inbound };

    let reply;
    let replyMarkup;
    let deterministic = true;
    let toolCalls = null;
    const command = String(parsed.body || '').trim().toLowerCase().split(/\s+/)[0];

    if (!parsed.body && !parsed.contact) {
      reply = 'Please send a text message so I can help with products and orders.';
    } else if (parsed.contact) {
      if (!isOwnedContact(parsed.contact, userId)) {
        reply = 'Please use the button below to share your own phone number, not another contact.';
        replyMarkup = contactKeyboard();
      } else {
        customer = await customerService.attachPhoneToIdentity(sellerId, {
          channel: 'telegram',
          externalId: userId,
          phone: parsed.contact.phone_number,
          handle: username,
          displayName: name,
        });
        const resumed = await aiService.resumeAfterContact({
          sellerId,
          customerPhone: customer.phone,
          customerName: name,
          customerEmail: customer.email || '',
          channel: 'telegram',
          channelAccountId: botId,
          channelUserId: userId,
          channelUsername: username,
          conversationKey: `telegram:${userId}`,
        });
        if (resumed) {
          reply = `Phone number saved securely.\n\n${resumed.reply}`;
          toolCalls = resumed.toolCalls;
        } else {
          reply = 'Phone number saved. You can now place orders securely in this chat. What would you like to buy?';
        }
        // Remove the one-time contact keyboard. The resumed summary also tells
        // the buyer they can reply YES, so an inline keyboard is not required.
        replyMarkup = removeKeyboard();
      }
    } else if (command === '/start') {
      await customerService.setOptOutByIdentity(sellerId, 'telegram', userId, false);
      const store = await businessService.getBySellerId(sellerId);
      reply = `Welcome to ${(store && store.name) || 'our store'}! Browse products here, ask about prices, or place an order. Share your phone number when you are ready to buy.`;
      replyMarkup = customer.phone ? removeKeyboard() : contactKeyboard();
    } else if (['/stop', 'stop', 'unsubscribe'].includes(command)) {
      await customerService.setOptOutByIdentity(sellerId, 'telegram', userId, true);
      reply = 'You have been unsubscribed from Telegram marketing broadcasts. Essential order updates will still be sent.';
    } else if (['/help', 'help'].includes(command)) {
      reply = 'Ask me to find a product or place an order. Send “MY ORDERS” to see purchases, “TRACK #00012” for status, “RESUME #00012” to continue payment, or “CANCEL ORDER #00012”. Use /stop to leave marketing broadcasts.';
      replyMarkup = customer.phone ? undefined : contactKeyboard();
    } else {
      const aiResult = await aiService.chat({
        sellerId,
        customerPhone: customer.phone || 'telegram_customer',
        customerName: name,
        customerEmail: customer.email || '',
        body: parsed.body,
        history,
        channel: 'telegram',
        channelAccountId: botId,
        channelUserId: userId,
        channelUsername: username,
        conversationKey: `telegram:${userId}`,
      });
      reply = aiResult.reply;
      toolCalls = aiResult.toolCalls;
      deterministic = aiResult.intent !== 'ai_completion';
      replyMarkup = aiResult.replyMarkup;
      if (!customer.phone && (aiResult.needsContact || aiResult.intent === 'ai_completion')) {
        if (!reply.toLowerCase().includes('share phone number')) {
          reply = `${reply}\n\nTo place an order, tap “Share phone number” below.`;
        }
        replyMarkup = contactKeyboard();
      }
    }

    const outbound = await this.sendOutbound({
      sellerId,
      to: userId,
      body: reply,
      replyMarkup,
      token,
      botId,
      customerPhone: customer.phone || '',
      channelUsername: username,
      customerName: name,
      deterministic,
      toolCalls,
    });

    logger.info('Telegram conversation exchange processed:', {
      sellerId,
      botId,
      userId,
      updateId: parsed.updateId,
    });
    return { inbound, outbound, toolCalls, customer };
  },

  async handleUpdateForBot(botId, update) {
    const business = await Business.findOne({
      telegramBotId: String(botId),
      telegramConnected: true,
    }).select('+telegramBotToken +telegramWebhookSecret');
    if (!business) throw httpError('Telegram bot connection not found', 404);
    return this.handleUpdate({ business, update });
  },

  async pollOnce(business, offset) {
    const updates = await telegramApi.getUpdates(business.telegramBotToken, {
      ...(offset !== undefined ? { offset } : {}),
      timeout: Number(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS) || 25,
      allowed_updates: ['message', 'callback_query'],
    });
    let nextOffset = offset;
    for (const update of updates) {
      await this.handleUpdate({ business, update });
      nextOffset = Math.max(nextOffset || 0, Number(update.update_id) + 1);
    }
    return { processed: updates.length, nextOffset };
  },

  listMessages(sellerId, filters = {}) {
    return messageService.listMessages(sellerId, { ...filters, channel: 'telegram' });
  },

  getConversations(sellerId) {
    return messageService.getConversations(sellerId, { channel: 'telegram' });
  },
};

module.exports = telegramService;
