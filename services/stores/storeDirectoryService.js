/**
 * Public Seller Directory Service
 *
 * Powers the seller-first storefront: /stores lists *sellers*, not products.
 * Each card is a store — logo, name, short description, how many products it
 * stocks, its rating — and clicking through is the only way into a catalog.
 *
 * Ordering comes from Business.rankingScore, which the hourly ranking job
 * maintains. Serving the directory is therefore an indexed sort, not a
 * computation, which is what keeps it cheap. Near-ties are shuffled with an
 * hour-stable seed so exposure rotates without breaking pagination.
 */

const Business = require('../../models/Business');
const Product = require('../../models/Product');
const rankingService = require('../ranking/rankingService');
const { slugify } = require('../../utils/slug');
const { escapeRegex } = require('../../utils/validators');

const MAX_LIMIT = 48;
const DEFAULT_LIMIT = 24;
/** The promoted strip is deliberately small — small icons, not big cards. */
const PROMOTED_MAX = 8;

/**
 * Trim a store description down to something that fits on a card without
 * cutting a word in half.
 */
function shortDescription(text, maxLength = 120) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  const cut = clean.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Shape a Business document for a public directory card.
 * Deliberately narrow: bank details, Telegram secrets, phone and email are
 * not directory data and never appear here.
 */
function toDirectoryCard(business, now = new Date()) {
  const sponsored = rankingService.isSponsorshipActive(business, now);
  const ratingCount = business.ratingCount || 0;

  return {
    sellerId: business.sellerId,
    slug: business.slug || slugify(business.name),
    name: business.name,
    description: shortDescription(business.description),
    logo: business.logo || '',
    productCount: business.activeProductCount || 0,
    // `null` rather than 0: "not rated yet" and "rated zero" are different
    // things, and the UI has to be able to tell them apart.
    rating: ratingCount > 0 ? Math.round((business.ratingAvg || 0) * 10) / 10 : null,
    ratingCount,
    isSponsored: sponsored,
    // Drives the "New" badge. Same window the ranking boost uses, so the badge
    // and the boost can never disagree.
    isNew: rankingService.newSellerBoost(business.createdAt, now) > 0,
    deliveryTime: business.deliveryTime || '',
    createdAt: business.createdAt,
  };
}

const storeDirectoryService = {
  /**
   * Paginated public list of sellers.
   *
   * @param {object} [query]
   * @param {number|string} [query.page=1]
   * @param {number|string} [query.limit=24]
   * @param {string} [query.q]            Filter by store name
   * @param {string} [query.sort]         'ranked' (default) | 'newest' | 'name' | 'products'
   * @param {boolean} [query.includeEmpty=false] Include stores with no live products
   */
  async listStores({ page = 1, limit = DEFAULT_LIMIT, q = '', sort = 'ranked', includeEmpty = false } = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(MAX_LIMIT, parseInt(limit, 10) || DEFAULT_LIMIT));
    const now = new Date();

    const filter = { isListed: { $ne: false } };

    // A store with nothing in stock is a dead end for a buyer, so it is hidden
    // from the directory by default. It stays reachable by direct link.
    if (!(includeEmpty === true || includeEmpty === 'true')) {
      filter.activeProductCount = { $gt: 0 };
    }

    const term = String(q || '').trim();
    if (term) {
      const safe = escapeRegex(term.slice(0, 80));
      filter.$or = [
        { name: { $regex: safe, $options: 'i' } },
        { description: { $regex: safe, $options: 'i' } },
      ];
    }

    const sortSpec =
      {
        newest: { createdAt: -1 },
        name: { name: 1 },
        products: { activeProductCount: -1 },
      }[sort] || { rankingScore: -1, createdAt: -1 };

    const [rows, total] = await Promise.all([
      Business.find(filter)
        .sort(sortSpec)
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      Business.countDocuments(filter),
    ]);

    let stores = rows.map((row) => toDirectoryCard(row, now));

    // Fairness shuffle, applied only to the default ranked ordering: an
    // explicit "sort by name" must stay alphabetical.
    if (sortSpec.rankingScore) {
      const withScores = rows.map((row, index) => ({
        rankingScore: row.rankingScore || 0,
        card: stores[index],
      }));
      stores = rankingService
        .shuffleTieGroups(withScores, rankingService.currentShuffleSeed(now))
        .map((entry) => entry.card);
    }

    const totalPages = Math.ceil(total / limitNum) || 1;

    return {
      stores,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages,
        hasMore: pageNum < totalPages,
      },
    };
  },

  /**
   * The small "Promoted Products" / "Trending Now" strip above the seller list.
   *
   * Hard-capped at 8. This is a strip of small icons by design — it must not
   * grow into a second product grid that buries the sellers underneath it.
   */
  async listPromotedProducts({ limit = PROMOTED_MAX } = {}) {
    const limitNum = Math.max(1, Math.min(PROMOTED_MAX, parseInt(limit, 10) || PROMOTED_MAX));
    const now = new Date();

    const products = await Product.find({
      isPromoted: true,
      isActive: true,
      // An expired promotion stops showing even if the flag was left on.
      $or: [{ promotedUntil: null }, { promotedUntil: { $gt: now } }],
    })
      .limit(limitNum * 3) // headroom: some sellers may be unlisted
      .lean();

    if (!products.length) return { products: [] };

    // Rank promoted items by their seller's score so the strip inherits the
    // same fairness rules as the directory rather than being first-come.
    const sellerIds = [...new Set(products.map((p) => String(p.sellerId)))];
    const businesses = await Business.find({ sellerId: { $in: sellerIds } })
      .select('sellerId name slug logo rankingScore isListed')
      .lean();

    const bySeller = new Map(businesses.map((b) => [String(b.sellerId), b]));

    const ranked = products
      .map((product) => {
        const store = bySeller.get(String(product.sellerId));
        return { product, store, rankingScore: store ? store.rankingScore || 0 : -1 };
      })
      .filter((entry) => entry.store && entry.store.isListed !== false)
      .sort((a, b) => b.rankingScore - a.rankingScore);

    const shuffled = rankingService
      .shuffleTieGroups(ranked, rankingService.currentShuffleSeed(now))
      .slice(0, limitNum);

    return {
      products: shuffled.map(({ product, store }) => ({
        id: String(product._id),
        name: product.name,
        price: product.price,
        currency: product.currency || 'NGN',
        image: (product.images && product.images[0]) || '',
        discount: product.discount || null,
        sellerId: product.sellerId,
        storeName: store.name,
        storeSlug: store.slug || slugify(store.name),
        storeLogo: store.logo || '',
      })),
    };
  },

  /**
   * A handful of other stores, for the "Other Stores" quick-jump bar inside a
   * store page. Excludes the store currently being viewed.
   */
  async listOtherStores(excludeSellerId, limit = 10) {
    const limitNum = Math.max(1, Math.min(20, parseInt(limit, 10) || 10));
    const now = new Date();

    const rows = await Business.find({
      isListed: { $ne: false },
      activeProductCount: { $gt: 0 },
      sellerId: { $ne: excludeSellerId },
    })
      .sort({ rankingScore: -1 })
      .limit(limitNum)
      .lean();

    return {
      stores: rows.map((row) => {
        const card = toDirectoryCard(row, now);
        return {
          sellerId: card.sellerId,
          slug: card.slug,
          name: card.name,
          logo: card.logo,
          productCount: card.productCount,
        };
      }),
    };
  },

  toDirectoryCard,
  shortDescription,
};

module.exports = storeDirectoryService;
