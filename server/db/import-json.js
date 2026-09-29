const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPool, getDatabaseUrl, getStorageMode } = require('./postgres');
const { runMigrations } = require('./migrate');
const { mediaMode, migrateLegacyProductImages } = require('../media');

const stableId = (collection, key) => `${collection}_${crypto.createHash('sha256').update(`${collection}:${key}`).digest('hex').slice(0, 24)}`;
const text = value => value === undefined || value === null ? null : String(value);
const safeDate = value => {
  if (!value) return '2000-01-01T00:00:00.000Z';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '2000-01-01T00:00:00.000Z' : parsed.toISOString();
};
const centsToAmount = value => Number((Number(value || 0) / 100).toFixed(2));
const dollars = value => Number(Number(value || 0).toFixed(2));
const slugify = value => String(value || 'item').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
const asJson = value => JSON.stringify(value === undefined ? null : value);

function normalizeJsonStore(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('JSON data must be an object.');
  return raw;
}

function backupJsonSource(sourcePath) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  let attempt = 0;
  let backupPath;
  do {
    backupPath = `${sourcePath}.pre-postgres-import-${timestamp}-${process.pid}-${attempt}.bak`;
    attempt += 1;
  } while (fs.existsSync(backupPath));
  fs.copyFileSync(sourcePath, backupPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backupPath, 0o600);
  return backupPath;
}

function entriesFor(store, collection) {
  const value = store[collection];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`JSON collection "${collection}" must be an array.`);
  return value;
}

function paymentsFromStore(store) {
  const payments = entriesFor(store, 'payments').map((payment, index) => ({
    collection: 'payments', sourceKey: payment.id ?? index, id: payment.id ?? stableId('payment', index), value: payment
  }));
  for (const [index, order] of entriesFor(store, 'orders').entries()) {
    if (!order.paymentProvider && !order.paypalOrderId && !order.stripeSessionId && !order.stripePaymentIntentId) continue;
    const id = stableId('legacy_payment', order.id ?? index);
    if (payments.some(payment => String(payment.id) === id)) continue;
    payments.push({
      collection: 'orders:payments', sourceKey: order.id ?? index, id,
      value: {
        id,
        orderId: order.id,
        provider: order.paymentProvider || (order.paypalOrderId ? 'paypal' : 'stripe'),
        providerOrderId: order.paypalOrderId || order.stripeSessionId || null,
        providerCaptureId: order.paypalCaptureId || order.stripePaymentIntentId || null,
        amount: centsToAmount(order.totalAmount),
        currency: order.currency || 'USD',
        status: order.paymentStatus || 'pending',
        createdAt: order.createdAt,
        updatedAt: order.updatedAt || order.createdAt
      }
    });
  }
  return payments;
}

function shipmentsFromStore(store) {
  const shipments = entriesFor(store, 'shipments').map((shipment, index) => ({
    collection: 'shipments', sourceKey: shipment.id ?? index, id: shipment.id ?? stableId('shipment', index), value: shipment
  }));
  for (const [index, order] of entriesFor(store, 'orders').entries()) {
    if (!order.shippingCarrier && !order.trackingNumber && !order.trackingUrl && !order.estimatedDeliveryDate) continue;
    const existing = shipments.find(shipment => String(shipment.value.orderId || shipment.value.order_id || '') === String(order.id || ''));
    if (existing) {
      existing.value = {
        ...existing.value,
        orderId: order.id,
        carrier: order.shippingCarrier || existing.value.carrier || 'unknown',
        trackingNumber: order.trackingNumber || existing.value.trackingNumber || null,
        trackingUrl: order.trackingUrl || existing.value.trackingUrl || null,
        estimatedDelivery: order.estimatedDeliveryDate || existing.value.estimatedDelivery || null,
        status: order.shippingStatus || existing.value.status || order.status || 'placed',
        updatedAt: order.updatedAt || existing.value.updatedAt || order.createdAt
      };
      continue;
    }
    const id = stableId('legacy_shipment', order.id ?? index);
    if (shipments.some(shipment => String(shipment.id) === id)) continue;
    shipments.push({ collection: 'orders:shipments', sourceKey: order.id ?? index, id, value: {
      id, orderId: order.id, carrier: order.shippingCarrier || 'unknown', trackingNumber: order.trackingNumber,
      trackingUrl: order.trackingUrl, estimatedDelivery: order.estimatedDeliveryDate,
      status: order.shippingStatus || order.status || 'placed', createdAt: order.createdAt, updatedAt: order.updatedAt
    } });
  }
  return shipments;
}

function inventoryRows(store) {
  const reservations = entriesFor(store, 'inventoryReservations');
  const held = new Map();
  for (const reservation of reservations) {
    if (String(reservation.status || '').toLowerCase() !== 'reserved' || !reservation.expiresAt || new Date(reservation.expiresAt) <= new Date()) continue;
    for (const item of Array.isArray(reservation.items) ? reservation.items : []) {
      const productId = text(item.productId || item.product_id);
      if (productId) held.set(productId, (held.get(productId) || 0) + Number(item.quantity || 0));
    }
  }
  return entriesFor(store, 'products').map(product => ({
    productId: text(product.id),
    available: Number(product.stock || 0),
    reserved: held.get(text(product.id)) || 0,
    threshold: Number(product.lowStockThreshold ?? 5),
    updatedAt: safeDate(product.updatedAt || product.createdAt)
  }));
}

function mappedRows(store) {
  const rows = [];
  const add = (collection, table, value, index, id = value.id) => rows.push({
    collection,
    sourceKey: String(value.id ?? index),
    id: text(id) || stableId(collection, index),
    value,
    table
  });

  for (const [i, row] of entriesFor(store, 'users').entries()) add('users', 'users', row, i);
  for (const [i, row] of entriesFor(store, 'suppliers').entries()) add('suppliers', 'suppliers', row, i);
  for (const [i, row] of entriesFor(store, 'categories').entries()) add('categories', 'categories', row, i);
  for (const [i, row] of entriesFor(store, 'products').entries()) add('products', 'products', row, i);
  for (const [i, row] of entriesFor(store, 'addresses').entries()) add('addresses', 'addresses', row, i);
  for (const [i, row] of entriesFor(store, 'orders').entries()) add('orders', 'orders', row, i);
  for (const [i, row] of entriesFor(store, 'reviews').entries()) add('reviews', 'reviews', row, i);
  for (const [i, row] of entriesFor(store, 'wishlist').entries()) add('wishlist', 'wishlist_items', row, i, row.id ?? stableId('wishlist', `${row.customerId}:${row.productId}`));
  for (const [i, row] of entriesFor(store, 'notifications').entries()) add('notifications', 'notifications', row, i);
  for (const [i, row] of entriesFor(store, 'rfqs').entries()) add('rfqs', 'rfqs', row, i);
  for (const [i, row] of entriesFor(store, 'sessions').entries()) add('sessions', 'sessions', row, i, row.tokenHash ?? row.id ?? stableId('session', i));
  for (const [i, row] of entriesFor(store, 'inventoryReservations').entries()) add('inventoryReservations', 'inventory_reservations', row, i);
  for (const [i, row] of entriesFor(store, 'pendingPayPalOrders').entries()) add('pendingPayPalOrders', 'pending_paypal_orders', row, i);
  for (const payment of paymentsFromStore(store)) rows.push({ ...payment, table: 'payments' });
  for (const shipment of shipmentsFromStore(store)) rows.push({ ...shipment, table: 'shipments' });
  return rows;
}

async function insertRow(client, row) {
  const value = row.value;
  const createdAt = safeDate(value.createdAt);
  const updatedAt = safeDate(value.updatedAt || value.createdAt);
  const json = asJson(value);
  const records = {
    users: ['users', { id: row.id, email: String(value.email || '').trim().toLowerCase(), password_hash: value.passwordHash || value.password_hash || '', name: value.name || 'Unknown', role: value.role || 'customer', created_at: createdAt, updated_at: updatedAt, payload: json }],
    suppliers: ['suppliers', { id: row.id, owner_id: value.ownerId || value.owner_id || null, business_name: value.businessName || value.companyName || 'Supplier', business_type: value.businessType || 'general', country: value.country || value.location || '', address: asJson(value.businessAddress || value.address || {}), description: value.description || value.businessDescription || '', website: value.website || null, verification_status: value.verificationStatus || value.status || 'pending', status: value.status || value.verificationStatus || 'pending', created_at: createdAt, updated_at: updatedAt, payload: json }],
    categories: ['categories', { id: row.id, name: value.name || 'Uncategorized', slug: value.slug || slugify(value.name), parent_id: value.parentId || null, active: value.active !== false && value.status !== 'inactive', created_at: createdAt, updated_at: updatedAt, payload: json }],
    products: ['products', { id: row.id, supplier_id: value.supplierId || null, supplier_name: value.supplier || null, category_id: value.categoryId || null, category_name: value.category || null, name: value.name || 'Product', slug: value.slug || `${slugify(value.name || row.id)}-${slugify(row.id)}`, description: value.description || '', retail_price: dollars(value.price), wholesale_price: value.wholesalePrice == null ? null : dollars(value.wholesalePrice), currency: value.currency || 'USD', moq: Math.max(1, Number(value.moq || 1)), stock: Math.max(0, Number(value.stock || 0)), low_stock_threshold: Math.max(0, Number(value.lowStockThreshold ?? 5)), status: value.status || 'active', approved_at: value.approvedAt ? safeDate(value.approvedAt) : null, created_at: createdAt, updated_at: updatedAt, payload: json }],
    addresses: ['addresses', { id: row.id, customer_id: value.customerId || value.userId || null, full_name: value.fullName || value.name || '', phone: value.phone || '', country: value.country || '', country_code: value.countryCode || '', state: value.state || '', city: value.city || '', postal_code: value.postalCode || value.postal_code || '', address_line_1: value.addressLine1 || value.address_line_1 || '', address_line_2: value.addressLine2 || value.address_line_2 || '', label: value.label || null, is_default: Boolean(value.isDefault), created_at: createdAt, updated_at: updatedAt, payload: json }],
    orders: ['orders', { id: row.id, customer_id: value.buyerId || value.customerId || null, status: value.status || 'placed', currency: String(value.currency || 'USD').toUpperCase(), subtotal: centsToAmount(value.subtotal ?? value.totalAmount), shipping_total: centsToAmount(value.shippingTotal), grand_total: centsToAmount(value.totalAmount), payment_status: value.paymentStatus || 'pending', payment_provider: value.paymentProvider || null, paypal_order_id: value.paypalOrderId || null, paypal_capture_id: value.paypalCaptureId || null, stripe_session_id: value.stripeSessionId || null, stripe_payment_intent_id: value.stripePaymentIntentId || null, paypal_status: value.paypalStatus || null, shipping_address: asJson(value.shippingAddress || {}), created_at: createdAt, updated_at: updatedAt, payload: json }],
    reviews: ['reviews', { id: row.id, customer_id: value.authorId || value.customerId || null, product_id: value.productId || null, supplier_id: value.supplierId || null, order_id: value.orderId || null, rating: Number(value.rating || 0), title: value.title || null, review_text: value.comment || value.text || '', status: value.status || 'pending', verified_purchase: Boolean(value.verifiedPurchase), created_at: createdAt, updated_at: updatedAt, payload: json }],
    wishlist_items: ['wishlist_items', { id: row.id, customer_id: value.customerId || value.userId || null, product_id: value.productId || null, created_at: createdAt, payload: json }],
    notifications: ['notifications', { id: row.id, recipient_id: value.userId || value.customerId || null, order_id: value.orderId || null, product_id: value.productId || null, type: value.type || 'system', title: value.title || 'Notification', message: value.message || value.body || '', read: Boolean(value.read || value.readAt || value.read_at), read_at: value.readAt || value.read_at || null, created_at: createdAt, updated_at: updatedAt, payload: json }],
    rfqs: ['rfqs', { id: row.id, buyer_id: value.buyerId || value.customerId || null, product_required: value.productRequired || value.product || '', quantity: Math.max(1, Number(value.quantity || 1)), target_price: value.targetPrice == null ? null : dollars(value.targetPrice), preferred_supplier_location: value.preferredSupplierLocation || null, shipping_destination: value.shippingDestination || '', requirements: value.requirements || null, status: value.status || 'open', created_at: createdAt, updated_at: updatedAt, payload: json }],
    sessions: ['sessions', { token_hash: row.id, user_id: value.userId || null, expires_at: safeDate(value.expiresAt), created_at: createdAt, payload: json }],
    pending_paypal_orders: ['pending_paypal_orders', { id: row.id, paypal_order_id: value.paypalOrderId || null, buyer_id: value.buyerId || null, reservation_id: value.reservationId || null, status: value.status || 'created', total_cents: Math.max(0, Number(value.totalCents || 0)), currency: String(value.currency || 'USD').toUpperCase(), created_at: createdAt, updated_at: updatedAt, payload: json }],
    inventory_reservations: ['inventory_reservations', { id: row.id, provider: value.provider || null, order_id: value.orderId || null, status: value.status || 'reserved', total_cents: Math.max(0, Number(value.totalCents || 0)), expires_at: value.expiresAt ? safeDate(value.expiresAt) : null, created_at: createdAt, updated_at: updatedAt, released_at: value.releasedAt ? safeDate(value.releasedAt) : null, committed_at: value.committedAt ? safeDate(value.committedAt) : null, payload: json }],
    payments: ['payments', { id: row.id, order_id: value.orderId || value.order_id || null, provider: value.provider || 'unknown', provider_order_id: value.providerOrderId || value.provider_order_id || value.paypalOrderId || null, provider_capture_id: value.providerCaptureId || value.provider_capture_id || value.paypalCaptureId || null, amount: value.amount == null ? centsToAmount(value.amountCents) : dollars(value.amount), currency: String(value.currency || 'USD').toUpperCase(), status: value.status || 'pending', created_at: createdAt, updated_at: updatedAt, payload: json }],
    shipments: ['shipments', { id: row.id, order_id: value.orderId || value.order_id || null, carrier: value.carrier || 'unknown', tracking_number: value.trackingNumber || value.tracking_number || null, tracking_url: value.trackingUrl || value.tracking_url || null, estimated_delivery: value.estimatedDelivery || value.estimated_delivery ? safeDate(value.estimatedDelivery || value.estimated_delivery) : null, status: value.status || 'pending', created_at: createdAt, updated_at: updatedAt, payload: json }]
  };

  const [table, columns] = records[row.table];
  const keys = Object.keys(columns);
  const values = Object.values(columns);
  const primaryKey = row.table === 'sessions' ? 'token_hash' : 'id';
  const updates = keys.filter(key => key !== primaryKey).map(key => `${key} = EXCLUDED.${key}`).join(', ');
  const placeholders = keys.map((_, index) => `$${index + 1}`).join(', ');
  await client.query(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) ON CONFLICT (${primaryKey}) DO UPDATE SET ${updates}`,
    values
  );
  return { table, id: row.id };
}

async function insertOrderItems(client, order, orderIndex, errors, imported) {
  for (const [index, item] of (Array.isArray(order.items) ? order.items : []).entries()) {
    const id = text(item.id) || stableId('order_item', `${order.id}:${index}`);
    const savepoint = `item_${orderIndex}_${index}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      const quantity = Math.max(1, Number(item.quantity || 1));
      const unitCents = item.unitPrice ?? item.price ?? item.unitCents ?? 0;
      const values = [id, order.id, item.productId || item.product_id || null, item.supplierId || null, item.name || item.productName || null, quantity, item.size || null, item.color || null, centsToAmount(unitCents), centsToAmount(item.lineTotal ?? Number(unitCents) * quantity), safeDate(item.createdAt || order.createdAt), asJson(item)];
      await client.query(`
        INSERT INTO order_items (id, order_id, product_id, supplier_id, product_name_snapshot, quantity, selected_size, selected_color, unit_price, line_total, created_at, payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (id) DO UPDATE SET order_id=EXCLUDED.order_id, product_id=EXCLUDED.product_id,
          supplier_id=EXCLUDED.supplier_id, product_name_snapshot=EXCLUDED.product_name_snapshot,
          quantity=EXCLUDED.quantity, selected_size=EXCLUDED.selected_size, selected_color=EXCLUDED.selected_color,
          unit_price=EXCLUDED.unit_price, line_total=EXCLUDED.line_total, payload=EXCLUDED.payload
      `, values);
      await client.query(`INSERT INTO migration_import_rows (collection, source_key, target_table, target_id)
        VALUES ('order_items', $1, 'order_items', $2)
        ON CONFLICT (collection, source_key) DO UPDATE SET target_id=EXCLUDED.target_id, imported_at=now()`, [`${order.id}:${index}`, id]);
      await client.query('RELEASE SAVEPOINT ' + savepoint);
      imported.order_items += 1;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT ' + savepoint);
      errors.push({ collection: 'orders.items', record: `${order.id || orderIndex}:${index}`, reason: error.message });
    }
  }
}

async function importJsonStoreFromFile(filePath, options = {}) {
  if (getStorageMode() !== 'postgres') throw new Error('PostgreSQL import requires STORAGE_MODE=postgres.');
  if (!getDatabaseUrl() && !options.pool) throw new Error('DATABASE_URL is required to import JSON into PostgreSQL.');
  const sourcePath = path.resolve(filePath || path.join(process.cwd(), 'data', 'dev.json'));
  if (!fs.existsSync(sourcePath)) throw new Error(`JSON source file not found: ${sourcePath}`);
  const sourceBackup = backupJsonSource(sourcePath);
  const store = normalizeJsonStore(JSON.parse(fs.readFileSync(sourcePath, 'utf8')));
  const sourceSnapshot = structuredClone(store);
  const migration = await runMigrations({ pool: options.pool });
  const mediaMigration = mediaMode() === 's3'
    ? await migrateLegacyProductImages(entriesFor(store, 'products'))
    : { migrated: 0, errors: [] };
  if (mediaMigration.errors.length) {
    throw new Error(`Product media migration failed for ${mediaMigration.errors.length} image(s): ${mediaMigration.errors.map(item => `${item.productId}: ${item.reason}`).join('; ')}`);
  }
  const pool = options.pool || createPool();
  const closePool = !options.pool;
  const client = await pool.connect();
  const report = {
    source: sourcePath,
    sourceBackup,
    media: mediaMigration,
    migrations: migration.applied,
    sourceCounts: Object.fromEntries(Object.entries(store).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])),
    expected: {},
    imported: {},
    mappedCounts: {},
    databaseCounts: {},
    countComparisons: {},
    relationshipChecks: {},
    errors: [],
    preservedCollections: 0
  };
  const importStartedAt = new Date().toISOString();

  try {
    await client.query('BEGIN');
    let sequence = 0;
    const rows = mappedRows(store);
    const tableByCollection = new Map();
    report.expected.supplier_stores = entriesFor(store, 'suppliers').length;
    tableByCollection.set('supplier_stores', 'supplier_stores');
    report.expected.inventory_reservation_items = entriesFor(store, 'inventoryReservations').reduce((count, reservation) => count + (Array.isArray(reservation.items) ? reservation.items.length : 0), 0);
    tableByCollection.set('inventory_reservation_items', 'inventory_reservation_items');
    const seenSourceKeys = new Set();
    for (const row of rows) {
      report.expected[row.collection] = (report.expected[row.collection] || 0) + 1;
      tableByCollection.set(row.collection, row.table);
      const sourceIdentity = `${row.collection}\0${row.sourceKey}`;
      if (seenSourceKeys.has(sourceIdentity)) {
        report.errors.push({ collection: row.collection, record: row.sourceKey, reason: 'Duplicate source ID/key; later duplicate was not imported.' });
        continue;
      }
      seenSourceKeys.add(sourceIdentity);
      const savepoint = `row_${sequence++}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        const target = await insertRow(client, row);
        if (row.table === 'suppliers') {
          const supplier = row.value;
          await client.query(`INSERT INTO supplier_stores (supplier_id, store_name, description, logo_url, website, settings, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
            ON CONFLICT (supplier_id) DO UPDATE SET store_name=EXCLUDED.store_name, description=EXCLUDED.description,
              logo_url=EXCLUDED.logo_url, website=EXCLUDED.website, settings=EXCLUDED.settings, updated_at=EXCLUDED.updated_at`, [
            row.id,
            supplier.storeName || supplier.storefrontName || supplier.businessName || supplier.companyName || null,
            supplier.storeDescription || supplier.businessDescription || supplier.description || null,
            supplier.logoUrl || supplier.storeLogo || null,
            supplier.website || null,
            asJson(supplier.storefront || supplier.store || supplier.storeSettings || {}),
            safeDate(supplier.updatedAt || supplier.createdAt)
          ]);
          await client.query(`INSERT INTO migration_import_rows (collection, source_key, target_table, target_id)
            VALUES ('supplier_stores', $1, 'supplier_stores', $2)
            ON CONFLICT (collection, source_key) DO UPDATE SET target_id=EXCLUDED.target_id, imported_at=now()`, [row.sourceKey, row.id]);
          report.imported.supplier_stores = (report.imported.supplier_stores || 0) + 1;
        }
        if (row.table === 'inventory_reservations') {
          for (const [itemIndex, item] of (Array.isArray(row.value.items) ? row.value.items : []).entries()) {
            const itemId = stableId('reservation_item', `${row.id}:${item.productId || item.product_id || itemIndex}`);
            const itemSavepoint = `reservation_item_${sequence}_${itemIndex}`;
            await client.query(`SAVEPOINT ${itemSavepoint}`);
            try {
              await client.query(`INSERT INTO inventory_reservation_items (id, reservation_id, product_id, quantity, product_name, unit_cents, payload)
                VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
                ON CONFLICT (id) DO UPDATE SET reservation_id=EXCLUDED.reservation_id, product_id=EXCLUDED.product_id,
                  quantity=EXCLUDED.quantity, product_name=EXCLUDED.product_name, unit_cents=EXCLUDED.unit_cents, payload=EXCLUDED.payload`, [
                itemId, row.id, item.productId || item.product_id || null, Math.max(1, Number(item.quantity || 1)),
                item.name || item.productName || null, item.unitCents == null ? null : Math.max(0, Number(item.unitCents)), asJson(item)
              ]);
              await client.query(`INSERT INTO migration_import_rows (collection, source_key, target_table, target_id)
                VALUES ('inventory_reservation_items', $1, 'inventory_reservation_items', $2)
                ON CONFLICT (collection, source_key) DO UPDATE SET target_id=EXCLUDED.target_id, imported_at=now()`, [`${row.id}:${itemIndex}`, itemId]);
              await client.query(`RELEASE SAVEPOINT ${itemSavepoint}`);
              report.imported.inventory_reservation_items = (report.imported.inventory_reservation_items || 0) + 1;
            } catch (error) {
              await client.query(`ROLLBACK TO SAVEPOINT ${itemSavepoint}`);
              report.errors.push({ collection: 'inventory_reservation_items', record: `${row.id}:${itemIndex}`, reason: error.message });
            }
          }
        }
        await client.query(`
          INSERT INTO migration_import_rows (collection, source_key, target_table, target_id)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (collection, source_key) DO UPDATE SET target_table=EXCLUDED.target_table,
            target_id=EXCLUDED.target_id, imported_at=now()
        `, [row.collection, row.sourceKey, target.table, target.id]);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        report.imported[row.collection] = (report.imported[row.collection] || 0) + 1;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        report.errors.push({ collection: row.collection, record: row.sourceKey, reason: error.message });
      }
    }

    for (const [index, order] of entriesFor(store, 'orders').entries()) {
      await insertOrderItems(client, order, index, report.errors, report.imported);
    }
    report.expected.order_items = entriesFor(store, 'orders').reduce((total, order) => total + (Array.isArray(order.items) ? order.items.length : 0), 0);

    for (const [index, product] of entriesFor(store, 'products').entries()) {
      const images = Array.isArray(product.images) && product.images.length ? product.images : (product.image || product.imageUrl ? [product.image || product.imageUrl] : []);
      for (const [imageIndex, imageUrl] of images.filter(Boolean).entries()) {
        const imageId = stableId('product_image', `${product.id}:${imageIndex}:${imageUrl}`);
        const savepoint = `image_${index}_${imageIndex}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        try {
          await client.query(`INSERT INTO product_images (id, product_id, image_url, sort_order) VALUES ($1,$2,$3,$4)
            ON CONFLICT (id) DO UPDATE SET product_id=EXCLUDED.product_id, image_url=EXCLUDED.image_url, sort_order=EXCLUDED.sort_order`, [imageId, product.id, imageUrl, imageIndex]);
          await client.query(`INSERT INTO migration_import_rows (collection, source_key, target_table, target_id)
            VALUES ('product_images', $1, 'product_images', $2)
            ON CONFLICT (collection, source_key) DO UPDATE SET target_id=EXCLUDED.target_id, imported_at=now()`, [`${product.id}:${imageIndex}`, imageId]);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
          report.imported.product_images = (report.imported.product_images || 0) + 1;
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          report.errors.push({ collection: 'products.images', record: `${product.id || index}:${imageIndex}`, reason: error.message });
        }
      }
    }

    report.expected.product_variations = entriesFor(store, 'products').reduce((total, product) => total + (Array.isArray(product.variations) ? product.variations.length : 0), 0);
    tableByCollection.set('product_variations', 'product_variations');
    for (const [productIndex, product] of entriesFor(store, 'products').entries()) {
      for (const [variationIndex, variation] of (Array.isArray(product.variations) ? product.variations : []).entries()) {
        const variationId = variation.id || stableId('product_variation', `${product.id}:${variationIndex}`);
        const variationSavepoint = `variation_${productIndex}_${variationIndex}`;
        await client.query(`SAVEPOINT ${variationSavepoint}`);
        try {
          await client.query(`INSERT INTO product_variations (id,product_id,sku,attributes,stock,payload)
            VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb)
            ON CONFLICT (id) DO UPDATE SET product_id=EXCLUDED.product_id,sku=EXCLUDED.sku,
              attributes=EXCLUDED.attributes,stock=EXCLUDED.stock,payload=EXCLUDED.payload`, [
            variationId, product.id, variation.sku || null, asJson(variation.attributes || variation),
            Math.max(0, Number(variation.stock || 0)), asJson(variation)
          ]);
          await client.query(`INSERT INTO migration_import_rows (collection,source_key,target_table,target_id)
            VALUES ('product_variations',$1,'product_variations',$2)
            ON CONFLICT (collection,source_key) DO UPDATE SET target_id=EXCLUDED.target_id,imported_at=now()`, [`${product.id}:${variationIndex}`, variationId]);
          await client.query(`RELEASE SAVEPOINT ${variationSavepoint}`);
          report.imported.product_variations = (report.imported.product_variations || 0) + 1;
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT ${variationSavepoint}`);
          report.errors.push({ collection: 'product_variations', record: `${product.id || productIndex}:${variationIndex}`, reason: error.message });
        }
      }
    }

    for (const [index, product] of entriesFor(store, 'products').entries()) {
      const inventory = inventoryRows(store)[index];
      const savepoint = `inventory_${index}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        await client.query(`INSERT INTO inventory (product_id, available_quantity, reserved_quantity, low_stock_threshold, updated_at)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT (product_id) DO UPDATE SET available_quantity=EXCLUDED.available_quantity,
          reserved_quantity=EXCLUDED.reserved_quantity, low_stock_threshold=EXCLUDED.low_stock_threshold, updated_at=EXCLUDED.updated_at`,
        [product.id, inventory.available, inventory.reserved, inventory.threshold, inventory.updatedAt]);
        await client.query(`INSERT INTO migration_import_rows (collection, source_key, target_table, target_id)
          VALUES ('inventory', $1, 'inventory', $2)
          ON CONFLICT (collection, source_key) DO UPDATE SET target_id=EXCLUDED.target_id, imported_at=now()`, [product.id, product.id]);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        report.imported.inventory = (report.imported.inventory || 0) + 1;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        report.errors.push({ collection: 'inventory', record: product.id || index, reason: error.message });
      }
    }
    report.expected.inventory = entriesFor(store, 'products').length;
    tableByCollection.set('order_items', 'order_items');
    tableByCollection.set('inventory', 'inventory');
    tableByCollection.set('product_images', 'product_images');
    report.expected.product_images = entriesFor(store, 'products').reduce((total, product) => total + (Array.isArray(product.images) && product.images.length ? product.images.filter(Boolean).length : (product.image || product.imageUrl ? 1 : 0)), 0);

    for (const [collection, value] of Object.entries(sourceSnapshot)) {
      const savepoint = `collection_${sequence++}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        await client.query(`INSERT INTO migration_source_snapshots (collection, payload, updated_at) VALUES ($1,$2::jsonb,now())
          ON CONFLICT (collection) DO UPDATE SET payload=EXCLUDED.payload, updated_at=EXCLUDED.updated_at`, [collection, asJson(value)]);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        report.preservedCollections += 1;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        report.errors.push({ collection, record: 'collection snapshot', reason: error.message });
      }
    }

    for (const [collection, table] of tableByCollection) {
      const mapped = await client.query('SELECT COUNT(*)::int AS count FROM migration_import_rows WHERE collection = $1', [collection]);
      const total = await client.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
      report.mappedCounts[collection] = mapped.rows[0].count;
      report.databaseCounts[collection] = total.rows[0].count;
      report.countComparisons[collection] = {
        source: report.expected[collection],
        mapped: report.mappedCounts[collection],
        match: report.expected[collection] === report.mappedCounts[collection]
      };
    }
    const integrity = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM suppliers s LEFT JOIN users u ON u.id=s.owner_id WHERE s.owner_id IS NOT NULL AND u.id IS NULL) AS orphan_suppliers,
        (SELECT COUNT(*) FROM orders o LEFT JOIN users u ON u.id=o.customer_id WHERE o.customer_id IS NOT NULL AND u.id IS NULL) AS orphan_orders,
        (SELECT COUNT(*) FROM order_items i LEFT JOIN orders o ON o.id=i.order_id WHERE o.id IS NULL) AS orphan_order_items,
        (SELECT COUNT(*) FROM reviews r LEFT JOIN products p ON p.id=r.product_id WHERE r.product_id IS NOT NULL AND p.id IS NULL) AS orphan_reviews,
        (SELECT COUNT(*) FROM wishlist_items w LEFT JOIN products p ON p.id=w.product_id WHERE w.product_id IS NOT NULL AND p.id IS NULL) AS orphan_wishlist,
        (SELECT COUNT(*) FROM addresses a LEFT JOIN users u ON u.id=a.customer_id WHERE a.customer_id IS NOT NULL AND u.id IS NULL) AS orphan_addresses,
        (SELECT COUNT(*) FROM payments p LEFT JOIN orders o ON o.id=p.order_id WHERE p.order_id IS NOT NULL AND o.id IS NULL) AS orphan_payments,
        (SELECT COUNT(*) FROM inventory i LEFT JOIN products p ON p.id=i.product_id WHERE p.id IS NULL) AS orphan_inventory,
        (SELECT COUNT(*) FROM pending_paypal_orders p LEFT JOIN users u ON u.id=p.buyer_id WHERE p.buyer_id IS NOT NULL AND u.id IS NULL) AS orphan_pending_paypal_buyers,
        (SELECT COUNT(*) FROM order_items i JOIN products p ON p.id=i.product_id WHERE i.supplier_id IS NOT NULL AND p.supplier_id IS NOT NULL AND i.supplier_id <> p.supplier_id) AS order_item_supplier_mismatches,
        (SELECT COUNT(*) FROM reviews r JOIN orders o ON o.id=r.order_id WHERE r.customer_id IS NOT NULL AND o.customer_id IS NOT NULL AND r.customer_id <> o.customer_id) AS review_customer_order_mismatches,
        (SELECT COUNT(*) FROM inventory i JOIN products p ON p.id=i.product_id WHERE i.available_quantity <> p.stock) AS inventory_mismatches,
        (SELECT COUNT(*) FROM inventory i JOIN products p ON p.id=i.product_id WHERE i.reserved_quantity <> COALESCE((
          SELECT SUM(ri.quantity)
          FROM inventory_reservations r JOIN inventory_reservation_items ri ON ri.reservation_id=r.id
          WHERE r.status='reserved' AND r.expires_at > now() AND ri.product_id=p.id
        ), 0)) AS reserved_inventory_mismatches
    `);
    report.relationshipChecks = Object.fromEntries(Object.entries(integrity.rows[0]).map(([key, value]) => [key, Number(value)]));
    for (const [collection, comparison] of Object.entries(report.countComparisons)) {
      if (!comparison.match) report.errors.push({ collection, record: 'count comparison', reason: `Source count ${comparison.source} differs from mapped count ${comparison.mapped}.` });
    }
    for (const [check, count] of Object.entries(report.relationshipChecks)) {
      if (count) report.errors.push({ collection: 'relationships', record: check, reason: `${count} relationship or quantity mismatch(es).` });
    }
    report.success = report.errors.length === 0 && Object.values(report.countComparisons).every(comparison => comparison.match);
    await client.query(`INSERT INTO migration_import_runs (source, success, source_counts, imported_counts, errors, started_at, completed_at)
      VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,now())`, [
      sourcePath, report.success, asJson(report.sourceCounts), asJson(report.imported), asJson(report.errors), importStartedAt
    ]);
    await client.query('COMMIT');
    return report;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    if (closePool) await pool.end();
  }
}

if (require.main === module) {
  importJsonStoreFromFile(process.argv[2])
    .then(report => {
      console.log(JSON.stringify(report, null, 2));
      if (report.errors.length) process.exitCode = 1;
    })
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = { importJsonStoreFromFile, normalizeJsonStore, backupJsonSource, paymentsFromStore, shipmentsFromStore, inventoryRows, mappedRows, insertRow, stableId };