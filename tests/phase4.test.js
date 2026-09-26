/**
 * Phase 4 Verification Test Suite
 * Tests Customer Profiles, Order Checkout, Stock Deduction, Idempotency, and Order Lifecycle
 */

const http = require('http');
const app = require('../server');
const authService = require('../services/auth/authService');
const productService = require('../services/products/productService');

async function runTests() {
  console.log('=== Running Phase 4 Verification Tests ===');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Setup seller and product
    const sellerRes = await authService.register({
      businessName: 'Lagos Urban Threads',
      email: `urban_${Date.now()}@threads.ng`,
      password: 'Password123!',
      phone: '+2348033333333',
    });
    const seller = sellerRes.seller;
    const token = sellerRes.token;

    const product = await productService.create(seller.id, {
      name: 'Classic Linen Shirt',
      price: 15000,
      stock: 10,
      category: 'Fashion',
      variants: [
        { id: 'var_m_wht', size: 'M', color: 'White', stock: 5, sku: 'LIN-M-WHT', price: 15000 },
        { id: 'var_l_wht', size: 'L', color: 'White', stock: 5, sku: 'LIN-L-WHT', price: 15000 },
      ],
    });

    // 2. Order Checkout with Idempotency Key
    console.log('Testing Order Creation and Stock Reservation...');
    const idemKey = `idem_${Date.now()}_test`;
    const orderPayload = {
      customer: {
        name: 'Chioma Adebayo',
        phone: '+2348035555555',
        address: '24 Ozumba Mbadiwe Avenue, Victoria Island, Lagos',
      },
      items: [
        {
          productId: product.id,
          variantId: 'var_m_wht',
          quantity: 2,
        },
      ],
      deliveryFee: 2000,
    };

    const resOrder = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Idempotency-Key': idemKey,
      },
      body: JSON.stringify(orderPayload),
    });
    const order = await resOrder.json();

    if (resOrder.status !== 201) throw new Error(`Order placement failed: ${resOrder.status} - ${JSON.stringify(order)}`);
    if (order.subtotal !== 30000) throw new Error(`Expected subtotal 30000, got ${order.subtotal}`);
    if (order.total !== 32000) throw new Error(`Expected total 32000, got ${order.total}`);
    if (order.orderStatus !== 'Pending') throw new Error(`Expected status Pending, got ${order.orderStatus}`);
    console.log('  [PASS] Order created with authoritative price snapshots (HTTP 201)');

    // 3. Verify stock deduction
    const updatedProduct = await productService.getById(product.id, seller.id);
    const updatedVariant = updatedProduct.variants.find((v) => v.id === 'var_m_wht');
    if (updatedVariant.stock !== 3) {
      throw new Error(`Variant stock should be deducted from 5 to 3, got: ${updatedVariant.stock}`);
    }
    if (updatedProduct.stock !== 8) {
      throw new Error(`Total product stock should be deducted from 10 to 8, got: ${updatedProduct.stock}`);
    }
    console.log('  [PASS] Stock atomically deducted upon order placement');

    // 4. Test Idempotency: Re-submitting the same payload with the same key returns cached order without deducting stock again
    console.log('Testing Request Idempotency...');
    const resIdem = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Idempotency-Key': idemKey,
      },
      body: JSON.stringify(orderPayload),
    });
    const cachedOrder = await resIdem.json();

    if (cachedOrder.id !== order.id) throw new Error('Idempotent request did not return identical order ID');
    const productAfterIdem = await productService.getById(product.id, seller.id);
    if (productAfterIdem.stock !== 8) throw new Error('Stock was deducted twice on duplicate idempotent request!');
    console.log('  [PASS] Request idempotency verified: Duplicate requests safely handled without double deduction');

    // 5. Order Status Lifecycle: Pending -> Confirmed -> Shipped -> Delivered
    console.log('Testing Order Status Updates...');
    const resUpdate = await fetch(`${baseUrl}/api/orders/${order.id}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ orderStatus: 'Confirmed' }),
    });
    const updatedOrder = await resUpdate.json();
    if (resUpdate.status !== 200 || updatedOrder.orderStatus !== 'Confirmed') {
      throw new Error(`Status update failed: ${JSON.stringify(updatedOrder)}`);
    }
    console.log('  [PASS] Order status transition succeeded (Confirmed)');

    // 6. Customer Profile Automatic Aggregates Verification
    console.log('Testing Customer Record and Aggregate Stats...');
    const resCust = await fetch(`${baseUrl}/api/customers`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const customers = await resCust.json();
    const customer = customers.find((c) => c.phone.includes('8035555555'));
    if (!customer) throw new Error('Customer profile was not created during checkout');
    if (customer.totalOrders < 1 || customer.totalSpent < 32000) {
      throw new Error(`Customer aggregates not updated properly: ${JSON.stringify(customer)}`);
    }
    console.log('  [PASS] Customer lifetime metrics updated accurately');

    console.log('=== All Phase 4 Tests Passed Successfully! ===');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('Phase 4 Test Suite Failed:', err);
  process.exit(1);
});
