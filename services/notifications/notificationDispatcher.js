/**
 * Notification Transport Dispatcher
 *
 * Commerce code emits rendered notifications to a named channel without
 * knowing anything about Brevo, Telegram's Bot API, or future providers.
 * Brevo email and Telegram are registered without coupling order, payment, or
 * buyer-auth services to either provider.
 */

const brevoEmailTransport = require('./transports/brevoEmailTransport');
const telegramTransport = require('./transports/telegramTransport');
const logger = require('../../utils/logger');

const transports = new Map([
  ['email', brevoEmailTransport],
  ['telegram', telegramTransport],
]);

function registerTransport(channel, transport) {
  const name = String(channel || '').trim().toLowerCase();
  if (!name) throw new Error('Notification channel is required');
  if (!transport || typeof transport.send !== 'function') {
    throw new Error(`Notification transport '${name}' must implement send()`);
  }
  transports.set(name, transport);
  return transport;
}

function unregisterTransport(channel) {
  transports.delete(String(channel || '').trim().toLowerCase());
}

function getTransport(channel) {
  return transports.get(String(channel || '').trim().toLowerCase()) || null;
}

function canSend(channel) {
  const transport = getTransport(channel);
  if (!transport) return false;
  return typeof transport.isConfigured !== 'function' || transport.isConfigured();
}

async function dispatch(notification = {}) {
  const channel = String(notification.channel || '').trim().toLowerCase();
  const transport = getTransport(channel);

  if (!transport) {
    logger.warn('Notification skipped: unsupported channel', {
      channel,
      event: notification.event,
    });
    return { delivered: false, channel, reason: 'unsupported_channel' };
  }

  if (typeof transport.isConfigured === 'function' && !transport.isConfigured()) {
    logger.warn('Notification skipped: transport is not configured', {
      channel,
      provider: transport.provider,
      event: notification.event,
    });
    return {
      delivered: false,
      channel,
      provider: transport.provider || '',
      reason: 'transport_not_configured',
    };
  }

  try {
    const result = await transport.send(notification);
    logger.info('Notification delivered:', {
      event: notification.event,
      channel,
      provider: result.provider || transport.provider,
      messageId: result.messageId || '',
    });
    return result;
  } catch (error) {
    // Notifications are side effects. An unavailable provider must never roll
    // back an order or payment that is already durable in MongoDB.
    logger.warn('Notification delivery failed:', {
      event: notification.event,
      channel,
      provider: transport.provider,
      error: error.message,
    });
    return {
      delivered: false,
      channel,
      provider: transport.provider || '',
      reason: 'delivery_failed',
      error: error.message,
    };
  }
}

module.exports = {
  registerTransport,
  unregisterTransport,
  getTransport,
  canSend,
  dispatch,
};
