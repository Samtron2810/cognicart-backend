#!/usr/bin/env node
/**
 * Local-development Telegram long poller.
 * Production should use signed HTTPS webhooks instead.
 */

require('dotenv').config();
const Business = require('../models/Business');
const telegramService = require('../services/telegram/telegramService');
const { connectDB, disconnectDB } = require('../config/db');
const logger = require('../utils/logger');

let stopping = false;
const offsets = new Map();

async function pollBusiness(business) {
  const key = business.telegramBotId;
  try {
    const result = await telegramService.pollOnce(business, offsets.get(key));
    if (result.nextOffset !== undefined) offsets.set(key, result.nextOffset);
    if (result.processed) {
      logger.info('Telegram polling updates processed:', {
        sellerId: business.sellerId,
        botId: key,
        count: result.processed,
      });
    }
  } catch (error) {
    logger.warn('Telegram polling cycle failed:', {
      sellerId: business.sellerId,
      botId: key,
      error: error.message,
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function run() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Long polling is for local development only; configure Telegram webhooks in production');
  }
  await connectDB();
  logger.info('Telegram local poller started');

  while (!stopping) {
    const businesses = await Business.find({
      telegramConnected: true,
      telegramWebhookVerified: false,
    }).select('+telegramBotToken +telegramWebhookSecret');

    if (!businesses.length) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    await Promise.all(businesses.filter((business) => business.telegramBotToken).map(pollBusiness));
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info(`Telegram poller received ${signal}; shutting down`);
  await disconnectDB().catch(() => {});
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

run()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Telegram poller stopped:', { error: error.message });
    process.exit(1);
  });
