/**
 * WhatsApp Webhook and Deterministic Rule-Based Reply Service
 * Generates authoritative replies when AI agent is offline or for deterministic queries
 */

const businessService = require('../sellers/businessService');
const productService = require('../products/productService');
const logger = require('../../utils/logger');

const webhookService = {
  /**
   * Deterministic rule-based reply engine
   */
  async deterministicReply(sellerId, body) {
    const lower = (body || '').toLowerCase().trim();
    const business = await businessService.getBySellerId(sellerId);
    const businessName = business ? business.name : 'Our Store';
    const deliveryInfo = business && business.deliveryInfo ? business.deliveryInfo : 'Lagos 1-2 days, outside Lagos 2-4 days';
    const paymentInfo = business && business.paymentMethod === 'both'
      ? 'Paystack (card/bank) and direct transfer'
      : (business ? business.paymentMethod : 'Paystack and bank transfer');

    // Fetch active catalog for authoritative product matching
    const products = await productService.list({ sellerId, isPublic: true });

    // 1. Greetings
    if (/(^|\s)(hi|hello|hey|hiya|good morning|good afternoon|good day)(\s|!|\.|$)/i.test(lower)) {
      const topItems = products.slice(0, 3).map((p) => `• ${p.name} — ₦${p.price.toLocaleString()}`).join('\n');
      return (
        `Hello! Welcome to ${businessName} on WhatsApp.\n` +
        `I can help you browse products, check prices, stock availability, and place orders directly.\n\n` +
        (topItems ? `Top available items:\n${topItems}\n\n` : '') +
        `Try: "show me products", "is [product] in stock?", or "price of [product]".`
      );
    }

    // 2. Delivery Inquiries
    if (lower.includes('deliver') || lower.includes('shipping') || lower.includes('when will') || lower.includes('where is my')) {
      const feeText = business && business.deliveryFee ? ` Delivery fee is ₦${business.deliveryFee.toLocaleString()}.` : '';
      return `Delivery Information for ${businessName}: ${deliveryInfo}.${feeText} What product would you like to order?`;
    }

    // 3. Payment Inquiries
    if (lower.includes('pay') || lower.includes('payment') || lower.includes('paystack') || lower.includes('account number')) {
      let bankDetails = '';
      if (business && business.accountNumber && business.bankName) {
        bankDetails = ` Bank: ${business.bankName}, Account: ${business.accountNumber} (${business.accountName || ''}).`;
      }
      return `Payment Options: We accept ${paymentInfo}.${bankDetails} Orders are confirmed once payment is verified.`;
    }

    // 4. Extract search keywords
    const extractKeyword = (text) => {
      const stopwords = ['show', 'me', 'i', 'need', 'want', 'looking', 'for', 'a', 'an', 'the', 'is', 'are', 'price', 'stock', 'available', 'in', 'how', 'much', 'what', 'tell', 'about', 'do', 'you', 'have', 'any', 'with', 'under', 'around', 'please', 'hi', 'hello'];
      const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const filtered = words.filter((w) => !stopwords.includes(w) && w.length > 2);
      return filtered.join(' ') || words.join(' ');
    };

    const keyword = extractKeyword(body);
    const searchMatches = (kw) => {
      if (!kw) return [];
      const kwLower = kw.toLowerCase();
      return products.filter(
        (p) =>
          p.name.toLowerCase().includes(kwLower) ||
          p.category.toLowerCase().includes(kwLower) ||
          p.description.toLowerCase().includes(kwLower)
      );
    };

    // 5. Price Check
    if (lower.includes('price') || lower.includes('how much') || lower.includes('cost')) {
      if (keyword) {
        const matches = searchMatches(keyword);
        if (matches.length > 0) {
          const match = matches[0];
          const stockStatus = match.stock > 0 ? `in stock (${match.stock} units available)` : 'currently out of stock';
          return `${match.name} is ₦${match.price.toLocaleString()} and is ${stockStatus}. Would you like to place an order?`;
        }
      }
      return `Please tell me which product you would like the price for. Example: "price of [product name]"`;
    }

    // 6. Stock Check
    if (lower.includes('stock') || lower.includes('available') || lower.includes('in stock')) {
      if (keyword) {
        const matches = searchMatches(keyword);
        if (matches.length > 0) {
          const m = matches[0];
          return `${m.name} • ₦${m.price.toLocaleString()} • ${m.stock > 0 ? `In stock: ${m.stock} units` : 'Out of stock'}. Would you like to order?`;
        }
      }
      return `Which product would you like me to check stock for? Example: "is [product name] in stock?"`;
    }

    // 7. Catalog Search
    if (lower.includes('show') || lower.includes('search') || lower.includes('find') || lower.includes('catalog') || keyword.length >= 3) {
      const matches = searchMatches(keyword);
      if (matches.length > 0) {
        const list = matches.slice(0, 3).map((p) => `• ${p.name} — ₦${p.price.toLocaleString()} (${p.stock > 0 ? `${p.stock} in stock` : 'out of stock'})`).join('\n');
        return `Found ${matches.length} matching product${matches.length > 1 ? 's' : ''}:\n${list}\n\nTo order, tell me the product name, quantity, and your delivery address.`;
      }
      if (products.length > 0) {
        const list = products.slice(0, 3).map((p) => `• ${p.name} — ₦${p.price.toLocaleString()}`).join('\n');
        return `We couldn't find an exact match for "${keyword}", but here are our top items:\n${list}\nWhat are you looking for?`;
      }
    }

    // 8. Order Placement Prompt
    if (lower.includes('order') || lower.includes('buy') || lower.includes('want to') || lower.includes('checkout')) {
      return `Great! To place an order, please provide:\n1. Product name\n2. Quantity\n3. Your delivery address\n\nExample: "I want 2 units of [Product Name] delivered to [Your Address]". I will calculate the total and prepare your order.`;
    }

    // Fallback
    return (
      `I can help you browse ${businessName}'s catalog, check prices, verify stock, and place orders.\n` +
      `Try asking: "show me products", "what is the price of [item]?", or "is [item] available?".`
    );
  },

  /**
   * Parse incoming Meta Webhook payload or simulated tester body
   */
  parseIncomingPayload(reqBody) {
    // 1. Direct simulated tester payload from frontend
    if (reqBody.from && reqBody.body) {
      return {
        from: reqBody.from,
        body: reqBody.body,
        businessPhone: reqBody.businessPhone || '',
        messageId: reqBody.messageId || 'wmid_' + Date.now().toString(36),
      };
    }

    // 2. Official Meta WhatsApp Cloud API Webhook payload
    try {
      const entry = reqBody.entry && reqBody.entry[0];
      const change = entry && entry.changes && entry.changes[0];
      const value = change && change.value;

      if (value && value.messages && value.messages.length > 0) {
        const msg = value.messages[0];
        const businessPhone = (value.metadata && value.metadata.display_phone_number) || '';
        const textBody = msg.text ? msg.text.body : (msg.button ? msg.button.text : '');

        return {
          from: msg.from,
          body: textBody,
          businessPhone,
          messageId: msg.id,
        };
      }
    } catch (err) {
      logger.warn('Error parsing WhatsApp Cloud API payload:', { error: err.message });
    }

    return null;
  },
};

module.exports = webhookService;
