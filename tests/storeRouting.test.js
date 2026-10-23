'use strict';

/**
 * Store slugs and payment-reference routing.
 *
 * Both are string-level contracts that other subsystems depend on, so they
 * are worth pinning without a database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-routing-suite-0123456789';

const { slugify, RESERVED_SLUGS } = require('../utils/slug');
const { isGroupReference, GROUP_REFERENCE_PREFIX } = require('../services/payments/groupPaymentService');

test('slugify produces clean URL segments', () => {
  assert.equal(slugify('Vivid Fashions'), 'vivid-fashions');
  assert.equal(slugify('  Spaced   Out  '), 'spaced-out');
  assert.equal(slugify('UPPER case'), 'upper-case');
  assert.equal(slugify("Mama's Kitchen!"), 'mamas-kitchen');
  assert.equal(slugify('A -- B'), 'a-b');
  assert.equal(slugify('--leading-and-trailing--'), 'leading-and-trailing');
});

test('slugify handles empty and junk input without throwing', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');
  assert.equal(slugify(undefined), '');
  assert.equal(slugify('!!!'), '');
});

test('slugify never emits a path separator or a leading dot', () => {
  // A slug lands straight in /store/:identifier, so traversal must be
  // impossible by construction.
  for (const input of ['../../etc/passwd', 'a/b', 'a\\b', '.hidden', 'a?b=c', 'a#b']) {
    const slug = slugify(input);
    assert.ok(!slug.includes('/'), `slash survived in ${slug}`);
    assert.ok(!slug.includes('\\'), `backslash survived in ${slug}`);
    assert.ok(!slug.startsWith('.'), `leading dot survived in ${slug}`);
    assert.ok(!slug.includes('?'), `query char survived in ${slug}`);
  }
});

test('reserved slugs cover the routes a store could otherwise shadow', () => {
  // Each of these is a real path segment in the frontend router.
  for (const route of ['store', 'stores', 'cart', 'checkout', 'search', 'admin', 'api', 'dashboard', 'login', 's']) {
    assert.ok(RESERVED_SLUGS.has(route), `${route} must be reserved`);
  }
});

test('group references are distinguishable from single-seller ones', () => {
  assert.equal(isGroupReference(`${GROUP_REFERENCE_PREFIX}ABC123`), true);
  assert.equal(isGroupReference('CS_SINGLE_ORDER_REF'), false);
  assert.equal(isGroupReference('ORD-1042'), false);
});

test('isGroupReference rejects non-strings rather than throwing', () => {
  for (const bad of [null, undefined, 42, {}, [], true]) {
    assert.equal(isGroupReference(bad), false);
  }
});

test('a sub-order reference stays recognisable as a group reference', () => {
  // Each sub-order gets its own Payment row keyed GRP_xxx-A, GRP_xxx-B...
  // because Payment.reference is unique. The prefix must survive that.
  const parent = `${GROUP_REFERENCE_PREFIX}MLK3J2_DEADBEEF`;
  assert.equal(isGroupReference(`${parent}-A`), true);
  assert.equal(isGroupReference(`${parent}-B`), true);
});
