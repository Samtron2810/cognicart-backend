/**
 * Shared test database helper.
 *
 * The backend has no in-memory fallback, so the integration suites need a real
 * MongoDB. Point MONGO_URI_TEST (or MONGO_URI) at a throwaway database -
 * `setupTestDb()` connects and wipes it before each suite runs.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('../../config/db');
const authService = require('../../services/auth/authService');

const DEFAULT_TEST_URI = 'mongodb://127.0.0.1:27017/wabac_test';

function getTestUri() {
  return process.env.MONGO_URI_TEST || process.env.MONGO_URI || DEFAULT_TEST_URI;
}

/**
 * Connect to the test database and drop every collection so each suite starts clean.
 */
async function setupTestDb({ reset = true } = {}) {
  const uri = getTestUri();

  try {
    await connectDB(uri);
  } catch (err) {
    console.error('\n[tests] Could not connect to MongoDB at', uri);
    console.error('[tests] Start MongoDB (or set MONGO_URI_TEST) and run the suite again.');
    console.error('[tests] Reason:', err.message, '\n');
    throw err;
  }

  if (reset) {
    const collections = await mongoose.connection.db.collections();
    await Promise.all(collections.map((c) => c.deleteMany({})));
  }

  return mongoose.connection;
}

async function teardownTestDb() {
  await disconnectDB();
}

/**
 * Create a privileged account for the RBAC/admin suites and return a bearer token.
 */
async function createAdminAccount({
  email = `admin_${Date.now()}@wabac.test`,
  password = 'AdminPass123',
  businessName = 'WABAC Platform Administration',
  role = 'admin',
} = {}) {
  const user = await authService.createAccount({ businessName, email, password, role });
  const { token } = await authService.login({ email, password });

  return {
    id: user._id.toString(),
    email: user.email,
    password,
    role: user.role,
    token,
  };
}

module.exports = {
  DEFAULT_TEST_URI,
  getTestUri,
  setupTestDb,
  teardownTestDb,
  createAdminAccount,
};
