/**
 * Store slug generation.
 *
 * The slug is a store's public address (/store/vivid-fashions), so it has to
 * be stable, safe to put in a URL, and unique across the platform.
 *
 * Run: node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { slugify, generateUniqueSlug, RESERVED_SLUGS } = require('../utils/slug');

/** Stand-in for the Business model: only findOne().select().lean() is used. */
function fakeBusinessModel(existing = []) {
  return {
    findOne(filter) {
      const taken = existing.find(
        (row) => row.slug === filter.slug && row.sellerId !== filter.sellerId.$ne
      );
      return {
        select() {
          return { lean: async () => taken || null };
        },
      };
    },
  };
}

test('slugify produces URL-safe output', () => {
  assert.equal(slugify('Vivid Fashions'), 'vivid-fashions');
  assert.equal(slugify('  Ada & Sons  '), 'ada-sons');
  assert.equal(slugify("Chidi's Kitchen!"), 'chidis-kitchen');
  assert.equal(slugify('Multiple   Spaces'), 'multiple-spaces');
  assert.equal(slugify('---Leading and trailing---'), 'leading-and-trailing');
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');
});

test('slugify is idempotent', () => {
  const once = slugify('Vivid Fashions');
  assert.equal(slugify(once), once);
});

test('an unused name keeps its plain slug', async () => {
  const Model = fakeBusinessModel([]);
  assert.equal(await generateUniqueSlug(Model, 'Vivid Fashions', 'seller-1'), 'vivid-fashions');
});

test('a clashing name gets a numeric suffix', async () => {
  const Model = fakeBusinessModel([{ slug: 'vivid-fashions', sellerId: 'seller-1' }]);
  assert.equal(await generateUniqueSlug(Model, 'Vivid Fashions', 'seller-2'), 'vivid-fashions-2');
});

test('a business re-saving does not collide with itself', async () => {
  // Without the sellerId exclusion, every settings save would bump the slug
  // and silently break the store's shared links.
  const Model = fakeBusinessModel([{ slug: 'vivid-fashions', sellerId: 'seller-1' }]);
  assert.equal(await generateUniqueSlug(Model, 'Vivid Fashions', 'seller-1'), 'vivid-fashions');
});

test('reserved words never become a bare slug', async () => {
  const Model = fakeBusinessModel([]);
  for (const reserved of ['cart', 'checkout', 'admin', 'stores']) {
    const slug = await generateUniqueSlug(Model, reserved, 'seller-x');
    assert.notEqual(slug, reserved, `"${reserved}" must not shadow a platform route`);
    assert.ok(RESERVED_SLUGS.has(reserved));
  }
});

test('a name that slugifies to nothing still yields a usable slug', async () => {
  const Model = fakeBusinessModel([]);
  const slug = await generateUniqueSlug(Model, '!!!', 'seller-1');
  assert.ok(slug.length > 0);
  assert.match(slug, /^[a-z0-9-]+$/);
});
