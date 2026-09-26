/**
 * Phase 5 Verification Test Suite
 * Tests WhatsApp Webhook Handshake, Inbound Rule Engine, Outbound Messaging, and Chat Threads
 */

const http = require('http');
const app = require('../server');
const authService = require('../services/auth/authService');
const productService = require('../services/products/productService');

async function runTests() {
  console.log('=== Running Phase 5 Verification Tests ===');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. WhatsApp Webhook Handshake Verification (Meta Hub Challenge)
    console.log('Testing Meta Webhook Verification Handshake...');
    const challengeStr = 'challenge_test_token_98765';
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'wabac_whatsapp_verify_token_default';

    const resHandshake = await fetch(
      `${baseUrl}/api/whatsapp/webhook?hub.mode=subscribe&hub.challenge=${challengeStr}&hub.verify_token=${verifyToken}`
    );
    const bodyHandshake = await resHandshake.text();

    if (resHandshake.status !== 200 || bodyHandshake !== challengeStr) {
      throw new Error(`Webhook handshake failed: ${resHandshake.status} - ${bodyHandshake}`);
    }
    console.log('  [PASS] Meta WhatsApp Webhook Handshake successfully answered (HTTP 200)');

    // Bad token handshake rejected
    const resBadHandshake = await fetch(
      `${baseUrl}/api/whatsapp/webhook?hub.mode=subscribe&hub.challenge=${challengeStr}&hub.verify_token=wrong_token`
    );
    if (resBadHandshake.status === 200) throw new Error('Webhook handshake should reject invalid verify token');
    console.log('  [PASS] Invalid webhook token correctly rejected');

    // 2. Setup Seller with a WhatsApp business phone & catalog
    const sellerRes = await authService.register({
      businessName: 'Naija Spice Hub',
      email: `spice_${Date.now()}@hub.ng`,
      password: 'Password123!',
      phone: '+2348099999999',
    });
    const seller = sellerRes.seller;
    const token = sellerRes.token;

    // Connect WhatsApp
    const businessPhone = '+2348099999999';
    await fetch(`${baseUrl}/api/whatsapp/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ businessPhone }),
    });

    // Add a product to the seller's catalog
    await productService.create(seller.id, {
      name: 'Organic Suya Spice Blend',
      price: 3500,
      stock: 45,
      category: 'Food',
      description: 'Authentic roasted peanut and pepper suya seasoning',
    });

    // 3. Inbound Customer Greeting Message
    console.log('Testing Inbound Greeting Message...');
    const customerPhone = '+2348077777777';
    const resGreeting = await fetch(`${baseUrl}/api/whatsapp/incoming`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        from: customerPhone,
        body: 'Hello, good afternoon!',
        businessPhone,
        sellerId: seller.id,
      }),
    });
    const greetingData = await resGreeting.json();

    if (resGreeting.status !== 200 || !greetingData.outbound) {
      throw new Error(`Greeting handling failed: ${JSON.stringify(greetingData)}`);
    }
    if (!greetingData.outbound.body.includes('Naija Spice Hub')) {
      throw new Error(`Outbound reply should mention business name: ${greetingData.outbound.body}`);
    }
    console.log('  [PASS] Inbound greeting replied with branded welcome');

    // 4. Inbound Product Price Inquiry
    console.log('Testing Inbound Product Price Inquiry...');
    const resPrice = await fetch(`${baseUrl}/api/whatsapp/incoming`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        from: customerPhone,
        body: 'How much is Organic Suya Spice Blend?',
        businessPhone,
        sellerId: seller.id,
      }),
    });
    const priceData = await resPrice.json();
    if (!priceData.outbound.body.includes('3,500') || !priceData.outbound.body.includes('in stock')) {
      throw new Error(`Outbound reply missing authoritative price: ${priceData.outbound.body}`);
    }
    console.log('  [PASS] Inbound price query answered with authoritative price (₦3,500)');

    // 5. Inbound Delivery Inquiry
    console.log('Testing Inbound Delivery Inquiry...');
    const resDelivery = await fetch(`${baseUrl}/api/whatsapp/incoming`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        from: customerPhone,
        body: 'Do you deliver to outside Lagos?',
        businessPhone,
        sellerId: seller.id,
      }),
    });
    const deliveryData = await resDelivery.json();
    if (!deliveryData.outbound.body.includes('Delivery Information')) {
      throw new Error(`Outbound reply missing delivery info: ${deliveryData.outbound.body}`);
    }
    console.log('  [PASS] Inbound delivery inquiry answered with business delivery policies');

    // 6. Outbound Chat Message from Seller Dashboard
    console.log('Testing Outbound Message Dispatch...');
    const resSend = await fetch(`${baseUrl}/api/whatsapp/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: customerPhone,
        body: 'Your package has been prepared for dispatch.',
      }),
    });
    const sendData = await resSend.json();
    if (resSend.status !== 200 || sendData.direction !== 'outbound') {
      throw new Error(`Outbound dispatch failed: ${JSON.stringify(sendData)}`);
    }
    console.log('  [PASS] Outbound chat message dispatched successfully');

    // 7. Message History & Conversation Aggregates
    console.log('Testing Message Transcript and Conversation Threads...');
    const resMsgs = await fetch(`${baseUrl}/api/whatsapp/messages?customerPhone=${encodeURIComponent(customerPhone)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const messages = await resMsgs.json();
    if (messages.length < 4) {
      throw new Error(`Expected at least 4 messages in transcript, got ${messages.length}`);
    }
    console.log(`  [PASS] Retrieved ${messages.length} messages in customer transcript`);

    const resConvs = await fetch(`${baseUrl}/api/whatsapp/conversations`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const conversations = await resConvs.json();
    if (!conversations.some((c) => c.customerPhone === customerPhone)) {
      throw new Error('Conversation thread list does not include customer');
    }
    console.log('  [PASS] Conversation threads aggregated accurately');

    console.log('=== All Phase 5 Tests Passed Successfully! ===');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('Phase 5 Test Suite Failed:', err);
  process.exit(1);
});
