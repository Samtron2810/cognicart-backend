# Telegram & Storefront AI Commerce Backend

Multi-tenant commerce backend powering Telegram sales bots, guest-first public storefronts, an AI sales agent, catalog and inventory management, Paystack payment reconciliation, Brevo email, seller order operations, Telegram campaigns, platform revenue administration, and production-grade security controls.

---

## 🌟 Architecture & Phases

The system architecture is implemented across modular phases following domain-driven design, multi-tenant isolation, and resilient architectural standards:

### Phase 1: Base Architecture & Infrastructure
- **Core Server**: Node.js & Express cleanly separated in `server.js` (no root `index.js`).
- **Configuration**: Modularized CORS (`config/corsOptions.js`, `config/allowedOrigins.js`), database connections (`config/db.js`), and environment defaults (`config/config.js`).
- **Middleware**: Centralized Winston logger with morgan integration (`middleware/requestLogger.js`), centralized error handler (`middleware/errorHandler.js`), and 404 router.
- **Validation**: Reusable payload validation schemas and utilities (`utils/validators.js`, `utils/jwt.js`).

### Phase 2: Seller Authentication & Multi-Tenant Business Profiles
- **Authentication**: JWT token generation (`/api/auth/register`, `/api/auth/login`, `/api/auth/me`).
- **Multi-Tenant Protection**: RBAC and tenant authorization guards (`middleware/authMiddleware.js`).
- **Business Profile**: Store profile, public share contact, currency, and delivery policies (`/api/business`, `/api/sellers/:id`).

### Phase 3: Product Catalog & Variant Inventory Management
- **Catalog Model**: Products with dynamic variants (size, color), SKU tracking, discount percentages, and Cloudinary media upload hooks (`/api/products`).
- **Isolation**: Automatic seller scoping preventing cross-tenant access, modification, or deletions.
- **Search & Filter**: Keyword search, category filtering, in-stock queries, and public catalog endpoints.

### Phase 4: Order Lifecycle, Stock Deductions & Idempotency
- **Order Processing**: Atomically validates stock, calculates delivery fees, captures unit prices, reserves inventory, and records orders (`/api/orders`).
- **Idempotency**: Header-driven deduplication (`X-Idempotency-Key`) preventing double-charges and double-stock reservation.
- **Customer CRM**: Automatic customer record updates and aggregate lifetime order metrics (`/api/customers`).

### Phase 5: Conversational Commerce Foundation
- **Channel-Aware Memory**: Customer transcripts and conversation threads are transport-aware and tenant-scoped.
- **Commerce Agent Foundation**: Product discovery, stock checks, delivery information, order creation, and payments use authoritative seller data.
- **Removed Provider Surface**: The former Cloud messaging credentials, webhook, routes, controller, and sender were deleted. Only client-opened `wa.me` share links remain.

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
- **Orchestration**: `services/ai/aiService.js` uses the OpenAI tool loop when configured. Without an API key, `services/ai/deterministicAgent.js` runs a durable state machine for ranked product discovery, product/variant choice, quantity, address, verified contact, confirmation, order creation, and payment handoff.
- **Durable Sessions**: Deterministic drafts are tenant-scoped, stored under opaque keys in MongoDB, and expire after 24 hours instead of disappearing on a process restart.
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

### Phase 10: Transactional Notifications, Marketing Campaigns & CRM Automation
- **Event-Driven Transactional Notifications**: Order confirmations, payment receipts, and fulfillment updates are provider-neutral events; storefront buyers receive them through Brevo email.
- **Audience Segmentation**: Filter customers into actionable segments (`ALL`, `VIP`, `INACTIVE`, `NEW`) with live preview (`GET /api/campaigns/segments/:segment/preview`).
- **Broadcast Marketing Campaigns**: Create and dispatch personalized broadcast messages with variable interpolation (`{{name}}`, `{{store}}`) (`POST /api/campaigns`, `POST /api/campaigns/:id/send`).
- **Abandoned Order Recovery Engine**: Detects unpaid Telegram orders and dispatches personalized in-chat reminders (`POST /api/campaigns/abandoned-orders/trigger`).
- **Telegram Opt-Out Compliance**: `/stop`, `STOP`, and `UNSUBSCRIBE` immediately remove a bot user from marketing; `/start` opts them back in.

### Phase 11: Public Storefront & Discoverability Endpoints (Catalog & SEO Support)
- **Storefront Discovery & Slug Routing**: Public storefront access by unique `sellerId` or customized handle/slug (`GET /api/storefront/:identifier`).
- **Public Catalog Browsing**: Category filtering, keyword search, price range filtering, in-stock badges, sorting (`price-asc`, `price-desc`, `newest`), and pagination (`GET /api/storefront/:identifier/products`).
- **Public Product Detail & Recommendations**: Item attributes, variant selections, and related category products (`GET /api/storefront/:identifier/products/:productId`).
- **Social Sharing & OpenGraph/Twitter Cards**: Dynamic metadata for messaging-app link unfurling and social media cards (`GET /api/storefront/:identifier/seo`, `GET /api/storefront/:identifier/products/:productId/seo`).
- **Schema.org JSON-LD Structured Data**: Search-engine rich snippets for Google Merchant (`Product`, `Offer`, `OnlineStore`).
- **Search Engine Sitemaps**: Dynamic XML and JSON sitemaps indexer (`GET /api/storefront/:identifier/sitemap.xml`, `GET /api/storefront/:identifier/sitemap.json`).

### Phase 12: Production Hardening, Security, Rate Limiting & End-to-End Validation
- **Tiered Sliding-Window Rate Limiting**: Dedicated protection for auth/login endpoints (`15 req/15min`), sensitive API mutations (`100 req/min`), and public browsing (`300 req/min`) with `RateLimit-*` headers and `429 Too Many Requests` responses.
- **Production Defense Headers**: `Content-Security-Policy`, `Strict-Transport-Security` (HSTS), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and removal of `X-Powered-By`.
- **NoSQL Injection Defense**: Automated detection and blocking of prohibited query operators (`$gt`, `$where`, `$ne`, etc.) across bodies, query parameters, and route parameters.
- **Reliability & Health Probes**: Container liveness probe (`GET /health/live`) and deep readiness probe (`GET /health/ready`) tracking database status and heap memory usage.

### Phase 14: Unified Seller Order Hub
- **Manual Order Capture**: Authenticated sellers can log orders taken on Instagram, WhatsApp, Facebook, TikTok, phone calls, walk-ins, referrals, or any other external channel (`POST /api/orders/manual`).
- **Clear Provenance**: Every order has a visible/indexed `source` (`storefront`, `telegram`, or `manual`); manual rows also carry `sourceChannel`, `sourceNote`, and the seller who entered them. One collection keeps revenue and customer reporting whole while badges and filters keep automatic/manual workflows distinct.
- **Catalog + Custom Items**: A manual order can combine catalog products with negotiated prices and off-catalog free-text items. Automatic checkout remains price-authoritative and cannot use this seller-only path.
- **Offline Payment Guard**: Sellers may record cash, bank transfer, POS, or other payment only for `source=manual` rows. Storefront/bot orders become Paid only through payment verification.
- **Operations**: Per-seller references (`#00001`), expected delivery dates, notes, optional inventory deduction, source-split dashboard totals, source-aware CSV exports, and corrections with stock reconciliation.
- **No-API Sharing**: `GET /api/orders/:id/share` returns copyable summary text and a pre-filled `wa.me` deep link. It never calls Meta, sends in the background, or requires an access token.

### Phase 15: Provider-Neutral Notifications + Brevo
- **Transport Boundary**: Commerce services emit `order.created`, `payment.received`, `order.status_changed`, and `buyer.otp`; `notificationDispatcher` routes them without importing provider-specific code.
- **Brevo Email**: Storefront confirmations, magic tracking links, payment receipts, shipping updates, and one-time login codes use the Brevo transactional email API.
- **Safe OTP Routing**: A request may only select an email already associated with that phone through checkout or a verified shopper profile. Supplying an arbitrary email cannot redirect another buyer's code.
- **Failure Isolation**: Provider failures are logged and return a normalized delivery result; they never roll back an order or verified payment already stored in MongoDB.
- **Telegram-Ready**: The dispatcher supports runtime transport registration without changing order, payment, or shopper-auth services.

### Phase 16: Telegram Bot Commerce
- **Per-Seller Bot Connection**: Sellers connect a BotFather token through `POST /api/telegram/connect`. Bot tokens and webhook secrets are excluded from normal MongoDB queries and every API JSON response.
- **Signed Production Webhooks**: Updates arrive at `/webhooks/telegram/:botId` and must carry the seller-specific `X-Telegram-Bot-Api-Secret-Token`. `(bot, chat, message_id)` is unique in the transcript store, so webhook retries cannot create duplicate orders.
- **Local Long Polling**: `npm run telegram:poll` processes bots connected in polling mode during development. Production intentionally rejects the poller and uses HTTPS webhooks.
- **Progressive Contact**: A buyer can browse immediately. Before checkout, the bot presents Telegram's `request_contact` keyboard and accepts the phone only when `contact.user_id` matches the message sender.
- **Scoped AI Commerce**: AI tools receive an immutable `(seller, channel, bot, Telegram user)` context. Telegram order reads/payment links require an exact channel-user match and never interpret a numeric Telegram ID as a phone number.
- **Transactions + Marketing**: Telegram orders retain indexed provenance, use existing Paystack checkout links, receive in-chat confirmations/receipts/status updates, and can receive throttled campaigns only after initiating the bot. `/stop` opts out of marketing.

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
| `POST` | `/api/orders` | Storefront/customer checkout (idempotent) | Public / Optional session |
| `GET` | `/api/orders` | List/filter seller orders (`source=manual\|automatic`) | Bearer Token |
| `GET` | `/api/orders/summary` | Source/status/payment dashboard totals | Bearer Token |
| `POST` | `/api/orders/manual` | Log a seller-entered external order | Bearer Token |
| `PATCH` | `/api/orders/manual/:id` | Correct a manually entered order | Bearer Token |
| `PATCH` | `/api/orders/manual/:id/payment` | Record offline payment on a manual order | Bearer Token |
| `GET` | `/api/orders/:id/share` | Copyable summary + pre-filled `wa.me` link (no API send) | Bearer Token |
| `PATCH` | `/api/orders/:id/status`| Update order status | Bearer Token |
| `GET` | `/api/customers` | Seller customer list & metrics | Bearer Token |
| `GET` | `/api/telegram/config` | Get masked bot connection state | Bearer Token |
| `POST` | `/api/telegram/connect` | Validate/connect bot and configure webhook or polling | Bearer Token |
| `DELETE` | `/api/telegram/disconnect` | Remove webhook and stored bot credentials | Bearer Token |
| `GET` | `/api/telegram/conversations` | List Telegram customer threads | Bearer Token |
| `GET` | `/api/telegram/messages` | List Telegram transcripts | Bearer Token |
| `POST` | `/webhooks/telegram/:botId` | Receive Telegram updates | Secret Header |
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
| `GET` | `/api/admin/telegram` | Telegram bot/message operations summary | Admin Only |
| `GET` | `/api/admin/fee` | Get platform fee configuration | Admin Only |
| `PATCH` | `/api/admin/fee` | Update platform commission rate | Admin Only |
| `GET` | `/api/admin/payouts` | List all platform payout requests | Admin Only |
| `PATCH` | `/api/admin/payouts/:id/process`| Approve or reject seller payout | Admin Only |

---

## 🔐 Environment Contract

`.env.example` intentionally lists only deployment inputs used by the application:

| Variable | Required when | Purpose |
| :--- | :--- | :--- |
| `NODE_ENV` | Always | Enables production cookie, CORS, indexing, and polling safeguards |
| `PORT` | Host does not inject one | HTTP listener port |
| `CLIENT_URL` | Always | Browser CORS origin, checkout callbacks, magic links, and order links |
| `API_PUBLIC_URL` | Production Telegram webhooks | Public HTTPS API origin; local polling can leave it blank |
| `MONGO_URI` | Always | Durable MongoDB connection |
| `JWT_SECRET` | Always | Seller/shopper token signing and buyer-token hashing |
| `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME` | Email delivery | Transactional email provider and sender identity |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Media uploads | Product image storage |
| `OPENAI_API_KEY` | OpenAI agent | Optional; deterministic commerce behavior remains available without it |
| `PAYSTACK_SECRET_KEY` | Payments or payouts | Server-side Paystack API calls and webhook verification |

Provider URLs, timeouts, model names, token lifetimes, campaign pacing, fee defaults, test-only
flags, and public payment keys all have safe server defaults or belong in test/runtime tooling,
so they are not duplicated in the environment template. Telegram bot tokens and webhook
secrets are seller-owned credentials stored through the authenticated connection flow.
Run `npm run check-env` after configuration changes to detect stale, duplicate, missing, or
runtime-unused entries in `.env.example`.

## 🗄️ Database Requirement & Setup

MongoDB is **mandatory**. The backend persists every entity (users, businesses, products,
orders, customers, messages, payments, payouts, campaigns, platform config) in MongoDB and
has **no in-memory fallback store** — if the database is unreachable the server refuses to
boot, and if the connection drops at runtime every `/api/*` and `/webhooks/*` request answers
`503 Service Unavailable` instead of silently serving throwaway data.

1. Copy the environment template and point `MONGO_URI` at your instance:
   ```bash
   cp .env.example .env
   ```
2. Start the API:
   ```bash
   npm run dev      # or: npm start
   ```

Health probes stay reachable even while the database is down, so orchestrators can observe it:

| Endpoint | Database up | Database down |
| :--- | :--- | :--- |
| `GET /health` | `200 healthy` | `503 degraded` |
| `GET /health/live` | `200 alive` | `200 alive` |
| `GET /health/ready` | `200 ready` | `503 not-ready` |

### Creating admin / platform owner accounts

There are **no seeded default accounts**. Self-service registration (`POST /api/auth/register`)
always creates a `seller` — a `role` supplied in the request body is ignored. Privileged
accounts are provisioned explicitly from the CLI:

```bash
# create a platform admin
npm run create-admin -- --email admin@yourdomain.com --password 'Str0ngPass1' --name "Platform Admin"

# create a platform owner
npm run create-admin -- --email owner@yourdomain.com --password 'Str0ngPass1' --role platform_owner

# promote an account that already exists (password left untouched)
npm run create-admin -- --email existing@yourdomain.com --role admin --promote

# promote and reset the password in one go
npm run create-admin -- --email existing@yourdomain.com --password 'NewStr0ngPass1' --role admin --promote
```

| Flag | Required | Description |
| :--- | :--- | :--- |
| `--email` | yes | Login email |
| `--password` | when creating | Min 8 characters, 1 uppercase, 1 number |
| `--role` | no | `seller`, `admin` or `platform_owner` (default `admin`) |
| `--name` | no | Business/display name (default `Platform Administration`) |
| `--phone` | no | Nigerian phone number |
| `--promote` | no | Update an account that already exists instead of failing |

The command reads `MONGO_URI` from `.env`, creates the `User` plus its default `Business`
profile, prints the new id/email/role and exits. Admin-only endpoints live under
`/api/admin/*` and `/api/platform/*` (`authorizeRoles('admin', 'platform_owner')`).

### Schema index audit

```bash
npm run check-indexes
```

Loads every model and fails if two definitions declare the same key pattern — the cause of
Mongoose's `Duplicate schema index on {...}` startup warning. No database connection needed.

### Brevo transactional email

1. Verify a sender address or domain in Brevo.
2. Create a v3 API key under Brevo SMTP & API settings.
3. Configure the backend (never expose the API key to the browser):

```bash
BREVO_API_KEY=xkeysib-...
BREVO_SENDER_EMAIL=orders@yourdomain.com
BREVO_SENDER_NAME="Your Platform"
```

`BREVO_API_URL` normally stays at `https://api.brevo.com/v3/smtp/email`; the override exists
for local integration tests. Missing/failed email delivery is logged but never reverses a
stored order or verified payment.

### Telegram bot setup

1. Create a bot with Telegram's `@BotFather` and copy its token.
2. Set the backend's public HTTPS origin in `API_PUBLIC_URL`.
3. As the authenticated seller, connect the token:

```bash
curl -X POST "$API_URL/api/telegram/connect" \
  -H "Authorization: Bearer $SELLER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"botToken":"123456:bot-token","mode":"webhook"}'
```

The API validates the token through `getMe`, generates a per-bot webhook secret, registers
only message/callback updates, and returns masked connection state. It never returns the token
or secret. For local development, omit a webhook URL or pass `"mode":"polling"`, then run:

```bash
npm run telegram:poll
```

Long polling deletes the bot webhook to avoid Telegram `409 Conflict` errors and is blocked
when `NODE_ENV=production`. A seller can disconnect with `DELETE /api/telegram/disconnect`.

---

## 🛒 Buyer Identity (Progressive)

Buyers never register and never hold a password. Guest checkout stays the default
path — the storefront posts `POST /api/orders` with a `sellerId` and no session — and
identity is only established when the buyer wants to *read data back* (order history,
saved addresses). Two ways in, both friction-light:

| Tier | How they got there | What it unlocks |
| :--- | :--- | :--- |
| **0 — Anonymous** | `deviceId` in the frontend | Browse, local cart, guest checkout |
| **1 — Contact claimed** | Phone and email typed at checkout | Order placed; confirmation sent to the supplied email |
| **2 — Contact verified** | Tapped the tracking link in their Brevo order email, or entered the emailed one-time code | Matching cross-store order history, saved addresses, profile |

Verifying creates the global `Shopper` record and claims guest `Order`/`Customer` rows
carrying the exact proven phone-and-email pair. A shared or forged phone number alone
never grants access to another buyer's history.

### Buyer endpoints

| Method | Endpoint | Description | Access |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/shop/auth/request-otp` | Email a 6 digit code for a known phone+email pair (10 min TTL) | Public, rate limited |
| `POST` | `/api/shop/auth/verify-otp` | Exchange phone, email, and code for a buyer session | Public, rate limited |
| `POST` | `/api/shop/auth/magic` | Redeem a single-use tracking-link token | Public, rate limited |
| `POST` | `/api/shop/auth/logout` | Clear the buyer session cookie | Public |
| `GET` | `/api/shop/me` | Profile, stores shopped, saved addresses | Buyer session |
| `PATCH` | `/api/shop/me` | Update display name; email changes require verification | Buyer session |
| `GET` | `/api/shop/me/orders` | Cross-store history (`?sellerId=` to filter) | Buyer session |
| `GET` | `/api/shop/me/orders/:id` | Single order, ownership enforced | Buyer session |

### Security model

- **Separate audiences on a shared secret.** Every JWT carries a `typ` claim
  (`seller` / `shopper`). `protect` rejects buyer tokens, `protectShopper` rejects seller
  tokens, and a buyer session never populates `req.sellerId`. Tokens issued before this
  claim existed are still treated as seller tokens.
- **Separate cookie.** Buyer sessions use `shop_token`, so a merchant and a buyer can be
  signed in in the same browser.
- **Checkout binding.** With a verified session, the order is recorded against the
  session's verified phone and email; `shopperId` in a request body is always discarded.
- **Ownership on read.** History is filtered strictly by backfilled `shopperId`; there is
  no phone-only fallback. Another buyer's order returns `404`.
- **Magic links are single use**, expire after 7 days, and are redeemed over `POST` so
  email security scanners/link previews cannot burn them. Codes expire in 10 minutes,
  allow 5 attempts, and are rate limited per phone+email pair (60s cooldown) and per IP (10/hour).
- **OTP email cannot be redirected.** The destination must already be associated with the
  phone through checkout or a verified profile; an arbitrary email in the request is ignored.
- Only hashes of codes and link tokens are stored; documents self-destruct via a TTL index.
- **AI agent tools are scoped to the conversation counterparty.** Tool executors receive
  verified shopper identity or the exact `(channel, bot, channelUserId)` tuple in addition
  to `sellerId`. `getOrder` and `createPayment` only touch orders belonging to that identity,
  while `createOrder` records immutable provenance. Unknown ownership answers
  "not found" rather than "forbidden", so the agent cannot be used to probe which order IDs
  exist. A seller authenticated against their own tenant (dashboard / agent test console)
  keeps tenant-wide access.

### Local testing without a Brevo account

```bash
SHOP_OTP_DEBUG=true npm run dev     # returns the code in the API response (never in production)
```

---

## 🧪 Testing

The repository contains automated integration test suites across all implemented phases.

Integration suites exercise the real persistence layer, so a **running MongoDB is required**
for phases 1–15. Point `MONGO_URI_TEST` at a throwaway database (default
`mongodb://127.0.0.1:27017/wabac_test`) — each database-backed suite wipes it before use.
Phases 16–17 are offline provider/security contract suites:

```bash
export MONGO_URI_TEST=mongodb://127.0.0.1:27017/wabac_test
```

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
node tests/phase13.test.js
node tests/phase14.test.js
node tests/phase15.test.js
node tests/phase16.test.js   # Telegram adapter contracts; no MongoDB required
node tests/phase17.test.js   # removed-provider/share-link contracts; no MongoDB required
```
