/**
 * Slug helpers for public storefront URLs.
 *
 * Store pages are addressed as /store/:identifier where the identifier is
 * either the slug or the raw sellerId. A slug is nicer to read and share, so
 * every business gets one, and it has to be unique across the platform or two
 * sellers would fight over the same public URL.
 */

/**
 * Convert free text into a URL-safe slug.
 * Kept byte-identical to the original storefrontService implementation so
 * existing links and sitemaps resolve exactly as before.
 */
function slugify(text) {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

/**
 * Slugs that would collide with a real route segment or shadow a platform
 * page. A store called "Cart" must not take over /store/cart.
 */
const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'cart',
  'checkout',
  'contact',
  'dashboard',
  'login',
  'logout',
  'new',
  'products',
  'register',
  'search',
  's',
  'seller',
  'sellers',
  'store',
  'stores',
  'track',
]);

/**
 * Build a slug for `name` that no other business is already using.
 *
 * Collisions get a numeric suffix (vivid-fashions, vivid-fashions-2, ...).
 * `ownSellerId` is excluded from the collision check so re-saving a business
 * does not make it fight with itself.
 *
 * @param {import('mongoose').Model} BusinessModel
 * @param {string} name       Business display name
 * @param {string} ownSellerId Seller that will own the slug
 * @returns {Promise<string>} A slug that is free at the time of the call
 */
async function generateUniqueSlug(BusinessModel, name, ownSellerId) {
  const base = slugify(name) || 'store';
  // A reserved word is never handed out bare; it always gets a suffix.
  let candidate = RESERVED_SLUGS.has(base) ? `${base}-store` : base;

  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const clash = await BusinessModel.findOne({
      slug: candidate,
      sellerId: { $ne: ownSellerId },
    })
      .select('_id')
      .lean();

    if (!clash) return candidate;
    candidate = `${base}-${attempt + 1}`;
  }

  // Pathological case only: fall back to something guaranteed unique.
  return `${base}-${Date.now().toString(36)}`;
}

module.exports = { slugify, generateUniqueSlug, RESERVED_SLUGS };
