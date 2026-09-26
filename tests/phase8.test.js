/**
 * Phase 8 Verification Test Suite
 * Tests Platform Admin KPIs, Revenue Ledger, Seller Account Suspension, Fee Configuration, and RBAC
 */

const http = require('http');
const app = require('../server');
const authService = require('../services/auth/authService');

async function runTests() {
  console.log('=== Running Phase 8 Verification Tests ===');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Admin Authentication
    console.log('Testing Admin Authentication...');
    const adminLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@cognicart.ng', password: 'Admin123!' }),
    });
    const adminData = await adminLoginRes.json();
    if (adminLoginRes.status !== 200 || !adminData.token) {
      throw new Error(`Admin login failed: ${JSON.stringify(adminData)}`);
    }
    const adminToken = adminData.token;
    console.log('  [PASS] Admin authenticated successfully');

    // 2. Setup ordinary seller to verify RBAC
    const regularSellerRes = await authService.register({
      businessName: 'Regular Seller Boutique',
      email: `regular_${Date.now()}@boutique.ng`,
      password: 'Password123!',
      phone: '+2348011223344',
    });
    const regularToken = regularSellerRes.token;
    const regularSellerId = regularSellerRes.seller.id;

    // 3. Test RBAC: Regular seller blocked from /api/admin/*
    console.log('Testing RBAC Protection on Admin Endpoints...');
    const resBlocked = await fetch(`${baseUrl}/api/admin/stats`, {
      headers: { Authorization: `Bearer ${regularToken}` },
    });
    if (resBlocked.status !== 403) {
      throw new Error(`Expected 403 Forbidden for non-admin, got ${resBlocked.status}`);
    }
    console.log('  [PASS] Non-admin access correctly rejected with HTTP 403 Forbidden');

    // 4. Platform KPIs: GET /api/admin/stats
    console.log('Testing Admin Platform KPIs (GET /api/admin/stats)...');
    const resStats = await fetch(`${baseUrl}/api/admin/stats`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const statsData = await resStats.json();
    if (resStats.status !== 200 || statsData.totalSellers === undefined || statsData.platformRevenue === undefined) {
      throw new Error(`Platform stats query failed: ${JSON.stringify(statsData)}`);
    }
    console.log(`  [PASS] Platform stats retrieved (Total Sellers: ${statsData.totalSellers}, Platform Revenue: ₦${statsData.platformRevenue})`);

    // 5. Seller Management: GET /api/admin/sellers
    console.log('Testing Seller List for Admin...');
    const resSellers = await fetch(`${baseUrl}/api/admin/sellers`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const sellersList = await resSellers.json();
    if (resSellers.status !== 200 || !Array.isArray(sellersList)) {
      throw new Error(`List sellers failed: ${JSON.stringify(sellersList)}`);
    }
    console.log(`  [PASS] Retrieved ${sellersList.length} sellers with activity metrics`);

    // 6. Seller Suspension & Activation Toggle: PATCH /api/admin/sellers/:id/status
    console.log('Testing Seller Suspension Toggle...');
    // Suspend
    const resSuspend = await fetch(`${baseUrl}/api/admin/sellers/${regularSellerId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ isActive: false }),
    });
    const suspendData = await resSuspend.json();
    if (resSuspend.status !== 200 || suspendData.isActive !== false) {
      throw new Error(`Suspend seller failed: ${JSON.stringify(suspendData)}`);
    }

    // Verify suspended seller cannot log in
    const resSuspendedLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: regularSellerRes.seller.email, password: 'Password123!' }),
    });
    if (resSuspendedLogin.status !== 403) {
      throw new Error(`Suspended seller login should be blocked with 403, got ${resSuspendedLogin.status}`);
    }
    console.log('  [PASS] Seller suspended and blocked from logging in');

    // Reactivate
    const resReactivate = await fetch(`${baseUrl}/api/admin/sellers/${regularSellerId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ isActive: true }),
    });
    const reactivateData = await resReactivate.json();
    if (resReactivate.status !== 200 || reactivateData.isActive !== true) {
      throw new Error(`Reactivate seller failed: ${JSON.stringify(reactivateData)}`);
    }
    console.log('  [PASS] Seller account reactivated successfully');

    // 7. Revenue Ledger: GET /api/admin/revenue
    console.log('Testing Revenue Ledger (GET /api/admin/revenue)...');
    const resRevenue = await fetch(`${baseUrl}/api/admin/revenue`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const revenueData = await resRevenue.json();
    if (resRevenue.status !== 200 || !Array.isArray(revenueData.breakdown)) {
      throw new Error(`Revenue ledger query failed: ${JSON.stringify(revenueData)}`);
    }
    console.log('  [PASS] Revenue ledger retrieved with detailed commission splits');

    // 8. Platform Commission Policy Configuration: GET / PATCH /api/admin/fee
    console.log('Testing Commission Fee Policy Configuration...');
    const resUpdateFee = await fetch(`${baseUrl}/api/admin/fee`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ percentage: 7, fixed: 100 }),
    });
    const updatedFee = await resUpdateFee.json();
    if (resUpdateFee.status !== 200 || updatedFee.percentage !== 7 || updatedFee.fixed !== 100) {
      throw new Error(`Fee update failed: ${JSON.stringify(updatedFee)}`);
    }
    console.log('  [PASS] Platform fee updated to 7% + ₦100');

    // Restore default fee for subsequent tests
    await fetch(`${baseUrl}/api/admin/fee`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ percentage: 5, fixed: 0 }),
    });

    console.log('=== All Phase 8 Tests Passed Successfully! ===');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('Phase 8 Test Suite Failed:', err);
  process.exit(1);
});
