/**
 * Phase 11 Verification Test Suite
 * Tests Public Storefront Discovery, Slug Resolution, Categories, Catalog Filtering, SEO Metadata, Schema.org, and XML Sitemaps
 */

const http = require('http');
const app = require('../server');

async function runTests() {
  console.log('=== Running Phase 11 Verification Tests ===');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Setup Seller with custom slug & business details
    const sellerPayload = {
      email: `storefront_${Date.now()}@glow.ng`,
      password: 'Password123',
      businessName: 'Lagos Glow Essentials',
      phone: '+2348055556666',
    };

    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sellerPayload),
    });
    const regData = await regRes.json();
    const sellerId = regData.seller.id;
    const sellerToken = regData.token;

    // Update business profile with slug and custom settings
    await fetch(`${baseUrl}/api/business`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        slug: 'lagos-glow',
        description: 'Premium organic beauty and skincare essentials crafted in Lagos.',
        location: 'Lekki Phase 1, Lagos',
        deliveryInfo: 'Same-day delivery in Lagos, 2-3 days outside Lagos',
        deliveryFee: 2000,
      }),
    });

    // 2. Create Products in multiple categories
    const prod1Res = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Radiance Vitamin C Serum',
        price: 15000,
        stock: 25,
        category: 'Skincare',
        description: 'Brightening face serum with 10% Vitamin C and hyaluronic acid.',
      }),
    });
    const prod1 = await prod1Res.json();

    const prod2Res = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Hydrating Shea Body Butter',
        price: 8000,
        stock: 50,
        category: 'Bodycare',
        description: 'Pure whipped shea butter infused with lavender and jojoba oil.',
      }),
    });
    const prod2 = await prod2Res.json();

    const prod3Res = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sellerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Exfoliating Coffee Body Scrub',
        price: 12000,
        stock: 0, // Out of stock to test inStock filter
        category: 'Bodycare',
        description: 'Arabica coffee scrub to polish and renew dull skin.',
      }),
    });
    const prod3 = await prod3Res.json();

    // 3. Test Public Storefront Discovery by SellerId and Slug
    console.log('Testing Storefront Discovery (by ID and by Slug)...');
    const storeByIdRes = await fetch(`${baseUrl}/api/storefront/${sellerId}`);
    const storeById = await storeByIdRes.json();
    if (storeByIdRes.status !== 200 || storeById.name !== 'Lagos Glow Essentials' || storeById.slug !== 'lagos-glow') {
      throw new Error(`Storefront by ID failed: ${JSON.stringify(storeById)}`);
    }

    const storeBySlugRes = await fetch(`${baseUrl}/api/storefront/lagos-glow`);
    const storeBySlug = await storeBySlugRes.json();
    if (storeBySlugRes.status !== 200 || storeBySlug.sellerId !== sellerId) {
      throw new Error(`Storefront by slug failed: ${JSON.stringify(storeBySlug)}`);
    }
    console.log('  [PASS] Public storefront resolved by seller ID and slug');

    // 4. Test Storefront Categories Aggregation
    console.log('Testing Storefront Categories Aggregation...');
    const catRes = await fetch(`${baseUrl}/api/storefront/lagos-glow/categories`);
    const categories = await catRes.json();
    if (catRes.status !== 200 || !Array.isArray(categories) || categories.length !== 2) {
      throw new Error(`Categories aggregation failed: ${JSON.stringify(categories)}`);
    }
    const bodycareCat = categories.find((c) => c.name === 'Bodycare');
    if (!bodycareCat || bodycareCat.count !== 2) {
      throw new Error(`Expected Bodycare category to have 2 products: ${JSON.stringify(categories)}`);
    }
    console.log('  [PASS] Categories aggregated accurately with product counts');

    // 5. Test Public Catalog Filtering & Sorting
    console.log('Testing Catalog Filtering and Sorting...');
    // Filter by Category
    const filterCatRes = await fetch(`${baseUrl}/api/storefront/lagos-glow/products?category=Skincare`);
    const filterCat = await filterCatRes.json();
    if (filterCat.products.length !== 1 || filterCat.products[0].id !== prod1.id) {
      throw new Error('Category filtering failed');
    }

    // Filter by In-Stock
    const filterStockRes = await fetch(`${baseUrl}/api/storefront/lagos-glow/products?inStock=true`);
    const filterStock = await filterStockRes.json();
    if (filterStock.products.some((p) => p.id === prod3.id)) {
      throw new Error('In-stock filter failed (out-of-stock product was returned)');
    }

    // Filter by Price Range
    const filterPriceRes = await fetch(`${baseUrl}/api/storefront/lagos-glow/products?minPrice=10000&maxPrice=16000`);
    const filterPrice = await filterPriceRes.json();
    if (filterPrice.products.length !== 2) {
      throw new Error(`Price range filter failed, expected 2 products, got: ${filterPrice.products.length}`);
    }

    // Sort by price-asc
    const sortRes = await fetch(`${baseUrl}/api/storefront/lagos-glow/products?sort=price-asc`);
    const sortData = await sortRes.json();
    if (sortData.products[0].price > sortData.products[1].price) {
      throw new Error('Sort price-asc failed');
    }

    // Pagination
    const pageRes = await fetch(`${baseUrl}/api/storefront/lagos-glow/products?page=1&limit=2`);
    const pageData = await pageRes.json();
    if (pageData.pagination.total !== 3 || pageData.pagination.totalPages !== 2 || pageData.products.length !== 2) {
      throw new Error(`Pagination failed: ${JSON.stringify(pageData.pagination)}`);
    }
    console.log('  [PASS] Catalog filtering (category, inStock, price range), sorting and pagination verified');

    // 6. Test Product Detail & Related Recommendations
    console.log('Testing Product Detail & Related Recommendations...');
    const detailRes = await fetch(`${baseUrl}/api/storefront/lagos-glow/products/${prod2.id}`);
    const detail = await detailRes.json();
    if (detailRes.status !== 200 || detail.product.id !== prod2.id) {
      throw new Error('Product detail query failed');
    }
    if (!detail.relatedProducts || !detail.relatedProducts.some((p) => p.id === prod3.id)) {
      throw new Error('Related products recommendation failed');
    }
    console.log(`  [PASS] Product detail retrieved with ${detail.relatedProducts.length} related product(s)`);

    // 7. Test Storefront SEO & OpenGraph Metadata
    console.log('Testing Storefront SEO & OpenGraph Metadata...');
    const storeSeoRes = await fetch(`${baseUrl}/api/storefront/lagos-glow/seo`);
    const storeSeo = await storeSeoRes.json();
    if (
      storeSeoRes.status !== 200 ||
      !storeSeo.seo.openGraph['og:title'].includes('Lagos Glow Essentials') ||
      storeSeo.seo.structuredData['@type'] !== 'OnlineStore'
    ) {
      throw new Error(`Store SEO generation failed: ${JSON.stringify(storeSeo)}`);
    }
    console.log('  [PASS] Storefront OpenGraph and Schema.org OnlineStore tags generated');

    // 8. Test Product SEO & Schema.org JSON-LD Markup
    console.log('Testing Product SEO & Schema.org Product Markup...');
    const prodSeoRes = await fetch(`${baseUrl}/api/storefront/lagos-glow/products/${prod1.id}/seo`);
    const prodSeo = await prodSeoRes.json();
    if (
      prodSeoRes.status !== 200 ||
      prodSeo.seo.openGraph['og:type'] !== 'product' ||
      prodSeo.seo.structuredData['@type'] !== 'Product' ||
      prodSeo.seo.structuredData.offers.price !== 15000
    ) {
      throw new Error(`Product SEO generation failed: ${JSON.stringify(prodSeo)}`);
    }
    console.log('  [PASS] Product SEO tags and Schema.org Product/Offer markup verified');

    // 9. Test XML and JSON Sitemaps
    console.log('Testing Sitemaps (XML & JSON)...');
    const xmlRes = await fetch(`${baseUrl}/api/storefront/lagos-glow/sitemap.xml`);
    const xmlText = await xmlRes.text();
    if (
      xmlRes.status !== 200 ||
      !xmlText.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">') ||
      !xmlText.includes(prod1.id)
    ) {
      throw new Error(`XML Sitemap generation failed: ${xmlText}`);
    }

    const jsonSitemapRes = await fetch(`${baseUrl}/api/storefront/lagos-glow/sitemap.json`);
    const jsonSitemap = await jsonSitemapRes.json();
    if (jsonSitemapRes.status !== 200 || jsonSitemap.totalUrls !== 4) {
      throw new Error(`JSON Sitemap generation failed: ${JSON.stringify(jsonSitemap)}`);
    }
    console.log('  [PASS] XML and JSON Sitemaps generated with valid schema for search engines');

  } finally {
    server.close();
  }

  console.log('=== All Phase 11 Tests Passed Successfully! ===');
}

runTests().catch((err) => {
  console.error('Phase 11 Test Suite Failed:', err);
  process.exit(1);
});
