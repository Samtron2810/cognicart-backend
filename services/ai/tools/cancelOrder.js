/** Buyer-scoped pre-fulfillment order cancellation tool. */

const orderService = require('../../orders/orderService');

const definition = {
  type: 'function',
  function: {
    name: 'cancelOrder',
    description: 'Cancel an unpaid Pending or Confirmed order owned by the buyer in this conversation.',
    parameters: {
      type: 'object',
      properties: {
        orderId: { type: 'string', description: 'Order ObjectId or human reference such as #00012' },
        reason: { type: 'string', description: 'Optional cancellation reason' },
      },
      required: ['orderId'],
    },
  },
};

async function execute(sellerId, args, context = {}) {
  if (!args || !args.orderId) throw new Error('Order reference is required');
  const order = await orderService.cancelForCounterparty(
    sellerId,
    args.orderId,
    context,
    args.reason || 'Cancelled by buyer in Telegram'
  );
  return {
    id: order.id,
    reference: order.reference,
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    inventoryRestored: Boolean(order.inventoryRestoredAt),
    cancelledAt: order.cancelledAt,
  };
}

module.exports = { definition, execute };
