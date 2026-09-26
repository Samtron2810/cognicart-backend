/**
 * Phase 9 Verification Test Suite
 * Tests Seller Analytics, Sales Trends, Top Products, Payout/Settlement Engine, Bank Resolution, and CSV Exports
 */

const http = require('http');
const app = require('../server');
const { generateToken } = require('../utils/generateToken');

async function runTests() {
  console.log('=== Running Phase 9 Verification Tests ===');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Setup Seller and Admin
    const sellerPayload = {
      email: `analytics_${Date.now()}@mart.ng`,
      password: 'Password123',
      businessName: 'Zaria Artisans',
      phone: '+2348088888888',
    };

    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sellerPayload),
    });
    const regData = await regRes.json();
    const sellerId = regData.seller.id;
    const sellerToken = regData.token;

    // Login as Admin
    const adminRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@cognicart.ng', password: 'Admin123!' }),
    });
    const adminData = await adminRes.json();
    const adminToken = adminData.token;

    // 2. Create Products
    const prodRes1 = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Handwoven Leather Bag',
        price: 20000,
        stock: 50,
        category: 'Fashion',
      }),
    });
    const prod1 = await prodRes1.json();

    const prodRes2 = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Handcrafted Beaded Necklace',
        price: 10000,
        stock: 30,
        category: 'Jewelry',
      }),
    });
    const prod2 = await prodRes2.json();

    // 3. Create Orders and Complete Payments
    // Order 1: 2x Leather Bags = 40,000 + 1500 = 41,500
    const ordRes1 = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customer: { name: 'Amina Bello', phone: '+2348011112222', address: 'Victoria Island, Lagos' },
        items: [{ productId: prod1.id, quantity: 2 }],
      }),
    });
    const order1 = await ordRes1.json();

    // Initialize & verify payment for Order 1
    const initPay1 = await fetch(`${baseUrl}/api/payments/initialize`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        orderId: order1.id,
        amount: order1.total,
        email: 'amina@test.com',
      }),
    });
    const payData1 = await initPay1.json();
    await fetch(`${baseUrl}/api/payments/verify/${payData1.reference}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sellerToken}` },
    });

    // Order 2: 1x Necklace = 10,000 + 1500 = 11,500
    const ordRes2 = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customer: { name: 'Amina Bello', phone: '+2348011112222', address: 'Victoria Island, Lagos' },
        items: [{ productId: prod2.id, quantity: 1 }],
      }),
    });
    const order2 = await ordRes2.json();

    const initPay2 = await fetch(`${baseUrl}/api/payments/initialize`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        orderId: order2.id,
        amount: order2.total,
        email: 'amina@test.com',
      }),
    });
    const payData2 = await initPay2.json();
    await fetch(`${baseUrl}/api/payments/verify/${payData2.reference}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sellerToken}` },
    });

    // 4. Test Analytics Overview
    console.log('Testing Seller Analytics Overview (GET /api/analytics/overview)...');
    const overviewRes = await fetch(`${baseUrl}/api/analytics/overview`, {
      headers: { 'Authorization': `Bearer ${sellerToken}` },
    });
    const overview = await overviewRes.json();

    if (overviewRes.status !== 200) throw new Error(`Overview returned HTTP ${overviewRes.status}`);
    if (overview.totalSales !== 51500) {
      throw new Error(`Expected totalSales 51500, got ${overview.totalSales}`);
    }
    if (overview.orders.paid !== 2) {
      throw new Error(`Expected 2 paid orders, got ${overview.orders.paid}`);
    }
    if (overview.settlement.availableBalance <= 0) {
      throw new Error(`Expected positive available balance, got ${overview.settlement.availableBalance}`);
    }
    console.log(`  [PASS] Analytics Overview (Sales: ₦${overview.totalSales.toLocaleString()}, Available: ₦${overview.settlement.availableBalance.toLocaleString()})`);

    // 5. Test Sales Trends
    console.log('Testing Sales Trends (GET /api/analytics/trends)...');
    const trendsRes = await fetch(`${baseUrl}/api/analytics/trends?days=7`, {
      headers: { 'Authorization': `Bearer ${sellerToken}` },
    });
    const trends = await trendsRes.json();
    if (trendsRes.status !== 200 || !Array.isArray(trends) || trends.length !== 7) {
      throw new Error('Sales trends failed or returned incorrect length');
    }
    const todayTrend = trends[trends.length - 1];
    if (todayTrend.revenue !== 51500 || todayTrend.ordersCount !== 2) {
      throw new Error(`Sales trend today mismatch: ${JSON.stringify(todayTrend)}`);
    }
    console.log('  [PASS] Sales Trends accurately aggregated by date');

    // 6. Test Top Products
    console.log('Testing Top Products (GET /api/analytics/top-products)...');
    const topProdRes = await fetch(`${baseUrl}/api/analytics/top-products?limit=2`, {
      headers: { 'Authorization': `Bearer ${sellerToken}` },
    });
    const topProducts = await topProdRes.json();
    if (topProdRes.status !== 200 || topProducts.length !== 2) {
      throw new Error('Top products failed');
    }
    if (topProducts[0].productId !== prod1.id || topProducts[0].unitsSold !== 2) {
      throw new Error(`Expected prod1 to be #1 seller with 2 units sold, got: ${JSON.stringify(topProducts[0])}`);
    }
    console.log(`  [PASS] Top product correctly ranked: ${topProducts[0].name} (${topProducts[0].unitsSold} units)`);

    // 7. Test Bank Account Resolution
    console.log('Testing Bank Account Resolution (POST /api/payouts/resolve-account)...');
    const resolveRes = await fetch(`${baseUrl}/api/payouts/resolve-account`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        accountNumber: '0123456789',
        bankCode: '058',
      }),
    });
    const resolveData = await resolveRes.json();
    if (resolveRes.status !== 200 || !resolveData.verified || resolveData.bankName !== 'Guaranty Trust Bank') {
      throw new Error(`Bank resolution failed: ${JSON.stringify(resolveData)}`);
    }

    // Invalid account number rejected
    const invalidResolveRes = await fetch(`${baseUrl}/api/payouts/resolve-account`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        accountNumber: '12345', // only 5 digits
        bankCode: '058',
      }),
    });
    if (invalidResolveRes.status !== 400) {
      throw new Error(`Expected HTTP 400 for invalid account number, got ${invalidResolveRes.status}`);
    }
    console.log('  [PASS] Bank account resolution verified and invalid NUBAN rejected');

    // 8. Test Payout Request and Balance Reservation
    console.log('Testing Payout Withdrawal Request (POST /api/payouts/request)...');
    const available = overview.settlement.availableBalance;

    // Minimum amount validation (< 1000)
    const minRes = await fetch(`${baseUrl}/api/payouts/request`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: 500,
        bankCode: '058',
        accountNumber: '0123456789',
        accountName: 'Zaria Artisans Ltd',
      }),
    });
    if (minRes.status !== 400) throw new Error('Expected 400 for sub-1000 withdrawal');

    // Exceeds available balance
    const excessRes = await fetch(`${baseUrl}/api/payouts/request`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: available + 100000,
        bankCode: '058',
        accountNumber: '0123456789',
        accountName: 'Zaria Artisans Ltd',
      }),
    });
    if (excessRes.status !== 400) throw new Error('Expected 400 for withdrawal exceeding balance');

    // Valid payout request for ₦10,000
    const validPayoutRes = await fetch(`${baseUrl}/api/payouts/request`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: 10000,
        bankCode: '058',
        accountNumber: '0123456789',
        accountName: 'Zaria Artisans Ltd',
      }),
    });
    const payoutData = await validPayoutRes.json();
    if (validPayoutRes.status !== 201 || payoutData.status !== 'pending' || payoutData.amount !== 10000) {
      throw new Error(`Payout request failed: ${JSON.stringify(payoutData)}`);
    }

    // Verify balance is deducted
    const balanceRes = await fetch(`${baseUrl}/api/payouts/balance`, {
      headers: { 'Authorization': `Bearer ${sellerToken}` },
    });
    const balanceData = await balanceRes.json();
    if (balanceData.availableBalance !== available - 10000) {
      throw new Error(`Available balance was not decremented by requested payout: ${JSON.stringify(balanceData)}`);
    }
    console.log(`  [PASS] Payout requested (₦10,000) and available balance reserved`);

    // 9. Admin Payout Processing
    console.log('Testing Admin Payout Processing (PATCH /api/admin/payouts/:id/process)...');
    const adminPayoutsRes = await fetch(`${baseUrl}/api/admin/payouts`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    const allPayouts = await adminPayoutsRes.json();
    if (adminPayoutsRes.status !== 200 || !allPayouts.some((p) => p.id === payoutData.id)) {
      throw new Error('Admin failed to view seller payout requests');
    }

    const processRes = await fetch(`${baseUrl}/api/admin/payouts/${payoutData.id}/process`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'success' }),
    });
    const processed = await processRes.json();
    if (processRes.status !== 200 || processed.status !== 'success') {
      throw new Error(`Admin payout processing failed: ${JSON.stringify(processed)}`);
    }
    console.log('  [PASS] Admin approved seller payout successfully');

    // 10. CSV Exports
    console.log('Testing CSV Data Exports...');
    const csvOrdersRes = await fetch(`${baseUrl}/api/analytics/export/orders`, {
      headers: { 'Authorization': `Bearer ${sellerToken}` },
    });
    const csvOrders = await csvOrdersRes.text();
    if (csvOrdersRes.status !== 200 || !csvOrders.includes('Order ID') || !csvOrders.includes('Handwoven Leather Bag')) {
      throw new Error('Orders CSV export failed or missing content');
    }

    const csvRevenueRes = await fetch(`${baseUrl}/api/analytics/export/revenue`, {
      headers: { 'Authorization': `Bearer ${sellerToken}` },
    });
    const csvRevenue = await csvRevenueRes.text();
    if (csvRevenueRes.status !== 200 || !csvRevenue.includes('Reference') || !csvRevenue.includes(payData1.reference)) {
      throw new Error('Revenue CSV export failed or missing content');
    }
    console.log('  [PASS] CSV export of Orders and Financial Revenue ledger generated successfully');

  } finally {
    server.close();
  }

  console.log('=== All Phase 9 Tests Passed Successfully! ===');
}

runTests().catch((err) => {
  console.error('Phase 9 Test Suite Failed:', err);
  process.exit(1);
});
