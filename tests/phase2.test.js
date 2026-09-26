/**
 * Phase 2 Verification Test Suite
 * Tests Seller Registration, Login, Token Authentication, Business Profiles, and RBAC
 */

const http = require('http');
const app = require('../server');

async function runTests() {
  console.log('=== Running Phase 2 Verification Tests ===');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Seller Registration
    console.log('Testing Seller Registration...');
    const sellerPayload = {
      businessName: 'Amara Glow Cosmetics',
      email: 'amara@glowcosmetics.ng',
      password: 'Password123!',
      phone: '+2348031234567',
    };

    const resReg = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sellerPayload),
    });
    const dataReg = await resReg.json();

    if (resReg.status !== 201) throw new Error(`Registration failed: ${resReg.status} - ${JSON.stringify(dataReg)}`);
    if (!dataReg.token || !dataReg.seller || !dataReg.seller.id) throw new Error('Registration response missing token or seller info');
    if (dataReg.seller.email !== sellerPayload.email.toLowerCase()) throw new Error('Seller email mismatch');
    if (dataReg.seller.role !== 'seller') throw new Error(`Expected role 'seller', got: ${dataReg.seller.role}`);
    console.log('  [PASS] Seller Registration success (HTTP 201)');

    const sellerToken = dataReg.token;
    const sellerId = dataReg.seller.id;

    // 2. Duplicate Registration Rejection
    const resDup = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sellerPayload),
    });
    if (resDup.status !== 409) throw new Error(`Expected 409 Conflict for duplicate email, got ${resDup.status}`);
    console.log('  [PASS] Duplicate email registration rejected (HTTP 409)');

    // 3. Validation Failures (weak password, invalid email)
    const resWeakPass = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...sellerPayload, email: 'valid@test.com', password: 'weak' }),
    });
    if (resWeakPass.status !== 400) throw new Error(`Expected 400 for weak password, got ${resWeakPass.status}`);
    console.log('  [PASS] Weak password rejected (HTTP 400)');

    // 4. Seller Login
    console.log('Testing Seller Login...');
    const resLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: sellerPayload.email, password: sellerPayload.password }),
    });
    const dataLogin = await resLogin.json();
    if (resLogin.status !== 200 || !dataLogin.token) throw new Error('Login failed with valid credentials');
    console.log('  [PASS] Seller Login success (HTTP 200)');

    // 5. Invalid Login Credentials
    const resBadLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: sellerPayload.email, password: 'WrongPassword999!' }),
    });
    if (resBadLogin.status !== 401) throw new Error(`Expected 401 for wrong password, got ${resBadLogin.status}`);
    console.log('  [PASS] Incorrect credentials rejected (HTTP 401)');

    // 6. Protected Route: GET /api/auth/me
    console.log('Testing Protected Route: GET /api/auth/me...');
    const resMeUnauth = await fetch(`${baseUrl}/api/auth/me`);
    if (resMeUnauth.status !== 401) throw new Error(`Expected 401 when accessing protected route without token, got ${resMeUnauth.status}`);

    const resMe = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${sellerToken}` },
    });
    const dataMe = await resMe.json();
    if (resMe.status !== 200 || dataMe.id !== sellerId) throw new Error('GET /api/auth/me failed or identity mismatch');
    console.log('  [PASS] GET /api/auth/me authenticated successfully');

    // 7. Business Profile Retrieval: GET /api/business
    console.log('Testing Business Profile Management...');
    const resBiz = await fetch(`${baseUrl}/api/business`, {
      headers: { Authorization: `Bearer ${sellerToken}` },
    });
    const dataBiz = await resBiz.json();
    if (resBiz.status !== 200 || dataBiz.sellerId !== sellerId) throw new Error('GET /api/business failed');
    if (dataBiz.name !== sellerPayload.businessName) throw new Error('Business name mismatch');
    console.log('  [PASS] GET /api/business retrieved default profile');

    // 8. Business Profile Update: PATCH /api/business
    const updatePayload = {
      location: '15 Admiralty Way, Lekki Phase 1, Lagos',
      deliveryFee: 2500,
      description: 'Premium organic skincare and beauty essentials',
      whatsappPhone: '+2348031234567',
      whatsappConnected: true,
    };

    const resUpdateBiz = await fetch(`${baseUrl}/api/business`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
      },
      body: JSON.stringify(updatePayload),
    });
    const dataUpdatedBiz = await resUpdateBiz.json();
    if (resUpdateBiz.status !== 200 || dataUpdatedBiz.deliveryFee !== 2500 || dataUpdatedBiz.whatsappConnected !== true) {
      throw new Error(`PATCH /api/business failed: ${JSON.stringify(dataUpdatedBiz)}`);
    }
    console.log('  [PASS] PATCH /api/business updated settings successfully');

    // 9. Pre-seeded Admin Login & RBAC Verification
    console.log('Testing Pre-seeded Admin & Role verification...');
    const resAdminLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@cognicart.ng', password: 'Admin123!' }),
    });
    const dataAdmin = await resAdminLogin.json();
    if (resAdminLogin.status !== 200 || dataAdmin.seller.role !== 'admin') {
      throw new Error(`Admin login failed: ${JSON.stringify(dataAdmin)}`);
    }
    console.log('  [PASS] Admin authenticated with role "admin"');

    // 10. Public Storefront: GET /api/sellers/:id
    console.log('Testing Public Storefront Endpoint...');
    const resStorefront = await fetch(`${baseUrl}/api/sellers/${sellerId}`);
    const dataStorefront = await resStorefront.json();
    if (resStorefront.status !== 200 || dataStorefront.name !== sellerPayload.businessName) {
      throw new Error('GET /api/sellers/:id failed');
    }
    console.log('  [PASS] GET /api/sellers/:id returned public storefront profile');

    console.log('=== All Phase 2 Tests Passed Successfully! ===');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('Phase 2 Test Suite Failed:', err);
  process.exit(1);
});
