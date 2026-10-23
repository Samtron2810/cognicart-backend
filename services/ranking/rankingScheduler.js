/**
 * Seller Ranking Scheduler
 *
 * There is no cron runner and no job queue in this stack, and adding one for a
 * single hourly task would be a lot of operational surface for very little.
 * An in-process interval plus the JobLock collection gives the same guarantee
 * that matters — the job runs about once an hour, platform-wide, even with
 * several API instances — without another thing to deploy and monitor.
 *
 * Swap this for a real scheduler by disabling it with RANKING_JOB_ENABLED=false
 * and pointing an external cron at POST /api/admin/ranking/recompute. The
 * service underneath is identical either way.
 */

const rankingService = require('./rankingService');
const logger = require('../../utils/logger');

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // hourly
// Delay the first run so it does not compete with boot-time work (index sync,
// first requests after a cold start).
const DEFAULT_INITIAL_DELAY_MS = 60 * 1000;

let timer = null;
let initialTimer = null;

function intervalMs() {
  const configured = parseInt(process.env.RANKING_JOB_INTERVAL_MS, 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_INTERVAL_MS;
}

function isEnabled() {
  return process.env.RANKING_JOB_ENABLED !== 'false';
}

async function runOnce() {
  try {
    const result = await rankingService.recomputeWithLock();
    if (!result.ran) {
      logger.debug('Ranking job skipped; another instance holds the lock');
    }
    return result;
  } catch (error) {
    // A failed ranking pass must never take the API down. Yesterday's scores
    // keep serving until the next tick succeeds.
    logger.error('Ranking job failed', { error: error.message });
    return { ran: false, reason: 'error' };
  }
}

/**
 * Begin the hourly recompute. Safe to call twice; the second call is ignored.
 */
function start() {
  if (!isEnabled()) {
    logger.info('Seller ranking job disabled (RANKING_JOB_ENABLED=false)');
    return;
  }
  if (timer || initialTimer) return;

  const every = intervalMs();
  const initialDelay = parseInt(process.env.RANKING_JOB_INITIAL_DELAY_MS, 10) || DEFAULT_INITIAL_DELAY_MS;

  initialTimer = setTimeout(() => {
    initialTimer = null;
    void runOnce();
    timer = setInterval(() => void runOnce(), every);
    // Do not hold the event loop open on shutdown.
    if (timer.unref) timer.unref();
  }, initialDelay);

  if (initialTimer.unref) initialTimer.unref();

  logger.info('Seller ranking job scheduled', { everyMs: every, initialDelayMs: initialDelay });
}

function stop() {
  if (timer) clearInterval(timer);
  if (initialTimer) clearTimeout(initialTimer);
  timer = null;
  initialTimer = null;
}

module.exports = { start, stop, runOnce, isEnabled };
