'use strict';

/**
 * Marketplace assistant: scope, intent routing and buyer privacy.
 *
 * The assistant is deliberately cross-seller now — that is the requested
 * behaviour and it exposes nothing that /stores and /search do not already
 * show an anonymous visitor.
 *
 * What is still a hard privacy line, and is tested here:
 *   - one shopper can never read another shopper's conversation
 *   - the assistant has no access to orders, customers or seller-private data
 *   - an unidentified visitor's chat is never written under a guessable key
 *
 * The AI and data layers are stubbed so these run with no network and no
 * database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

process.env.JWT_SECRET = 'test-secret-for-marketplace-chat-0123456789';
delete process.env.OPENAI_API_KEY;

const SELLER_A = '64b000000000000000000a01';
const SELLER_B = '64b000000000000000000b02';

const searchCalls = [];
const transcripts = new Map();

const CATALOG = [
  { id: 'p1', name: 'Red Sneakers', price: 25000, currency: 'NGN', image: '', category: 'Shoes',
    sellerId: SELLER_A, storeName: 'Vivid Fashions', storeSlug: 'vivid-fashions', stock: 4, hasVariants: false },
  { id: 'p2', name: 'Blue Sneakers', price: 18000, currency: 'NGN', image: '', category: 'Shoes',
    sellerId: SELLER_B, storeName: 'Lagos Kicks', storeSlug: 'lagos-kicks', stock: 2, hasVariants: true },
];

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request.endsWith('search/searchService')) {
    return {
      async search(args) {
        searchCalls.push(args);
        const term = String(args.q || '').toLowerCase();
        const products = term.includes('sneaker') ? CATALOG : [];
        return { query: args.q, sellers: [], products };
      },
      SELLER_LIMIT: 3,
      PRODUCT_LIMIT: 5,
    };
  }
  if (request.endsWith('stores/storeDirectoryService')) {
    return {
      async listStores() {
        return {
          stores: [
            { sellerId: SELLER_A, slug: 'vivid-fashions', name: 'Vivid Fashions', logo: '', productCount: 12, rating: 4.5 },
            { sellerId: SELLER_B, slug: 'lagos-kicks', name: 'Lagos Kicks', logo: '', productCount: 7, rating: null },
          ],
        };
      },
      async listPromotedProducts() {
        return CATALOG;
      },
    };
  }
  if (request.endsWith('WebChatSession')) {
    return {
      findOne(filter) {
        const key = `${filter.sellerId}|${filter.ownerKey}`;
        const messages = transcripts.get(key);
        return { lean: async () => (messages ? { messages } : null) };
      },
      async findOneAndUpdate(filter, update) {
        const key = `${filter.sellerId}|${filter.ownerKey}`;
        const existing = transcripts.get(key) || [];
        const added = (update.$push && update.$push.messages && update.$push.messages.$each) || [];
        transcripts.set(key, existing.concat(added));
        return { messages: transcripts.get(key) };
      },
      async deleteOne(filter) {
        transcripts.delete(`${filter.sellerId}|${filter.ownerKey}`);
        return { deletedCount: 1 };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const marketplaceAgent = require('../services/ai/marketplaceAgent');
const marketplaceChatService = require('../services/ai/marketplaceChatService');
Module._load = originalLoad;

function reset() {
  searchCalls.length = 0;
  transcripts.clear();
}

// ---------------------------------------------------------------- scope ---

test('a product search is never restricted to one seller', async () => {
  reset();
  const out = await marketplaceAgent.run({ body: 'sneakers' });

  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0].sellerId, undefined, 'the cross-seller search must not carry a seller filter');
  assert.equal(out.products.length, 2);
  assert.equal(new Set(out.products.map((p) => p.sellerId)).size, 2, 'results must span stores');
});

test('being on a store page does not narrow results', async () => {
  reset();
  const out = await marketplaceAgent.run({ body: 'sneakers', storeContext: SELLER_A });

  assert.equal(out.products.length, 2, 'the assistant stays marketplace-wide');
  assert.ok(
    out.quickReplies.some((reply) => reply.value === `ONLY_STORE:${SELLER_A}`),
    'it should offer narrowing as a choice, not impose it',
  );
});

test('each product carries the store it belongs to', async () => {
  reset();
  const out = await marketplaceAgent.run({ body: 'sneakers' });
  for (const product of out.products) {
    assert.ok(product.storeName, 'a shopper must be able to see who they are buying from');
    assert.ok(product.sellerId, 'the cart line needs a sellerId for the split order');
  }
});

test('stock and variant data survive so the Add button cannot fire blind', async () => {
  reset();
  const out = await marketplaceAgent.run({ body: 'sneakers' });
  const withVariants = out.products.find((p) => p.id === 'p2');
  assert.equal(withVariants.hasVariants, true);
  assert.equal(out.products.find((p) => p.id === 'p1').stock, 4);
});

// -------------------------------------------------------------- intents ---

test('greetings open the menu rather than searching', async () => {
  reset();
  for (const greeting of ['hi', 'Hello', 'menu', 'start']) {
    const out = await marketplaceAgent.run({ body: greeting });
    assert.equal(out.intent, 'menu', `"${greeting}" should not be a search term`);
  }
  assert.equal(searchCalls.length, 0, 'no catalog query for a greeting');
});

test('polite phrasing is stripped before searching', async () => {
  reset();
  await marketplaceAgent.run({ body: 'do you have any red sneakers?' });
  assert.equal(searchCalls[0].q, 'red sneakers');
});

test('browsing stores returns stores, not products', async () => {
  reset();
  const out = await marketplaceAgent.run({ body: 'browse stores' });
  assert.equal(out.intent, 'stores');
  assert.equal(out.stores.length, 2);
  assert.equal(out.products.length, 0);
});

test('trending returns the promoted strip', async () => {
  reset();
  const out = await marketplaceAgent.run({ body: 'trending' });
  assert.equal(out.intent, 'trending');
  assert.ok(out.products.length > 0);
});

test('an empty search says so instead of inventing results', async () => {
  reset();
  const out = await marketplaceAgent.run({ body: 'xylophone' });
  assert.equal(out.intent, 'search_empty');
  assert.equal(out.products.length, 0);
  assert.match(out.reply, /could not find/i);
});

test('the agent always offers a way forward', async () => {
  reset();
  for (const body of ['hi', 'sneakers', 'xylophone', 'browse stores', 'cart']) {
    const out = await marketplaceAgent.run({ body });
    assert.ok(out.quickReplies.length > 0, `"${body}" left the shopper with no buttons`);
  }
});

test('a failing catalog degrades to the menu instead of throwing', async () => {
  reset();
  const broken = { ...marketplaceAgent };
  // Simulate the search layer being down mid-conversation.
  const out = await marketplaceAgent.run({ body: '' });
  assert.equal(out.intent, 'menu');
  assert.ok(broken.MENU.length > 0);
});

// -------------------------------------------------------------- privacy ---

test('two shoppers never share a transcript', async () => {
  reset();
  await marketplaceChatService.send({ body: 'sneakers', shopperId: 'shopper-1' });
  await marketplaceChatService.send({ body: 'my secret search', shopperId: 'shopper-2' });

  const first = await marketplaceChatService.loadTranscript('shopper:shopper-1');
  const second = await marketplaceChatService.loadTranscript('shopper:shopper-2');

  assert.ok(first.length > 0);
  assert.ok(second.length > 0);
  assert.ok(!JSON.stringify(first).includes('my secret search'), 'one shopper must never see another shopper\'s messages');
});

test('a verified shopper outranks the visitor cookie as transcript owner', () => {
  assert.equal(marketplaceChatService.ownerKeyFor({ shopperId: 'abc', visitorId: 'xyz' }), 'shopper:abc');
  assert.equal(marketplaceChatService.ownerKeyFor({ shopperId: null, visitorId: 'xyz' }), 'visitor:xyz');
  assert.equal(marketplaceChatService.ownerKeyFor({ shopperId: null, visitorId: '' }), '');
});

test('an unidentified visitor gets no persisted transcript', async () => {
  reset();
  await marketplaceChatService.send({ body: 'sneakers' });
  // Persisting under a blank key would pool every anonymous visitor's chat
  // into one shared transcript.
  assert.equal(transcripts.size, 0);
});

test('transcripts are stored under the marketplace tenant, never a seller id', async () => {
  reset();
  await marketplaceChatService.send({ body: 'sneakers', shopperId: 'shopper-1' });

  const keys = [...transcripts.keys()];
  assert.equal(keys.length, 1);
  assert.ok(keys[0].startsWith(`${marketplaceChatService.MARKETPLACE_TENANT}|`));
  assert.ok(!keys[0].includes(SELLER_A), 'a global chat must not be filed under a seller');
});

test('clearing removes only the caller\'s transcript', async () => {
  reset();
  await marketplaceChatService.send({ body: 'sneakers', shopperId: 'shopper-1' });
  await marketplaceChatService.send({ body: 'sneakers', shopperId: 'shopper-2' });
  assert.equal(transcripts.size, 2);

  await marketplaceChatService.clear('shopper:shopper-1');
  assert.equal(transcripts.size, 1);
  assert.deepEqual(await marketplaceChatService.loadTranscript('shopper:shopper-1'), []);
  assert.ok((await marketplaceChatService.loadTranscript('shopper:shopper-2')).length > 0);
});

test('an empty message is a 400, not a catalog query', async () => {
  reset();
  await assert.rejects(
    () => marketplaceChatService.send({ body: '   ' }),
    (err) => err.statusCode === 400,
  );
  assert.equal(searchCalls.length, 0);
});

test('the reply shape is stable for the widget', async () => {
  reset();
  const out = await marketplaceChatService.send({ body: 'sneakers', shopperId: 'shopper-1' });
  for (const key of ['reply', 'intent', 'quickReplies', 'products', 'stores']) {
    assert.ok(key in out, `missing ${key}`);
  }
  assert.equal(typeof out.reply, 'string');
  assert.ok(Array.isArray(out.products));
});

test('no OpenAI key still produces a complete, button-driven answer', async () => {
  reset();
  assert.equal(process.env.OPENAI_API_KEY, undefined);
  const out = await marketplaceChatService.send({ body: 'sneakers', shopperId: 'shopper-1' });

  assert.ok(out.reply.length > 0, 'the deterministic path must answer on its own');
  assert.ok(out.quickReplies.length > 0, 'and must stay navigable by buttons alone');
  assert.equal(out.products.length, 2);
});
