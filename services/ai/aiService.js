/**
 * AI Sales Agent Service
 * Orchestrates OpenAI function calling and backend tools for conversational commerce
 */

const { getSystemPrompt } = require('./prompts/systemPrompt');
const businessService = require('../sellers/businessService');
const searchProducts = require('./tools/searchProducts');
const getProduct = require('./tools/getProduct');
const checkStock = require('./tools/checkStock');
const getBusinessInformation = require('./tools/getBusinessInformation');
const calculateOrderTotal = require('./tools/calculateOrderTotal');
const createOrder = require('./tools/createOrder');
const getOrder = require('./tools/getOrder');
const createPayment = require('./tools/createPayment');
const logger = require('../../utils/logger');
const { sanitize } = require('../../utils/validators');
const { buildToolContext } = require('./toolGuards');

const toolsRegistry = {
  searchProducts: searchProducts.execute,
  getProduct: getProduct.execute,
  checkStock: checkStock.execute,
  getBusinessInformation: getBusinessInformation.execute,
  calculateOrderTotal: calculateOrderTotal.execute,
  createOrder: createOrder.execute,
  getOrder: getOrder.execute,
  createPayment: createPayment.execute,
};

const toolsDefinitions = [
  searchProducts.definition,
  getProduct.definition,
  checkStock.definition,
  getBusinessInformation.definition,
  calculateOrderTotal.definition,
  createOrder.definition,
  getOrder.definition,
  createPayment.definition,
];

// Conversation session state store for customer interactions
const contextStore = new Map();

function getContext(sellerId, contextKey, customerPhone) {
  const key = `${sellerId}_${contextKey}`;
  if (!contextStore.has(key)) {
    contextStore.set(key, { sellerId, customerPhone, contextKey });
  }
  const context = contextStore.get(key);
  // A Telegram contact may become known after the conversation starts.
  context.customerPhone = customerPhone;
  return context;
}

function saveContext(ctx) {
  contextStore.set(`${ctx.sellerId}_${ctx.contextKey || ctx.customerPhone}`, ctx);
}

const aiService = {
  /**
   * Main conversational commerce chat loop
   */
  async chat({
    sellerId,
    customerPhone,
    body,
    history = [],
    shopperId = null,
    channel = '',
    channelAccountId = '',
    channelUserId = '',
    channelUsername = '',
    conversationKey = '',
    trusted = false,
  }) {
    // Identity of who we are talking to; tools are scoped to it so per-customer
    // data cannot be read by another customer of the same store.
    const toolContext = buildToolContext({
      sellerId,
      customerPhone,
      shopperId,
      channel,
      channelAccountId,
      channelUserId,
      channelUsername,
      trusted,
    });
    if (!sellerId || !body) {
      throw new Error('sellerId and message body are required');
    }

    const business = await businessService.getBySellerId(sellerId);
    const businessName = business ? business.name : 'Store';
    const deliveryInfo = business ? business.deliveryInfo : '';
    const paymentInfo = business ? business.paymentMethod : '';

    const systemPrompt = getSystemPrompt({
      businessName,
      deliveryInfo,
      paymentInfo,
      channel: channel || 'web chat',
      contactAvailable: Boolean(customerPhone && /^\+?[\d\s()\-]+$/.test(customerPhone)),
    });
    const cleanBody = sanitize(body, 4000);

    // If live OpenAI key is configured, use official SDK with function calling
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey && !apiKey.includes('your_')) {
      try {
        const OpenAI = require('openai');
        const openai = new OpenAI({ apiKey });

        const messages = [
          { role: 'system', content: systemPrompt },
          ...history.slice(-6).map((h) => ({ role: h.role, content: h.content })),
          { role: 'user', content: cleanBody },
        ];

        let response = await openai.chat.completions.create({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          messages,
          tools: toolsDefinitions,
          tool_choice: 'auto',
          temperature: 0.2,
        });

        let responseMessage = response.choices[0].message;
        const toolCallsExecuted = [];

        // Function execution loop
        while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
          messages.push(responseMessage);

          for (const toolCall of responseMessage.tool_calls) {
            const toolName = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments || '{}');
            const executor = toolsRegistry[toolName];

            let result = null;
            if (executor) {
              try {
                result = await executor(sellerId, args, toolContext);
              } catch (err) {
                result = { error: err.message };
              }
            } else {
              result = { error: `Tool ${toolName} not found` };
            }

            toolCallsExecuted.push({
              id: toolCall.id,
              name: toolName,
              arguments: args,
              result,
            });

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(result),
            });
          }

          // Follow-up completion after tool results
          response = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            messages,
          });
          responseMessage = response.choices[0].message;
        }

        return {
          reply: responseMessage.content,
          toolCalls: toolCallsExecuted,
          intent: 'ai_completion',
        };
      } catch (err) {
        logger.warn('OpenAI API call failed or unavailable, falling back to tool execution agent:', { error: err.message });
      }
    }

    // Intelligent Deterministic Tool Execution Agent (fallback for offline/dev/test)
    return this.fallbackToolAgent(
      sellerId,
      customerPhone,
      cleanBody,
      businessName,
      toolContext,
      conversationKey || (channel && channelUserId ? `${channel}:${channelUserId}` : customerPhone)
    );
  },

  /**
   * Deterministic Tool Execution Agent
   * Orchestrates the exact same backend tools without requiring external OpenAI network access
   */
  async fallbackToolAgent(
    sellerId,
    customerPhone,
    body,
    businessName,
    toolContext = null,
    conversationKey = customerPhone
  ) {
    const ctxScope = toolContext || buildToolContext({ sellerId, customerPhone });
    const lower = body.toLowerCase().trim();
    const ctx = getContext(sellerId, conversationKey, customerPhone);
    const toolCalls = [];

    // 1. Order Confirmation handling (when awaiting YES / CONFIRM)
    if (ctx.awaitingConfirmation && (lower === 'yes' || lower === 'confirm' || lower === 'yes please' || lower === 'place order')) {
      ctx.awaitingConfirmation = false;
      const toolCallId = 'call_' + Date.now();
      const orderArgs = {
        customer: {
          name: ctx.customerName || `Customer (${customerPhone.slice(-4)})`,
          phone: customerPhone,
          address: ctx.pendingAddress || 'Pickup / Store address',
        },
        items: [{ productId: ctx.pendingProductId, quantity: ctx.pendingQuantity || 1 }],
      };

      try {
        const order = await toolsRegistry.createOrder(sellerId, orderArgs, ctxScope);
        toolCalls.push({ id: toolCallId, name: 'createOrder', arguments: orderArgs, result: order });
        ctx.lastOrderId = order.id;
        saveContext(ctx);

        return {
          reply: (
            `🎉 Order Confirmed! Your Order ID is #${order.id.slice(-6).toUpperCase()}.\n` +
            `Total: ₦${order.total.toLocaleString()} (including ₦${order.deliveryFee.toLocaleString()} delivery).\n` +
            `Delivery Address: ${order.deliveryAddress}\n\n` +
            `Reply "PAY" to generate your instant Paystack payment link.`
          ),
          toolCalls,
          intent: 'order_confirmed',
          orderId: order.id,
        };
      } catch (err) {
        return {
          reply: `Could not complete order: ${err.message}`,
          toolCalls,
          intent: 'order_failed',
        };
      }
    }

    // 2. Greetings
    if (/^(hi|hello|hey|good morning|good afternoon)\b/i.test(lower)) {
      const toolCallId = 'call_' + Date.now();
      const products = await toolsRegistry.searchProducts(sellerId, { limit: 3 }, ctxScope);
      toolCalls.push({ id: toolCallId, name: 'searchProducts', arguments: { limit: 3 }, result: products });

      const list = products.map((p) => `• ${p.name} — ₦${p.price.toLocaleString()} (${p.stock > 0 ? `${p.stock} in stock` : 'out of stock'})`).join('\n');
      return {
        reply: (
          `Hello! Welcome to ${businessName}. I can help you find products, check prices, and place orders.\n\n` +
          `Top available items:\n${list}\n\n` +
          `What product are you looking for today?`
        ),
        toolCalls,
        intent: 'greeting',
      };
    }

    // 3. Payment Request
    if (lower === 'pay' || lower.includes('payment link') || lower.includes('how to pay')) {
      const orderId = ctx.lastOrderId;
      if (!orderId) {
        return {
          reply: 'You do not have a pending order yet. Please choose a product to place an order first.',
          toolCalls: [],
          intent: 'no_order',
        };
      }

      const toolCallId = 'call_' + Date.now();
      const payResult = await toolsRegistry.createPayment(sellerId, { orderId }, ctxScope);
      toolCalls.push({ id: toolCallId, name: 'createPayment', arguments: { orderId }, result: payResult });

      return {
        reply: (
          `💳 Payment link ready for Order #${orderId.slice(-6).toUpperCase()}!\n` +
          `Amount: ₦${payResult.amount.toLocaleString()}\n` +
          `Reference: ${payResult.reference}\n\n` +
          `Pay now: ${payResult.authorization_url}`
        ),
        toolCalls,
        intent: 'payment_ready',
        orderId,
      };
    }

    // 4. Order Initiation Intent with Address & Quantity
    const hasOrderIntent = lower.includes('want') || lower.includes('order') || lower.includes('buy') || lower.includes('need') || lower.includes('units');
    const hasAddress = lower.includes('street') || lower.includes('road') || lower.includes('avenue') || lower.includes('way') || lower.includes('lagos') || lower.includes('ikeja') || lower.includes('deliver to') || lower.includes('delivered to');

    if (hasOrderIntent && hasAddress) {
      const qtyMatch = lower.match(/\b([1-9]|10)\b/);
      const qty = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;
      const targetId = ctx.pendingProductId || (await toolsRegistry.searchProducts(sellerId, { limit: 1 }, ctxScope))[0]?.id;

      if (targetId) {
        const totalCalc = await toolsRegistry.calculateOrderTotal(sellerId, { items: [{ productId: targetId, quantity: qty }] }, ctxScope);
        ctx.pendingProductId = targetId;
        ctx.pendingQuantity = qty;
        ctx.pendingAddress = body;
        ctx.awaitingConfirmation = true;
        saveContext(ctx);

        const targetProduct = await toolsRegistry.getProduct(sellerId, { productId: targetId }, ctxScope);
        return {
          reply: (
            `Order Summary:\n` +
            `• ${targetProduct.name} x${qty} — ₦${totalCalc.subtotal.toLocaleString()}\n` +
            `• Delivery Fee: ₦${totalCalc.deliveryFee.toLocaleString()}\n` +
            `• Total Amount: ₦${totalCalc.total.toLocaleString()}\n\n` +
            `Please reply "YES" to confirm and place your order.`
          ),
          toolCalls: [{ id: 'call_' + Date.now(), name: 'calculateOrderTotal', arguments: { items: [{ productId: targetId, quantity: qty }] }, result: totalCalc }],
          intent: 'confirm_order',
        };
      }
    }

    // 5. Delivery & Store Info (FAQ queries)
    if (
      (lower.includes('deliver') || lower.includes('shipping') || lower.includes('location')) &&
      !hasOrderIntent
    ) {
      const toolCallId = 'call_' + Date.now();
      const info = await toolsRegistry.getBusinessInformation(sellerId);
      toolCalls.push({ id: toolCallId, name: 'getBusinessInformation', arguments: {}, result: info });

      return {
        reply: `Delivery Information for ${businessName}: ${info.deliveryInfo}. Delivery fee is ₦${info.deliveryFee.toLocaleString()} (free over ₦${info.freeDeliveryThreshold.toLocaleString()}).`,
        toolCalls,
        intent: 'business_info',
      };
    }

    // 5. Catalog Search & Product Inquiries
    const cleanSearchQuery = lower
      .replace(/^(show|search|find|need|want|looking for|is|are|how much is|what is the price of|price of)\s+/i, '')
      .replace(/^(the|a|an)\s+/i, '')
      .replace(/[?!.,;]/g, '')
      .trim();
    const products = await toolsRegistry.searchProducts(sellerId, { query: cleanSearchQuery, limit: 3 }, ctxScope);
    const toolCallId = 'call_' + Date.now();
    toolCalls.push({ id: toolCallId, name: 'searchProducts', arguments: { query: cleanSearchQuery }, result: products });

    if (products.length > 0) {
      const target = products[0];
      if (lower.includes('price') || lower.includes('how much') || lower.includes('cost')) {
        return {
          reply: `${target.name} is ₦${target.price.toLocaleString()} and is ${target.stock > 0 ? `in stock (${target.stock} units)` : 'out of stock'}. Would you like to order?`,
          toolCalls,
          intent: 'price_check',
        };
      }

      // Check if user specified quantity and address to initiate an order
      const qtyMatch = lower.match(/\b([1-9]|10)\b/);
      const hasAddress = lower.includes('street') || lower.includes('road') || lower.includes('avenue') || lower.includes('lagos') || lower.includes('ikeja') || lower.includes('deliver to');

      if (hasAddress && target.stock > 0) {
        const qty = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;
        const totalCalc = await toolsRegistry.calculateOrderTotal(sellerId, { items: [{ productId: target.id, quantity: qty }] }, ctxScope);

        ctx.pendingProductId = target.id;
        ctx.pendingQuantity = qty;
        ctx.pendingAddress = body;
        ctx.awaitingConfirmation = true;
        saveContext(ctx);

        return {
          reply: (
            `Order Summary:\n` +
            `• ${target.name} x${qty} — ₦${totalCalc.subtotal.toLocaleString()}\n` +
            `• Delivery Fee: ₦${totalCalc.deliveryFee.toLocaleString()}\n` +
            `• Total Amount: ₦${totalCalc.total.toLocaleString()}\n\n` +
            `Please reply "YES" to confirm and place your order.`
          ),
          toolCalls,
          intent: 'confirm_order',
        };
      }

      const list = products.map((p) => `• ${p.name} — ₦${p.price.toLocaleString()} (${p.stock > 0 ? `${p.stock} in stock` : 'out of stock'})`).join('\n');
      return {
        reply: `Here are the matching products from ${businessName}:\n${list}\n\nTo order, tell me the product name, quantity, and delivery address.`,
        toolCalls,
        intent: 'search_results',
      };
    }

    return {
      reply: `I couldn't find a matching product for "${cleanSearchQuery}". What product are you looking for?`,
      toolCalls: [],
      intent: 'fallback',
    };
  },
};

module.exports = aiService;
