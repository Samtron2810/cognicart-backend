/** Buyer-scoped recent order history tool. */

const orderService = require('../../orders/orderService');

const definition = {
  type: 'function',
  function: {
    name: 'listOrders',
    description: 'List recent orders belonging only to the buyer in the current conversation.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Optional fulfillment status filter' },
        paymentStatus: { type: 'string', description: 'Optional payment status filter' },
        limit: { type: 'number', description: 'Maximum recent orders, up to 10' },
      },
      required: [],
    },
  },
};

function present(order) {
  return {
    id: order.id,
    reference: order.reference,
    orderNumber: order.orderNumber,
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    total: order.total,
    items: (order.items || []).map((item) => ({
      name: item.name,
      quantity: item.quantity,
      variantLabel: item.variantLabel || '',
    })),
    createdAt: order.createdAt,
  };
}

async function execute(sellerId, args = {}, context = {}) {
  const orders = await orderService.listForCounterparty(sellerId, context, {
    status: args.status,
    paymentStatus: args.paymentStatus,
    limit: args.limit || 5,
  });
  return orders.map(present);
}

module.exports = { definition, execute, present };
