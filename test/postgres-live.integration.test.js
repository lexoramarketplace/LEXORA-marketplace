const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

function passwordHash(password, salt) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

const databaseUrl = String(process.env.POSTGRES_TEST_DATABASE_URL || '').trim();
const previousMode = process.env.STORAGE_MODE;
process.env.STORAGE_MODE = 'postgres';
const { createPool } = require('../server/db/postgres');
const { importJsonStoreFromFile } = require('../server/db/import-json');

test('live PostgreSQL migration and JSON import are relationally correct and idempotent', { skip: !databaseUrl }, async () => {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schemaName = `lexora_it_${crypto.randomBytes(8).toString('hex')}`;
  let isolatedPool;
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lexora-postgres-it-'));
  const sourcePath = path.join(tempDirectory, 'migration-source.json');
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const source = {
    users: [
      { id: 'usr_it_customer', email: 'customer@example.test', name: 'IT Customer', role: 'customer', passwordHash: passwordHash('ITCustomerPassword123!', 'integration-customer-salt'), createdAt: future },
      { id: 'usr_it_admin', email: 'admin@example.test', name: 'IT Admin', role: 'admin', passwordHash: passwordHash('ITAdminPassword123!', 'integration-admin-salt'), createdAt: future }
    ],
    suppliers: [{ id: 'sup_it_owner', ownerId: 'usr_it_customer', businessName: 'IT Store', country: 'US', businessType: 'general', description: 'Integration fixture' }],
    products: [{ id: 'prod_it_item', supplierId: 'sup_it_owner', name: 'IT Product', category: 'Home', supplier: 'IT Store', location: 'US', price: 25, stock: 3, lowStockThreshold: 1, image: '/uploads/products/it.jpg', variations: [{ sku: 'IT-SIZE-1', attributes: { size: 'S' }, stock: 3 }] }],
    orders: [{ id: 'ord_it_paid', buyerId: 'usr_it_customer', items: [{ productId: 'prod_it_item', supplierId: 'sup_it_owner', name: 'IT Product', quantity: 1, unitPrice: 2500 }], totalAmount: 2500, currency: 'USD', paymentProvider: 'paypal', paymentStatus: 'paid', paypalOrderId: 'PAYPAL-IT-ORDER', paypalCaptureId: 'PAYPAL-IT-CAPTURE', shippingAddress: { fullName: 'IT Customer' }, trackingNumber: 'TRACK-IT-1', shippingCarrier: 'Test Carrier' }],
    addresses: [{ id: 'adr_it_home', customerId: 'usr_it_customer', fullName: 'IT Customer', addressLine1: '1 Test Street', city: 'Test City', state: 'CA', postalCode: '90210', country: 'US', isDefault: true }],
    wishlist: [{ id: 'wl_it_item', customerId: 'usr_it_customer', productId: 'prod_it_item' }],
    reviews: [{ id: 'rev_it_product', authorId: 'usr_it_customer', productId: 'prod_it_item', orderId: 'ord_it_paid', rating: 5, comment: 'Verified integration review', status: 'approved' }],
    notifications: [{ id: 'ntf_it_order', userId: 'usr_it_customer', orderId: 'ord_it_paid', productId: 'prod_it_item', type: 'order_update', title: 'Test', message: 'Test message' }],
    inventoryReservations: [{ id: 'inv_it_reserved', orderId: 'ord_it_paid', status: 'reserved', expiresAt: future, totalCents: 2500, items: [{ productId: 'prod_it_item', quantity: 1, name: 'IT Product', unitCents: 2500 }] }],
    pendingPayPalOrders: [{ id: 'ppp_it_pending', paypalOrderId: 'PAYPAL-IT-PENDING', buyerId: 'usr_it_customer', reservationId: 'inv_it_reserved', status: 'created', totalCents: 2500 }],
    sessions: [{ tokenHash: 'it_session_hash', userId: 'usr_it_customer', expiresAt: future }],
    categories: [],
    rfqs: []
  };

  try {
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    isolatedPool = createPool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
    fs.writeFileSync(sourcePath, JSON.stringify(source));

    const first = await importJsonStoreFromFile(sourcePath, { pool: isolatedPool });
    const second = await importJsonStoreFromFile(sourcePath, { pool: isolatedPool });
    assert.equal(first.success, true, JSON.stringify(first.errors));
    assert.equal(second.success, true, JSON.stringify(second.errors));
    assert.equal(first.migrations.length, 2);
    assert.equal(second.migrations.length, 0);

    const counts = await isolatedPool.query(`SELECT
      (SELECT COUNT(*)::int FROM users) AS users,
      (SELECT COUNT(*)::int FROM suppliers) AS suppliers,
      (SELECT COUNT(*)::int FROM products) AS products,
      (SELECT COUNT(*)::int FROM product_variations) AS variations,
      (SELECT COUNT(*)::int FROM orders) AS orders,
      (SELECT COUNT(*)::int FROM order_items) AS order_items,
      (SELECT COUNT(*)::int FROM payments) AS payments,
      (SELECT COUNT(*)::int FROM inventory) AS inventory,
      (SELECT COUNT(*)::int FROM inventory_reservation_items) AS reservation_items,
      (SELECT COUNT(*)::int FROM reviews) AS reviews,
      (SELECT COUNT(*)::int FROM wishlist_items) AS wishlist,
      (SELECT COUNT(*)::int FROM addresses) AS addresses,
      (SELECT COUNT(*)::int FROM notifications) AS notifications,
      (SELECT COUNT(*)::int FROM shipments) AS shipments`);
    assert.deepEqual(counts.rows[0], {
      users: 1, suppliers: 1, products: 1, variations: 1, orders: 1, order_items: 1, payments: 1,
      inventory: 1, reservation_items: 1, reviews: 1, wishlist: 1, addresses: 1,
      notifications: 1, shipments: 1
    });

    const relationship = await isolatedPool.query(`SELECT s.owner_id, o.customer_id, i.product_id, p.status AS payment_status,
      inv.available_quantity, inv.reserved_quantity FROM suppliers s JOIN orders o ON o.customer_id=s.owner_id
      JOIN order_items i ON i.order_id=o.id JOIN payments p ON p.order_id=o.id
      JOIN inventory inv ON inv.product_id=i.product_id WHERE s.id='sup_it_owner' AND o.id='ord_it_paid'`);
    assert.equal(relationship.rowCount, 1);
    assert.equal(relationship.rows[0].owner_id, 'usr_it_customer');
    assert.equal(relationship.rows[0].customer_id, 'usr_it_customer');
    assert.equal(relationship.rows[0].product_id, 'prod_it_item');
    assert.equal(relationship.rows[0].payment_status, 'paid');
    assert.equal(relationship.rows[0].available_quantity, 3);
    assert.equal(relationship.rows[0].reserved_quantity, 1);
    const registryCount = await isolatedPool.query("SELECT COUNT(*)::int AS count FROM migration_import_rows WHERE collection='orders'");
    assert.equal(registryCount.rows[0].count, 1);

    const { createServer } = require('../server/index');
    const { reserveInventory, releaseInventoryReservation } = require('../server/db/repository');
    const { withPostgresStore } = require('../server/db/postgres-store');
    const server = createServer({ postgresPool: isolatedPool });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const api = (method, route, body, token) => fetch(`${baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    try {
      const productsResponse = await api('GET', '/api/products');
      assert.equal(productsResponse.status, 200);
      assert.ok((await productsResponse.json()).data.some(product => product.id === 'prod_it_item'));

      const customerLogin = await api('POST', '/api/auth/login', { email: 'customer@example.test', password: 'ITCustomerPassword123!' });
      const customerToken = (await customerLogin.json()).data.token;
      assert.equal(customerLogin.status, 200);
      const adminLogin = await api('POST', '/api/auth/login', { email: 'admin@example.test', password: 'ITAdminPassword123!' });
      const adminToken = (await adminLogin.json()).data.token;
      assert.equal(adminLogin.status, 200);

      const supplierRegistration = await api('POST', '/api/auth/register', {
        email: 'new-supplier@example.test', name: 'New Supplier', password: 'NewSupplierPassword123!', role: 'supplier', businessName: 'New Relational Store'
      });
      assert.equal(supplierRegistration.status, 201);
      const supplierLogin = await api('POST', '/api/auth/login', { email: 'new-supplier@example.test', password: 'NewSupplierPassword123!' });
      assert.equal(supplierLogin.status, 200);
      assert.equal(Number((await isolatedPool.query('SELECT COUNT(*)::int AS count FROM supplier_stores')).rows[0].count), 2);

      const createdProductResponse = await api('POST', '/api/admin/products', {
        name: 'API relational product', category: 'Home', supplier: 'New Relational Store', location: 'US', price: 18, stock: 4
      }, adminToken);
      assert.equal(createdProductResponse.status, 201);
      const createdProduct = (await createdProductResponse.json()).data;
      assert.equal((await api('PATCH', `/api/admin/products/${createdProduct.id}`, { stock: 3 }, adminToken)).status, 200);
      const productRow = await isolatedPool.query('SELECT stock FROM products WHERE id=$1', [createdProduct.id]);
      const inventoryRow = await isolatedPool.query('SELECT available_quantity,reserved_quantity FROM inventory WHERE product_id=$1', [createdProduct.id]);
      assert.equal(productRow.rows[0].stock, 3);
      assert.equal(inventoryRow.rows[0].available_quantity, 3);

      const wishlistResponse = await api('POST', '/api/wishlist/prod_it_item', {}, customerToken);
      assert.equal(wishlistResponse.status, 201);
      assert.equal(Number((await isolatedPool.query('SELECT COUNT(*)::int AS count FROM wishlist_items WHERE customer_id=$1 AND product_id=$2', ['usr_it_customer', 'prod_it_item'])).rows[0].count), 1);
      const addressResponse = await api('POST', '/api/addresses', {
        label: 'Home', fullName: 'IT Customer', phone: '+1 (202) 555-0147', addressLine1: '1 Test Street',
        city: 'Test City', state: 'CA', postalCode: '90210', country: 'US'
      }, customerToken);
      assert.equal(addressResponse.status, 201);
      assert.equal(Number((await isolatedPool.query('SELECT COUNT(*)::int AS count FROM addresses WHERE customer_id=$1', ['usr_it_customer'])).rows[0].count), 2);

      const orderResponse = await api('POST', '/api/orders', {
        items: [{ productId: createdProduct.id, quantity: 1 }], shippingAddress: { fullName: 'IT Customer' }
      }, customerToken);
      assert.equal(orderResponse.status, 201);
      const createdOrder = (await orderResponse.json()).data;
      assert.equal(Number((await isolatedPool.query('SELECT COUNT(*)::int AS count FROM order_items WHERE order_id=$1', [createdOrder.id])).rows[0].count), 1);
      assert.equal((await api('GET', '/api/orders', undefined, customerToken)).status, 200);
      assert.equal((await api('GET', '/api/admin/orders', undefined, adminToken)).status, 200);

      const reviewUpdate = await api('PATCH', '/api/reviews/rev_it_product', { rating: 4, title: 'Updated', comment: 'Updated relational review' }, customerToken);
      assert.equal(reviewUpdate.status, 200);
      assert.equal((await isolatedPool.query('SELECT review_text,status FROM reviews WHERE id=$1', ['rev_it_product'])).rows[0].review_text, 'Updated relational review');

      const shipmentUpdate = await api('PATCH', '/api/admin/orders/ord_it_paid', {
        status: 'shipped', shippingCarrier: 'New Carrier', trackingNumber: 'TRACK-UPDATED', trackingUrl: 'https://carrier.example/track'
      }, adminToken);
      assert.equal(shipmentUpdate.status, 200);
      assert.equal((await isolatedPool.query('SELECT tracking_number FROM shipments WHERE order_id=$1', ['ord_it_paid'])).rows[0].tracking_number, 'TRACK-UPDATED');

      const reservationResult = await withPostgresStore(() => reserveInventory('inv_live_pg_test', [{ productId: createdProduct.id, quantity: 1 }], { provider: 'integration' }), { pool: isolatedPool });
      assert.equal(reservationResult.ok, true);
      assert.equal((await isolatedPool.query('SELECT reserved_quantity FROM inventory WHERE product_id=$1', [createdProduct.id])).rows[0].reserved_quantity, 1);
      await withPostgresStore(() => releaseInventoryReservation('inv_live_pg_test'), { pool: isolatedPool });
      assert.equal((await isolatedPool.query('SELECT reserved_quantity FROM inventory WHERE product_id=$1', [createdProduct.id])).rows[0].reserved_quantity, 0);
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  } finally {
    if (isolatedPool) await isolatedPool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => undefined);
    await adminPool.end();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test.after(() => {
  if (previousMode === undefined) delete process.env.STORAGE_MODE;
  else process.env.STORAGE_MODE = previousMode;
});
