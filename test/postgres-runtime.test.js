const test = require('node:test');
const assert = require('node:assert/strict');

const previousMode = process.env.STORAGE_MODE;
process.env.STORAGE_MODE = 'postgres';
const { createServer } = require('../server/index');
const { hashPassword } = require('../server/auth');

class FakePool {
  constructor(data) {
    this.rows = new Map(Object.entries(data));
  }

  async connect() {
    const pool = this;
    let transactionRows;
    let committed = false;
    return {
      async query(sql, values = []) {
        if (sql === 'BEGIN') {
          transactionRows = new Map([...pool.rows].map(([key, value]) => [key, structuredClone(value)]));
          return { rows: [] };
        }
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
        if (sql === 'LOAD_STATE') {
          return { rows: [{ state: Object.fromEntries(transactionRows) }] };
        }
        if (sql === 'SYNC_STATE') {
          transactionRows = new Map(Object.entries(JSON.parse(values[0])));
          return { rows: [] };
        }
        if (sql === 'COMMIT') {
          pool.rows = transactionRows;
          committed = true;
          return { rows: [] };
        }
        if (sql === 'ROLLBACK') return { rows: [] };
        throw new Error(`Unexpected SQL in fake pool: ${sql}`);
      },
      release() {
        if (!committed) transactionRows = undefined;
      }
    };
  }
}

function storeAdapter() {
  return {
    async load(client) {
      return (await client.query('LOAD_STATE')).rows[0].state;
    },
    async persist(client, previous, current) {
      await client.query('SYNC_STATE', [JSON.stringify(current)]);
    }
  };
}

test('HTTP customer, supplier, admin, product, wishlist, address, order, RFQ, and shipment flows persist in PostgreSQL mode', async () => {
  const pool = new FakePool({
    users: [{ id: 'usr_admin', email: 'pg-admin@example.test', name: 'PG Admin', role: 'admin', passwordHash: hashPassword('PGAdminPassword123!'), createdAt: new Date().toISOString() }],
    products: [{ id: 'prod_pg', name: 'PostgreSQL sample', category: 'Home', supplier: 'LEXORA', location: 'Global', price: 20, stock: 8, lowStockThreshold: 2 }],
    suppliers: [],
    orders: [],
    reviews: [],
    addresses: [],
    wishlist: [],
    categories: [],
    sessions: [],
    pendingPayPalOrders: [],
    inventoryReservations: [],
    notifications: [],
    rfqs: []
  });
  const server = createServer({ postgresPool: pool, postgresStoreAdapter: storeAdapter() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  async function api(method, path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  }

  try {
    const productsResponse = await fetch(`${baseUrl}/api/products`);
    const products = await productsResponse.json();
    assert.equal(productsResponse.status, 200);
    assert.equal(products.data[0].id, 'prod_pg');

    const customerRegistration = await api('POST', '/api/auth/register', {
      email: 'pg-customer@example.test', name: 'PG Customer', password: 'PGCustomerPassword123!'
    });
    assert.equal(customerRegistration.status, 201);
    assert.equal(pool.rows.get('users').length, 2);
    const customerToken = (await customerRegistration.json()).data.token;
    const customerLogin = await api('POST', '/api/auth/login', { email: 'pg-customer@example.test', password: 'PGCustomerPassword123!' });
    assert.equal(customerLogin.status, 200);
    assert.equal((await api('POST', '/api/wishlist/prod_pg', {}, customerToken)).status, 201);
    assert.equal(pool.rows.get('wishlist').length, 1);
    const addressResponse = await api('POST', '/api/addresses', {
      label: 'Home', fullName: 'PG Customer', phone: '+1 (202) 555-0147', addressLine1: '10 Main Street',
      addressLine2: '', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US'
    }, customerToken);
    assert.ok(addressResponse.status === 201, await addressResponse.text());
    assert.equal(pool.rows.get('addresses').length, 1);
    const orderResponse = await api('POST', '/api/orders', {
      items: [{ productId: 'prod_pg', quantity: 1 }], shippingAddress: { fullName: 'PG Customer' }
    }, customerToken);
    assert.equal(orderResponse.status, 201);
    assert.equal((await api('GET', '/api/orders', undefined, customerToken)).status, 200);
    assert.equal(pool.rows.get('orders').length, 1);
    const rfqResponse = await api('POST', '/api/rfqs', { productRequired: 'sample', quantity: '5', shippingDestination: 'Austin' }, customerToken);
    assert.ok(rfqResponse.status === 201, await rfqResponse.text());
    assert.equal(pool.rows.get('rfqs').length, 1);

    const supplierRegistration = await api('POST', '/api/auth/register', {
      email: 'pg-supplier@example.test', name: 'PG Supplier', password: 'PGSupplierPassword123!', role: 'supplier', businessName: 'PG Store'
    });
    assert.equal(supplierRegistration.status, 201);
    assert.equal(pool.rows.get('suppliers').length, 1);
    const supplierLogin = await api('POST', '/api/auth/login', { email: 'pg-supplier@example.test', password: 'PGSupplierPassword123!' });
    assert.equal(supplierLogin.status, 200);
    const adminLogin = await api('POST', '/api/auth/login', { email: 'pg-admin@example.test', password: 'PGAdminPassword123!' });
    assert.equal(adminLogin.status, 200);
    const adminToken = (await adminLogin.json()).data.token;
    const newProduct = await api('POST', '/api/admin/products', {
      name: 'PG-created item', category: 'Home', supplier: 'PG Store', location: 'Global', price: 12, stock: 4
    }, adminToken);
    assert.equal(newProduct.status, 201);
    const createdProduct = (await newProduct.json()).data;
    assert.equal((await api('PATCH', `/api/admin/products/${createdProduct.id}`, { stock: 3 }, adminToken)).status, 200);
    assert.equal((await api('GET', '/api/admin/orders', undefined, adminToken)).status, 200);
    const tracked = await api('PATCH', `/api/admin/orders/${pool.rows.get('orders')[0].id}`, {
      shippingCarrier: 'DHL', trackingNumber: 'PG-TRACK-1', trackingUrl: 'https://carrier.example/PG-TRACK-1', status: 'shipped'
    }, adminToken);
    assert.equal(tracked.status, 200);
    assert.equal(pool.rows.get('orders')[0].trackingNumber, 'PG-TRACK-1');
    assert.equal(pool.rows.get('sessions').length, 5);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('health endpoint identifies PostgreSQL persistence without exposing connection data', async () => {
  const pool = new FakePool({ users: [], products: [] });
  const server = createServer({ postgresPool: pool, postgresStoreAdapter: storeAdapter() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.storageMode, 'postgres');
    assert.equal(body.database, 'connected');
    assert.equal(Object.hasOwn(body, 'databaseUrl'), false);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test.after(() => {
  if (previousMode === undefined) delete process.env.STORAGE_MODE;
  else process.env.STORAGE_MODE = previousMode;
});
