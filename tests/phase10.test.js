/**
 * Phase 10 Verification Test Suite
 * Tests Event-Driven Notifications, Customer Segmentation, WhatsApp Marketing Campaigns, Opt-out Compliance, and Abandoned Order Recovery
 */

const http = require('http');
const app = require('../server');

async function runTests() {
  console.log('=== Running Phase 10 Verification Tests ===');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Setup Seller
    const sellerPayload = {
      email: `marketing_${Date.now()}@hub.ng`,
      password: 'Password123',
      businessName: 'AfriStyle Couture',
      phone: '+2348033334444',
    };

    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sellerPayload),
    });
    const regData = await regRes.json();
    const sellerId = regData.seller.id;
    const sellerToken = regData.token;

    // Connect WhatsApp for seller
    await fetch(`${baseUrl}/api/whatsapp/connect`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ businessPhone: '+2348033334444' }),
    });

    // Create a product
    const prodRes = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Silk Ankara Kimono',
        price: 25000,
        stock: 20,
        category: 'Fashion',
      }),
    });
    const prod = await prodRes.json();

    // 2. Test Event-Driven Transactional Notifications
    console.log('Testing Event-Driven Order Confirmation Notification...');
    const orderRes = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customer: { name: 'Kemi Adebisi', phone: '+2348099887766', address: 'Lekki Phase 1, Lagos' },
        items: [{ productId: prod.id, quantity: 1 }],
      }),
    });
    const order = await orderRes.json();

    // Check message transcript for Order Confirmation notification
    const msgsRes1 = await fetch(`${baseUrl}/api/whatsapp/messages?customerPhone=%2B2348099887766`, {
      headers: { 'Authorization': `Bearer ${sellerToken}` },
    });
    const msgs1 = await msgsRes1.json();
    const confirmMsg = msgs1.find((m) => m.body.includes('Order Confirmed') && m.body.includes(order.id));
    if (!confirmMsg) {
      throw new Error(`Order confirmation notification was not dispatched: ${JSON.stringify(msgs1)}`);
    }
    console.log(`  [PASS] Order Confirmation notification delivered to customer (+2348099887766)`);

    // Test Order Status Transition Notification (Shipped)
    console.log('Testing Order Status Update Notification (Shipped)...');
    await fetch(`${baseUrl}/api/orders/${order.id}/status`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'Shipped' }),
    });

    const msgsRes2 = await fetch(`${baseUrl}/api/whatsapp/messages?customerPhone=%2B2348099887766`, {
      headers: { 'Authorization': `Bearer ${sellerToken}` },
    });
    const msgs2 = await msgsRes2.json();
    const shippedMsg = msgs2.find((m) => m.body.includes('Shipped'));
    if (!shippedMsg) {
      throw new Error('Order Shipped update notification was not dispatched');
    }
    console.log(`  [PASS] Order Status notification (Shipped) delivered to customer`);

    // Test Payment Receipt Notification
    console.log('Testing Payment Receipt Notification...');
    const initPay = await fetch(`${baseUrl}/api/payments/initialize`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        orderId: order.id,
        amount: order.total,
        email: 'kemi@test.com',
      }),
    });
    const payData = await initPay.json();

    await fetch(`${baseUrl}/api/payments/verify/${payData.reference}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sellerToken}` },
    });

    const msgsRes3 = await fetch(`${baseUrl}/api/whatsapp/messages?customerPhone=%2B2348099887766`, {
      headers: { 'Authorization': `Bearer ${sellerToken}` },
    });
    const msgs3 = await msgsRes3.json();
    const receiptMsg = msgs3.find((m) => m.body.includes('Payment Received') && m.body.includes(payData.reference));
    if (!receiptMsg) {
      throw new Error('Payment receipt notification was not dispatched');
    }
    console.log(`  [PASS] Payment Receipt notification delivered to customer`);

    // 3. Test WhatsApp Opt-Out Compliance (STOP / START)
    console.log('Testing WhatsApp Marketing Opt-out Compliance (STOP)...');
    const stopRes = await fetch(`${baseUrl}/api/whatsapp/incoming`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sellerId,
        from: '+2348099887766',
        body: 'STOP',
      }),
    });
    const stopData = await stopRes.json();
    if (!stopData.outbound.body.includes('unsubscribed')) {
      throw new Error(`Expected opt-out confirmation reply, got: ${stopData.outbound.body}`);
    }

    // Verify customer profile now has marketingOptOut = true
    const custRes = await fetch(`${baseUrl}/api/customers`, {
      headers: { 'Authorization': `Bearer ${sellerToken}` },
    });
    const customers = await custRes.json();
    const kemi = customers.find((c) => c.phone === '+2348099887766');
    if (!kemi || !kemi.marketingOptOut) {
      throw new Error('Customer marketingOptOut was not set to true after sending STOP');
    }
    console.log('  [PASS] Customer successfully unsubscribed (marketingOptOut = true)');

    // Test Re-subscribing via START
    console.log('Testing WhatsApp Re-subscription Compliance (START)...');
    const startRes = await fetch(`${baseUrl}/api/whatsapp/incoming`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sellerId,
        from: '+2348099887766',
        body: 'START',
      }),
    });
    const startData = await startRes.json();
    if (!startData.outbound.body.includes('re-subscribed')) {
      throw new Error(`Expected re-subscription confirmation reply, got: ${startData.outbound.body}`);
    }

    const custRes2 = await fetch(`${baseUrl}/api/customers`, {
      headers: { 'Authorization': `Bearer ${sellerToken}` },
    });
    const customers2 = await custRes2.json();
    const kemi2 = customers2.find((c) => c.phone === '+2348099887766');
    if (!kemi2 || kemi2.marketingOptOut) {
      throw new Error('Customer marketingOptOut was not cleared after sending START');
    }
    console.log('  [PASS] Customer re-subscribed successfully');

    // 4. Test Customer Segmentation & Audience Preview
    console.log('Testing Audience Segmentation Preview...');
    // Create second customer who opts out to test exclusion
    await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customer: { name: 'Tunde Bakare', phone: '+2348022223333', address: 'Ikeja, Lagos' },
        items: [{ productId: prod.id, quantity: 1 }],
      }),
    });

    // Tunde opts out
    await fetch(`${baseUrl}/api/whatsapp/incoming`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sellerId,
        from: '+2348022223333',
        body: 'STOP',
      }),
    });

    const segRes = await fetch(`${baseUrl}/api/campaigns/segments/ALL/preview`, {
      headers: { 'Authorization': `Bearer ${sellerToken}` },
    });
    const segData = await segRes.json();
    if (segRes.status !== 200 || segData.totalAudience !== 1) {
      throw new Error(`Expected totalAudience 1 (opted-out customer excluded), got: ${JSON.stringify(segData)}`);
    }
    console.log('  [PASS] Audience segment correctly excludes opted-out contacts');

    // 5. Test Broadcast Marketing Campaign
    console.log('Testing Marketing Campaign Broadcast Creation & Dispatch...');
    const campRes = await fetch(`${baseUrl}/api/campaigns`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Exclusive Flash Sale Weekend',
        segment: 'ALL',
        message: 'Hello {{name}}! Enjoy 15% off your next order at {{store}} with code FLASH15.',
      }),
    });
    const campaign = await campRes.json();
    if (campRes.status !== 201 || campaign.status !== 'draft') {
      throw new Error(`Campaign creation failed: ${JSON.stringify(campaign)}`);
    }

    // Broadcast campaign
    const sendRes = await fetch(`${baseUrl}/api/campaigns/${campaign.id}/send`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sellerToken}` },
    });
    const sentCampaign = await sendRes.json();
    if (sendRes.status !== 200 || sentCampaign.status !== 'completed' || sentCampaign.stats.sentCount !== 1) {
      throw new Error(`Campaign dispatch failed: ${JSON.stringify(sentCampaign)}`);
    }

    // Verify recipient received interpolated message
    const msgsRes4 = await fetch(`${baseUrl}/api/whatsapp/messages?customerPhone=%2B2348099887766`, {
      headers: { 'Authorization': `Bearer ${sellerToken}` },
    });
    const msgs4 = await msgsRes4.json();
    const promoMsg = msgs4.find((m) => m.body.includes('Hello Kemi Adebisi') && m.body.includes('AfriStyle Couture'));
    if (!promoMsg) {
      throw new Error(`Campaign template placeholder interpolation failed: ${JSON.stringify(msgs4)}`);
    }
    console.log(`  [PASS] Broadcast dispatched and received with personalized tags: "${promoMsg.body}"`);

    // 6. Test Abandoned Order Recovery Engine
    console.log('Testing Abandoned Order Automated Recovery Reminder...');
    // Create an unpaid pending order
    const abandonOrderRes = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customer: { name: 'Kemi Adebisi', phone: '+2348099887766', address: 'Lekki Phase 1, Lagos' },
        items: [{ productId: prod.id, quantity: 1 }],
      }),
    });
    const abandonOrder = await abandonOrderRes.json();

    // Trigger abandoned order recovery
    const triggerRes = await fetch(`${baseUrl}/api/campaigns/abandoned-orders/trigger`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ageMinutes: 0 }),
    });
    const triggerData = await triggerRes.json();
    if (triggerRes.status !== 200 || !triggerData.success || triggerData.remindersSentCount === 0) {
      throw new Error(`Abandoned order reminder trigger failed: ${JSON.stringify(triggerData)}`);
    }

    const msgsRes5 = await fetch(`${baseUrl}/api/whatsapp/messages?customerPhone=%2B2348099887766`, {
      headers: { 'Authorization': `Bearer ${sellerToken}` },
    });
    const msgs5 = await msgsRes5.json();
    const reminderMsg = msgs5.find((m) => m.body.includes('Incomplete Order Reminder') && m.body.includes(abandonOrder.id));
    if (!reminderMsg) {
      throw new Error('Abandoned order reminder was not dispatched to customer');
    }
    console.log(`  [PASS] Abandoned order recovery reminder dispatched for Order #${abandonOrder.id}`);

  } finally {
    server.close();
  }

  console.log('=== All Phase 10 Tests Passed Successfully! ===');
}

runTests().catch((err) => {
  console.error('Phase 10 Test Suite Failed:', err);
  process.exit(1);
});
