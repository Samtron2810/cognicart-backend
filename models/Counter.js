/**
 * Atomic Named Counter
 *
 * Backs per-seller sequential order numbers (#00001, #00002, ...). Merchants
 * need a short reference they can read out to a customer on a call; Mongo
 * ObjectIds are useless for that.
 *
 * The increment is a single findOneAndUpdate with $inc and upsert, so it is
 * atomic under concurrency without a transaction. Gaps are possible if a
 * caller takes a number and then fails to create the order - that is
 * deliberate and harmless; numbers are references, not an audit trail.
 */

const mongoose = require('mongoose');

const counterSchema = new mongoose.Schema(
  {
    // Composite key, e.g. "order:<sellerId>"
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false }
);

const Counter = mongoose.model('Counter', counterSchema);

/**
 * Reserve the next number in a named sequence.
 *
 * @param {string} scope Sequence name, unique per tenant (e.g. "order:abc123")
 * @returns {Promise<number>} the reserved value, starting at 1
 */
async function nextSequence(scope) {
  if (!scope) throw new Error('Counter scope is required');

  const counter = await Counter.findOneAndUpdate(
    { _id: scope },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  return counter.seq;
}

/**
 * Next order number for a seller. Each seller counts from 1 independently,
 * so one merchant's volume is never visible to another.
 */
function nextOrderNumber(sellerId) {
  return nextSequence(`order:${sellerId}`);
}

module.exports = Counter;
module.exports.nextSequence = nextSequence;
module.exports.nextOrderNumber = nextOrderNumber;
