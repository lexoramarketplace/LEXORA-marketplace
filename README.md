# Visual Search

Visual Search is public and does not require a customer account. Customer images are validated and decoded in memory; they are not written to the uploads directory. The no-credential mode is reported as `catalog-fallback` and compares normalized RGB histograms only against existing catalog images. It does not claim category, style, or material recognition.

Optional server-side vision configuration:

- `VISUAL_SEARCH_PROVIDER=openai-compatible`
- `VISUAL_SEARCH_API_KEY` (server environment only)
- `VISUAL_SEARCH_API_URL` (optional; defaults to the OpenAI chat-completions endpoint)
- `VISUAL_SEARCH_MODEL` (optional; defaults to `gpt-4o-mini`)

If the provider or key is absent, Visual Search uses the local catalog color-comparison fallback. Never place the API key in frontend code or return it from an API route.
# LEXORA

A premium marketplace for **LEXORA — Discover. Connect. Trade.**

## Run locally

No Node.js installation is required for this prototype. From this directory, use any static file server, for example:

```sh
ruby -run -e httpd . -p 4173
```

Then open `http://localhost:4173`.

## Included in this prototype

- Responsive luxury marketplace homepage and catalogue
- Product search across product, supplier, location, and category content
- Category shortcuts, supplier location, price, verified, wholesale, and sorting filters
- Product details with tiered wholesale pricing and quantity control
- Visual Search over real catalog products using a configured vision provider or transparent local color-comparison fallback
- Wishlist and cart persistence through `localStorage`
- Multi-currency display for USD, EUR, AED, and GBP
- Supplier onboarding entry points, trust messaging, newsletter capture, and mobile layout
- Demo catalogue clearly labeled as demo data

## Production architecture notes

The repository now includes a dependency-light Node API scaffold in `server/`. The current frontend still uses demo data, while the API provides a migration path for real accounts, products, orders, RFQs, and supplier applications.

### PostgreSQL migration

The project includes a versioned relational PostgreSQL schema and deterministic JSON importer. With `STORAGE_MODE=postgres`, API reads assemble records from normalized PostgreSQL tables and writes update those tables in a request transaction; JSONB source snapshots are audit-only. A transaction advisory lock protects existing inventory and payment idempotency rules across API instances. The JSON file repository is used only in local JSON mode.

Backend quick start (requires Node.js 20+):

```sh
cp .env.example .env
npm start
```

For a PostgreSQL database, provide credentials through your shell or secret manager (do not commit them):

```sh
export STORAGE_MODE=postgres
export DATABASE_URL='<your PostgreSQL connection string>'
npm run db:migrate
npm run db:import-json -- data/dev.json
npm run db:health
npm start
```

Production requires `STORAGE_MODE=postgres`, `DATABASE_URL`, `MEDIA_STORAGE=s3`, and `S3_BUCKET`, `S3_REGION`, and `S3_PUBLIC_BASE_URL`. S3-compatible endpoint and credentials are optional when the deployment provides an IAM/runtime role. Startup applies pending migrations and refuses to serve if PostgreSQL or persistent media configuration is missing or no successful verified import run exists.

Live migration/import/API integration coverage uses a separately configured disposable database. Set `POSTGRES_TEST_DATABASE_URL` to a database where the test role can create and drop schemas; the test creates a uniquely named temporary schema and drops only that schema when finished. Never point this variable at production.

See `server/README.md`, `server/db/README.md`, and `server/db/migrations/001_initial_schema.sql` for the table map, versioned schema, and import details.

Before production, run the disposable PostgreSQL integration suite, import the source JSON and verify its report, exercise the payment sandbox flows, and confirm the frontend/API deployment origins. Keep payment provider secrets server-side and never store raw card data.

Do not treat the demo ratings, supplier counts, or status language as production verification claims. The frontend uses demonstration data only.
