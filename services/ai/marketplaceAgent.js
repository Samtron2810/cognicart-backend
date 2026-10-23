'use strict';

/**
 * Marketplace Agent — the cross-seller shopping assistant.
 *
 * Deliberately a SEPARATE agent from `aiService`/`deterministicAgent`.
 *
 * Those are single-tenant by construction: every tool takes `sellerId` as its
 * first argument and filters on it, which is what keeps each seller's
 * Telegram bot isolated. Threading a "no seller / all sellers" mode through
 * that tool set would put a null-tenant code path inside the very functions
 * the Telegram bot depends on — one mistake there leaks a catalog into the
 * wrong conversation.
 *
 * So this agent never touches those tools. It reads only through the public
 * directory and search services — the same data any anonymous visitor can
 * already see on /stores and /search — and it cannot read orders, customers
 * or anything seller-private at all.
 *
 * Division of labour when an OpenAI key is present: GPT writes the sentence,
 * the catalog supplies the facts. Products are never invented by the model.
 */

const searchService = require('../search/searchService');
const storeDirectoryService = require('../stores/storeDirectoryService');
const logger = require('../../utils/logger');

const MAX_PRODUCTS = 6;
const MAX_STORES = 4;

const MENU = [
  { label: 'Search products', value: 'SEARCH' },
  { label: 'Browse stores', value: 'STORES' },
  { label: 'Trending now', value: 'TRENDING' },
  { label: 'Help', value: 'HELP' },
];

/** Strip anything that could make the reply look like markup. */
function clean(text) {
  return String(text || '').replace(/[<>]/g, '').trim();
}

function naira(amount) {
  return `₦${Number(amount || 0).toLocaleString('en-NG')}`;
}

/**
 * Classify a message without a model. Order matters: explicit menu tokens
 * first, then keywords, then "treat it as a search term", which is the right
 * default for a shopping assistant.
 */
function classify(body) {
  const text = clean(body).toLowerCase();
  if (!text) return { intent: 'menu' };

  if (['search', 'find'].includes(text)) return { intent: 'search_prompt' };
  if (['stores', 'store', 'shops', 'browse stores', 'sellers'].includes(text)) return { intent: 'stores' };
  if (['trending', 'promoted', 'popular', 'deals'].includes(text)) return { intent: 'trending' };
  if (['help', 'menu', 'start', 'hi', 'hello', 'hey'].includes(text)) return { intent: 'menu' };
  if (['cart', 'my cart', 'checkout'].includes(text)) return { intent: 'cart' };

  if (/^(show|list|browse)\b.*\b(stores?|shops?|sellers?)\b/.test(text)) return { intent: 'stores' };
  if (/\b(trending|promoted|on sale|deals?)\b/.test(text)) return { intent: 'trending' };
  if (/\b(help|how do i|how can i)\b/.test(text)) return { intent: 'menu' };

  // Everything else is a product hunt. Drop the polite scaffolding so
  // "do you have any red shoes" searches for "red shoes".
  const term = text
    .replace(/^(do you (have|sell)|are there|looking for|i want|i need|show me|find me|search for|find|search)\s+/i, '')
    .replace(/\b(any|some|please|pls)\b/gi, '')
    .replace(/[?!.]+$/, '')
    .trim();

  return { intent: 'search', term: term || text };
}

/** Compact product shape the chat widget renders as a card. */
function toCard(product) {
  return {
    id: product.id,
    name: product.name,
    price: product.price,
    currency: product.currency || 'NGN',
    image: product.image || '',
    category: product.category || '',
    sellerId: product.sellerId,
    storeName: product.storeName || '',
    storeSlug: product.storeSlug || '',
    stock: typeof product.stock === 'number' ? product.stock : null,
    hasVariants: Boolean(product.hasVariants),
  };
}

const marketplaceAgent = {
  MENU,
  classify,

  /**
   * Answer one turn. Always resolves — a failure degrades to the menu rather
   * than throwing a shopper out of a conversation.
   *
   * @param {object}  input
   * @param {string}  input.body            the shopper's message
   * @param {string}  [input.storeContext]  sellerId of the store being viewed,
   *                                        used only to offer a narrowing
   *                                        shortcut — never to restrict results
   * @returns {Promise<{reply:string,intent:string,quickReplies:Array,products:Array,stores:Array}>}
   */
  async run({ body, storeContext = '' } = {}) {
    const { intent, term } = classify(body);

    try {
      if (intent === 'menu') {
        return {
          reply:
            'Hi! I can search across every store on Chatstand. Tell me what you are looking for — ' +
            'say something like "red sneakers" or "shea butter" — or pick an option below.',
          intent: 'menu',
          quickReplies: MENU,
          products: [],
          stores: [],
        };
      }

      if (intent === 'search_prompt') {
        return {
          reply: 'What are you shopping for? Type a product name and I will look across every store.',
          intent: 'search_prompt',
          quickReplies: MENU,
          products: [],
          stores: [],
        };
      }

      if (intent === 'help') {
        return {
          reply: 'I can find products, show you stores and point you to checkout. What do you need?',
          intent: 'menu',
          quickReplies: MENU,
          products: [],
          stores: [],
        };
      }

      if (intent === 'cart') {
        return {
          reply:
            'Your cart can hold items from several stores at once — payment is split between them automatically. ' +
            'Open the cart to review it and check out.',
          intent: 'cart',
          quickReplies: [{ label: 'Open cart', value: 'OPEN_CART' }, ...MENU.slice(0, 2)],
          products: [],
          stores: [],
        };
      }

      if (intent === 'stores') {
        const { stores } = await storeDirectoryService.listStores({ page: 1, limit: MAX_STORES });
        if (!stores.length) {
          return {
            reply: 'No stores are published yet. Check back shortly.',
            intent: 'stores',
            quickReplies: MENU,
            products: [],
            stores: [],
          };
        }
        return {
          reply: `Here ${stores.length === 1 ? 'is' : 'are'} ${stores.length} ${
            stores.length === 1 ? 'store' : 'stores'
          } on Chatstand. Tap one to visit it, or tell me what you are looking for.`,
          intent: 'stores',
          quickReplies: MENU,
          products: [],
          stores: stores.map((store) => ({
            sellerId: store.sellerId,
            slug: store.slug,
            name: store.name,
            logo: store.logo || '',
            productCount: store.productCount || 0,
            rating: store.rating ?? null,
          })),
        };
      }

      if (intent === 'trending') {
        const items = await storeDirectoryService.listPromotedProducts(MAX_PRODUCTS);
        if (!items.length) {
          return {
            reply: 'Nothing is being promoted right now. Tell me what you are after and I will search for it.',
            intent: 'trending',
            quickReplies: MENU,
            products: [],
            stores: [],
          };
        }
        return {
          reply: 'Here is what is trending across the marketplace right now.',
          intent: 'trending',
          quickReplies: MENU,
          products: items.map(toCard),
          stores: [],
        };
      }

      // ---- product search, across every seller ----
      const results = await searchService.search({
        q: term,
        sellerLimit: MAX_STORES,
        productLimit: MAX_PRODUCTS,
      });

      if (!results.products.length && !results.sellers.length) {
        return {
          reply: `I could not find anything for "${clean(term)}". Try a different word, or browse the stores.`,
          intent: 'search_empty',
          quickReplies: MENU,
          products: [],
          stores: [],
        };
      }

      if (!results.products.length) {
        return {
          reply: `No products matched "${clean(term)}", but ${
            results.sellers.length === 1 ? 'this store looks' : 'these stores look'
          } relevant.`,
          intent: 'search',
          quickReplies: MENU,
          products: [],
          stores: results.sellers,
        };
      }

      const count = results.products.length;
      const storeCount = new Set(results.products.map((product) => String(product.sellerId))).size;
      const cheapest = results.products.reduce((low, p) => (p.price < low.price ? p : low), results.products[0]);

      let reply = `Found ${count} ${count === 1 ? 'match' : 'matches'} for "${clean(term)}"`;
      reply += storeCount > 1 ? ` across ${storeCount} stores.` : '.';
      if (count > 1) reply += ` Cheapest is ${cheapest.name} at ${naira(cheapest.price)}.`;

      const quickReplies = [...MENU];
      if (storeContext) {
        // A narrowing shortcut, never a default. Results above are already
        // marketplace-wide, which is the point of this assistant.
        quickReplies.unshift({ label: 'Only this store', value: `ONLY_STORE:${storeContext}` });
      }

      return {
        reply,
        intent: 'search',
        quickReplies: quickReplies.slice(0, 6),
        products: results.products.map(toCard),
        stores: results.sellers.slice(0, 2),
      };
    } catch (error) {
      logger.warn('Marketplace agent failed, falling back to menu', { error: error.message });
      return {
        reply: 'Something went wrong on my side. Try again, or browse the stores directly.',
        intent: 'error',
        quickReplies: MENU,
        products: [],
        stores: [],
      };
    }
  },
};

module.exports = marketplaceAgent;
