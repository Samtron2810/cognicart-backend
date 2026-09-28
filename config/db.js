/**
 * MongoDB Database Connection Manager
 *
 * MongoDB is a hard requirement for this service. There is no in-memory
 * fallback store: if the database is unreachable the process refuses to boot
 * so that the API never serves (or accepts) data that would silently vanish.
 */

const mongoose = require('mongoose');
const logger = require('../utils/logger');

function getMongoUri() {
  return process.env.MONGO_URI || process.env.MONGODB_URI || '';
}

/**
 * Establish the MongoDB connection.
 * Throws when MONGO_URI is missing or the server cannot be reached.
 */
async function connectDB(uriOverride) {
  const uri = uriOverride || getMongoUri();

  if (!uri) {
    throw new Error(
      'MONGO_URI is not defined. Set MONGO_URI (or MONGODB_URI) to a reachable MongoDB connection string.'
    );
  }

  mongoose.connection.removeAllListeners('error');
  mongoose.connection.removeAllListeners('disconnected');
  mongoose.connection.removeAllListeners('reconnected');

  mongoose.connection.on('error', (err) => {
    logger.error('MongoDB connection error:', { error: err.message });
  });

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected. Database-backed endpoints will respond with HTTP 503 until it recovers.');
  });

  mongoose.connection.on('reconnected', () => {
    logger.info('MongoDB reconnected');
  });

  const conn = await mongoose.connect(uri, {
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 10000,
    autoIndex: process.env.NODE_ENV !== 'production',
  });

  logger.info(`MongoDB Connected: ${conn.connection.host}/${conn.connection.name}`);
  return conn;
}

/**
 * Close the MongoDB connection (used by scripts and test teardown).
 */
async function disconnectDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

/**
 * True only when a live connection is usable.
 */
function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

/**
 * Human readable connection state for health probes.
 */
function getDbState() {
  const states = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
    99: 'uninitialized',
  };
  return states[mongoose.connection.readyState] || 'unknown';
}

module.exports = {
  connectDB,
  disconnectDB,
  isDbConnected,
  getDbState,
  getMongoUri,
};
