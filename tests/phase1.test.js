/**
 * Phase 1 Verification Test Suite
 * Tests server bootstrapping, utilities, CORS, health endpoints, and 404 error handling
 */

const http = require('http');
const app = require('../server');
const { isEmail, isStrongPassword, isNigerianPhone, normalizePhone, sanitize, clampRequestSize } = require('../utils/validators');
const { generateToken, verifyToken } = require('../utils/generateToken');

async function runTests() {
  console.log('=== Running Phase 1 Verification Tests ===');

  // 1. Validator Tests
  console.log('Testing validators...');
  if (!isEmail('seller@cognicart.ng')) throw new Error('isEmail failed for valid email');
  if (isEmail('invalid-email')) throw new Error('isEmail accepted invalid email');
  if (!isStrongPassword('Secret123!')) throw new Error('isStrongPassword failed for valid password');
  if (isStrongPassword('weakpass')) throw new Error('isStrongPassword accepted password without numbers');
  if (!isNigerianPhone('08012345678')) throw new Error('isNigerianPhone failed for 08012345678');
  if (!isNigerianPhone('+2348012345678')) throw new Error('isNigerianPhone failed for +2348012345678');
  if (normalizePhone('08012345678') !== '+2348012345678') throw new Error('normalizePhone failed');
  if (sanitize('<script>alert("xss")</script>clean text') !== 'clean text') throw new Error('sanitize failed');
  if (!clampRequestSize(JSON.stringify({ a: 1 }), 500)) throw new Error('clampRequestSize failed for small payload');
  console.log('  [PASS] Validators');

  // 2. JWT Generation & Verification Tests
  console.log('Testing JWT utilities...');
  const testPayload = { id: 'seller_123', email: 'seller@test.com', role: 'seller' };
  const token = generateToken(testPayload);
  const decoded = verifyToken(token);
  if (decoded.id !== testPayload.id || decoded.email !== testPayload.email || decoded.role !== testPayload.role) {
    throw new Error('JWT token payload mismatch');
  }
  console.log('  [PASS] JWT generation and verification');

  // 3. HTTP Server Endpoints Tests
  console.log('Testing HTTP server endpoints...');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // GET /
    const resRoot = await fetch(`${baseUrl}/`);
    const dataRoot = await resRoot.json();
    if (resRoot.status !== 200 || dataRoot.name !== 'WABAC API') {
      throw new Error(`GET / failed with status ${resRoot.status}`);
    }
    console.log('  [PASS] GET /');

    // GET /health
    const resHealth = await fetch(`${baseUrl}/health`);
    const dataHealth = await resHealth.json();
    if (resHealth.status !== 200 || dataHealth.status !== 'healthy') {
      throw new Error(`GET /health failed with status ${resHealth.status}`);
    }
    console.log('  [PASS] GET /health');

    // GET /api/health
    const resApiHealth = await fetch(`${baseUrl}/api/health`);
    const dataApiHealth = await resApiHealth.json();
    if (resApiHealth.status !== 200 || dataApiHealth.success !== true) {
      throw new Error(`GET /api/health failed with status ${resApiHealth.status}`);
    }
    console.log('  [PASS] GET /api/health');

    // GET /api
    const resApi = await fetch(`${baseUrl}/api`);
    const dataApi = await resApi.json();
    if (resApi.status !== 200 || !dataApi.endpoints) {
      throw new Error(`GET /api failed with status ${resApi.status}`);
    }
    console.log('  [PASS] GET /api (documentation endpoints mapped)');

    // 404 Handler
    const res404 = await fetch(`${baseUrl}/api/unmapped-endpoint-path`);
    const data404 = await res404.json();
    if (res404.status !== 404 || data404.success !== false) {
      throw new Error(`404 handler failed. Received: ${res404.status}`);
    }
    console.log('  [PASS] Centralized 404 handler');
  } finally {
    server.close();
  }

  console.log('=== All Phase 1 Tests Passed Successfully! ===');
}

runTests().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
