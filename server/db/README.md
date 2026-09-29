# PostgreSQL Persistence Map

`001_initial_schema.sql` defines the normalized runtime schema. `002_runtime_relational_storage.sql` upgrades databases created by the earlier collection-backed migration. The API reads core fields from table columns, attaches the `payload` JSONB field only for compatibility fields not yet represented as columns, and commits changes to relational tables in one request transaction. `migration_source_snapshots` is a one-time import audit copy; the API never reads or writes it.

| Entity | Table | Primary key | Ownership / foreign keys | Uniqueness and indexes |
| --- | --- | --- | --- | --- |
| Customers, suppliers, admins | `users` | `id` | Role is stored on the user row | Case-insensitive unique email; role index; create/update timestamps |
| Supplier profiles | `suppliers` | `id` | `owner_id` -> `users` | Owner and status indexes; create/update timestamps |
| Storefront/settings | `supplier_stores` | `supplier_id` | Supplier PK/FK -> `suppliers` with cascade | One storefront per supplier; create/update timestamps |
| Categories | `categories` | `id` | Optional `parent_id` -> `categories` | Unique slug; create/update timestamps |
| Products | `products` | `id` | Optional supplier/category FKs | Unique slug; supplier/category/status/search indexes; nonnegative stock and price; create/update timestamps |
| Product images | `product_images` | `id` | `product_id` -> `products` with cascade | Unique product/sort position; timestamp |
| Product variations | `product_variations` | `id` | `product_id` -> `products` with cascade | Unique optional SKU; create/update timestamps |
| Inventory | `inventory` | `product_id` | Product PK/FK -> `products` with cascade | Nonnegative available/reserved quantities; update timestamp |
| Reservations | `inventory_reservations` | `id` | Optional order FK -> `orders` | Status/expiry index; create/update/release/commit timestamps |
| Reservation lines | `inventory_reservation_items` | `id` | Reservation cascade; optional product FK | Unique reservation/product pair; product index |
| Saved addresses | `addresses` | `id` | Optional customer FK -> `users` | Customer index; partial unique one-default-per-customer; create/update timestamps |
| Orders | `orders` | `id` | Optional customer FK -> `users` | Customer/status indexes; partial unique PayPal order and Stripe session IDs; create/update timestamps |
| Order items | `order_items` | `id` | Order cascade; optional product/supplier FKs | Order/product/supplier indexes; timestamp |
| Payments | `payments` | `id` | Optional order FK -> `orders` | Partial unique provider/capture ID; order/status indexes; create/update timestamps |
| Pending PayPal orders | `pending_paypal_orders` | `id` | Optional buyer/reservation FKs | Partial unique PayPal order ID; buyer index; create/update timestamps |
| Shipments/tracking | `shipments` | `id` | Optional order FK -> `orders` with cascade | Order/tracking indexes; create/update timestamps |
| Reviews | `reviews` | `id` | Optional customer/product/supplier/order FKs | Partial unique customer/product; product/status/customer indexes; create/update timestamps |
| Wishlist | `wishlist_items` | `id` | Optional customer/product FKs | Unique customer/product; customer/date index; timestamp |
| Notifications | `notifications` | `id` | Optional recipient/order/product FKs | Recipient/date and partial unread indexes; partial unique legacy idempotency key; create/update timestamps |
| RFQs | `rfqs` | `id` | Optional buyer FK -> `users` | Buyer/date and status/date indexes; create/update timestamps |
| Quotes | `quotes` | `id` | RFQ cascade; optional supplier FK | Create/update timestamps |
| Authentication sessions | `sessions` | `token_hash` | Optional user FK -> `users` with cascade | User/expiry index; expiry/create timestamps |
| Conversations | `conversations` | `id` | Optional product FK | Create timestamp |
| Conversation membership | `conversation_members` | `(conversation_id,user_id)` | Conversation/user cascades | Composite primary key; create timestamp |
| Messages | `messages` | `id` | Conversation cascade; optional sender FK | Conversation/date index; create timestamp |
| Commissions | `commissions` | `id` | Optional order/supplier FKs | Create timestamp |
| Supplier subscriptions | `supplier_subscriptions` | `id` | Optional supplier FK with cascade | Unique provider subscription ID; create timestamp |
| Audit logs | `audit_logs` | `id` | Optional actor FK -> `users` | JSONB metadata; create timestamp |
| Import audit snapshots | `migration_source_snapshots` | `collection` | None; audit only | Update timestamp; excluded from runtime reads/writes |
| Import row registry | `migration_import_rows` | `(collection,source_key)` | None | Target table/ID index; import timestamp |
| Import runs | `migration_import_runs` | identity `id` | None | Success/completion index; source/import counts and error report |

Product image bytes live behind `server/media/`: local filesystem for development, S3-compatible object storage for production. The relational `product_images` table stores only durable image URLs and sort order.
