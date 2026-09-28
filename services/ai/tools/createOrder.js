/**
 * AI Tool: createOrder
 */

const orderService = require('../../orders/orderService');
const { comparablePhone } = require('../toolGuards');

const definition = {
  type: 'function',
  function: {
    name: 'createOrder',
    description: 'Place an authoritative order in the system after customer has confirmed all items, quantities, and delivery address.',
    parameters: {
      type: 'object',
      properties: {
        customer: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Customer full name' },
            phone: { type: 'string', description: 'Customer phone number' },
            address: { type: 'string', description: 'Delivery street address and city' },
          },
          required: ['name', 'phone', 'address'],
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              productId: { type: 'string' },
              quantity: { type: 'number' },
              variantId: { type: 'string' },
            },
            required: ['productId', 'quantity'],
          },
        },
        deliveryAddress: {
          type: 'string',
          description: 'Delivery address override',
        },
      },
      required: ['customer', 'items'],
    },
  },
};

async function execute(sellerId, args, context = {}) {
  const customer = { ...args.customer };

  // In a customer conversation the buyer is whoever we are chatting with, so
  // the agent cannot be talked into filing an order under another number.
  // A seller working in their own console (trusted) may set it explicitly.
  const counterparty = comparablePhone(context.customerPhone);
  if (!context.trusted && context.channel === 'telegram' && !counterparty) {
    const err = new Error('Please use the Share phone number button before placing an order.');
    err.statusCode = 400;
    throw err;
  }
  if (!context.trusted && counterparty) {
    customer.phone = counterparty;
    if (context.shopperId) customer.shopperId = context.shopperId;
  }

  return orderService.create(
    sellerId,
    {
      customer,
      shopperId: context.shopperId || null,
      items: args.items,
      deliveryAddress: args.deliveryAddress || customer.address,
    },
    undefined,
    {
      source: context.channel === 'telegram' ? 'telegram' : 'storefront',
      channel: context.channel || 'storefront',
      channelAccountId: context.channelAccountId || '',
      channelUserId: context.channelUserId || '',
      channelUsername: context.channelUsername || '',
    }
  );
}

module.exports = {
  definition,
  execute,
};
