/**
 * Global Search Service
 *
 * Powers the header type-ahead: one query returns both sellers and products,
 * because on a seller-first marketplace "lumo" is probably a store and
 * "serum" is probably a product, and the buyer should not have to know which
 * tab they are supposed to be on.
 *
 * Results are hard-capped at 3 sellers and 5 products. A type-ahead that
 * returns thirty rows is a page, not a dropdown.
 */

const Business = require('../../models/Business');
const Product = require('../../models/Product');
const { escapeRegex } = require('../../utils/validators');
const { slugify } = require('../../utils/slug');

const SELLER_LIMIT = 3;
const PRODUCT_LIMIT = 5;
const MAX_TERM_LENGTH = 80;

/**
 * Rank sellers so an exact or prefix match beats an incidental one in a
 * description. Typing "lumo" must surface the store called Lumo, not every
 * store whose blurb happens to mention it.
 */
function sellerRelevance(business, term) {
  const name = String(business.name || '').toLowerCase();
  if (name === term) return 3;
  if (name.startsWith(term)) return 2;
  if (name.includes(term)) return 1;
  return 0;
}

const searchService = {
  /**
   * @param {object} query
   * @param {string} query.q
   * @param {number} [query.sellerLimit=3]
   * @param {number} [query.productLimit=5]
   */
  async search({ q = '', sellerLimit = SELLER_LIMIT, productLimit = PRODUCT_LIMIT } = {}) {
    const term = String(q || '').trim().slice(0, MAX_TERM_LENGTH);

    // One character matches almost everything and is never a real query.
    if (term.length < 2) {
      return { query: term, sellers: [], products: [] };
    }

    const sellerCap = Math.max(1, Math.min(10, parseInt(sellerLimit, 10) || SELLER_LIMIT));
    const productCap = Math.max(1, Math.min(20, parseInt(productLimit, 10) || PRODUCT_LIMIT));
    const safe = escapeRegex(term);
    const pattern = { $regex: safe, $options: 'i' };
    const lower = term.toLowerCase();

    const [sellerRows, productRows] = await Promise.all([
      Business.find({
        isListed: { $ne: false },
        activeProductCount: { $gt: 0 },
        $or: [{ name: pattern }, { description: pattern }],
      })
        // Over-fetch, then re-rank by match quality below. Sorting on
        // rankingScore alone would let a big store outrank the store the
        // buyer actually typed the name of.
        .sort({ rankingScore: -1 })
        .limit(sellerCap * 4)
        .lean(),

      Product.find({
        isActive: true,
        $or: [{ name: pattern }, { description: pattern }, { category: pattern }],
      })
        .sort({ createdAt: -1 })
        .limit(productCap * 4)
        .lean(),
    ]);

    const sellers = sellerRows
      .map((business) => ({ business, relevance: sellerRelevance(business, lower) }))
      .sort((a, b) => {
        if (b.relevance !== a.relevance) return b.relevance - a.relevance;
        return (b.business.rankingScore || 0) - (a.business.rankingScore || 0);
      })
      .slice(0, sellerCap)
      .map(({ business }) => ({
        sellerId: business.sellerId,
        slug: business.slug || slugify(business.name),
        name: business.name,
        logo: business.logo || '',
        productCount: business.activeProductCount || 0,
        rating: (business.ratingCount || 0) > 0 ? Math.round((business.ratingAvg || 0) * 10) / 10 : null,
      }));

    // Products need their seller's slug to build a canonical nested URL.
    const trimmed = productRows.slice(0, productCap);
    const sellerIds = [...new Set(trimmed.map((product) => String(product.sellerId)))];
    const stores = sellerIds.length
      ? await Business.find({ sellerId: { $in: sellerIds } })
          .select('sellerId name slug isListed')
          .lean()
      : [];
    const storeById = new Map(stores.map((store) => [String(store.sellerId), store]));

    const products = trimmed
      // A product whose store has left the directory should not be surfaced
      // by a global search either.
      .filter((product) => {
        const store = storeById.get(String(product.sellerId));
        return store && store.isListed !== false;
      })
      .map((product) => {
        const store = storeById.get(String(product.sellerId));
        return {
          id: String(product._id),
          name: product.name,
          price: product.price,
          currency: product.currency || 'NGN',
          image: (product.images && product.images[0]) || '',
          category: product.category || '',
          sellerId: product.sellerId,
          storeName: store.name,
          storeSlug: store.slug || slugify(store.name),
          // The chat assistant and the search dropdown both render an
          // add-to-cart button, which must not fire blind: a variant product
          // needs a size/colour choice and a sold-out one must be disabled.
          stock: (product.variants || []).length
            ? (product.variants || []).reduce((sum, variant) => sum + (variant.stock || 0), 0)
            : product.stock || 0,
          hasVariants: Boolean((product.variants || []).length),
        };
      });

    return { query: term, sellers, products };
  },

  SELLER_LIMIT,
  PRODUCT_LIMIT,
};

module.exports = searchService;
