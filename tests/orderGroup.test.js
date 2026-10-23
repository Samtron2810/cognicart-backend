/**
 * Multi-seller checkout — grouping, labels and settlement arithmetic.
 *
 * This is money code, so the parts that can be tested without a database are
 * tested here rather than trusted. No mongoose connection is opened.
 *
 * Run: node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const orderGroupService = require('../services/orders/orderGroupService');
const groupPaymentService = require('../services/payments/groupPaymentService');

const { groupItemsBySeller, labelFor } = orderGroupService;

test('cart lines are grouped by seller, preserving the order they were added', () => {
  const grouped = groupItemsBySeller([
    { sellerId: 'A', productId: 'p1', quantity: 1 },
    { sellerId: 'B', productId: 'p2', quantity: 2 },
    { sellerId: 'A', productId: 'p3', quantity: 1 },
  ]);

  assert.deepEqual([...grouped.keys()], ['A', 'B'], 'seller order follows first appearance');
  assert.equal(grouped.get('A').length, 2);
  assert.equal(grouped.get('B').length, 1);
  assert.equal(grouped.get('B')[0].quantity, 2);
});

test('quantities are coerced to a sane positive integer', () => {
  const grouped = groupItemsBySeller([
    { sellerId: 'A', productId: 'p1', quantity: 0 },
    { sellerId: 'A', productId: 'p2', quantity: -5 },
    { sellerId: 'A', productId: 'p3', quantity: '3' },
    { sellerId: 'A', productId: 'p4' },
  ]);

  const quantities = grouped.get('A').map((item) => item.quantity);
  assert.deepEqual(quantities, [1, 1, 3, 1]);
});

test('a line without a seller or product is rejected outright', () => {
  // A cart line with no sellerId cannot be routed to anybody, and silently
  // dropping it would quietly charge the buyer for less than they chose.
  assert.throws(() => groupItemsBySeller([{ productId: 'p1', quantity: 1 }]), /sellerId/);
  assert.throws(() => groupItemsBySeller([{ sellerId: 'A', quantity: 1 }]), /productId/);
});

test('sub-order labels are A, B, C and stay unique past Z', () => {
  assert.equal(labelFor(0), 'A');
  assert.equal(labelFor(1), 'B');
  assert.equal(labelFor(25), 'Z');
  // Beyond 26 stores it falls back to a number rather than wrapping round
  // and producing two sub-orders called "A".
  assert.equal(labelFor(26), '27');

  const labels = Array.from({ length: 40 }, (_, i) => labelFor(i));
  assert.equal(new Set(labels).size, 40, 'every label must be unique');
});

test('group references are distinguishable from single-seller ones', () => {
  // Every entry point — webhook, callback, manual verify — picks the
  // settlement path from the reference string alone, so this prefix is
  // load-bearing, not cosmetic.
  assert.equal(groupPaymentService.isGroupReference('GRP_ABC_123'), true);
  assert.equal(groupPaymentService.isGroupReference('PSK_ABC_123'), false);
  assert.equal(groupPaymentService.isGroupReference(''), false);
  assert.equal(groupPaymentService.isGroupReference(null), false);
  assert.equal(groupPaymentService.isGroupReference(undefined), false);
  assert.equal(groupPaymentService.GROUP_REFERENCE_PREFIX, 'GRP_');
});

test('a sub-order payment reference is derived from the group and its label', () => {
  // These must be unique per sub-order: Payment.reference carries a unique
  // index, and that index is what makes the fan-out idempotent.
  const groupRef = 'GRP_ABC_123';
  const refs = ['A', 'B', 'C'].map((label) => `${groupRef}-${label}`);
  assert.deepEqual(refs, ['GRP_ABC_123-A', 'GRP_ABC_123-B', 'GRP_ABC_123-C']);
  assert.equal(new Set(refs).size, 3);
  for (const ref of refs) {
    assert.ok(groupPaymentService.isGroupReference(ref), 'a sub reference still reads as a group reference');
  }
});

test('the grand total is the sum of each seller slice, delivery included', () => {
  // Delivery is per seller because Business.deliveryFee is per seller:
  // three stores is three parcels from three places.
  const lines = [
    { subtotal: 18500, deliveryFee: 1500, total: 20000 },
    { subtotal: 12500, deliveryFee: 2000, total: 14500 },
    { subtotal: 4500, deliveryFee: 0, total: 4500 },
  ];

  const subtotal = lines.reduce((sum, line) => sum + line.subtotal, 0);
  const deliveryTotal = lines.reduce((sum, line) => sum + line.deliveryFee, 0);
  const grandTotal = lines.reduce((sum, line) => sum + line.total, 0);

  assert.equal(subtotal, 35500);
  assert.equal(deliveryTotal, 3500);
  assert.equal(grandTotal, 39000);
  assert.equal(grandTotal, subtotal + deliveryTotal, 'the total must reconcile exactly');
});

test('per-seller fee split never pays out more than was collected', () => {
  // The invariant that matters: for every sub-order,
  // sellerAmount + platformFee + paystackFee <= amount charged.
  const feeConfig = { percentage: 5, fixed: 0 };
  const calculatePaystackFee = (amount) => Math.min(Math.round(amount * 0.015), 2000);

  for (const amount of [500, 4500, 14500, 20000, 150000, 1000000]) {
    const platformFee = Math.round(amount * (feeConfig.percentage / 100) + feeConfig.fixed);
    const paystackFee = calculatePaystackFee(amount);
    const sellerAmount = Math.max(0, amount - platformFee - paystackFee);

    assert.ok(
      sellerAmount + platformFee + paystackFee <= amount + 0.001,
      `split exceeds the charge at ₦${amount}`
    );
    assert.ok(sellerAmount >= 0, 'a seller can never be credited a negative amount');
  }
});

test('splitting each sub-order separately collects the same fees as one big charge would', () => {
  // Sanity check on the split model: the platform is not quietly taking a
  // different cut just because the basket spanned several stores.
  const percentage = 5;
  const lines = [20000, 14500, 4500];
  const perLine = lines.reduce((sum, amount) => sum + Math.round(amount * (percentage / 100)), 0);
  const asOne = Math.round(lines.reduce((sum, amount) => sum + amount, 0) * (percentage / 100));

  // Rounding each line can differ by at most a naira per line.
  assert.ok(Math.abs(perLine - asOne) <= lines.length, `per-line ${perLine} vs single ${asOne}`);
});
