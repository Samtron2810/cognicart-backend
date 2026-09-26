/**
 * AI Tool: getBusinessInformation
 */

const businessService = require('../../sellers/businessService');

const definition = {
  type: 'function',
  function: {
    name: 'getBusinessInformation',
    description: 'Retrieve authoritative business policies including delivery timelines, delivery fees, accepted payment methods, and contact details.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
};

async function execute(sellerId) {
  const business = await businessService.getBySellerId(sellerId);
  return {
    name: business ? business.name : 'Store',
    location: business ? business.location : '',
    deliveryInfo: business && business.deliveryInfo ? business.deliveryInfo : 'Lagos 1-2 days, outside Lagos 2-4 days',
    deliveryFee: business && business.deliveryFee !== undefined ? business.deliveryFee : 1500,
    freeDeliveryThreshold: business ? business.freeDeliveryThreshold : 25000,
    paymentMethod: business && business.paymentMethod ? business.paymentMethod : 'both',
  };
}

module.exports = {
  definition,
  execute,
};
