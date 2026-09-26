# WABAC (WhatsApp Business & AI Commerce) Backend

High-performance, multi-tenant conversational commerce backend powering WhatsApp-first merchant storefronts, automated AI sales agents, real-time catalog & inventory management, automated Paystack payment reconciliation, platform revenue administration, seller financial settlements, automated marketing campaigns, public storefronts & SEO discoverability, and production-grade security hardening.

---

## 🌟 Architecture & Phases

The complete system architecture is implemented across 12 modular phases following domain-driven design, multi-tenant isolation, and resilient architectural standards:

### Phase 1: Base Architecture & Infrastructure
- **Core Server**: Node.js & Express cleanly separated in `server.js` (no root `index.js`).
- **Configuration**: Modularized CORS (`config/corsOptions.js`, `config/allowedOrigins.js`), database connections (`config/db.js`), and environment defaults (`config/config.js`).
- **Middleware**: Centralized Winston logger with morgan integration (`middleware/requestLogger.js`), centralized error handler (`middleware/errorHandler.js`), and 404 router.
- **Validation**: Reusable payload validation schemas and utilities (`utils/validators.js`, `utils/jwt.js`).

### Phase 2: Seller Authentication & Multi-Tenant Business Profiles
- **Authentication**: JWT token generation (`/api/auth/register`, `/api/auth/login`, `/api/auth/me`).
- **Multi-Tenant Protection**: RBAC and tenant authorization guards (`middleware/authMiddleware.js`).
- **Business Profile**: Store profile, WhatsApp connection state, currency, and delivery policies (`/api/business`, `/api/sellers/:id`).

### Phase 3: Product Catalog & Variant Inventory Management
- **Catalog Model**: Products with dynamic variants (size, color), SKU tracking, discount percentages, and Cloudinary media upload hooks (`/api/products`).
- **Isolation**: Automatic seller scoping preventing cross-tenant access, modification, or deletions.
- **Search & Filter**: Keyword search, category filtering, in-stock queries, and public catalog endpoints.

### Phase 4: Order Lifecycle, Stock Deductions & Idempotency
- **Order Processing**: Atomically validates stock, calculates delivery fees, captures unit prices, reserves inventory, and records orders (`/api/orders`).
- **Idempotency**: Header-driven deduplication (`X-Idempotency-Key`) preventing double-charges and double-stock reservation.
- **Customer CRM**: Automatic customer record updates and aggregate lifetime order metrics (`/api/customers`).

### Phase 5: WhatsApp Cloud API Integration & Webhook Auto-Responder
- **Meta Verification**: Hub challenge verification handshake (`GET /api/whatsapp/webhook`).
- **Event Handling**: Inbound message receiver (`POST /api/whatsapp/incoming` & `POST /api/whatsapp/webhook`).
- **Conversational Memory**: Customer message transcripts, conversation threading, and outbound message dispatch (`/api/whatsapp/messages`, `/api/whatsapp/send`).

### Phase 6: AI Conversational Sales Agent (OpenAI & Function Tools)
- **Zero-Hallucination Tools**:
  - `searchProducts`: Natural language query matching against seller's live catalog.
  - `getProduct`: Detailed variant and price lookup.
  - `checkStock`: Authoritative stock availability check.
  - `getBusinessInformation`: Operating hours, delivery areas, fees, and contact info.
  - `calculateOrderTotal`: Authoritative calculation of items, discounts, and delivery fees.
  - `createOrder`: Safe order creation with customer details and line items.
  - `getOrder`: Real-time order status tracking.
  - `createPayment`: Paystack link generation for confirmed orders.
- **Orchestration**: `services/ai/aiService.js` with iterative tool execution loop and deterministic fallback agent when API keys are absent.
- **AI Chat Endpoint**: `POST /api/ai/chat`.

### Phase 7: Paystack Payments & Automated Reconciliation
- **Payment Initialization**: Initializes transactions with dynamic revenue splitting (Platform Commission + Paystack Fee + Seller Payout) (`POST /api/payments/initialize`).
- **Verification & Reconciler**: Verifies references and automatically marks orders as `Paid`, triggering seller notification (`POST /api/payments/verify/:reference`).
- **Webhook Handshake**: Cryptographic HMAC-SHA512 signature verification for automated webhook callbacks (`POST /api/payments/webhook`).

### Phase 8: Platform Revenue Tracking & Admin Dashboard
- **Platform Analytics**: Global KPIs covering Total Sellers, Active Sellers, Platform Revenue, Total Orders, and Gross Merchandise Value (`GET /api/admin/stats`).
- **Seller Management**: Listing, auditing, and toggling seller suspension (`GET /api/admin/sellers`, `PATCH /api/admin/sellers/:id/status`).
- **Revenue Ledger**: Detailed commission breakdown and transaction history (`GET /api/admin/revenue`).
- **Dynamic Fee Configuration**: Configurable platform percentage and fixed cut engine (`GET /api/admin/fee`, `PATCH /api/admin/fee`).

### Phase 9: Seller Analytics Dashboard, Payouts & Data Exports
- **Seller Analytics**: Overview KPIs (Total Sales, Net Earnings, AOV, Orders breakdown, Customer retention rate) (`GET /api/analytics/overview`).
- **Sales Trends & Rankings**: Time-series revenue trends (`GET /api/analytics/trends`) and top-selling products by quantity and revenue (`GET /api/analytics/top-products`).
- **Payout & Settlement Engine**: Bank account verification (`POST /api/payouts/resolve-account`), available balance calculation, withdrawal requests (`POST /api/payouts/request`), and admin disbursement workflow (`GET /api/admin/payouts`, `PATCH /api/admin/payouts/:id/process`).
- **CSV Data Exports**: Downloadable CSV reports for order history (`GET /api/analytics/export/orders`) and financial revenue ledgers (`GET /api/analytics/export/revenue`).

### Phase 10: Automated WhatsApp Notifications, Marketing Campaigns & CRM Automation
- **Event-Driven Transactional Notifications**: Automated WhatsApp messages sent on Order Creation, Order Status Updates (`Shipped`, `Delivered`), and Payment Receipts.
- **Audience Segmentation**: Filter customers into actionable segments (`ALL`, `VIP`, `INACTIVE`, `NEW`) with live preview (`GET /api/campaigns/segments/:segment/preview`).
- **Broadcast Marketing Campaigns**: Create and dispatch personalized broadcast messages with variable interpolation (`{{name}}`, `{{store}}`) (`POST /api/campaigns`, `POST /api/campaigns/:id/send`).
- **Abandoned Order Recovery Engine**: Detects unpaid orders and automatically dispatches personalized WhatsApp checkout reminders with direct payment links (`POST /api/campaigns/abandoned-orders/trigger`).
- **WhatsApp Opt-Out Compliance**: Immediate handling of `STOP` / `UNSUBSCRIBE` and `START` keywords to respect customer preferences and regulatory standards.

### Phase 11: Public Storefront & Discoverability Endpoints (Catalog & SEO Support)
- **Storefront Discovery & Slug Routing**: Public storefront access by unique `sellerId` or customized handle/slug (`GET /api/storefront/:identifier`).
- **Public Catalog Browsing**: Category filtering, keyword search, price range filtering, in-stock badges, sorting (`price-asc`, `price-desc`, `newest`), and pagination (`GET /api/storefront/:identifier/products`).
- **Public Product Detail & Recommendations**: Item attributes, variant selections, and related category products (`GET /api/storefront/:identifier/products/:productId`).
- **Social Sharing & OpenGraph/Twitter Cards**: Dynamic metadata generator for WhatsApp link unfurling and social media cards (`GET /api/storefront/:identifier/seo`, `GET /api/storefront/:identifier/products/:productId/seo`).
- **Schema.org JSON-LD Structured Data**: Search-engine rich snippets for Google Merchant (`Product`, `Offer`, `OnlineStore`).
- **Search Engine Sitemaps**: Dynamic XML and JSON sitemaps indexer (`GET /api/storefront/:identifier/sitemap.xml`, `GET /api/storefront/:identifier/sitemap.json`).

### Phase 12: Production Hardening, Security, Rate Limiting & End-to-End Validation
- **Tiered Sliding-Window Rate Limiting**: Dedicated protection for auth/login endpoints (`15 req/15min`), sensitive API mutations (`100 req/min`), and public browsing (`300 req/min`) with `RateLimit-*` headers and `429 Too Many Requests` responses.
- **Production Defense Headers**: `Content-Security-Policy`, `Strict-Transport-Security` (HSTS), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and removal of `X-Powered-By`.
- **NoSQL Injection Defense**: Automated detection and blocking of prohibited query operators (`$gt`, `$where`, `$ne`, etc.) across bodies, query parameters, and route parameters.
- **Reliability & Health Probes**: Container liveness probe (`GET /health/live`) and deep readiness probe (`GET /health/ready`) tracking database status and heap memory usage.

---

## 🛠️ Complete API Routes Directory

| Method | Endpoint | Description | Access |
|---|---|---|---|
| `GET` | `/health` / `/api/health` | Service health status | Public |
| `GET` | `/health/live` / `/api/health/live` | Container liveness probe | Public |
| `GET` | `/health/ready` / `/api/health/ready` | Deep system readiness probe | Public |
| `POST` | `/api/auth/register` | Register new seller account (rate limited) | Public |
| `POST` | `/api/auth/login` | Authenticate seller or admin (rate limited) | Public |
| `GET` | `/api/auth/me` | Fetch authenticated seller profile | Bearer Token |
| `GET` | `/api/business` | Get seller's business configuration | Bearer Token |
| `PATCH` | `/api/business` | Update business settings, slug & policies | Bearer Token |
| `GET` | `/api/sellers/:id` | Public storefront profile | Public |
| `GET` | `/api/products` | Search/list seller products (or public) | Optional / Bearer |
| `POST` | `/api/products` | Create product with variants | Bearer Token |
| `PATCH` | `/api/products/:id` | Update product details | Bearer Token |
| `DELETE`| `/api/products/:id` | Remove product from catalog | Bearer Token |
| `POST` | `/api/orders` | Create customer order (idempotent) | Bearer Token |
| `GET` | `/api/orders` | List seller orders | Bearer Token |
| `PATCH` | `/api/orders/:id/status`| Update order status | Bearer Token |
| `GET` | `/api/customers` | Seller customer list & metrics | Bearer Token |
| `GET` | `/api/whatsapp/webhook` | Meta verification handshake | Public |
| `POST` | `/api/whatsapp/webhook` | Meta inbound webhook events | Public |
| `POST` | `/api/whatsapp/incoming`| Process inbound WhatsApp message | Public / Webhook |
| `POST` | `/api/whatsapp/send` | Dispatch outbound WhatsApp message | Bearer Token |
| `GET` | `/api/whatsapp/conversations`| Get conversation threads | Bearer Token |
| `GET` | `/api/whatsapp/messages`| Get customer message transcript | Bearer Token |
| `POST` | `/api/ai/chat` | AI Conversational Sales Agent chat | Bearer Token |
| `POST` | `/api/payments/initialize` | Initialize Paystack payment | Bearer Token |
| `POST` | `/api/payments/verify/:reference` | Verify payment & reconcile order | Bearer Token |
| `POST` | `/api/payments/webhook` | Paystack automated webhook | Signature Verified |
| `GET` | `/api/analytics/overview` | Seller sales & earnings overview | Bearer Token |
| `GET` | `/api/analytics/trends` | Time-series sales trends | Bearer Token |
| `GET` | `/api/analytics/top-products`| Top-selling products rankings | Bearer Token |
| `GET` | `/api/analytics/customers`| Customer lifetime spend & retention | Bearer Token |
| `GET` | `/api/analytics/export/orders` | Export seller orders as CSV | Bearer Token |
| `GET` | `/api/analytics/export/revenue` | Export financial transactions as CSV | Bearer Token |
| `GET` | `/api/payouts/balance` | Query current available balance | Bearer Token |
| `POST` | `/api/payouts/resolve-account` | Verify Nigerian bank account (NUBAN) | Bearer Token |
| `POST` | `/api/payouts/request` | Submit withdrawal request | Bearer Token |
| `GET` | `/api/payouts` | List seller payout history | Bearer Token |
| `POST` | `/api/campaigns` | Create marketing broadcast campaign | Bearer Token |
| `GET` | `/api/campaigns` | List seller marketing campaigns | Bearer Token |
| `GET` | `/api/campaigns/segments/:seg/preview`| Preview audience for segment | Bearer Token |
| `POST` | `/api/campaigns/:id/send` | Dispatch broadcast campaign | Bearer Token |
| `POST` | `/api/campaigns/abandoned-orders/trigger`| Trigger abandoned order reminders | Bearer Token |
| `GET` | `/api/storefront/:identifier` | Public storefront by slug or sellerId | Public |
| `GET` | `/api/storefront/:identifier/categories` | Public store categories with counts | Public |
| `GET` | `/api/storefront/:identifier/products` | Public catalog search, filter & sort | Public |
| `GET` | `/api/storefront/:identifier/products/:id` | Product details & related items | Public |
| `GET` | `/api/storefront/:identifier/seo` | Storefront OpenGraph & Schema.org tags | Public |
| `GET` | `/api/storefront/:identifier/products/:id/seo` | Product OpenGraph & Product JSON-LD | Public |
| `GET` | `/api/storefront/:identifier/sitemap.xml` | Dynamic XML Sitemap for crawlers | Public |
| `GET` | `/api/storefront/:identifier/sitemap.json` | Dynamic JSON Sitemap for crawlers | Public |
| `GET` | `/api/admin/stats` | Platform performance KPIs | Admin Only |
| `GET` | `/api/admin/sellers` | Manage platform sellers | Admin Only |
| `PATCH` | `/api/admin/sellers/:id/status`| Suspend or activate seller | Admin Only |
| `GET` | `/api/admin/revenue` | Platform revenue & commission ledger| Admin Only |
| `GET` | `/api/admin/fee` | Get platform fee configuration | Admin Only |
| `PATCH` | `/api/admin/fee` | Update platform commission rate | Admin Only |
| `GET` | `/api/admin/payouts` | List all platform payout requests | Admin Only |
| `PATCH` | `/api/admin/payouts/:id/process`| Approve or reject seller payout | Admin Only |

---

## 🧪 Testing

The repository contains automated integration test suites across all 12 phases.

Run the complete test suite:
```bash
npm test
```

Run individual phases:
```bash
node tests/phase1.test.js
node tests/phase2.test.js
node tests/phase3.test.js
node tests/phase4.test.js
node tests/phase5.test.js
node tests/phase6.test.js
node tests/phase7.test.js
node tests/phase8.test.js
node tests/phase9.test.js
node tests/phase10.test.js
node tests/phase11.test.js
node tests/phase12.test.js
```
