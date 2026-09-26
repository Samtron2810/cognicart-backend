/**
 * WhatsApp Controller
 * Manages webhook handshakes, incoming message routing, outbound chats, and connection credentials
 */

const whatsappService = require('../services/whatsapp/whatsappService');
const logger = require('../utils/logger');

/**
 * @route   GET /api/whatsapp/webhook
 * @desc    Meta WhatsApp Cloud API Webhook handshake verification
 * @access  Public
 */
function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'] || req.query.mode;
  const token = req.query['hub.verify_token'] || req.query.verifyToken;
  const challenge = req.query['hub.challenge'] || req.query.challenge;

  const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN || 'wabac_whatsapp_verify_token_default';

  if (mode === 'subscribe' && token === expectedToken) {
    logger.info('WhatsApp webhook successfully verified with Meta');
    return res.status(200).send(challenge);
  }

  logger.warn('WhatsApp webhook handshake failed: Token mismatch', { mode, token });
  return res.status(403).json({ success: false, message: 'Verification token mismatch' });
}

/**
 * @route   POST /api/whatsapp/webhook
 * @desc    Receive incoming WhatsApp Cloud API events from Meta
 * @access  Public (Signature protected)
 */
async function handleWebhookPost(req, res, next) {
  try {
    // Process incoming message asynchronously
    await whatsappService.handleIncoming(req.body);
    // Meta requires a prompt 200 OK acknowledgment
    res.status(200).json({ success: true, message: 'EVENT_RECEIVED' });
  } catch (error) {
    logger.error('WhatsApp webhook processing error:', { error: error.message });
    // Still acknowledge with 200 to Meta to prevent repeated webhook retry storms
    res.status(200).json({ success: false, error: error.message });
  }
}

/**
 * @route   POST /api/whatsapp/incoming
 * @desc    Test/simulate incoming WhatsApp message from frontend tester or client
 * @access  Public / Private
 */
async function handleIncoming(req, res, next) {
  try {
    const payload = {
      ...req.body,
      sellerId: req.sellerId || req.body.sellerId,
    };
    const result = await whatsappService.handleIncoming(payload);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   POST /api/whatsapp/send
 * @desc    Send outbound WhatsApp message
 * @access  Private
 */
async function sendOutbound(req, res, next) {
  try {
    const { to, body } = req.body;
    const msg = await whatsappService.sendOutbound({
      sellerId: req.sellerId,
      to,
      body,
    });
    res.status(200).json(msg);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   GET /api/whatsapp/config
 * @desc    Get seller's WhatsApp connection status & configuration
 * @access  Private
 */
async function getConfig(req, res, next) {
  try {
    const config = await whatsappService.getConfig(req.sellerId);
    res.status(200).json(config);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   POST /api/whatsapp/connect
 * @desc    Connect seller WhatsApp Business Account
 * @access  Private
 */
async function connect(req, res, next) {
  try {
    const config = await whatsappService.connect(req.sellerId, req.body);
    res.status(200).json(config);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   POST /api/whatsapp/disconnect
 * @desc    Disconnect seller WhatsApp Business Account
 * @access  Private
 */
async function disconnect(req, res, next) {
  try {
    const result = await whatsappService.disconnect(req.sellerId);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   GET /api/whatsapp/messages
 * @desc    List message transcript for seller
 * @access  Private
 */
async function getMessages(req, res, next) {
  try {
    const { customerPhone, direction } = req.query;
    const messages = await whatsappService.listMessages(req.sellerId, { customerPhone, direction });
    res.status(200).json(messages);
  } catch (error) {
    next(error);
  }
}

/**
 * @route   GET /api/whatsapp/conversations
 * @desc    Get active conversations for seller
 * @access  Private
 */
async function getConversations(req, res, next) {
  try {
    const conversations = await whatsappService.getConversations(req.sellerId);
    res.status(200).json(conversations);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  verifyWebhook,
  handleWebhookPost,
  handleIncoming,
  sendOutbound,
  getConfig,
  connect,
  disconnect,
  getMessages,
  getConversations,
};
