/**
 * Structured Logger for WABAC Backend
 * Supports debug, info, warn, error levels with timestamps and metadata
 */

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel = (process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug')).toLowerCase();
const currentLevelWeight = LOG_LEVELS[currentLevel] !== undefined ? LOG_LEVELS[currentLevel] : 1;

function formatTimestamp() {
  return new Date().toISOString();
}

function formatMeta(meta) {
  if (!meta || Object.keys(meta).length === 0) return '';
  try {
    return ' ' + JSON.stringify(meta);
  } catch {
    return ' [Circular/Unserializable Meta]';
  }
}

const logger = {
  debug(message, meta) {
    if (currentLevelWeight <= LOG_LEVELS.debug) {
      console.debug(`[${formatTimestamp()}] [DEBUG] ${message}${formatMeta(meta)}`);
    }
  },

  info(message, meta) {
    if (currentLevelWeight <= LOG_LEVELS.info) {
      console.info(`[${formatTimestamp()}] [INFO] ${message}${formatMeta(meta)}`);
    }
  },

  warn(message, meta) {
    if (currentLevelWeight <= LOG_LEVELS.warn) {
      console.warn(`[${formatTimestamp()}] [WARN] ${message}${formatMeta(meta)}`);
    }
  },

  error(message, meta) {
    if (currentLevelWeight <= LOG_LEVELS.error) {
      console.error(`[${formatTimestamp()}] [ERROR] ${message}${formatMeta(meta)}`);
    }
  },
};

module.exports = logger;
