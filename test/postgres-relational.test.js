const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRelationalStore, persistRelationalStore } = require('../server/db/relational-store');

function fixtureStore() {
  return {
    users: [{ id: 'usr_rel', email: 'rel@example.test', name: 'Relational User', role: 'customer', passwordHash: 'hash', createdAt: '2026-01-01T00:00:00.000Z' }],
    suppliers: [{ id: 'sup_rel', ownerId: 'usr_rel', businessName: 'Relational Store', companyName: 'Relational Store', businessType: 'general', country: 'US', description: 'Store', status: 'approved', verificationStatus: 'approved' }],
    categories: [{ id: 'cat_rel', name: 'Home', slug: 'home' }],
    products: [{ id: 'prod_rel', supplierId: 'sup_rel', name: 'Relational Product', category: 'Home', supplier: 'Relational Store', location: 'US', price: 25, stock: 7, lowStockThreshold: 2, images: ['https://media.example.test/products/one.jpg'], variations: [{ id: 'var_rel', sku: 'REL-S', stock: 4, attributes: { size: 'S' } }] }],
    addresses: [{ id: 'adr_rel', customerId: 'usr_rel', label: 'Home', fullName: 'Relational User', isDefault: true }],
    orders: [{ id: 'ord_rel', buyerId: 'usr_rel', items: [{ productId: 'prod_rel', name: 'Relational Product', quantity: 2, unitPrice: 2500 }], totalAmount: 5000, paymentProvider: 'paypal', paymentStatus: 'paid', paypalOrderId: 'PAY-REL', trackingNumber: 'TRACK-REL' }],
    reviews: [{ id: 'rev_rel', authorId: 'usr_rel', productId: 'prod_rel', orderId: 'ord_rel', rating: 5, comment: 'Great', status: 'approved' }],
    wishlist: [{ id: 'wl_rel', customerId: 'usr_rel', productId: 'prod_rel' }],
    notifications: [{ id: 'ntf_rel', userId: 'usr_rel', orderId: 'ord_rel', type: 'order', title: 'Order', message: 'Placed' }],
    rfqs: [{ id: 'rfq_rel', buyerId: 'usr_rel', productRequired: 'sample', quantity: 2, shippingDestination: 'US' }],
    sessions: [{ tokenHash: 'token_rel', userId: 'usr_rel', expiresAt: '2030-01-01T00:00:00.000Z' }],
    inventoryReservations: [{ id: 'inv_rel', status: 'reserved', expiresAt: '2030-01-01T00:00:00.000Z', items: [{ productId: 'prod_rel', quantity: 1, unitCents: 2500 }] }],
    pendingPayPalOrders: [{ id: 'ppp_rel', paypalOrderId: 'PAY-REL-PENDING', buyerId: 'usr_rel', reservationId: 'inv_rel', status: 'created', totalCents: 2500 }],
    payments: [],
    shipments: []
  };
}

class QueryRecorder {
  constructor() { this.calls = []; }
  async query(sql, values = []) {
    this.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
    if (sql.startsWith('SELECT supplier_id FROM products')) return { rows: [{ supplier_id: 'sup_rel' }] };
    return { rows: [], rowCount: 0 };
  }
}

test('runtime persistence writes changed application entities to normalized tables and child rows', async () => {
  const previous = fixtureStore();
  previous.orders[0].paymentProvider = null;
  previous.orders[0].paymentStatus = 'pending';
  previous.orders[0].paypalOrderId = null;
  previous.orders[0].trackingNumber = null;
  previous.wishlist = [];
  const current = structuredClone(previous);
  current.orders[0].paymentProvider = 'paypal';
  current.orders[0].paymentStatus = 'paid';
  current.orders[0].paypalOrderId = 'PAY-REL';
  current.orders[0].trackingNumber = 'TRACK-REL';
  current.wishlist = [{ id: 'wl_rel', customerId: 'usr_rel', productId: 'prod_rel' }];
  current.pendingPayPalOrders[0].status = 'capturing';
  current.products[0].stock = 4;
  current.products[0].status = 'inactive';
  current.orders[0].status = 'shipped';
  current.reviews[0].comment = 'Updated';
  current.addresses[0].city = 'Austin';
  current.suppliers[0].description = 'Updated store';
  current.inventoryReservations[0].status = 'released';
  const client = new QueryRecorder();

  await persistRelationalStore(client, previous, current);

  const sql = client.calls.map(call => call.sql).join('\n');
  for (const table of ['products', 'inventory', 'orders', 'order_items', 'payments', 'reviews', 'wishlist_items', 'addresses', 'suppliers', 'supplier_stores', 'product_images', 'product_variations', 'inventory_reservations', 'inventory_reservation_items', 'pending_paypal_orders', 'shipments']) {
    assert.match(sql, new RegExp(`INSERT INTO ${table}\\b`), `${table} was not written`);
  }
  assert.ok(client.calls.some(call => call.sql.startsWith('INSERT INTO products') && call.values.includes(4)));
  assert.ok(client.calls.some(call => call.sql.startsWith('INSERT INTO reviews') && call.values.includes('Updated')));
});

test('runtime reads load API records from normalized PostgreSQL tables, not a collection snapshot', async () => {
  const client = new QueryRecorder();
  client.query = async sql => {
    client.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values: [] });
    if (sql.includes('FROM users')) return { rows: [{ id: 'usr_rel', email: 'rel@example.test', password_hash: 'hash', name: 'Relational User', role: 'customer', created_at: new Date('2026-01-01T00:00:00Z'), updated_at: null, payload: {} }] };
    if (sql.includes('FROM suppliers s')) return { rows: [{ id: 'sup_rel', owner_id: 'usr_rel', business_name: 'Relational Store', business_type: 'general', country: 'US', address: {}, description: 'Store', website: null, verification_status: 'approved', status: 'approved', created_at: null, updated_at: null, payload: {}, store_name: 'Relational Store', logo_url: null, settings: {} }] };
    if (sql.includes('FROM categories')) return { rows: [] };
    if (sql.includes('FROM products WHERE')) return { rows: [{ id: 'prod_rel', supplier_id: 'sup_rel', supplier_name: 'Relational Store', category_id: null, category_name: 'Home', name: 'Relational Product', slug: 'relational-product', description: '', retail_price: '25.00', wholesale_price: null, currency: 'USD', moq: 1, stock: 7, low_stock_threshold: 2, status: 'active', approved_at: null, created_at: null, updated_at: null, payload: { color: 'red' } }] };
    if (sql.includes('FROM product_images')) return { rows: [{ product_id: 'prod_rel', image_url: 'https://media.example.test/products/one.jpg', sort_order: 0 }] };
    if (sql.includes('FROM product_variations')) return { rows: [] };
    if (sql.includes('FROM inventory')) return { rows: [{ product_id: 'prod_rel', available_quantity: 6, reserved_quantity: 1, low_stock_threshold: 2 }] };
    if (sql.includes('FROM order_items')) return { rows: [{ id: 'item_rel', order_id: 'ord_rel', product_id: 'prod_rel', supplier_id: 'sup_rel', product_name_snapshot: 'Relational Product', quantity: 2, selected_size: null, selected_color: null, unit_price: '25.00', line_total: '50.00', created_at: null, payload: {} }] };
    if (sql.includes('FROM orders')) return { rows: [{ id: 'ord_rel', customer_id: 'usr_rel', status: 'paid', currency: 'USD', subtotal: '50.00', shipping_total: '0.00', grand_total: '50.00', payment_status: 'paid', payment_provider: 'paypal', paypal_order_id: 'PAY-REL', paypal_capture_id: 'CAP-REL', stripe_session_id: null, stripe_payment_intent_id: null, paypal_status: 'COMPLETED', shipping_address: {}, created_at: null, updated_at: null, payload: {} }] };
    if (sql.includes('FROM shipments')) return { rows: [] };
    if (sql.includes('FROM addresses')) return { rows: [] };
    if (sql.includes('FROM reviews')) return { rows: [] };
    if (sql.includes('FROM wishlist_items')) return { rows: [] };
    if (sql.includes('FROM notifications')) return { rows: [] };
    if (sql.includes('FROM rfqs')) return { rows: [] };
    if (sql.includes('FROM sessions')) return { rows: [] };
    if (sql.includes('FROM inventory_reservations r')) return { rows: [] };
    if (sql.includes('FROM inventory_reservation_items')) return { rows: [] };
    if (sql.includes('FROM inventory_reservations')) return { rows: [] };
    if (sql.includes('FROM pending_paypal_orders')) return { rows: [] };
    if (sql.includes('FROM payments')) return { rows: [] };
    throw new Error(`Unexpected read query: ${sql}`);
  };

  const store = await loadRelationalStore(client);
  assert.equal(store.users[0].email, 'rel@example.test');
  assert.equal(store.products[0].price, 25);
  assert.equal(store.products[0].stock, 6);
  assert.equal(store.products[0].color, 'red');
  assert.equal(store.orders[0].buyerId, 'usr_rel');
  assert.equal(store.orders[0].items[0].productId, 'prod_rel');
  assert.equal(store.orders[0].items[0].unitPrice, 2500);
  assert.ok(client.calls.every(call => !call.sql.includes('application_collections')));
});

test('creating a non-default address does not demote the existing default address', async () => {
  const previous = fixtureStore();
  const current = structuredClone(previous);
  current.addresses.push({ id: 'adr_rel_work', customerId: 'usr_rel', label: 'Work', isDefault: false });
  const client = new QueryRecorder();
  await persistRelationalStore(client, previous, current);
  assert.equal(client.calls.some(call => call.sql.startsWith('UPDATE addresses SET is_default=false')), false);
});
