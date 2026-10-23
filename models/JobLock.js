/**
 * Job Lock Mongoose Model
 *
 * Background jobs run inside the API process. That is fine on one instance,
 * but the moment the app is scaled to two the same job fires twice at the same
 * moment. This collection is the mutual exclusion: a worker claims a lock by
 * key, holds it for a lease, and releases it when finished. A crashed worker
 * does not deadlock the job because the lease expires on its own.
 */

const mongoose = require('mongoose');

const jobLockSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true, // `unique` already builds the index
    },
    // Opaque id of the process holding the lock. Only the holder may release.
    owner: {
      type: String,
      default: '',
    },
    lockedAt: {
      type: Date,
      default: Date.now,
    },
    // After this instant any worker may steal the lock.
    expiresAt: {
      type: Date,
      required: true,
    },
    lastFinishedAt: {
      type: Date,
      default: null,
    },
    lastDurationMs: {
      type: Number,
      default: 0,
    },
    lastError: {
      type: String,
      default: '',
    },
  },
  { timestamps: true }
);

const JobLock = mongoose.model('JobLock', jobLockSchema);

module.exports = JobLock;
