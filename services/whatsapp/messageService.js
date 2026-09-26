/**
 * WhatsApp Message Transcript and Conversation Storage Service
 */

const Message = require('../../models/Message');
const Conversation = require('../../models/Conversation');
const { isDbConnected } = require('../../config/db');
const logger = require('../../utils/logger');

// In-Memory store for development/testing when MongoDB daemon is not running
const memoryMessages = [];
const memoryConversations = new Map();

const messageService = {
  /**
   * Save a message and update conversation thread
   */
  async saveMessage({
    sellerId,
    businessPhone = '',
    customerPhone,
    direction,
    body,
    deterministic = false,
    toolCalls = null,
    status = 'received',
  }) {
    const timestamp = new Date();
    const msgData = {
      sellerId,
      businessPhone,
      customerPhone,
      direction,
      body,
      timestamp,
      status: direction === 'outbound' ? 'sent' : status,
      deterministic,
      toolCalls,
    };

    if (isDbConnected()) {
      const msg = await Message.create(msgData);

      // Update or create conversation summary
      await Conversation.findOneAndUpdate(
        { sellerId, customerPhone },
        {
          $set: {
            businessPhone,
            lastMessage: body,
            lastMessageAt: timestamp,
          },
          $inc: { unreadCount: direction === 'inbound' ? 1 : 0 },
        },
        { upsert: true, new: true }
      );

      return msg.toJSON();
    }

    // In-memory fallback
    const id = 'wmsg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const memMsg = {
      id,
      _id: id,
      ...msgData,
      timestamp: timestamp.toISOString(),
    };
    memoryMessages.push(memMsg);

    const convKey = `${sellerId}_${customerPhone}`;
    const currentConv = memoryConversations.get(convKey) || {
      sellerId,
      customerPhone,
      businessPhone,
      unreadCount: 0,
    };

    memoryConversations.set(convKey, {
      ...currentConv,
      businessPhone,
      lastMessage: body,
      lastMessageAt: timestamp.toISOString(),
      unreadCount: direction === 'inbound' ? currentConv.unreadCount + 1 : currentConv.unreadCount,
    });

    return memMsg;
  },

  /**
   * List messages for a seller with optional customerPhone and direction filters
   */
  async listMessages(sellerId, { customerPhone, direction } = {}) {
    if (!sellerId) throw new Error('Seller ID is required');

    if (isDbConnected()) {
      const filter = { sellerId };
      if (customerPhone) filter.customerPhone = customerPhone;
      if (direction) filter.direction = direction;

      const msgs = await Message.find(filter).sort({ timestamp: 1 });
      return msgs.map((m) => m.toJSON());
    }

    let list = memoryMessages.filter((m) => m.sellerId === sellerId);
    if (customerPhone) list = list.filter((m) => m.customerPhone === customerPhone);
    if (direction) list = list.filter((m) => m.direction === direction);

    return list.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  },

  /**
   * Get active conversation threads for a seller
   */
  async getConversations(sellerId) {
    if (!sellerId) throw new Error('Seller ID is required');

    if (isDbConnected()) {
      const convs = await Conversation.find({ sellerId }).sort({ lastMessageAt: -1 });
      return convs.map((c) => c.toJSON());
    }

    const list = Array.from(memoryConversations.values()).filter((c) => c.sellerId === sellerId);
    return list.sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
  },

  getMemoryStore() {
    return { messages: memoryMessages, conversations: memoryConversations };
  },
};

module.exports = messageService;
