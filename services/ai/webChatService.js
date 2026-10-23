/**
 * Per-Store Website Chatbot
 *
 * A second transport onto the SAME agent the Telegram bot uses — never a
 * fork of it. Everything conversational still runs through
 * `aiService.chat`, which means OpenAI function calling when a key is set,
 * the deterministic button-menu agent when it is not, and in both cases the
 * identical seller-scoped tools.
 *
 * What this layer adds, and only this:
 *   1. a durable transcript keyed to {store, buyer} so the widget can reopen
 *      where it left off, and start clean at a different store;
 *   2. translation of the agent's Telegram inline keyboard into web quick
 *      replies, so the no-OpenAI-key fallback is a real button menu;
 *   3. channel wording, so a web buyer is not told to "use Telegram".
 *
 * ISOLATION. `sellerId` is resolved server-side from the store in the URL and
 * is the only tenant any call can touch. It is never read from the request
 * body, so a crafted request cannot point this store's chat at another
 * store's catalog or orders.
 */

const WebChatSession = require('../../models/WebChatSession');
const aiService = require('./aiService');
const businessService = require('../sellers/businessService');
const logger = require('../../utils/logger');
const { sanitize } = require('../../utils/validators');

const { TRANSCRIPT_TTL_MS, MAX_MESSAGES } = WebChatSession;

const CHANNEL = 'website_chatbot';

/**
 * The deterministic agent was written for Telegram and says so in its copy.
 * Rewriting 40KB of a working agent to add a second transport would be the
 * riskier change, so the wording is adjusted at the edge instead — and only
 * on the web transport. Telegram's own replies are untouched.
 */
function rephraseForWeb(text) {
  if (!text) return text;
  return String(text)
    .replace(/\bin this Telegram store\b/gi, 'in this store')
    .replace(/\bthis Telegram store\b/gi, 'this store')
    .replace(/\byour Telegram purchase history\b/gi, 'your purchase history')
    .replace(/\bTelegram store\b/gi, 'store')
    .replace(/\bShare phone number button\b/gi, 'phone number field')
    .replace(/\bon Telegram\b/gi, 'here')
    .replace(/\bvia Telegram\b/gi, 'here');
}

/**
 * Flatten a Telegram inline keyboard into web quick replies.
 * `callback_data` becomes the text the buyer would have typed, so one agent
 * serves both transports without a parallel command vocabulary.
 */
function toQuickReplies(replyMarkup) {
  const rows = (replyMarkup && replyMarkup.inline_keyboard) || [];
  const replies = [];
  for (const row of rows) {
    for (const button of row || []) {
      if (!button || !button.text) continue;
      replies.push({
        label: String(button.text).slice(0, 40),
        value: String(button.callback_data || button.text).slice(0, 80),
      });
    }
  }
  return replies.slice(0, 6);
}

/** Shown when a conversation has no menu of its own — the entry fallback. */
const DEFAULT_MENU = [
  { label: 'View all products', value: 'View all products' },
  { label: 'Search', value: 'Search' },
  { label: 'My orders', value: 'MY ORDERS' },
];

const webChatService = {
  CHANNEL,
  rephraseForWeb,
  toQuickReplies,
  DEFAULT_MENU,

  /**
   * Stable transcript owner. A verified shopper is preferred so the chat
   * follows them across devices; otherwise the signed visitor cookie.
   * Returns '' when neither exists, in which case the chat still works but
   * is not persisted — better than persisting under a guessable key.
   */
  ownerKeyFor({ shopperId, visitorId }) {
    if (shopperId) return `shopper:${shopperId}`;
    if (visitorId) return `visitor:${visitorId}`;
    return '';
  },

  async loadTranscript(sellerId, ownerKey) {
    if (!sellerId || !ownerKey) return [];
    const session = await WebChatSession.findOne({ sellerId, ownerKey }).lean();
    if (!session) return [];
    return (session.messages || []).map((message) => ({
      role: message.role,
      content: message.content,
      quickReplies: message.quickReplies || [],
      createdAt: message.createdAt,
    }));
  },

  async appendMessages(sellerId, ownerKey, messages) {
    if (!sellerId || !ownerKey || !messages.length) return;
    await WebChatSession.findOneAndUpdate(
      { sellerId, ownerKey },
      {
        // $slice keeps the newest MAX_MESSAGES, so a long-running chat cannot
        // grow a document without bound.
        $push: { messages: { $each: messages, $slice: -MAX_MESSAGES } },
        $set: { expiresAt: new Date(Date.now() + TRANSCRIPT_TTL_MS) },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  },

  async clear(sellerId, ownerKey) {
    if (!sellerId || !ownerKey) return;
    await WebChatSession.deleteOne({ sellerId, ownerKey });
  },

  /**
   * Opening payload for the widget: the store's name for the title, and the
   * transcript to restore.
   */
  async open({ sellerId, shopperId = null, visitorId = '' }) {
    if (!sellerId) throw new Error('sellerId is required');

    const business = await businessService.getBySellerId(sellerId);
    const ownerKey = this.ownerKeyFor({ shopperId, visitorId });
    const messages = await this.loadTranscript(sellerId, ownerKey);

    return {
      storeName: (business && business.name) || 'Store',
      storeLogo: (business && business.logo) || '',
      // Drives the header: "Chat with Vivid Fashions Bot".
      title: `Chat with ${(business && business.name) || 'this store'} Bot`,
      messages,
      quickReplies: messages.length
        ? messages[messages.length - 1].quickReplies || []
        : DEFAULT_MENU,
      persisted: Boolean(ownerKey),
    };
  },

  /**
   * One conversational turn.
   *
   * `sellerId` is passed in by the controller from the resolved store, never
   * from the caller's body.
   */
  async send({
    sellerId,
    body,
    shopperId = null,
    visitorId = '',
    customerName = '',
    customerEmail = '',
    customerPhone = '',
  }) {
    if (!sellerId) throw new Error('sellerId is required');

    const cleanBody = sanitize(body, 2000);
    if (!cleanBody) {
      const err = new Error('Message body is required');
      err.statusCode = 400;
      throw err;
    }

    const ownerKey = this.ownerKeyFor({ shopperId, visitorId });

    // Recent turns give the model continuity. Trimmed, because the whole
    // transcript is neither needed nor affordable in a prompt.
    const stored = await this.loadTranscript(sellerId, ownerKey);
    const history = stored.slice(-8).map((message) => ({
      role: message.role,
      content: message.content,
    }));

    const result = await aiService.chat({
      sellerId,
      body: cleanBody,
      history,
      shopperId,
      customerName,
      customerEmail,
      customerPhone: customerPhone || 'anon_customer',
      channel: CHANNEL,
      // Scoping the agent session to the store as well as the person is what
      // makes a different store start a genuinely fresh conversation.
      conversationKey: ownerKey ? `${CHANNEL}:${sellerId}:${ownerKey}` : '',
      // Never trusted: a buyer in a storefront widget must not get the
      // seller's tenant-wide reads, whoever they are signed in as.
      trusted: false,
    });

    const reply = rephraseForWeb(result.reply || '');
    const quickReplies = toQuickReplies(result.replyMarkup);

    if (ownerKey) {
      try {
        await this.appendMessages(sellerId, ownerKey, [
          { role: 'user', content: cleanBody, createdAt: new Date() },
          {
            role: 'assistant',
            content: reply,
            quickReplies,
            createdAt: new Date(),
          },
        ]);
      } catch (error) {
        // A transcript that fails to save must not swallow a reply the buyer
        // is waiting for — or worse, an order the agent just created.
        logger.warn('Could not persist web chat transcript', {
          sellerId,
          error: error.message,
        });
      }
    }

    return {
      reply,
      intent: result.intent || '',
      quickReplies: quickReplies.length ? quickReplies : DEFAULT_MENU,
      // Surfaced so the widget can link straight to a created order or a
      // Paystack checkout without re-deriving it from the reply text.
      toolCalls: (result.toolCalls || []).map((call) => ({
        name: call.name,
        result: call.result,
      })),
    };
  },
};

module.exports = webChatService;
