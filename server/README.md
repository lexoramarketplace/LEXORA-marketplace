# LEXORA API

## Start

Requires Node.js 20+.

```sh
cp .env.example .env
npm start
```

The API listens on `http://localhost:4000`.

## Endpoints

- `GET /` - API welcome message
- `GET /health` - API health check
- `GET /api/health`
- `GET /api/products?search=&category=&location=&verified=true`
- `GET /api/products/:id`
- `GET|POST /api/products/:id/reviews`
- `PUT|PATCH|DELETE /api/reviews/:id`
- `GET /api/wishlist`
- `POST|DELETE /api/wishlist/:productId`
- `GET /api/categories`
- `GET /api/suppliers`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/me`
- `GET|POST /api/addresses`
- `PUT|PATCH|DELETE /api/addresses/:id`
- `POST /api/addresses/:id/default`
- `POST /api/orders`
- `POST /api/rfqs`
- `POST /api/suppliers/apply`
- `GET /api/paypal/config`
- `GET /api/paypal/client-token`
- `POST /api/paypal/create-order`
- `POST /api/paypal/cancel-order`
- `POST /api/paypal/capture-order`
- `GET /api/admin/dashboard`
- `GET|POST /api/admin/products`
- `PATCH|DELETE /api/admin/products/:id`
- `GET /api/admin/orders`
- `GET|PATCH /api/admin/orders/:id`
- `GET|PATCH /api/admin/customers/:id`
- `GET|PATCH /api/admin/suppliers/:id`
- `GET|POST /api/admin/categories`
- `PATCH|DELETE /api/admin/categories/:id`
- `GET /api/admin/payments`
- `GET /api/admin/rfqs`
- `GET /api/admin/reviews?page=1&limit=50`
- `PATCH|DELETE /api/admin/reviews/:id`

Current route inventory: product browsing, product detail, category listing, and supplier listing are registered. Authentication includes register, login, and the authenticated `/api/me` route. Orders are registered as an authenticated `POST /api/orders` route. Supplier onboarding is registered as `POST /api/suppliers/apply`. Category and supplier listings use repository data and include demo records when a production database is not connected.

Authenticated routes expect `Authorization: Bearer <token>`.

Admin routes require an authenticated user whose stored role is `admin`; the server enforces this independently of the dashboard UI. For the JSON development repository, register an account through `/api/auth/register`, then run `node server/promote-admin.js your-email@example.com` locally. This utility changes only that user's role and never handles a password or secret.

PayPal uses the official REST API with server-only `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_ENVIRONMENT=sandbox` values. The wallet flow continues to use a PayPal approval URL. Card checkout loads PayPal's JavaScript SDK v5 directly from the official `/sdk/js` endpoint and uses the hosted `CardFields` component with a server-generated browser-safe client token; card data is sent directly from PayPal-hosted fields to PayPal. The server creates card orders from authoritative catalog data, requests `SCA_WHEN_REQUIRED`, reserves inventory through the existing reservation system, retrieves and verifies the order before capture, and finalizes an order only after PayPal confirms the capture amount, currency, and completed status. Failed or cancelled card attempts release their pending reservation. Raw card data is never sent to or stored by Lexora.

Open `http://localhost:4173/admin.html` after starting the API and static frontend servers. Product reviews are active in the JSON repository; messages and marketplace settings remain unavailable in this runtime.

Product reviews use the selected repository. Public reads include approved reviews only; authenticated customers may create one review per product after the API confirms a paid order that they own. New and edited reviews remain pending until an administrator approves them. Product averages and distributions are calculated only from approved review records. Customer mutations are owner-only, and admin moderation is protected by the existing administrator role guard.

Customer addresses use the selected repository and are scoped to the authenticated customer ID. The first saved address becomes the default; default changes and default deletion are applied in a single repository transaction. Checkout can submit a saved address ID, which the API resolves only within the authenticated customer's address book before making the existing order snapshot.

In PostgreSQL mode, the API reconstructs its existing repository-shaped records from normalized tables and writes changed entities, order items, variations, images, inventory, reservations, payments, and shipments back to those tables in the same transaction. A transaction advisory lock preserves current inventory and payment idempotency checks across API instances. `migration_source_snapshots` is an import audit copy only; runtime reads and writes never use it. Access outside the PostgreSQL request context fails rather than falling back to `data/dev.json`. Local development can use `STORAGE_MODE=json` and `MEDIA_STORAGE=local`.

Production requires `STORAGE_MODE=postgres`, `DATABASE_URL`, and `MEDIA_STORAGE=s3`. Configure `S3_BUCKET`, `S3_REGION`, and `S3_PUBLIC_BASE_URL`; set `S3_ENDPOINT` for an S3-compatible provider and either set access/secret keys or provide runtime-role credentials. Product bytes are never stored in PostgreSQL. The importer copies existing `/uploads/products/` images to the configured object store and updates the PostgreSQL product references without modifying `data/dev.json`. Customer visual-search uploads remain temporary buffers.

Run live migration/API integration coverage only with `POSTGRES_TEST_DATABASE_URL` pointing to a disposable database. Tests create and drop a uniquely named schema and must not use production data. Payment endpoints intentionally keep payments pending until Stripe or PayPal server credentials are configured.
