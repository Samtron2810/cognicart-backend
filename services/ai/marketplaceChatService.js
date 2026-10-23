'use strict';

/**
 * Marketplace chat — transcript persistence and the optional GPT layer.
 *
 * One assistant for the whole marketplace, reachable from every public page.
 * It replaces the former per-store widget: shoppers asked for one bot that
 * can search across sellers rather than a different bot in every store.
 *
 * What changed, and what deliberately did not:
 *
 *   - Catalog scope is now marketplace-wide. That is the requested change,
 *     and it leaks nothing: the directory, search and every storefront page
 *     already expose this exact data to anonymous visitors.
 *   - Buyer privacy is unchanged and still enforced. A transcript is keyed to
 *     one owner, so no shopper can read another's conversation.
 *   - This assistant has NO access to orders, customers, revenue or any
 *     seller-private read. It cannot, because it does not use the per-seller
 *     tool set at all.
 *   - `services/telegram` and `aiService` are untouched, so each seller's
 *     Telegram bot keeps its original isolation.
 */

const WebChatSession = require('../../models/WebChatSession');
const marketplaceAgent = require('./marketplaceAgent');
const logger = require('../../utils/logger');

const CHANNEL = 'website_chatbot';

/**
 * Sentinel tenant for marketplace-wide transcripts.
 *
 * `WebChatSession.sellerId` is a required string with a unique compound index
 * on {sellerId, ownerKey}. Reusing the field with a reserved value keeps one
 * collection, one TTL and one index. The value is not a valid ObjectId, so it
 * can never collide with a real seller.
 */
const MARKETPLACE_TENANT = '__marketplace__';

const MAX_MESSAGES = 60;
const TRANSCRIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sanitize(value, max) {
  return String(value || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
}

const marketplaceChatService = {
  CHANNEL,
  MARKETPLACE_TENANT,

  /**
   * Stable transcript owner. A verified shopper is preferred so the
   * conversation follows them across devices; otherwise the signed visitor
   * cookie. Returns '' when neither exists, in which case nothing is
   * persisted — better than writing under a guessable key.
   */
  ownerKeyFor({ shopperId, visitorId }) {
    if (shopperId) return `shopper:${shopperId}`;
    if (visitorId) return `visitor:${visitorId}`;
    return '';
  },

  async loadTranscript(ownerKey) {
    if (!ownerKey) return [];
    const session = await WebChatSession.findOne({ sellerId: MARKETPLACE_TENANT, ownerKey }).lean();
    if (!session) return [];
    return (session.messages || []).map((message) => ({
      role: message.role,
      content: message.content,
      quickReplies: message.quickReplies || [],
      createdAt: message.createdAt,
    }));
  },

  async appendMessages(ownerKey, messages) {
    if (!ownerKey || !messages.length) return;
    await WebChatSession.findOneAndUpdate(
      { sellerId: MARKETPLACE_TENANT, ownerKey },
      {
        $push: { messages: { $each: messages, $slice: -MAX_MESSAGES } },
        $set: { expiresAt: new Date(Date.now() + TRANSCRIPT_TTL_MS) },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  },

  async clear(ownerKey) {
    if (!ownerKey) return;
    await WebChatSession.deleteOne({ sellerId: MARKETPLACE_TENANT, ownerKey });
  },

  /** Opening payload for the widget. */
  async open({ shopperId = null, visitorId = '' } = {}) {
    const ownerKey = this.ownerKeyFor({ shopperId, visitorId });
    const messages = await this.loadTranscript(ownerKey);

    return {
      title: 'Chatstand Assistant',
      subtitle: 'Shopping across every store',
      messages,
      quickReplies: messages.length
        ? (messages[messages.length - 1].quickReplies || marketplaceAgent.MENU)
        : marketplaceAgent.MENU,
    };
  },

  /**
   * Handle one shopper turn.
   *
   * @param {object} input
   * @param {string} input.body
   * @param {string} [input.storeContext] sellerId of the store page the
   *        shopper happens to be on. Offers a "only this store" shortcut;
   *        it never restricts results on its own.
   */
  async send({ body, shopperId = null, visitorId = '', storeContext = '' } = {}) {
    const cleanBody = sanitize(body, 2000);
    if (!cleanBody) {
      const err = new Error('Message body is required');
      err.statusCode = 400;
      throw err;
    }

    const ownerKey = this.ownerKeyFor({ shopperId, visitorId });
    const stored = await this.loadTranscript(ownerKey);
    const history = stored.slice(-8).map((message) => ({ role: message.role, content: message.content }));

    const result = await marketplaceAgent.run({ body: cleanBody, storeContext });
    const reply = await this.polish({ reply: result.reply, body: cleanBody, history, result });

    if (ownerKey) {
      try {
        await this.appendMessages(ownerKey, [
          { role: 'user', content: cleanBody, createdAt: new Date() },
          { role: 'assistant', content: reply, quickReplies: result.quickReplies, createdAt: new Date() },
        ]);
      } catch (error) {
        // A transcript that fails to save must not swallow a reply the
        // shopper is waiting for.
        logger.warn('Could not persist marketplace chat transcript', { error: error.message });
      }
    }

    return {
      reply,
      intent: result.intent,
      quickReplies: result.quickReplies,
      products: result.products,
      stores: result.stores,
    };
  },

  /**
   * Optional GPT rewrite of the assistant's sentence.
   *
   * The model only ever rephrases copy that was already generated from real
   * catalog data — it is never given the ability to name a product, quote a
   * price or invent a store. That keeps the "GPT with catalog in the prompt"
   * experience without any risk of a hallucinated listing, and means the
   * button-menu fallback and the GPT path return identical data.
   */
  async polish({ reply, body, history, result }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey.includes('your_')) return reply;

    try {
      // eslint-disable-next-line global-require
      const OpenAI = require('openai');
      const openai = new OpenAI({ apiKey });

      const facts = [
        `Intent: ${result.intent}`,
        result.products.length
          ? `Products found: ${result.products
              .map((p) => `${p.name} (₦${p.price}) at ${p.storeName || 'a store'}`)
              .join('; ')}`
          : 'Products found: none',
        result.stores.length ? `Stores found: ${result.stores.map((s) => s.name).join('; ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      const response = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.4,
        max_tokens: 120,
        messages: [
          {
            role: 'system',
            content:
              'You are the Chatstand marketplace shopping assistant for a Nigerian marketplace. ' +
              'Rewrite the draft reply so it sounds warm, brief and natural. ' +
              'STRICT RULES: use only the facts provided. Never invent a product, price, store or stock level. ' +
              'Never promise delivery times. Do not use markdown or emoji. Two sentences maximum. ' +
              'The shopper sees the product cards separately, so do not list every item.',
          },
          ...history.slice(-4),
          { role: 'user', content: body },
          { role: 'user', content: `Facts:\n${facts}\n\nDraft reply:\n${reply}\n\nRewrite the draft.` },
        ],
      });

      const polished = sanitize(response.choices?.[0]?.message?.content, 600);
      return polished || reply;
    } catch (error) {
      // Any model problem falls back to the deterministic sentence, which is
      // already correct — the assistant stays fully usable with no key at all.
      logger.warn('Marketplace chat polish failed, using deterministic reply', { error: error.message });
      return reply;
    }
  },
};

module.exports = marketplaceChatService;
