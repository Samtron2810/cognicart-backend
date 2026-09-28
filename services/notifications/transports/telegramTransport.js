/** Telegram transactional notification transport. */

const businessService = require('../../sellers/businessService');
const templates = require('../notificationTemplates');

function render(notification, business) {
  switch (notification.event) {
    case 'order.created':
      return templates.orderConfirmation({
        order: notification.order,
        business,
        trackingUrl: '',
      }).text;
    case 'payment.received':
      return templates.paymentReceipt({
        payment: notification.payment,
        order: notification.order,
        business,
      }).text;
    case 'order.status_changed':
      return templates.orderStatus({
        order: notification.order,
        business,
        status: notification.status,
      }).text;
    default:
      return notification.text || '';
  }
}

module.exports = {
  provider: 'telegram-bot-api',

  // Bot credentials are tenant-specific and validated by sendOutbound.
  isConfigured() {
    return true;
  },

  async send(notification) {
    const order = notification.order || {};
    const sellerId = notification.sellerId || order.sellerId || (notification.payment && notification.payment.sellerId);
    const to = notification.to || order.channelUserId;
    if (!sellerId || !to) throw new Error('Telegram notification destination is missing');

    const business = (await businessService.getBySellerId(sellerId)) || {};
    const text = render(notification, business);
    if (!text) throw new Error(`Unsupported Telegram notification event: ${notification.event || 'unknown'}`);

    // Lazy require avoids a load-time commerce -> notification -> Telegram ->
    // AI tools -> commerce cycle.
    const telegramService = require('../../telegram/telegramService');
    const saved = await telegramService.sendOutbound({
      sellerId,
      to,
      body: text,
      customerPhone: order.customerPhone || '',
      channelUsername: order.channelUsername || '',
      customerName: order.customerName || '',
      deterministic: true,
    });

    return {
      delivered: true,
      channel: 'telegram',
      provider: 'telegram-bot-api',
      messageId: saved.providerMessageId || saved.id,
    };
  },
};
