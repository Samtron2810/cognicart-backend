/**
 * AI Tool: searchProducts
 */

const productService = require('../../products/productService');

const definition = {
  type: 'function',
  function: {
    name: 'searchProducts',
    description: 'Search the active catalog for products matching a query or category under the current seller.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword (product name, description, variant or SKU)',
        },
        category: {
          type: 'string',
          description: 'Filter by category name (e.g. Fashion, Skincare, Food)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of items to return (default: 5)',
        },
      },
      required: [],
    },
  },
};

async function execute(sellerId, args = {}) {
  const limit = Math.min(Number(args.limit) || 5, 10);
  const products = await productService.list({
    sellerId,
    search: args.query || '',
    category: args.category || '',
    isPublic: true,
  });

  return products.slice(0, limit).map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price,
    stock: p.stock,
    category: p.category,
    description: p.description,
    hasDiscount: !!(p.discount && p.discount.active),
    variants: (p.variants || []).map((v) => ({
      id: v.id,
      size: v.size,
      color: v.color,
      price: v.price || p.price,
      stock: v.stock,
    })),
  }));
}

module.exports = {
  definition,
  execute,
};
