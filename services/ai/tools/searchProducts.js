/**
 * AI Tool: ranked, seller-scoped product discovery.
 *
 * Conversational queries are matched by meaningful tokens rather than as one
 * literal sentence. Small retail synonym groups and singular/plural forms make
 * deterministic searches such as "shoe" match a product named "Sneakers".
 */

const productService = require('../../products/productService');
const { getEffectivePrice } = require('../../../models/Product');

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
          description: 'Search keyword (product name, description, category, variant or SKU)',
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

const SYNONYM_GROUPS = [
  ['shoe', 'shoes', 'sneaker', 'sneakers', 'trainer', 'trainers', 'footwear'],
  ['shirt', 'shirts', 'tshirt', 'tshirts', 'tee', 'tees', 'top', 'tops'],
  ['trouser', 'trousers', 'pants', 'jean', 'jeans'],
  ['phone', 'phones', 'smartphone', 'smartphones', 'mobile', 'mobiles', 'handset', 'handsets'],
  ['bag', 'bags', 'handbag', 'handbags', 'backpack', 'backpacks', 'purse', 'purses'],
  ['slipper', 'slippers', 'slide', 'slides', 'sandal', 'sandals'],
  ['child', 'children', 'kid', 'kids', 'baby', 'babies'],
];

const SYNONYMS = new Map();
for (const group of SYNONYM_GROUPS) {
  for (const word of group) SYNONYMS.set(word, new Set(group));
}

function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordForms(word) {
  const forms = new Set([word]);
  const synonyms = SYNONYMS.get(word);
  if (synonyms) for (const synonym of synonyms) forms.add(synonym);

  if (word.length > 3) {
    if (word.endsWith('ies')) forms.add(`${word.slice(0, -3)}y`);
    if (word.endsWith('es')) forms.add(word.slice(0, -2));
    if (word.endsWith('s')) forms.add(word.slice(0, -1));
    else {
      forms.add(`${word}s`);
      if (word.endsWith('y')) forms.add(`${word.slice(0, -1)}ies`);
    }
  }
  return [...forms];
}

function scoreProduct(product, query) {
  const cleanQuery = normalize(query);
  if (!cleanQuery) return 1;

  const name = normalize(product.name);
  const category = normalize(product.category);
  const description = normalize(product.description);
  const variants = normalize(
    (product.variants || [])
      .flatMap((variant) => [variant.sku, variant.size, variant.color])
      .filter(Boolean)
      .join(' ')
  );
  const fields = { name, category, description, variants };
  const tokens = [...new Set(cleanQuery.split(' ').filter((token) => token.length > 1))];
  if (tokens.length === 0) return 1;

  let score = 0;
  for (const token of tokens) {
    const forms = wordForms(token);
    let tokenScore = 0;
    for (const form of forms) {
      if (fields.name.split(' ').includes(form)) tokenScore = Math.max(tokenScore, 30);
      else if (fields.name.includes(form)) tokenScore = Math.max(tokenScore, 22);
      if (fields.category.split(' ').includes(form)) tokenScore = Math.max(tokenScore, 18);
      else if (fields.category.includes(form)) tokenScore = Math.max(tokenScore, 12);
      if (fields.variants.split(' ').includes(form)) tokenScore = Math.max(tokenScore, 16);
      else if (fields.variants.includes(form)) tokenScore = Math.max(tokenScore, 10);
      if (fields.description.split(' ').includes(form)) tokenScore = Math.max(tokenScore, 8);
      else if (fields.description.includes(form)) tokenScore = Math.max(tokenScore, 5);
    }
    // Every meaningful concept in the request must match somewhere. This keeps
    // "black shoe" useful without returning every black product or every shoe.
    if (tokenScore === 0) return 0;
    score += tokenScore;
  }

  if (name === cleanQuery) score += 100;
  else if (name.includes(cleanQuery)) score += 50;
  return score;
}

function present(product) {
  return {
    id: product.id,
    name: product.name,
    price: getEffectivePrice(product),
    stock: product.stock,
    category: product.category,
    description: product.description,
    hasDiscount: !!(product.discount && product.discount.active),
    variants: (product.variants || []).map((variant) => ({
      id: variant.id,
      size: variant.size,
      color: variant.color,
      sku: variant.sku,
      price: getEffectivePrice(product, variant),
      stock: variant.stock,
    })),
  };
}

async function execute(sellerId, args = {}) {
  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
  const products = await productService.list({
    sellerId,
    category: args.category || '',
    isPublic: true,
  });
  const query = String(args.query || '').trim();

  if (!query) return products.slice(0, limit).map(present);

  return products
    .map((product) => ({ product, score: scoreProduct(product, query) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => present(entry.product));
}

module.exports = {
  definition,
  execute,
  normalize,
  scoreProduct,
  wordForms,
};
