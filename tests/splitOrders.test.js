'use strict';

/**
 * Split-order grouping: one payment, one sub-order per seller.
 *
 * The grouping and labelling are pure, so they are pinned here directly.
 * The settlement path itself needs a real database and is called out as an
 * integration gap rather than faked.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-split-suite-0123456789';

const { labelFor, groupItemsBySeller } = require('../services/orders/orderGroupService');
const { ORDER_SOURCES, AUTOMATIC_SOURCES } = require('../models/Order');

test('sub-order labels run A, B, C…', () => {
  assert.equal(labelFor(0), 'A');
  assert.equal(labelFor(1), 'B');
  assert.equal(labelFor(25), 'Z');
});

test('labelling survives a basket with more than 26 stores', () => {
  const label = labelFor(26);
  assert.ok(label, 'must not return empty');
  assert.notEqual(label, 'A', 'must not wrap around and collide with the first sub-order');
});

test('items are grouped into one line per seller', () => {
  const groups = groupItemsBySeller([
    { sellerId: 's1', productId: 'p1', quantity: 1 },
    { sellerId: 's2', productId: 'p2', quantity: 2 },
    { sellerId: 's1', productId: 'p3', quantity: 1 },
  ]);

  assert.equal(groups.size, 2, 'two stores means two sub-orders');
  assert.equal(groups.get('s1').length, 2, "a seller's items stay together in one sub-order");
  assert.equal(groups.get('s2').length, 1);
});

test('a single-store basket still produces exactly one group', () => {
  const groups = groupItemsBySeller([
    { sellerId: 's1', productId: 'p1', quantity: 1 },
    { sellerId: 's1', productId: 'p2', quantity: 1 },
  ]);
  assert.equal(groups.size, 1);
});

test('grouping preserves the order stores were added in', () => {
  const groups = groupItemsBySeller([
    { sellerId: 'sB', productId: 'p1', quantity: 1 },
    { sellerId: 'sA', productId: 'p2', quantity: 1 },
  ]);
  // A Map iterates in insertion order, which is what makes the A/B labels
  // reproducible between a retry and the original attempt.
  assert.deepEqual([...groups.keys()], ['sB', 'sA']);
});

test('an empty basket groups to nothing rather than throwing', () => {
  assert.equal(groupItemsBySeller([]).size, 0);
});

test('quantities are coerced to a sane positive integer', () => {
  const groups = groupItemsBySeller([
    { sellerId: 's1', productId: 'p1', quantity: 0 },
    { sellerId: 's1', productId: 'p2', quantity: -5 },
    { sellerId: 's1', productId: 'p3', quantity: '3' },
    { sellerId: 's1', productId: 'p4' },
  ]);
  // A zero or negative quantity would otherwise produce a free or
  // negative-value sub-order.
  assert.deepEqual(groups.get('s1').map((i) => i.quantity), [1, 1, 3, 1]);
});

test('an item without a sellerId is refused', () => {
  // This is the guard that stops an item being silently attributed to the
  // wrong store.
  assert.throws(() => groupItemsBySeller([{ productId: 'p1', quantity: 1 }]), /sellerId/);
  assert.throws(() => groupItemsBySeller([{ sellerId: '   ', productId: 'p1' }]), /sellerId/);
});

test('an item without a productId is refused', () => {
  assert.throws(() => groupItemsBySeller([{ sellerId: 's1', quantity: 1 }]), /productId/);
});

test('no seller appears in more than one group', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({
    sellerId: `s${i % 4}`,
    productId: `p${i}`,
    quantity: 1,
  }));
  const groups = groupItemsBySeller(items);

  assert.equal(groups.size, 4, 'a seller must never get two sub-orders');
  let total = 0;
  for (const line of groups.values()) total += line.length;
  assert.equal(total, 30, 'no item may be dropped');
});

test('website_chatbot is a recognised order source', () => {
  assert.ok(ORDER_SOURCES.includes('website_chatbot'));
  // Pre-existing sources must survive — the Telegram bot especially.
  for (const source of ['storefront', 'telegram', 'manual']) {
    assert.ok(ORDER_SOURCES.includes(source), `${source} must still be valid`);
  }
});

test('website_chatbot counts as automatic, or orderService silently downgrades it', () => {
  // orderService.create falls back to 'storefront' for anything not in this
  // list, which would make bot sales indistinguishable from cart checkouts.
  assert.ok(AUTOMATIC_SOURCES.includes('website_chatbot'));
  assert.ok(AUTOMATIC_SOURCES.includes('telegram'));
  assert.ok(!AUTOMATIC_SOURCES.includes('manual'), 'manual orders are seller-entered, not automatic');
});
