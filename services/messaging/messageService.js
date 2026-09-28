/**
 * Channel-neutral Transcript and Conversation Service
 */

const Message = require('../../models/Message');
const Conversation = require('../../models/Conversation');

function identity(input = {}) {
  const channel = input.channel || 'telegram';
  const channelUserId = String(input.channelUserId || '').trim();
  if (!input.sellerId) {
    const err = new Error('Seller ID is required');
    err.statusCode = 400;
    throw err;
  }
  if (!channelUserId) {
    const err = new Error('Channel user identity is required');
    err.statusCode = 400;
    throw err;
  }
  return { channel, channelUserId };
}

const messageService = {
  async findProviderMessage({ channel, channelAccountId = '', channelUserId, providerMessageId }) {
    if (!providerMessageId || !channelUserId) return null;
    const message = await Message.findOne({
      channel,
      channelAccountId: String(channelAccountId),
      channelUserId: String(channelUserId),
      providerMessageId: String(providerMessageId),
    });
    return message ? message.toJSON() : null;
  },

  /** Save a message and atomically update its conversation summary. */
  async saveMessage(input) {
    const { channel, channelUserId } = identity(input);
    const timestamp = input.timestamp ? new Date(input.timestamp) : new Date();
    const data = {
      sellerId: input.sellerId,
      channel,
      channelAccountId: String(input.channelAccountId || ''),
      channelUserId,
      channelUsername: String(input.channelUsername || ''),
      customerName: String(input.customerName || ''),
      providerMessageId: input.providerMessageId
        ? String(input.providerMessageId)
        : undefined,
      providerUpdateId: input.providerUpdateId
        ? String(input.providerUpdateId)
        : undefined,
      customerPhone: input.customerPhone || '',
      direction: input.direction,
      body: input.body,
      timestamp,
      status: input.direction === 'outbound' ? input.status || 'sent' : input.status || 'received',
      deterministic: !!input.deterministic,
      toolCalls: input.toolCalls || null,
    };

    let msg;
    try {
      msg = await Message.create(data);
    } catch (error) {
      if (error && error.code === 11000 && data.providerMessageId) {
        const existing = await this.findProviderMessage(data);
        if (existing) return { ...existing, duplicate: true };
      }
      throw error;
    }

    await Conversation.findOneAndUpdate(
      { sellerId: input.sellerId, channel, channelUserId },
      {
        $set: {
          channelAccountId: data.channelAccountId,
          channelUsername: data.channelUsername,
          customerName: data.customerName,
          customerPhone: data.customerPhone,
          lastMessage: input.body,
          lastMessageAt: timestamp,
        },
        $inc: { unreadCount: input.direction === 'inbound' ? 1 : 0 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return msg.toJSON();
  },

  async listMessages(sellerId, filters = {}) {
    if (!sellerId) throw new Error('Seller ID is required');
    const filter = { sellerId };
    if (filters.channel) filter.channel = filters.channel;
    if (filters.channelUserId) filter.channelUserId = String(filters.channelUserId);
    if (filters.customerPhone) filter.customerPhone = filters.customerPhone;
    if (filters.direction) filter.direction = filters.direction;

    const msgs = await Message.find(filter).sort({ timestamp: 1 });
    return msgs.map((message) => message.toJSON());
  },

  async getRecentHistory(sellerId, { channel, channelUserId, limit = 8 }) {
    const messages = await Message.find({ sellerId, channel, channelUserId: String(channelUserId) })
      .sort({ timestamp: -1 })
      .limit(Math.min(Math.max(Number(limit) || 8, 1), 20));

    return messages.reverse().map((message) => ({
      role: message.direction === 'inbound' ? 'user' : 'assistant',
      content: message.body,
    }));
  },

  async getConversations(sellerId, filters = {}) {
    if (!sellerId) throw new Error('Seller ID is required');
    const query = { sellerId };
    if (filters.channel) query.channel = filters.channel;
    const conversations = await Conversation.find(query).sort({ lastMessageAt: -1 });
    return conversations.map((conversation) => conversation.toJSON());
  },
};

module.exports = messageService;
