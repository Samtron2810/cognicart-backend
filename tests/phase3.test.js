/**
 * Phase 3 Verification Test Suite
 * Tests Product Catalog, Variants, Discounts, Multi-Tenant Isolation, and Search
 */

const http = require('http');
const app = require('../server');
const authService = require('../services/auth/authService');

async function runTests() {
  console.log('=== Running Phase 3 Verification Tests ===');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Setup two distinct sellers for tenant isolation testing
    const sellerARes = await authService.register({
      businessName: 'Luxe Botanicals',
      email: `luxe_${Date.now()}@botanicals.ng`,
      password: 'Password123!',
      phone: '+2348011111111',
    });
    const sellerA = sellerARes.seller;
    const tokenA = sellerARes.token;

    const sellerBRes = await authService.register({
      businessName: 'Urban Kicks',
      email: `urban_${Date.now()}@kicks.ng`,
      password: 'Password123!',
      phone: '+2348022222222',
    });
    const sellerB = sellerBRes.seller;
    const tokenB = sellerBRes.token;

    console.log('Testing Product Creation with Variants and Discounts...');
    const productAPayload = {
      name: 'Radiance Face Elixir',
      description: 'Organic vitamin C facial oil for glowing skin',
      price: 12500,
      currency: 'NGN',
      stock: 20,
      category: 'Skincare',
      images: ['https://example.com/serum.jpg'],
      discount: { active: true, type: 'percentage', value: 10 },
      variants: [
        { id: 'var_30ml', size: '30ml', stock: 15, sku: 'RAD-30', price: 12500 },
        { id: 'var_50ml', size: '50ml', stock: 5, sku: 'RAD-50', price: 18000 },
      ],
    };

    const resCreate = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify(productAPayload),
    });
    const productA = await resCreate.json();

    if (resCreate.status !== 201 || productA.sellerId !== sellerA.id) {
      throw new Error(`Product creation failed: ${resCreate.status} - ${JSON.stringify(productA)}`);
    }
    if (productA.stock !== 20) throw new Error(`Stock normalization failed, expected 20, got ${productA.stock}`);
    console.log('  [PASS] Product created with variants & discount (HTTP 201)');

    // 2. Multi-Tenant Listing Check: Seller A sees it, Seller B does not
    console.log('Testing Multi-Tenant Catalog Isolation...');
    const resListA = await fetch(`${baseUrl}/api/products`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const listA = await resListA.json();
    if (!listA.some((p) => p.id === productA.id)) throw new Error('Seller A should see their own product');

    const resListB = await fetch(`${baseUrl}/api/products`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const listB = await resListB.json();
    if (listB.some((p) => p.id === productA.id)) throw new Error('Tenant leak: Seller B saw Seller A product');
    console.log('  [PASS] Tenant isolation enforced on catalog list queries');

    // 3. Cross-Tenant Mutation Attempt: Seller B attempts to edit Seller A product
    console.log('Testing Cross-Tenant Modification Guard...');
    const resCrossEdit = await fetch(`${baseUrl}/api/products/${productA.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({ price: 100 }),
    });
    if (resCrossEdit.status !== 404 && resCrossEdit.status !== 403) {
      throw new Error(`Cross-tenant edit should be rejected with 404/403, got ${resCrossEdit.status}`);
    }
    console.log('  [PASS] Cross-tenant product modification rejected');

    // 4. Cross-Tenant Deletion Attempt: Seller B attempts to delete Seller A product
    console.log('Testing Cross-Tenant Deletion Guard...');
    const resCrossDelete = await fetch(`${baseUrl}/api/products/${productA.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    if (resCrossDelete.status !== 404 && resCrossDelete.status !== 403) {
      throw new Error(`Cross-tenant delete should be rejected, got ${resCrossDelete.status}`);
    }
    console.log('  [PASS] Cross-tenant product deletion rejected');

    // 5. Search Functionality
    console.log('Testing Catalog Search...');
    const resSearch = await fetch(`${baseUrl}/api/products?search=Elixir`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const searchResults = await resSearch.json();
    if (searchResults.length === 0 || !searchResults[0].name.includes('Elixir')) {
      throw new Error('Search query by keyword failed');
    }
    console.log('  [PASS] Catalog search by keyword functional');

    // 6. Public Storefront Catalog
    console.log('Testing Public Catalog Access...');
    const resPublic = await fetch(`${baseUrl}/api/products?public=true&sellerId=${sellerA.id}`);
    const publicList = await resPublic.json();
    if (!publicList.some((p) => p.id === productA.id)) {
      throw new Error('Public catalog did not return active product');
    }
    console.log('  [PASS] Public catalog query functional');

    console.log('=== All Phase 3 Tests Passed Successfully! ===');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('Phase 3 Test Suite Failed:', err);
  process.exit(1);
});
