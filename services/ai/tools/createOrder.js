/**
 * AI Tool: createOrder
 */

const orderService = require('../../orders/orderService');

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

async function execute(sellerId, args) {
  return orderService.create(sellerId, {
    customer: args.customer,
    items: args.items,
    deliveryAddress: args.deliveryAddress || args.customer.address,
  });
}

module.exports = {
  definition,
  execute,
};
