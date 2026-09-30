/**
 * AI Sales Agent Service
 * Uses OpenAI function calling when configured and a durable deterministic
 * commerce state machine otherwise.
 */

const { getSystemPrompt } = require('./prompts/systemPrompt');
const businessService = require('../sellers/businessService');
const searchProducts = require('./tools/searchProducts');
const getProduct = require('./tools/getProduct');
const checkStock = require('./tools/checkStock');
const getBusinessInformation = require('./tools/getBusinessInformation');
const calculateOrderTotal = require('./tools/calculateOrderTotal');
const createOrder = require('./tools/createOrder');
const listOrders = require('./tools/listOrders');
const getOrder = require('./tools/getOrder');
const cancelOrder = require('./tools/cancelOrder');
const createPayment = require('./tools/createPayment');
const agentSessionService = require('./agentSessionService');
const { createDeterministicAgent } = require('./deterministicAgent');
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
  listOrders: listOrders.execute,
  getOrder: getOrder.execute,
  cancelOrder: cancelOrder.execute,
  createPayment: createPayment.execute,
};

const toolsDefinitions = [
  searchProducts.definition,
  getProduct.definition,
  checkStock.definition,
  getBusinessInformation.definition,
  calculateOrderTotal.definition,
  createOrder.definition,
  listOrders.definition,
  getOrder.definition,
  cancelOrder.definition,
  createPayment.definition,
];

const deterministicAgent = createDeterministicAgent({
  tools: toolsRegistry,
  sessions: agentSessionService,
});

function sessionKeyFor(input) {
  return agentSessionService.resolveSessionKey(input);
}

function toolContextFor({
  sellerId,
  customerPhone,
  customerName = '',
  customerEmail = '',
  shopperId = null,
  channel = '',
  channelAccountId = '',
  channelUserId = '',
  channelUsername = '',
  trusted = false,
}) {
  return buildToolContext({
    sellerId,
    customerPhone,
    customerName,
    customerEmail,
    shopperId,
    channel,
    channelAccountId,
    channelUserId,
    channelUsername,
    trusted,
  });
}

const aiService = {
  /** Main conversational-commerce loop. */
  async chat({
    sellerId,
    customerPhone,
    customerName = '',
    customerEmail = '',
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
    if (!sellerId || !body) throw new Error('sellerId and message body are required');

    const toolContext = toolContextFor({
      sellerId,
      customerPhone,
      customerName,
      customerEmail,
      shopperId,
      channel,
      channelAccountId,
      channelUserId,
      channelUsername,
      trusted,
    });
    const business = await businessService.getBySellerId(sellerId);
    const businessName = business ? business.name : 'Store';
    const deliveryInfo = business ? business.deliveryInfo : '';
    const paymentInfo = business ? business.paymentMethod : '';
    const cleanBody = sanitize(body, 4000);

    // Use OpenAI when configured. All side effects still pass through the same
    // seller/counterparty-scoped tools as the deterministic agent.
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey && !apiKey.includes('your_')) {
      try {
        const OpenAI = require('openai');
        const openai = new OpenAI({ apiKey });
        const systemPrompt = getSystemPrompt({
          businessName,
          deliveryInfo,
          paymentInfo,
          channel: channel || 'web chat',
          contactAvailable: Boolean(customerPhone && /^\+?[\d\s()\-]+$/.test(customerPhone)),
        });
        const messages = [
          { role: 'system', content: systemPrompt },
          ...history.slice(-6).map((item) => ({ role: item.role, content: item.content })),
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

        while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
          messages.push(responseMessage);
          for (const toolCall of responseMessage.tool_calls) {
            const toolName = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments || '{}');
            const executor = toolsRegistry[toolName];
            let result;
            if (!executor) {
              result = { error: `Tool ${toolName} not found` };
            } else {
              try {
                result = await executor(sellerId, args, toolContext);
              } catch (error) {
                result = { error: error.message };
              }
            }
            toolCallsExecuted.push({ id: toolCall.id, name: toolName, arguments: args, result });
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(result),
            });
          }

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
      } catch (error) {
        logger.warn('OpenAI unavailable; using deterministic commerce agent:', { error: error.message });
      }
    }

    const sessionKey = sessionKeyFor({
      conversationKey,
      channel,
      channelAccountId,
      channelUserId,
      shopperId,
      customerPhone,
    });
    return deterministicAgent.run({
      sellerId,
      sessionKey,
      customerPhone,
      customerName,
      customerEmail,
      businessName,
      body: cleanBody,
      toolContext,
    });
  },

  /**
   * Continue a saved deterministic checkout immediately after Telegram verifies
   * the buyer's shared contact.
   */
  async resumeAfterContact({
    sellerId,
    customerPhone,
    customerName = '',
    customerEmail = '',
    channel = 'telegram',
    channelAccountId = '',
    channelUserId = '',
    channelUsername = '',
    conversationKey = '',
  }) {
    const toolContext = toolContextFor({
      sellerId,
      customerPhone,
      customerName,
      customerEmail,
      channel,
      channelAccountId,
      channelUserId,
      channelUsername,
    });
    const business = await businessService.getBySellerId(sellerId);
    const sessionKey = sessionKeyFor({
      conversationKey,
      channel,
      channelAccountId,
      channelUserId,
      customerPhone,
    });
    return deterministicAgent.resumeAfterContact({
      sellerId,
      sessionKey,
      customerPhone,
      customerName,
      customerEmail,
      businessName: business ? business.name : 'Store',
      toolContext,
    });
  },

  /** Backwards-compatible direct entry used by older callers/tests. */
  async fallbackToolAgent(
    sellerId,
    customerPhone,
    body,
    businessName,
    toolContext = null,
    conversationKey = customerPhone
  ) {
    const context = toolContext || toolContextFor({ sellerId, customerPhone });
    return deterministicAgent.run({
      sellerId,
      sessionKey: sessionKeyFor({ conversationKey, customerPhone }),
      customerPhone,
      customerName: context.customerName || '',
      customerEmail: context.customerEmail || '',
      businessName,
      body,
      toolContext: context,
    });
  },
};

module.exports = aiService;
