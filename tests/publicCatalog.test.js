'use strict';

/**
 * Public catalog scoping.
 *
 * `optionalAuth` attaches req.sellerId to ANY signed-in seller, including one
 * who is just browsing the marketplace. The controller used to fall back to
 * that id when choosing what to list, so /marketplace quietly showed a
 * logged-in seller only their own products — and an empty page when their
 * own shop was empty, with no error anywhere.
 *
 * These tests pin the rule: an explicit public request is never narrowed by
 * who happens to be signed in.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-catalog-suite-0123456789';

const SELLER_A = '64b000000000000000000a01';
const SELLER_B = '64b000000000000000000b02';

const listCalls = [];

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request.endsWith('products/productService')) {
    return {
      async list(args) {
        listCalls.push(args);
        return [];
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const productController = require('../controllers/productController');
Module._load = originalLoad;

/** Minimal express doubles. */
function run(req) {
  listCalls.length = 0;
  const res = {
    statusCode: 0,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  const next = (error) => {
    if (error) throw error;
  };
  return productController.getProducts({ query: {}, ...req }, res, next).then(() => res);
}

test('an anonymous public request lists every seller', async () => {
  await run({ query: { public: 'true' } });
  assert.equal(listCalls[0].isPublic, true);
  assert.equal(listCalls[0].sellerId, undefined, 'no seller filter means the whole marketplace');
});

test('a signed-in seller browsing the marketplace still sees every seller', async () => {
  // The regression: req.sellerId is set, but public=true was asked for.
  await run({ query: { public: 'true' }, sellerId: SELLER_A });

  assert.equal(listCalls[0].isPublic, true);
  assert.equal(
    listCalls[0].sellerId,
    undefined,
    'a seller browsing /marketplace must not be shown only their own catalog',
  );
});

test('an explicit sellerId still narrows a public listing', async () => {
  // This is how a storefront asks for one shop's public catalog.
  await run({ query: { public: 'true', sellerId: SELLER_B }, sellerId: SELLER_A });
  assert.equal(listCalls[0].sellerId, SELLER_B, 'the explicit query wins');
  assert.equal(listCalls[0].isPublic, true);
});

test('the seller dashboard is still scoped to the signed-in seller', async () => {
  // No public flag: this is the authenticated "my products" call.
  await run({ query: {}, sellerId: SELLER_A });
  assert.equal(listCalls[0].sellerId, SELLER_A, 'a seller must still only manage their own catalog');
  assert.equal(listCalls[0].isPublic, false);
});

test('an anonymous caller with no public flag is still treated as public', async () => {
  await run({ query: {} });
  assert.equal(listCalls[0].isPublic, true);
  assert.equal(listCalls[0].sellerId, undefined);
});

test('search and category pass through on a public listing', async () => {
  await run({ query: { public: 'true', search: 'tote', category: 'Bags' }, sellerId: SELLER_A });
  assert.equal(listCalls[0].search, 'tote');
  assert.equal(listCalls[0].category, 'Bags');
  assert.equal(listCalls[0].sellerId, undefined, 'filters must not reintroduce the seller scope');
});

test('the response is the product array the service returned', async () => {
  const res = await run({ query: { public: 'true' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, []);
});
