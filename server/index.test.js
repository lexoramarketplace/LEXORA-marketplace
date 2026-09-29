const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const sharp = require('sharp');

process.env.LEXORA_DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lexora-test-')), 'dev.json');
process.env.LEXORA_ADMIN_NOTIFICATION_EMAIL = 'lexora.market@gmail.com';
process.env.LEXORA_EMAIL_FROM = 'LEXORA <noreply@lexora.test>';
process.env.RESEND_API_KEY = 'test_resend_key';

const { route } = require('./index');
const { verifiedOrderFromSession } = require('./index');
const repository = require('./db/repository');
const { createUser, updateUser, readStore, listNotifications, createOrder, listReviews, updateReview, createSupplier, createProduct, listProducts } = repository;
const { hashPassword, issueToken } = require('./auth');
const emailService = require('./services/email');
const orderNotificationService = require('./services/order-notifications');
const { MAX_UPLOAD_BYTES: maxVisualSearchImageSize } = require('./services/visual-search');

const baseSeed = {
  users: [],
  products: [
    { id: 'prod_vela', name: 'Vela sculptural table lamp', category: 'Home & Furniture', price: 420, wholesalePrice: 280, moq: 10, supplier: 'Atelier Nera', location: 'Italy', verified: true, rating: 4.9, reviews: 38, stock: 120 },
    { id: 'prod_kanso', name: 'Kanso travel case', category: 'Bags & Accessories', price: 185, wholesalePrice: 112, moq: 25, supplier: 'Kanso Works', location: 'Japan', verified: true, rating: 4.8, reviews: 64, stock: 220 },
    { id: 'prod_forma', name: 'Forma lounge chair', category: 'Home & Furniture', price: 890, wholesalePrice: 590, moq: 5, supplier: 'Nord Form', location: 'Denmark', verified: true, rating: 4.7, reviews: 21, stock: 42 }
  ],
  addresses: [],
  wishlist: [],
  suppliers: [],
  orders: [],
  rfqs: [],
  sessions: [],
  categories: [],
  pendingPayPalOrders: [],
  notifications: []
};

function resetMarketplaceData() {
  repository.writeStore(JSON.parse(JSON.stringify(baseSeed)));
}

function makeRequest({ method, url, headers = {}, body = null }) {
  const request = new EventEmitter();
  request.method = method;
  request.url = url;
  request.headers = headers;

  if (body) {
    process.nextTick(() => {
      request.emit('data', Buffer.from(JSON.stringify(body)));
      request.emit('end');
    });
  }

  return request;
}

function makeRawRequest({ method, url, token, rawBody }) {
  const request = new EventEmitter();
  request.method = method;
  request.url = url;
  request.headers = { host: 'localhost:4000', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  process.nextTick(() => {
    request.emit('data', Buffer.from(rawBody));
    request.emit('end');
  });
  return request;
}

function makeMultipartRequest({ method = 'POST', url, token, fields = {}, files = [] }) {
  const boundary = `lexora-visual-${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName || 'image'}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`));
    chunks.push(file.buffer);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  const request = new EventEmitter();
  request.method = method;
  request.url = url;
  request.headers = {
    host: 'localhost:4000',
    'content-type': `multipart/form-data; boundary=${boundary}`,
    ...(token ? { authorization: `Bearer ${token}` } : {})
  };
  process.nextTick(() => {
    request.emit('data', Buffer.concat(chunks));
    request.emit('end');
  });
  return request;
}

function createAdminUser() {
  const adminUser = createUser({
    email: 'admin@example.com',
    name: 'Admin User',
    role: 'admin',
    passwordHash: hashPassword('AdminPassword123!')
  });
  return updateUser(adminUser.id, { status: 'active' });
}

function createReviewCustomer(email, name = 'Review Customer') {
  return createUser({ email, name, role: 'customer', passwordHash: hashPassword('ReviewPassword123!') });
}

function addressData(label = 'Home', overrides = {}) {
  return { label, fullName: 'Address Customer', phone: '+1 (202) 555-0147', addressLine1: '10 Main Street', addressLine2: '', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US', ...overrides };
}

function createPaidProductOrder(customer, productId) {
  return createOrder({
    buyerId: customer.id,
    items: [{ productId, quantity: 1, unitPrice: 42000 }],
    shippingAddress: { email: customer.email },
    paymentStatus: 'paid',
    paymentProvider: 'paypal'
  });
}

function reviewRequest(method, url, { token, body } = {}) {
  return makeRequest({
    method,
    url,
    headers: { host: 'localhost:4000', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body
  });
}

function mockPayPalFlow({ orderId = 'PAYPAL_TEST_ORDER', captureStatus = 'COMPLETED', captureAmount = '420.00', verificationFailed = false } = {}) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/v1/oauth2/token')) {
      return { ok: true, json: async () => ({ access_token: 'mock-paypal-token', expires_in: 3600 }) };
    }

    if (url.includes('/v2/checkout/orders') && !url.includes('/capture')) {
      return {
        ok: true,
        json: async () => ({
          id: orderId,
          links: [{ rel: 'approve', href: 'https://paypal.example.com/approve' }]
        })
      };
    }

    if (url.includes('/capture')) {
      if (verificationFailed) {
        return {
          ok: true,
          json: async () => ({
            status: 'CREATED',
            purchase_units: [{
              payments: { captures: [{ id: 'CAPTURE_FAIL', status: 'PENDING', amount: { currency_code: 'USD', value: captureAmount } }] }
            }]
          })
        };
      }

      return {
        ok: true,
        json: async () => ({
          status: captureStatus,
          purchase_units: [{
            payments: { captures: [{ id: 'CAPTURE_123', status: captureStatus, amount: { currency_code: 'USD', value: captureAmount } }] }
          }]
        })
      };
    }

    return { ok: false, json: async () => ({ message: 'Unhandled fetch call.' }) };
  };
  return { calls };
}

function mockPayPalCardFlow({ orderId = 'PAYPAL_CARD_ORDER_1', verifiedOrderId = orderId, orderStatus = 'APPROVED', verifiedAmount = '420.00', verifiedCurrency = 'USD', orderFetchFails = false, createOrderHttpStatus = 201, captureHttpStatus = 200, captureStatus = 'COMPLETED', captureAmount = '420.00', captureCurrency = 'USD' } = {}) {
  const calls = [];
  let createdOrderBody = null;
  let createdOrderSerializedBody = null;
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/v1/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'mock-paypal-safe-token', expires_in: 3600 }) };
    if (url.endsWith('/v2/checkout/orders') && options.method === 'POST') {
      createdOrderSerializedBody = options.body;
      createdOrderBody = JSON.parse(options.body);
      return { ok: createOrderHttpStatus >= 200 && createOrderHttpStatus < 300, status: createOrderHttpStatus, json: async () => createOrderHttpStatus >= 400 ? ({ name: 'INVALID_REQUEST', message: 'Mock PayPal order rejection.' }) : ({ id: orderId, status: 'CREATED' }) };
    }
    if (url.endsWith(`/v2/checkout/orders/${orderId}`) && options.method === 'GET') {
      if (orderFetchFails) return { ok: false, json: async () => ({ message: 'Mock order retrieval failure.' }) };
      return { ok: true, json: async () => ({ id: verifiedOrderId, status: orderStatus, purchase_units: [{ amount: { currency_code: verifiedCurrency, value: verifiedAmount } }] }) };
    }
    if (url.endsWith(`/v2/checkout/orders/${orderId}/capture`)) {
      return {
        ok: captureHttpStatus >= 200 && captureHttpStatus < 300,
        status: captureHttpStatus,
        json: async () => captureHttpStatus >= 400 ? ({ message: 'Mock card was declined.' }) : ({
          status: captureStatus,
          purchase_units: [{ payments: { captures: [{ id: 'CARD_CAPTURE_1', status: captureStatus, amount: { currency_code: captureCurrency, value: captureAmount } }] } }]
        })
      };
    }
    return { ok: false, json: async () => ({ message: 'Unhandled mocked PayPal request.' }) };
  };
  return { calls, get createdOrderBody() { return createdOrderBody; }, get createdOrderSerializedBody() { return createdOrderSerializedBody; } };
}

function paypalCheckoutBody({ paymentMethod = 'card', guest = true, items = [{ productId: 'prod_vela', quantity: 1 }] } = {}) {
  return {
    guest,
    paymentMethod,
    shippingAddress: { fullName: 'Test Buyer', email: 'test@example.com', phone: '2025550147', addressLine1: '1 Main St', city: 'Austin', state: 'TX', country: 'US', postalCode: '78701' },
    items
  };
}

function withMockedEmail(wrapped) {
  const original = emailService.sendPaidOrderAdminEmail;
  emailService.sendPaidOrderAdminEmail = wrapped;
  return () => {
    emailService.sendPaidOrderAdminEmail = original;
  };
}

function ensureLegacyPayPalOrders() {
  const store = readStore();
  if (!store.orders.some(order => order.totalAmount === 42000 && order.paymentProvider === 'paypal')) {
    store.orders.push({
      id: 'ord_legacy_420',
      status: 'placed',
      createdAt: '2026-09-25T13:49:27.062Z',
      buyerId: null,
      items: [{ productId: 'prod_vela', quantity: 1, unitPrice: 42000 }],
      shippingAddress: {
        fullName: 'Alex Buyer',
        email: 'alex@example.com',
        phone: '2025550147',
        addressLine1: '100 Market Street',
        addressLine2: '',
        city: 'San Francisco',
        state: 'CA',
        country: 'US',
        postalCode: '94105'
      },
      currency: 'USD',
      totalAmount: 42000,
      paymentProvider: 'paypal',
      paymentStatus: 'paid',
      paypalOrderId: '6DG71767NY0968042',
      paypalCaptureId: '3HY75144RR6437611',
      paypalStatus: 'COMPLETED'
    });
  }
  if (!store.orders.some(order => order.totalAmount === 15000 && order.paymentProvider === 'paypal')) {
    store.orders.push({
      id: 'ord_legacy_150',
      status: 'placed',
      createdAt: '2026-09-25T16:15:59.353Z',
      buyerId: null,
      items: [{ productId: 'prod_b8706d65-774c-4220-8270-a24a739ca519', quantity: 1, unitPrice: 15000 }],
      shippingAddress: {
        fullName: 'kelvin shirima',
        email: 'bwoycavy05@gmail.com',
        phone: '+86 13-653382075',
        addressLine1: 'china hebei xinle shijiazhuang',
        addressLine2: '34',
        city: 'shijiazhuang',
        state: 'hebei',
        country: 'china',
        postalCode: '05000'
      },
      currency: 'USD',
      totalAmount: 15000,
      paymentProvider: 'paypal',
      paymentStatus: 'paid',
      paypalOrderId: '06F6652971905481W',
      paypalCaptureId: '8LH60836VC4980144',
      paypalStatus: 'COMPLETED'
    });
  }
  repository.writeStore(store);
}

describe('LEXORA marketplace flows', { concurrency: false }, () => {
  beforeEach(() => {
    resetMarketplaceData();
    delete global.fetch;
  });

  test('GET /api/products returns marketplace data', async () => {
    const response = await route(makeRequest({
      method: 'GET',
      url: '/api/products',
      headers: { host: 'localhost:4000' }
    }));

    assert.equal(response.status, 200);
    const payload = JSON.parse(response.body);
    assert.ok(Array.isArray(payload.data));
    assert.ok(payload.data.length > 0);
  });

  test('wishlist initializes safely without removing existing catalogue or orders', () => {
    const store = readStore();
    delete store.wishlist;
    store.orders.push({ id: 'ord_wishlist_migration_preserved', status: 'placed', items: [] });
    repository.writeStore(store);

    const migrated = readStore();
    assert.deepEqual(migrated.wishlist, []);
    assert.ok(migrated.products.some(product => product.id === 'prod_vela'));
    assert.ok(migrated.orders.some(order => order.id === 'ord_wishlist_migration_preserved'));
  });

  test('customer wishlist routes enforce ownership, ignore forged identity, and prevent duplicates', async () => {
    const customerA = createReviewCustomer('wishlist-a@example.com', 'Wishlist A');
    const customerB = createReviewCustomer('wishlist-b@example.com', 'Wishlist B');
    const admin = createAdminUser();
    const tokenA = issueToken(customerA);
    const tokenB = issueToken(customerB);
    const adminToken = issueToken(admin);

    assert.equal((await route(reviewRequest('GET', '/api/wishlist'))).status, 401);
    assert.equal((await route(reviewRequest('POST', '/api/wishlist/prod_vela'))).status, 401);
    assert.equal((await route(reviewRequest('DELETE', '/api/wishlist/prod_vela'))).status, 401);
    assert.equal((await route(reviewRequest('GET', '/api/wishlist', { token: adminToken }))).status, 401);
    assert.equal((await route(reviewRequest('POST', '/api/wishlist/missing-product', { token: tokenA }))).status, 404);
    assert.equal((await route(reviewRequest('POST', '/api/wishlist/%E0%A4%A', { token: tokenA }))).status, 400);

    const added = await route(reviewRequest('POST', '/api/wishlist/prod_vela', { token: tokenA, body: { customerId: customerB.id, productId: 'prod_kanso' } }));
    const duplicate = await route(reviewRequest('POST', '/api/wishlist/prod_vela', { token: tokenA, body: { customerId: customerB.id } }));
    const ownList = JSON.parse((await route(reviewRequest('GET', '/api/wishlist', { token: tokenA }))).body).data;
    const otherList = JSON.parse((await route(reviewRequest('GET', '/api/wishlist', { token: tokenB }))).body).data;
    const foreignDelete = await route(reviewRequest('DELETE', '/api/wishlist/prod_vela', { token: tokenB }));

    assert.equal(added.status, 201);
    assert.equal(JSON.parse(added.body).data.productId, 'prod_vela');
    assert.equal('customerId' in JSON.parse(added.body).data, false);
    assert.equal(duplicate.status, 200);
    assert.equal(JSON.parse(duplicate.body).data.added, false);
    assert.equal(ownList.length, 1);
    assert.equal(ownList[0].productId, 'prod_vela');
    assert.equal(ownList[0].product.name, 'Vela sculptural table lamp');
    assert.equal('customerId' in ownList[0], false);
    assert.deepEqual(otherList, []);
    assert.equal(foreignDelete.status, 404);
    assert.equal(JSON.parse((await route(reviewRequest('GET', '/api/wishlist', { token: tokenA }))).body).data.length, 1);
    assert.equal((await route(reviewRequest('DELETE', '/api/wishlist/prod_vela', { token: tokenA }))).status, 200);
    assert.deepEqual(JSON.parse((await route(reviewRequest('GET', '/api/wishlist', { token: tokenA }))).body).data, []);
  });

  test('wishlist survives logout and login while reflecting unavailable and deleted products safely', async () => {
    const customer = createReviewCustomer('wishlist-persist@example.com', 'Wishlist Persist');
    const firstToken = issueToken(customer);
    repository.updateProduct('prod_forma', { stock: 0 });
    assert.equal((await route(reviewRequest('POST', '/api/wishlist/prod_forma', { token: firstToken }))).status, 201);
    const outOfStock = JSON.parse((await route(reviewRequest('GET', '/api/wishlist', { token: firstToken }))).body).data[0];
    assert.equal(outOfStock.product.availableStock, 0);
    assert.equal(readStore().products.find(product => product.id === 'prod_forma').stock, 0);

    assert.equal((await route(reviewRequest('POST', '/api/auth/logout', { token: firstToken }))).status, 200);
    assert.equal((await route(reviewRequest('GET', '/api/wishlist', { token: firstToken }))).status, 401);
    const secondToken = issueToken(customer);
    const afterLogin = JSON.parse((await route(reviewRequest('GET', '/api/wishlist', { token: secondToken }))).body).data;
    assert.equal(afterLogin.length, 1);
    assert.equal(afterLogin[0].productId, 'prod_forma');

    repository.deleteProduct('prod_forma');
    const deletedProduct = JSON.parse((await route(reviewRequest('GET', '/api/wishlist', { token: secondToken }))).body).data;
    assert.equal(deletedProduct.length, 1);
    assert.equal(deletedProduct[0].product, null);
  });

  test('addresses initialize safely without replacing existing customers, products, orders, or reviews', () => {
    const store = readStore();
    const existingUserCount = store.users.length;
    const existingProductCount = store.products.length;
    const existingOrderCount = store.orders.length;
    const existingReviewCount = store.reviews.length;
    delete store.addresses;
    repository.writeStore(store);

    const migrated = readStore();
    assert.deepEqual(migrated.addresses, []);
    assert.equal(migrated.users.length, existingUserCount);
    assert.equal(migrated.products.length, existingProductCount);
    assert.equal(migrated.orders.length, existingOrderCount);
    assert.equal(migrated.reviews.length, existingReviewCount);
  });

  test('address CRUD is customer-scoped, validates fields, and keeps exactly one default', async () => {
    const customerA = createReviewCustomer('address-a@example.com', 'Address A');
    const customerB = createReviewCustomer('address-b@example.com', 'Address B');
    const admin = createAdminUser();
    const tokenA = issueToken(customerA);
    const tokenB = issueToken(customerB);
    const adminToken = issueToken(admin);

    assert.equal((await route(reviewRequest('GET', '/api/addresses'))).status, 401);
    assert.equal((await route(reviewRequest('POST', '/api/addresses', { body: addressData() }))).status, 401);
    assert.equal((await route(reviewRequest('GET', '/api/addresses', { token: adminToken }))).status, 401);
    assert.equal((await route(reviewRequest('POST', '/api/addresses', { token: tokenA, body: { label: 'Home' } }))).status, 422);
    assert.equal((await route(reviewRequest('POST', '/api/addresses', { token: tokenA, body: addressData('Home', { phone: 'abc' }) }))).status, 422);
    assert.equal((await route(reviewRequest('POST', '/api/addresses', { token: tokenA, body: addressData('Home', { postalCode: '?!' }) }))).status, 422);
    assert.equal((await route(reviewRequest('POST', '/api/addresses', { token: tokenA, body: addressData('Home', { fullName: 'x'.repeat(121) }) }))).status, 422);
    assert.equal((await route(reviewRequest('POST', '/api/addresses', { token: tokenA, body: { ...addressData(), customerId: customerB.id } }))).status, 422);
    assert.equal((await route(reviewRequest('POST', '/api/addresses', { token: tokenA, body: { ...addressData(), isDefault: true } }))).status, 422);

    const first = await route(reviewRequest('POST', '/api/addresses', { token: tokenA, body: addressData('Home') }));
    const second = await route(reviewRequest('POST', '/api/addresses', { token: tokenA, body: addressData('Work', { addressLine1: '20 Office Road' }) }));
    const foreign = await route(reviewRequest('POST', '/api/addresses', { token: tokenB, body: addressData('Home B') }));
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(foreign.status, 201);
    const firstData = JSON.parse(first.body).data;
    const secondData = JSON.parse(second.body).data;
    const foreignData = JSON.parse(foreign.body).data;
    assert.equal(firstData.isDefault, true);
    assert.equal(secondData.isDefault, false);
    assert.equal('customerId' in firstData, false);

    assert.equal((await route(reviewRequest('PATCH', `/api/addresses/${foreignData.id}`, { token: tokenA, body: { label: 'Stolen' } }))).status, 404);
    assert.equal((await route(reviewRequest('DELETE', `/api/addresses/${foreignData.id}`, { token: tokenA }))).status, 404);
    assert.equal((await route(reviewRequest('POST', `/api/addresses/${foreignData.id}/default`, { token: tokenA }))).status, 404);

    const updated = await route(reviewRequest('PUT', `/api/addresses/${firstData.id}`, { token: tokenA, body: { phone: '+1 (202) 555-0199' } }));
    assert.equal(updated.status, 200);
    assert.equal(JSON.parse(updated.body).data.phone, '+1 (202) 555-0199');
    assert.equal((await route(reviewRequest('POST', `/api/addresses/${secondData.id}/default`, { token: tokenA }))).status, 200);
    let ownAddresses = JSON.parse((await route(reviewRequest('GET', '/api/addresses', { token: tokenA }))).body).data;
    assert.equal(ownAddresses.length, 2);
    assert.equal(ownAddresses.filter(address => address.isDefault).length, 1);
    assert.equal(ownAddresses[0].id, secondData.id);

    assert.equal((await route(reviewRequest('DELETE', `/api/addresses/${secondData.id}`, { token: tokenA }))).status, 200);
    ownAddresses = JSON.parse((await route(reviewRequest('GET', '/api/addresses', { token: tokenA }))).body).data;
    assert.equal(ownAddresses.length, 1);
    assert.equal(ownAddresses[0].id, firstData.id);
    assert.equal(ownAddresses[0].isDefault, true);
    assert.equal(JSON.parse((await route(reviewRequest('GET', '/api/addresses', { token: tokenB }))).body).data[0].id, foreignData.id);

    assert.equal((await route(reviewRequest('POST', '/api/auth/logout', { token: tokenA }))).status, 200);
    assert.equal((await route(reviewRequest('GET', '/api/addresses', { token: tokenA }))).status, 401);
    const reloginToken = issueToken(customerA);
    const afterLogin = JSON.parse((await route(reviewRequest('GET', '/api/addresses', { token: reloginToken }))).body).data;
    assert.equal(afterLogin.length, 1);
    assert.equal(afterLogin[0].id, firstData.id);
  });

  test('checkout resolves only the authenticated customer address and orders retain the address snapshot', async () => {
    const customerA = createReviewCustomer('checkout-address-a@example.com', 'Checkout Address A');
    const customerB = createReviewCustomer('checkout-address-b@example.com', 'Checkout Address B');
    const tokenA = issueToken(customerA);
    const tokenB = issueToken(customerB);
    const addressAResponse = await route(reviewRequest('POST', '/api/addresses', { token: tokenA, body: addressData('Home A') }));
    const addressBResponse = await route(reviewRequest('POST', '/api/addresses', { token: tokenB, body: addressData('Home B', { addressLine1: '99 Other Street' }) }));
    const addressA = JSON.parse(addressAResponse.body).data;
    const addressB = JSON.parse(addressBResponse.body).data;
    const items = [{ productId: 'prod_vela', quantity: 1 }];
    const spoofedAddress = { ...addressData('Spoofed', { addressLine1: 'B Address from browser' }), email: customerB.email };
    const foreignPayPal = await route(reviewRequest('POST', '/api/paypal/create-order', { token: tokenA, body: { savedAddressId: addressB.id, shippingAddress: spoofedAddress, items } }));
    const foreignStripe = await route(reviewRequest('POST', '/api/checkout', { token: tokenA, body: { savedAddressId: addressB.id, shippingAddress: spoofedAddress, items } }));
    assert.equal(foreignPayPal.status, 404);
    assert.equal(foreignStripe.status, 404);
    const validStripeAddress = await route(reviewRequest('POST', '/api/checkout', { token: tokenA, body: { savedAddressId: addressA.id, shippingAddress: spoofedAddress, items: [{ productId: 'missing-product', quantity: 1 }] } }));
    assert.equal(validStripeAddress.status, 422);
    assert.match(JSON.parse(validStripeAddress.body).error, /cart has changed|review your cart/i);
    assert.equal(readStore().inventoryReservations.length, 0);

    mockPayPalFlow({ orderId: 'PAYPAL_SAVED_ADDRESS_SNAPSHOT_1' });
    const restore = withMockedEmail(async () => ({ id: 'saved-address-email' }));
    try {
      const created = await route(reviewRequest('POST', '/api/paypal/create-order', { token: tokenA, body: { savedAddressId: addressA.id, shippingAddress: spoofedAddress, items } }));
      assert.equal(created.status, 201);
      const paypalOrderId = JSON.parse(created.body).data.paypalOrderId;
      const pending = repository.findPendingPayPalOrder(paypalOrderId);
      assert.equal(pending.shippingAddress.fullName, addressA.fullName);
      assert.equal(pending.shippingAddress.addressLine1, addressA.addressLine1);
      assert.equal(pending.shippingAddress.email, customerA.email);
      const captured = await route(reviewRequest('POST', '/api/paypal/capture-order', { token: tokenA, body: { paypalOrderId } }));
      assert.equal(captured.status, 200);
      const order = JSON.parse(captured.body).data.order;
      assert.equal(order.buyerId, customerA.id);
      assert.equal(order.shippingAddress.addressLine1, addressA.addressLine1);
      assert.equal(order.shippingAddress.email, customerA.email);
      repository.updateAddress(customerA.id, addressA.id, { addressLine1: 'Changed Future Address' });
      assert.equal(repository.getOrder(order.id).shippingAddress.addressLine1, addressA.addressLine1);
    } finally {
      restore();
    }
  });

  test('supplier registration, dashboard access, and ownership are enforced on the backend', async () => {
    const customer = createReviewCustomer('supplier-customer@example.com', 'Customer User');
    const customerToken = issueToken(customer);
    const admin = createAdminUser();
    const adminToken = issueToken(admin);

    const registration = await route(reviewRequest('POST', '/api/auth/register', {
      body: {
        name: 'Jane Supplier',
        email: 'supplier-registration@example.com',
        password: 'SupplierPassword123!',
        role: 'supplier',
        fullName: 'Jane Supplier',
        phone: '+1 555 010 2020',
        companyName: 'Northline Import Co.',
        country: 'US',
        state: 'NY',
        city: 'New York',
        businessAddress: '20 Hudson Avenue',
        businessDescription: 'Wholesale home goods from the Northeast.'
      }
    }));

    assert.equal(registration.status, 201);
    const registered = JSON.parse(registration.body).data;
    assert.equal(registered.user.role, 'supplier');
    assert.equal(registered.user.email, 'supplier-registration@example.com');
    const supplierRecord = readStore().suppliers.find(entry => entry.ownerId === registered.user.id);
    assert.ok(supplierRecord);
    assert.equal(supplierRecord.verificationStatus, 'pending');

    const supplierToken = issueToken(readStore().users.find(user => user.id === registered.user.id));
    assert.equal((await route(reviewRequest('GET', '/api/supplier/dashboard', { token: customerToken }))).status, 403);
    assert.equal((await route(reviewRequest('GET', '/api/supplier/dashboard', { token: adminToken }))).status, 403);

    const dashboard = await route(reviewRequest('GET', '/api/supplier/dashboard', { token: supplierToken }));
    assert.equal(dashboard.status, 200);
    const dashboardBody = JSON.parse(dashboard.body).data;
    assert.equal(dashboardBody.storeName, supplierRecord.businessName || supplierRecord.companyName);
    assert.equal(dashboardBody.verificationStatus, 'pending');

    const createProduct = await route(reviewRequest('POST', '/api/supplier/products', {
      token: supplierToken,
      body: {
        name: 'Northline Lamp',
        category: 'Home & Furniture',
        supplier: 'Northline Import Co.',
        location: 'United States',
        price: 180,
        wholesalePrice: 120,
        moq: 10,
        stock: 25,
        description: 'Hand-finished brass lamp for boutique retail.'
      }
    }));
    assert.equal(createProduct.status, 201);
    const createdProduct = JSON.parse(createProduct.body).data;
    assert.equal(createdProduct.supplierId, supplierRecord.id);

    const otherSupplier = createUser({ email: 'supplier-other@example.com', name: 'Other Supplier', role: 'supplier', passwordHash: hashPassword('SupplierPassword456!') });
    const otherSupplierRecord = createSupplier({ ownerId: otherSupplier.id, businessName: 'Other Brand Co.', country: 'US', businessType: 'wholesale', description: 'Another supplier.' });
    const otherToken = issueToken(otherSupplier);
    const foreignPatch = await route(reviewRequest('PATCH', `/api/supplier/products/${createdProduct.id}`, {
      token: otherToken,
      body: { name: 'Attempted takeover' }
    }));
    assert.equal(foreignPatch.status, 403);

    const adminApproval = await route(reviewRequest('PATCH', `/api/admin/suppliers/${supplierRecord.id}`, {
      token: adminToken,
      body: { status: 'approved' }
    }));
    assert.equal(adminApproval.status, 200);
    assert.equal(JSON.parse(adminApproval.body).data.verificationStatus, 'approved');
    const approvedProduct = JSON.parse((await route(reviewRequest('GET', `/api/products/${createdProduct.id}`))).body).data;
    const approvedProductList = JSON.parse((await route(reviewRequest('GET', '/api/products'))).body).data;
    assert.equal(approvedProduct.verified, true);
    assert.equal(approvedProductList.find(product => product.id === createdProduct.id).verified, true);

    const storefront = await route(reviewRequest('GET', `/api/suppliers/${supplierRecord.id}`));
    assert.equal(storefront.status, 200);
    const storefrontBody = JSON.parse(storefront.body).data;
    assert.equal(storefrontBody.businessName, 'Northline Import Co.');
    assert.equal(storefrontBody.verified, true);

    const supplierOrders = await route(reviewRequest('GET', '/api/orders', { token: supplierToken }));
    assert.equal(supplierOrders.status, 200);
    JSON.parse(supplierOrders.body).data;
  });

  test('supplier profile settings are owner-scoped and cannot change admin verification', async () => {
    const admin = createAdminUser();
    const customer = createReviewCustomer('supplier-profile-customer@example.com', 'Profile Customer');
    const supplierA = createUser({ email: 'supplier-profile-a@example.com', name: 'Supplier A', role: 'supplier', passwordHash: hashPassword('SupplierProfilePasswordA!') });
    const supplierB = createUser({ email: 'supplier-profile-b@example.com', name: 'Supplier B', role: 'supplier', passwordHash: hashPassword('SupplierProfilePasswordB!') });
    const recordA = createSupplier({ ownerId: supplierA.id, businessName: 'Profile Store A', country: 'US', description: 'Original description.' });
    const recordB = createSupplier({ ownerId: supplierB.id, businessName: 'Profile Store B', country: 'CA', description: 'Private store B.' });
    const tokenA = issueToken(supplierA);
    const tokenB = issueToken(supplierB);
    const customerToken = issueToken(customer);
    const adminToken = issueToken(admin);

    assert.equal((await route(reviewRequest('GET', '/api/supplier/profile'))).status, 401);
    assert.equal((await route(reviewRequest('GET', '/api/supplier/profile', { token: customerToken }))).status, 403);
    assert.equal((await route(reviewRequest('PATCH', '/api/supplier/profile', { token: customerToken, body: { businessName: 'Customer takeover' } }))).status, 403);
    assert.equal((await route(reviewRequest('PATCH', '/api/supplier/profile', { token: adminToken, body: { businessName: 'Admin takeover' } }))).status, 403);

    const ownSettings = await route(reviewRequest('GET', '/api/supplier/profile', { token: tokenA }));
    assert.equal(ownSettings.status, 200);
    assert.equal(JSON.parse(ownSettings.body).data.id, recordA.id);
    assert.equal(JSON.parse(ownSettings.body).data.businessName, 'Profile Store A');

    const updated = await route(reviewRequest('PATCH', '/api/supplier/profile', {
      token: tokenA,
      body: {
        businessName: 'Profile Store A Updated',
        logoUrl: 'https://example.test/store-logo.png',
        businessDescription: 'Updated public profile.',
        country: 'CA',
        state: 'ON',
        city: 'Toronto',
        businessAddress: '10 Market Street',
        phone: '+1 416 555 0100',
        businessEmail: 'trade@profile-store-a.example',
        categories: ['Home & Furniture', 'Fashion', 'home & furniture']
      }
    }));
    assert.equal(updated.status, 200);
    const updatedProfile = JSON.parse(updated.body).data;
    assert.equal(updatedProfile.businessName, 'Profile Store A Updated');
    assert.equal(updatedProfile.companyName, 'Profile Store A Updated');
    assert.deepEqual(updatedProfile.categories, ['Home & Furniture', 'Fashion']);
    assert.equal(updatedProfile.verificationStatus, 'pending');
    assert.equal(readStore().suppliers.find(entry => entry.id === recordA.id).ownerId, supplierA.id);

    const forgedProfile = await route(reviewRequest('PATCH', '/api/supplier/profile', {
      token: tokenA,
      body: { supplierId: recordB.id, businessName: 'Attempted Store B takeover', verificationStatus: 'approved', status: 'approved' }
    }));
    assert.equal(forgedProfile.status, 422);
    assert.equal(readStore().suppliers.find(entry => entry.id === recordA.id).businessName, 'Profile Store A Updated');
    assert.equal(readStore().suppliers.find(entry => entry.id === recordB.id).businessName, 'Profile Store B');
    assert.equal(readStore().suppliers.find(entry => entry.id === recordA.id).verificationStatus, 'pending');
    const otherOwnerAttempt = await route(reviewRequest('PATCH', '/api/supplier/profile', {
      token: tokenB,
      body: { supplierId: recordA.id, businessName: 'Supplier B attempting to edit Supplier A' }
    }));
    assert.equal(otherOwnerAttempt.status, 422);
    assert.equal(readStore().suppliers.find(entry => entry.id === recordA.id).businessName, 'Profile Store A Updated');
    assert.equal(readStore().suppliers.find(entry => entry.id === recordB.id).businessName, 'Profile Store B');

    const publicStorefront = await route(reviewRequest('GET', `/api/suppliers/${recordA.id}`));
    assert.equal(publicStorefront.status, 200);
    const publicProfile = JSON.parse(publicStorefront.body).data;
    assert.equal(publicProfile.businessName, 'Profile Store A Updated');
    assert.equal(publicProfile.logoUrl, 'https://example.test/store-logo.png');
    assert.equal(publicProfile.description, 'Updated public profile.');
    assert.equal(publicProfile.city, 'Toronto');
    assert.deepEqual(publicProfile.categories, ['Home & Furniture', 'Fashion']);
    assert.equal(Object.hasOwn(publicProfile, 'businessAddress'), false);
    assert.equal(Object.hasOwn(publicProfile, 'ownerId'), false);

    const adminApproval = await route(reviewRequest('PATCH', `/api/admin/suppliers/${recordA.id}`, { token: adminToken, body: { status: 'approved' } }));
    assert.equal(adminApproval.status, 200);
    assert.equal(JSON.parse(adminApproval.body).data.verificationStatus, 'approved');
    const approvedStorefront = JSON.parse((await route(reviewRequest('GET', `/api/suppliers/${recordA.id}`))).body).data;
    assert.equal(approvedStorefront.verified, true);
    assert.equal(approvedStorefront.businessName, 'Profile Store A Updated');
  });

  test('visual search uses real catalog images and never stores customer uploads', async () => {
    const originalProvider = process.env.VISUAL_SEARCH_PROVIDER;
    const originalApiKey = process.env.VISUAL_SEARCH_API_KEY;
    delete process.env.VISUAL_SEARCH_PROVIDER;
    delete process.env.VISUAL_SEARCH_API_KEY;
    try {
      const imageDirectory = path.join(__dirname, '..', 'uploads', 'products');
      const imageFilename = 'prod_b8706d65-774c-4220-8270-a24a739ca519_4020487a-b0b0-498c-91d0-5f55231eb564.jpg';
      const imagePath = path.join(imageDirectory, imageFilename);
      assert.ok(fs.existsSync(imagePath), 'real catalog image should exist');
      const imageBuffer = fs.readFileSync(imagePath);
      const realCatalogProduct = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'dev.json'), 'utf8')).products.find(product => product.id === 'prod_b8706d65-774c-4220-8270-a24a739ca519');
      assert.ok(realCatalogProduct, 'real uploaded catalog product should exist');
      createProduct(structuredClone(realCatalogProduct));
      createProduct({ id: 'prod_visual_inactive_match', name: 'Inactive catalog item', category: realCatalogProduct.category, supplier: 'LEXORA', location: 'Global', image: realCatalogProduct.image, images: realCatalogProduct.images, price: 10, stock: 10, status: 'inactive' });
      const productsBefore = structuredClone(readStore().products);
      const filesBefore = fs.readdirSync(imageDirectory).sort();

      const configuration = await route(reviewRequest('GET', '/api/visual-search'));
      assert.equal(configuration.status, 200);
      assert.equal(JSON.parse(configuration.body).data.provider, 'catalog-fallback');
      assert.equal(JSON.parse(configuration.body).data.maxUploadBytes, maxVisualSearchImageSize);

      const result = await route(makeMultipartRequest({
        url: '/api/visual-search',
        files: [{ fieldName: 'image', filename: 'necklace.jpg', contentType: 'image/jpeg', buffer: imageBuffer }]
      }));
      assert.equal(result.status, 200);
      const payload = JSON.parse(result.body);
      assert.equal(payload.success, true);
      assert.equal(payload.data.provider, 'catalog-fallback');
      assert.equal(payload.data.fallback, true);
      assert.equal(payload.data.analysis.category, null);
      assert.equal(payload.data.analysis.material, null);
      assert.match(payload.data.analysis.note, /not analyzed/i);
      assert.deepEqual(payload.data.results.map(product => product.productId), [realCatalogProduct.id]);
      assert.equal(payload.data.results[0].similarityScore, 100);
      assert.equal(payload.data.results[0].available, false);
      assert.equal(payload.data.results.some(product => product.productId === 'prod_visual_inactive_match'), false);
      assert.equal(JSON.stringify(payload).includes('necklace.jpg'), false);
      assert.deepEqual(readStore().products, productsBefore);
      assert.deepEqual(fs.readdirSync(imageDirectory).sort(), filesBefore);
      const leakedUpload = await route(reviewRequest('GET', '/uploads/products/customer-visual-search.jpg'));
      assert.equal(leakedUpload.status, 404);

      const catalogSource = await route(makeMultipartRequest({
        url: '/api/visual-search',
        fields: { productId: realCatalogProduct.id }
      }));
      assert.equal(catalogSource.status, 200);
      const catalogSourcePayload = JSON.parse(catalogSource.body);
      assert.equal(catalogSourcePayload.data.sourceType, 'catalog-product');
      assert.ok(catalogSourcePayload.data.results.some(product => product.productId === realCatalogProduct.id));
      assert.deepEqual(readStore().products, productsBefore);
      assert.deepEqual(fs.readdirSync(imageDirectory).sort(), filesBefore);
      const inactiveSource = await route(makeMultipartRequest({ url: '/api/visual-search', fields: { productId: 'prod_visual_inactive_match' } }));
      assert.equal(inactiveSource.status, 404);

      const notFound = await route(reviewRequest('GET', '/api/products/prod_visual_unknown'));
      assert.equal(notFound.status, 404);
      assert.equal(readStore().products.some(product => product.id === 'prod_visual_unknown'), false);
    } finally {
      if (originalProvider === undefined) delete process.env.VISUAL_SEARCH_PROVIDER;
      else process.env.VISUAL_SEARCH_PROVIDER = originalProvider;
      if (originalApiKey === undefined) delete process.env.VISUAL_SEARCH_API_KEY;
      else process.env.VISUAL_SEARCH_API_KEY = originalApiKey;
    }
  });

  test('visual search validates upload presence, size, signature, and decoded image format', async () => {
    const originalProvider = process.env.VISUAL_SEARCH_PROVIDER;
    const originalApiKey = process.env.VISUAL_SEARCH_API_KEY;
    delete process.env.VISUAL_SEARCH_PROVIDER;
    delete process.env.VISUAL_SEARCH_API_KEY;
    try {
      const missing = await route(makeMultipartRequest({ url: '/api/visual-search' }));
      assert.equal(missing.status, 400);

      const empty = await route(makeMultipartRequest({ url: '/api/visual-search', files: [{ filename: 'empty.jpg', contentType: 'image/jpeg', buffer: Buffer.alloc(0) }] }));
      assert.equal(empty.status, 422);

      const unsupported = await route(makeMultipartRequest({ url: '/api/visual-search', files: [{ filename: 'image.gif', contentType: 'image/gif', buffer: Buffer.from('GIF89a') }] }));
      assert.equal(unsupported.status, 415);

      const mismatched = await route(makeMultipartRequest({ url: '/api/visual-search', files: [{ filename: 'image.jpg', contentType: 'image/jpeg', buffer: Buffer.from('GIF89a') }] }));
      assert.equal(mismatched.status, 415);

      const corrupted = await route(makeMultipartRequest({ url: '/api/visual-search', files: [{ filename: 'corrupt.jpg', contentType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]) }] }));
      assert.equal(corrupted.status, 422);

      const oversized = await route(makeMultipartRequest({ url: '/api/visual-search', files: [{ filename: 'large.jpg', contentType: 'image/jpeg', buffer: Buffer.alloc(maxVisualSearchImageSize + 1, 0xff) }] }));
      assert.equal(oversized.status, 413);

      for (const format of ['png', 'webp']) {
        const buffer = await sharp({ create: { width: 18, height: 18, channels: 3, background: '#927451' } }).toFormat(format).toBuffer();
        const mime = format === 'png' ? 'image/png' : 'image/webp';
        const valid = await route(makeMultipartRequest({ url: '/api/visual-search', files: [{ filename: `valid.${format}`, contentType: mime, buffer }] }));
        assert.equal(valid.status, 200, `${format} should decode successfully`);
        assert.equal(JSON.parse(valid.body).data.provider, 'catalog-fallback');
      }
    } finally {
      if (originalProvider === undefined) delete process.env.VISUAL_SEARCH_PROVIDER;
      else process.env.VISUAL_SEARCH_PROVIDER = originalProvider;
      if (originalApiKey === undefined) delete process.env.VISUAL_SEARCH_API_KEY;
      else process.env.VISUAL_SEARCH_API_KEY = originalApiKey;
    }
  });

  test('configured visual provider stays server-side and matches stored attributes', async () => {
    const originalEnvironment = {
      provider: process.env.VISUAL_SEARCH_PROVIDER,
      key: process.env.VISUAL_SEARCH_API_KEY,
      url: process.env.VISUAL_SEARCH_API_URL,
      model: process.env.VISUAL_SEARCH_MODEL
    };
    process.env.VISUAL_SEARCH_PROVIDER = 'openai-compatible';
    process.env.VISUAL_SEARCH_API_KEY = 'visual-search-test-secret';
    process.env.VISUAL_SEARCH_API_URL = 'http://localhost:4999/v1/chat/completions';
    process.env.VISUAL_SEARCH_MODEL = 'test-vision-model';
    const providerCalls = [];
    global.fetch = async (url, options) => {
      providerCalls.push({ url: String(url), authorization: options.headers.Authorization, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ category: 'Accessories', colors: ['red'], style: 'minimal', material: 'leather', attributes: ['compact'] }) } }] }) };
    };
    try {
      createProduct({ id: 'prod_visual_attribute_match', name: 'Red leather travel pouch', category: 'Accessories', description: 'A minimal compact travel pouch.', color: 'red', material: 'leather', style: 'minimal', productType: 'pouch', supplier: 'LEXORA', location: 'Global', price: 32, stock: 3, status: 'active' });
      const before = structuredClone(readStore().products);
      const image = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#902d2d' } }).jpeg().toBuffer();
      const result = await route(makeMultipartRequest({ url: '/api/visual-search', files: [{ filename: 'query.jpg', contentType: 'image/jpeg', buffer: image }] }));

      assert.equal(result.status, 200);
      const payload = JSON.parse(result.body);
      assert.equal(payload.data.provider, 'openai-compatible');
      assert.equal(payload.data.fallback, false);
      assert.deepEqual(payload.data.analysis.colors, ['red']);
      assert.ok(payload.data.results.some(product => product.productId === 'prod_visual_attribute_match'));
      assert.equal(providerCalls.length, 1);
      assert.equal(providerCalls[0].url, 'http://localhost:4999/v1/chat/completions');
      assert.equal(providerCalls[0].authorization, 'Bearer visual-search-test-secret');
      assert.match(providerCalls[0].body.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
      assert.equal(JSON.stringify(payload).includes('visual-search-test-secret'), false);
      assert.equal(JSON.stringify(payload).includes(process.env.LEXORA_DATA_FILE), false);
      assert.deepEqual(readStore().products, before);
    } finally {
      for (const [key, value] of Object.entries({
        VISUAL_SEARCH_PROVIDER: originalEnvironment.provider,
        VISUAL_SEARCH_API_KEY: originalEnvironment.key,
        VISUAL_SEARCH_API_URL: originalEnvironment.url,
        VISUAL_SEARCH_MODEL: originalEnvironment.model
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      delete global.fetch;
    }
  });

  test('reviews initialize without altering existing products and empty product ratings are not faked', async () => {
    const response = await route(reviewRequest('GET', '/api/products/prod_vela/reviews'));
    const payload = JSON.parse(response.body);
    const product = JSON.parse((await route(reviewRequest('GET', '/api/products/prod_vela'))).body).data;

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(process.env.LEXORA_DATA_FILE, 'utf8')).reviews, []);
    assert.equal(payload.data.summary.reviewCount, 0);
    assert.equal(payload.data.summary.averageRating, 0);
    assert.deepEqual(payload.data.summary.distribution, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
    assert.equal(product.rating, null);
    assert.equal(product.reviews, 0);
    assert.equal((await route(reviewRequest('GET', '/api/products/unknown/reviews'))).status, 404);
  });

  test('only a customer with a paid owned order can submit a verified review', async () => {
    const customerA = createReviewCustomer('review-a@example.com', 'Customer A');
    const customerB = createReviewCustomer('review-b@example.com', 'Customer B');
    const tokenA = issueToken(customerA);
    const tokenB = issueToken(customerB);
    createPaidProductOrder(customerA, 'prod_vela');

    const anonymous = await route(reviewRequest('POST', '/api/products/prod_vela/reviews', { body: { rating: 5, comment: 'A lovely finish.' } }));
    const nonBuyer = await route(reviewRequest('POST', '/api/products/prod_kanso/reviews', { token: tokenA, body: { rating: 5, comment: 'A lovely finish.' } }));
    const fakeIdentity = await route(reviewRequest('POST', '/api/products/prod_vela/reviews', { token: tokenA, body: { rating: 5, comment: 'A lovely finish.', customerId: customerB.id, verifiedPurchase: true } }));
    const created = await route(reviewRequest('POST', '/api/products/prod_vela/reviews', { token: tokenA, body: { rating: 5, title: 'Beautifully made', comment: '<script>window.xss=1</script>Beautiful and well made.' } }));
    const ownView = await route(reviewRequest('GET', '/api/products/prod_vela/reviews', { token: tokenA }));
    const otherView = await route(reviewRequest('GET', '/api/products/prod_vela/reviews', { token: tokenB }));

    assert.equal(anonymous.status, 401);
    assert.equal(nonBuyer.status, 403);
    assert.equal(fakeIdentity.status, 422);
    assert.equal(created.status, 201);
    const review = JSON.parse(created.body).data;
    assert.equal(review.verifiedPurchase, true);
    assert.equal(review.status, 'pending');
    assert.equal('authorId' in review, false);
    assert.equal('customerId' in review, false);
    assert.equal('email' in review, false);
    assert.match(review.comment, /<script>/);
    const ownData = JSON.parse(ownView.body).data;
    assert.equal(ownData.eligible, true);
    assert.equal(ownData.myReview.id, review.id);
    assert.equal(ownData.reviews.length, 0);
    assert.equal(JSON.parse(otherView.body).data.myReview, null);
  });

  test('review input rejects malformed ratings and text without crashing', async () => {
    const customer = createReviewCustomer('review-validation@example.com');
    createPaidProductOrder(customer, 'prod_vela');
    const token = issueToken(customer);
    const invalidBodies = [
      { rating: 0, comment: 'No stars.' },
      { rating: 6, comment: 'Too many stars.' },
      { rating: -1, comment: 'Negative stars.' },
      { rating: '5', comment: 'String rating.' },
      { rating: null, comment: 'Null rating.' },
      { rating: 5, comment: '' },
      { rating: 5, comment: { html: 'not text' } },
      { rating: 5, comment: 'x'.repeat(2001) },
      { rating: 5, title: {}, comment: 'Invalid title type.' },
      []
    ];
    for (const body of invalidBodies) {
      const response = await route(reviewRequest('POST', '/api/products/prod_vela/reviews', { token, body }));
      assert.equal(response.status, 422, JSON.stringify(body).slice(0, 80));
    }
    const malformedJson = await route(makeRawRequest({ method: 'POST', url: '/api/products/prod_vela/reviews', token, rawBody: '{"rating":' }));
    assert.equal(malformedJson.status, 400);
    assert.match(JSON.parse(malformedJson.body).error, /valid JSON/i);
    for (const rating of [1, 5]) {
      const eligibleCustomer = createReviewCustomer(`review-rating-${rating}@example.com`);
      createPaidProductOrder(eligibleCustomer, 'prod_vela');
      const response = await route(reviewRequest('POST', '/api/products/prod_vela/reviews', { token: issueToken(eligibleCustomer), body: { rating, comment: `Valid ${rating}-star review.` } }));
      assert.equal(response.status, 201);
    }
  });

  test('a customer can create only one review for each product', async () => {
    const customer = createReviewCustomer('review-duplicate@example.com');
    createPaidProductOrder(customer, 'prod_vela');
    const token = issueToken(customer);
    const first = await route(reviewRequest('POST', '/api/products/prod_vela/reviews', { token, body: { rating: 4, comment: 'First review.' } }));
    const duplicate = await route(reviewRequest('POST', '/api/products/prod_vela/reviews', { token, body: { rating: 5, comment: 'Second review.' } }));

    assert.equal(first.status, 201);
    assert.equal(duplicate.status, 409);
    assert.equal(listReviews({ productId: 'prod_vela' }).total, 1);
  });

  test('review edit and deletion require ownership and preserve server-managed fields', async () => {
    const customerA = createReviewCustomer('review-owner-a@example.com', 'Owner A');
    const customerB = createReviewCustomer('review-owner-b@example.com', 'Owner B');
    createPaidProductOrder(customerA, 'prod_vela');
    const tokenA = issueToken(customerA);
    const tokenB = issueToken(customerB);
    const created = await route(reviewRequest('POST', '/api/products/prod_vela/reviews', { token: tokenA, body: { rating: 4, comment: 'Original comment.' } }));
    const reviewId = JSON.parse(created.body).data.id;
    const forbiddenEdit = await route(reviewRequest('PUT', `/api/reviews/${reviewId}`, { token: tokenB, body: { rating: 1, comment: 'Hijacked.' } }));
    const forbiddenDelete = await route(reviewRequest('DELETE', `/api/reviews/${reviewId}`, { token: tokenB }));
    const ownEdit = await route(reviewRequest('PUT', `/api/reviews/${reviewId}`, { token: tokenA, body: { rating: 5, title: 'Updated', comment: 'Updated comment.', verifiedPurchase: false } }));

    assert.equal(forbiddenEdit.status, 403);
    assert.equal(forbiddenDelete.status, 403);
    assert.equal(ownEdit.status, 422);
    const validEdit = await route(reviewRequest('PATCH', `/api/reviews/${reviewId}`, { token: tokenA, body: { rating: 5, title: 'Updated', comment: 'Updated comment.' } }));
    assert.equal(validEdit.status, 200);
    assert.equal(JSON.parse(validEdit.body).data.status, 'pending');
    assert.equal(JSON.parse(validEdit.body).data.verifiedPurchase, true);
    assert.equal(JSON.parse(validEdit.body).data.rating, 5);
    assert.equal((await route(reviewRequest('DELETE', `/api/reviews/${reviewId}`, { token: tokenA }))).status, 200);
    assert.equal((await route(reviewRequest('PUT', `/api/reviews/${reviewId}`, { token: tokenA, body: { rating: 5, comment: 'Deleted.' } }))).status, 404);
  });

  test('review moderation is admin-only and approved reviews alone drive public aggregates', async () => {
    const customerA = createReviewCustomer('review-moderation-a@example.com', 'Moderation A');
    const customerB = createReviewCustomer('review-moderation-b@example.com', 'Moderation B');
    const admin = createAdminUser();
    const tokenA = issueToken(customerA);
    const tokenB = issueToken(customerB);
    const adminToken = issueToken(admin);
    createPaidProductOrder(customerA, 'prod_vela');
    createPaidProductOrder(customerB, 'prod_vela');
    const first = JSON.parse((await route(reviewRequest('POST', '/api/products/prod_vela/reviews', { token: tokenA, body: { rating: 5, comment: 'Excellent quality.' } }))).body).data;
    const second = JSON.parse((await route(reviewRequest('POST', '/api/products/prod_vela/reviews', { token: tokenB, body: { rating: 3, comment: 'Good overall.' } }))).body).data;

    assert.equal((await route(reviewRequest('GET', '/api/admin/reviews'))).status, 401);
    assert.equal((await route(reviewRequest('GET', '/api/admin/reviews', { token: tokenA }))).status, 403);
    assert.equal((await route(reviewRequest('PATCH', `/api/admin/reviews/${first.id}`, { token: adminToken, body: { status: 'approved' } }))).status, 200);
    assert.equal((await route(reviewRequest('PATCH', `/api/admin/reviews/${second.id}`, { token: adminToken, body: { status: 'approved' } }))).status, 200);
    const thirdCustomer = createReviewCustomer('review-moderation-c@example.com', 'Moderation C');
    createPaidProductOrder(thirdCustomer, 'prod_vela');
    const third = JSON.parse((await route(reviewRequest('POST', '/api/products/prod_vela/reviews', { token: issueToken(thirdCustomer), body: { rating: 1, comment: 'Not for me.' } }))).body).data;
    assert.equal((await route(reviewRequest('PATCH', `/api/admin/reviews/${third.id}`, { token: adminToken, body: { status: 'hidden' } }))).status, 200);

    const productReviews = JSON.parse((await route(reviewRequest('GET', '/api/products/prod_vela/reviews'))).body).data;
    const adminReviews = JSON.parse((await route(reviewRequest('GET', '/api/admin/reviews', { token: adminToken }))).body);
    const product = JSON.parse((await route(reviewRequest('GET', '/api/products/prod_vela'))).body).data;
    assert.equal(productReviews.reviews.length, 2);
    assert.equal(productReviews.summary.reviewCount, 2);
    assert.equal(productReviews.summary.averageRating, 4);
    assert.deepEqual(productReviews.summary.distribution, { 1: 0, 2: 0, 3: 1, 4: 0, 5: 1 });
    assert.equal(product.rating, 4);
    assert.equal(product.reviews, 2);
    assert.ok(adminReviews.data.some(review => review.customer.email === customerA.email));
    assert.equal((await route(reviewRequest('PATCH', `/api/admin/reviews/${first.id}`, { token: adminToken, body: { status: 'public' } }))).status, 422);
    assert.equal((await route(reviewRequest('DELETE', `/api/admin/reviews/${third.id}`, { token: adminToken }))).status, 200);
  });

  test('public reviews sort correctly and paginate without truncating aggregate totals', async () => {
    const ratings = [1, 5, 4, 2, 3];
    ratings.forEach((rating, index) => {
      const created = repository.createReview({ productId: 'prod_vela', authorId: `customer-${index}`, authorName: `Customer ${index}`, rating, title: '', comment: `Review ${index}.`, verifiedPurchase: true, status: 'pending' });
      updateReview(created.review.id, { status: 'approved' });
    });
    const highest = JSON.parse((await route(reviewRequest('GET', '/api/products/prod_vela/reviews?sort=highest&page=1&limit=2'))).body).data;
    const lowestPage = JSON.parse((await route(reviewRequest('GET', '/api/products/prod_vela/reviews?sort=lowest&page=2&limit=2'))).body).data;

    assert.deepEqual(highest.reviews.map(review => review.rating), [5, 4]);
    assert.equal(highest.total, 5);
    assert.equal(highest.pageSize, 2);
    assert.deepEqual(lowestPage.reviews.map(review => review.rating), [3, 4]);
    assert.equal(lowestPage.page, 2);
    assert.equal(lowestPage.summary.reviewCount, 5);
    assert.equal(lowestPage.summary.averageRating, 3);
  });

  test('legacy email-matched paid orders can verify a review without changing order ownership', async () => {
    const customer = createReviewCustomer('legacy-review@example.com');
    const order = createOrder({ buyerId: null, items: [{ productId: 'prod_vela', quantity: 1 }], shippingAddress: { email: customer.email }, paymentStatus: 'paid' });
    const token = issueToken(customer);
    const response = await route(reviewRequest('POST', '/api/products/prod_vela/reviews', { token, body: { rating: 1, comment: 'A verified legacy order.' } }));

    assert.equal(response.status, 201);
    assert.equal(JSON.parse(response.body).data.verifiedPurchase, true);
    assert.equal(repository.getOrder(order.id).buyerId, null);
  });

  test('POST /api/auth/login rejects invalid credentials', async () => {
    const response = await route(makeRequest({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: 'localhost:4000', 'content-type': 'application/json' },
      body: { email: 'missing@example.com', password: 'wrong-pass' }
    }));

    assert.equal(response.status, 401);
    const payload = JSON.parse(response.body);
    assert.match(payload.error, /Invalid email or password/i);
  });

  test('POST /api/auth/logout invalidates the current customer session', async () => {
    const customer = createUser({
      email: 'logout.customer@example.com',
      name: 'Logout Customer',
      role: 'customer',
      passwordHash: hashPassword('StrongPassword123!')
    });
    const token = issueToken(customer);

    const logout = await route(makeRequest({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { host: 'localhost:4000', authorization: `Bearer ${token}` }
    }));

    assert.equal(logout.status, 200);
    const followUp = await route(makeRequest({
      method: 'GET',
      url: '/api/me',
      headers: { host: 'localhost:4000', authorization: `Bearer ${token}` }
    }));
    assert.equal(followUp.status, 401);
  });

  test('admin dashboard rejects unauthenticated requests', async () => {
    const response = await route(makeRequest({
      method: 'GET',
      url: '/api/admin/dashboard',
      headers: { host: 'localhost:4000' }
    }));

    assert.equal(response.status, 401);
    assert.match(JSON.parse(response.body).error, /Authentication required/i);
  });

  test('GET /api/admin/orders rejects unauthenticated access and returns existing orders to admins', async () => {
    resetMarketplaceData();
    const admin = createAdminUser();
    const customer = createUser({
      email: 'orders.customer@example.com',
      name: 'Orders Customer',
      role: 'customer',
      passwordHash: hashPassword('StrongPassword123!')
    });
    const firstOrder = repository.createOrder({
      buyerId: customer.id,
      items: [{ productId: 'prod_vela', quantity: 1, unitPrice: 42000 }],
      shippingAddress: { fullName: 'Orders Customer', email: 'orders.customer@example.com' },
      totalAmount: 42000,
      paymentStatus: 'paid'
    });
    const secondOrder = repository.createOrder({
      buyerId: null,
      items: [{ productId: 'prod_kanso', quantity: 1, unitPrice: 18500 }],
      shippingAddress: { fullName: 'Guest', email: 'guest@example.com' },
      totalAmount: 18500,
      paymentStatus: 'paid'
    });

    const unauthorized = await route(makeRequest({ method: 'GET', url: '/api/admin/orders', headers: { host: 'localhost:4000' } }));
    assert.equal(unauthorized.status, 401);

    const adminResponse = await route(makeRequest({
      method: 'GET',
      url: '/api/admin/orders',
      headers: { host: 'localhost:4000', authorization: `Bearer ${issueToken(admin)}` }
    }));
    assert.equal(adminResponse.status, 200);
    const orders = JSON.parse(adminResponse.body).data;
    assert.deepEqual(orders.map(order => order.id).sort(), [firstOrder.id, secondOrder.id].sort());
  });

  test('PayPal configuration does not expose credentials', async () => {
    const response = await route(makeRequest({
      method: 'GET',
      url: '/api/paypal/config',
      headers: { host: 'localhost:4000' }
    }));

    assert.equal(response.status, 200);
    const payload = JSON.parse(response.body);
    assert.equal(typeof payload.data.configured, 'boolean');
    assert.equal(payload.data.environment, 'sandbox');
    assert.equal(Object.prototype.hasOwnProperty.call(payload.data, 'clientSecret'), false);
  });

  test('PayPal client-token endpoint returns only a browser-safe SDK token', async () => {
    const mock = mockPayPalCardFlow();
    const response = await route(makeRequest({ method: 'GET', url: '/api/paypal/client-token', headers: { host: 'localhost:4000' } }));
    const payload = JSON.parse(response.body);
    const tokenRequest = mock.calls.find(call => call.url.includes('/v1/oauth2/token'));

    assert.equal(response.status, 200);
    assert.deepEqual(payload, { data: { clientToken: 'mock-paypal-safe-token' } });
    assert.match(tokenRequest.options.body, /response_type=client_token/);
    assert.match(tokenRequest.options.body, /intent=sdk_init/);
    assert.equal(Object.hasOwn(payload.data, 'clientSecret'), false);
  });

  test('PayPal Card Fields order uses server totals, SCA_WHEN_REQUIRED, and existing inventory reservations', async () => {
    const mock = mockPayPalCardFlow();
    const response = await route(makeRequest({
      method: 'POST',
      url: '/api/paypal/create-order',
      headers: { host: 'localhost:4000', 'content-type': 'application/json' },
      body: paypalCheckoutBody()
    }));
    const payload = JSON.parse(response.body);
    const pending = repository.findPendingPayPalOrder(payload.data.paypalOrderId);

    assert.equal(response.status, 201);
    assert.deepEqual(Object.keys(payload.data), ['paypalOrderId']);
    assert.equal(mock.createdOrderBody.purchase_units[0].amount.value, '420.00');
    assert.equal(mock.createdOrderBody.payment_source.card.attributes.verification.method, 'SCA_WHEN_REQUIRED');
    assert.ok(mock.createdOrderBody.payment_source.card.experience_context.return_url);
    assert.ok(mock.createdOrderBody.payment_source.card.experience_context.cancel_url);
    assert.equal(pending.paymentMethod, 'card');
    assert.equal(repository.getInventoryReservation(pending.reservationId).status, 'reserved');
  });

  test('PayPal Card Fields order includes the server-derived billing country and validated address fields', async () => {
    const mock = mockPayPalCardFlow();
    const response = await route(makeRequest({
      method: 'POST',
      url: '/api/paypal/create-order',
      headers: { host: 'localhost:4000', 'content-type': 'application/json' },
      body: paypalCheckoutBody()
    }));

    assert.equal(response.status, 201);
    assert.deepEqual(mock.createdOrderBody.payment_source.card.billing_address, {
      address_line_1: '1 Main St',
      admin_area_1: 'TX',
      admin_area_2: 'Austin',
      postal_code: '78701',
      country_code: 'US'
    });
    const actualRequestBody = JSON.parse(mock.createdOrderSerializedBody);
    const actualCountryCode = actualRequestBody.payment_source.card.billing_address.country_code;
    assert.equal(actualCountryCode, 'US');
    assert.match(mock.calls.find(call => call.url.endsWith('/v2/checkout/orders')).url, /\/v2\/checkout\/orders$/);
  });

  test('PayPal Card Fields maps validated country names to canonical ISO country codes', async () => {
    for (const [index, [country, expectedCode]] of [
      ['United States', 'US'],
      ['Sweden', 'SE'],
      ['China', 'CN'],
      ['Tanzania', 'TZ'],
      ['United Kingdom', 'GB']
    ].entries()) {
      const mock = mockPayPalCardFlow({ orderId: `PAYPAL_CARD_COUNTRY_${index}` });
      const body = paypalCheckoutBody();
      body.shippingAddress.country = country;
      body.shippingAddress.addressLine2 = 'Suite 2';
      const response = await route(makeRequest({ method: 'POST', url: '/api/paypal/create-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body }));
      const billingAddress = mock.createdOrderBody.payment_source.card.billing_address;

      assert.equal(response.status, 201, country);
      assert.equal(billingAddress.country_code, expectedCode, country);
      assert.equal(billingAddress.address_line_2, 'Suite 2', country);
    }
  });

  test('PayPal Card Fields rejects missing or unrecognized country before calling PayPal', async () => {
    const mock = mockPayPalCardFlow();
    for (const country of ['', 'Atlantis', 'ZZ', 'EU', 'AN', 'XK']) {
      const body = paypalCheckoutBody();
      body.shippingAddress.country = country;
      const response = await route(makeRequest({ method: 'POST', url: '/api/paypal/create-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body }));
      assert.equal(response.status, 422);
      assert.match(JSON.parse(response.body).error, /country|shipping information/i);
    }
    assert.equal(mock.calls.length, 0);
    assert.equal(readStore().inventoryReservations.length, 0);
  });

  test('PayPal Wallet order creation retains its approval flow without card billing data', async () => {
    const mock = mockPayPalFlow({ orderId: 'PAYPAL_WALLET_ADDRESS_1' });
    const body = paypalCheckoutBody({ paymentMethod: 'paypal' });
    body.shippingAddress.country = 'US';
    const response = await route(makeRequest({ method: 'POST', url: '/api/paypal/create-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body }));
    const payload = JSON.parse(response.body);
    const request = mock.calls.find(call => call.url.endsWith('/v2/checkout/orders'));
    const orderBody = JSON.parse(request.options.body);

    assert.equal(response.status, 201);
    assert.equal(payload.data.approvalUrl, 'https://paypal.example.com/approve');
    assert.equal(orderBody.payment_source?.card, undefined);
    assert.equal(orderBody.application_context.user_action, 'PAY_NOW');
  });

  test('PayPal order rejection releases its inventory reservation without creating pending payment state', async () => {
    const mock = mockPayPalCardFlow({ createOrderHttpStatus: 400 });
    const response = await route(makeRequest({ method: 'POST', url: '/api/paypal/create-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body: paypalCheckoutBody() }));
    const store = readStore();

    assert.equal(response.status, 502);
    assert.equal(mock.calls.filter(call => call.url.endsWith('/v2/checkout/orders')).length, 1);
    assert.equal(store.inventoryReservations.length, 1);
    assert.equal(store.inventoryReservations[0].status, 'released');
    assert.equal(store.pendingPayPalOrders.length, 0);
    assert.equal(store.orders.length, 0);
    assert.equal(repository.getProduct('prod_vela').stock, 120);
  });

  test('repeated PayPal rejections do not create duplicate orders or payments', async () => {
    const mock = mockPayPalCardFlow({ createOrderHttpStatus: 400 });
    const request = () => makeRequest({ method: 'POST', url: '/api/paypal/create-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body: paypalCheckoutBody() });

    assert.equal((await route(request())).status, 502);
    assert.equal((await route(request())).status, 502);
    const store = readStore();
    assert.equal(mock.calls.filter(call => call.url.endsWith('/v2/checkout/orders')).length, 2);
    assert.equal(store.orders.length, 0);
    assert.equal(store.pendingPayPalOrders.length, 0);
    assert.equal(store.inventoryReservations.length, 2);
    assert.ok(store.inventoryReservations.every(reservation => reservation.status === 'released'));
    assert.equal(repository.getProduct('prod_vela').stock, 120);
  });

  test('PayPal Card Fields capture verifies the server-side order and finalizes payment exactly once', async () => {
    const mock = mockPayPalCardFlow();
    let emailCalls = 0;
    const restore = withMockedEmail(async () => { emailCalls += 1; return { data: { id: 'test-email' } }; });
    try {
      const create = await route(makeRequest({ method: 'POST', url: '/api/paypal/create-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body: paypalCheckoutBody() }));
      const paypalOrderId = JSON.parse(create.body).data.paypalOrderId;
      const captureRequest = () => makeRequest({ method: 'POST', url: '/api/paypal/capture-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body: { guest: true, paypalOrderId } });
      const firstCapture = await route(captureRequest());
      const replay = await route(captureRequest());
      const order = JSON.parse(firstCapture.body).data.order;

      assert.equal(firstCapture.status, 200);
      assert.equal(order.paymentStatus, 'paid');
      assert.equal(order.paymentMethod, 'card');
      assert.equal(repository.getProduct('prod_vela').stock, 119);
      assert.equal(JSON.parse(replay.body).data.order.id, order.id);
      assert.equal(mock.calls.filter(call => call.url.endsWith('/capture')).length, 1);
      assert.equal(emailCalls, 1);
    } finally {
      restore();
    }
  });

  for (const scenario of [
    { name: 'wrong PayPal order ID', options: { verifiedOrderId: 'PAYPAL_CARD_ORDER_OTHER' } },
    { name: 'unapproved PayPal order', options: { orderStatus: 'PAYER_ACTION_REQUIRED' } },
    { name: 'incorrect PayPal amount', options: { verifiedAmount: '419.99' } },
    { name: 'incorrect PayPal currency', options: { verifiedCurrency: 'EUR' } },
    { name: 'incomplete capture', options: { captureStatus: 'PENDING' } },
    { name: 'incorrect captured amount', options: { captureAmount: '419.99' } },
    { name: 'incorrect captured currency', options: { captureCurrency: 'EUR' } }
  ]) {
    test(`PayPal Card Fields rejects ${scenario.name} and releases its reservation`, async () => {
      mockPayPalCardFlow(scenario.options);
      const create = await route(makeRequest({ method: 'POST', url: '/api/paypal/create-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body: paypalCheckoutBody() }));
      const paypalOrderId = JSON.parse(create.body).data.paypalOrderId;
      const pending = repository.findPendingPayPalOrder(paypalOrderId);
      const capture = await route(makeRequest({ method: 'POST', url: '/api/paypal/capture-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body: { guest: true, paypalOrderId } }));

      assert.equal(capture.status, 402);
      assert.equal(readStore().orders.some(order => order.paypalOrderId === paypalOrderId), false);
      assert.equal(repository.getProduct('prod_vela').stock, 120);
      assert.equal(repository.getInventoryReservation(pending.reservationId).status, 'released');
    });
  }

  test('PayPal Card Fields cancellation releases reservations without creating an order', async () => {
    mockPayPalCardFlow();
    const create = await route(makeRequest({ method: 'POST', url: '/api/paypal/create-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body: paypalCheckoutBody() }));
    const paypalOrderId = JSON.parse(create.body).data.paypalOrderId;
    const pending = repository.findPendingPayPalOrder(paypalOrderId);
    const cancel = () => makeRequest({ method: 'POST', url: '/api/paypal/cancel-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body: { guest: true, paypalOrderId } });

    assert.equal((await route(cancel())).status, 200);
    assert.equal((await route(cancel())).status, 200);
    assert.equal(repository.findPendingPayPalOrder(paypalOrderId).status, 'failed');
    assert.equal(repository.getInventoryReservation(pending.reservationId).status, 'released');
    assert.equal(readStore().orders.some(order => order.paypalOrderId === paypalOrderId), false);
  });

  test('PayPal Card Fields cancellation enforces customer ownership', async () => {
    mockPayPalCardFlow();
    const owner = createReviewCustomer('card-owner@example.com', 'Card Owner');
    const other = createReviewCustomer('card-other@example.com', 'Other Buyer');
    const create = await route(reviewRequest('POST', '/api/paypal/create-order', { token: issueToken(owner), body: paypalCheckoutBody({ guest: false }) }));
    const paypalOrderId = JSON.parse(create.body).data.paypalOrderId;
    const cancelBody = { guest: false, paypalOrderId };

    assert.equal((await route(reviewRequest('POST', '/api/paypal/cancel-order', { token: issueToken(other), body: cancelBody }))).status, 403);
    assert.equal((await route(reviewRequest('POST', '/api/paypal/cancel-order', { token: issueToken(owner), body: cancelBody }))).status, 200);
  });

  test('PayPal Card Fields capture enforces customer ownership even if guest mode is forged', async () => {
    mockPayPalCardFlow();
    const owner = createReviewCustomer('card-capture-owner@example.com', 'Card Capture Owner');
    const other = createReviewCustomer('card-capture-other@example.com', 'Other Card Buyer');
    const create = await route(reviewRequest('POST', '/api/paypal/create-order', { token: issueToken(owner), body: paypalCheckoutBody({ guest: false }) }));
    const paypalOrderId = JSON.parse(create.body).data.paypalOrderId;
    const capture = await route(reviewRequest('POST', '/api/paypal/capture-order', { token: issueToken(other), body: { guest: true, paypalOrderId } }));

    assert.equal(capture.status, 403);
    assert.equal(repository.getProduct('prod_vela').stock, 120);
  });

  test('PayPal Card Fields releases the reservation when order retrieval fails before capture', async () => {
    mockPayPalCardFlow({ orderFetchFails: true });
    const create = await route(makeRequest({ method: 'POST', url: '/api/paypal/create-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body: paypalCheckoutBody() }));
    const paypalOrderId = JSON.parse(create.body).data.paypalOrderId;
    const pending = repository.findPendingPayPalOrder(paypalOrderId);
    const capture = await route(makeRequest({ method: 'POST', url: '/api/paypal/capture-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body: { guest: true, paypalOrderId } }));

    assert.equal(capture.status, 502);
    assert.equal(repository.findPendingPayPalOrder(paypalOrderId).status, 'failed');
    assert.equal(repository.getInventoryReservation(pending.reservationId).status, 'released');
    assert.equal(readStore().orders.some(order => order.paypalOrderId === paypalOrderId), false);
  });

  test('PayPal Card Fields releases its reservation after a definitive capture rejection', async () => {
    mockPayPalCardFlow({ captureHttpStatus: 422 });
    const create = await route(makeRequest({ method: 'POST', url: '/api/paypal/create-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body: paypalCheckoutBody() }));
    const paypalOrderId = JSON.parse(create.body).data.paypalOrderId;
    const pending = repository.findPendingPayPalOrder(paypalOrderId);
    const capture = await route(makeRequest({ method: 'POST', url: '/api/paypal/capture-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body: { guest: true, paypalOrderId } }));

    assert.equal(capture.status, 502);
    assert.equal(repository.findPendingPayPalOrder(paypalOrderId).status, 'failed');
    assert.equal(repository.getInventoryReservation(pending.reservationId).status, 'released');
    assert.equal(readStore().orders.some(order => order.paypalOrderId === paypalOrderId), false);
  });

  test('PayPal Card Fields reservations prevent inventory races', async () => {
    repository.updateProduct('prod_vela', { stock: 1 });
    const mock = mockPayPalCardFlow();
    const first = await route(makeRequest({ method: 'POST', url: '/api/paypal/create-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body: paypalCheckoutBody() }));
    const second = await route(makeRequest({ method: 'POST', url: '/api/paypal/create-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body: paypalCheckoutBody() }));

    assert.equal(first.status, 201);
    assert.equal(second.status, 422);
    assert.match(JSON.parse(second.body).error, /insufficient stock/i);
    assert.equal(mock.calls.filter(call => call.url.endsWith('/v2/checkout/orders')).length, 1);
    assert.equal(repository.getProduct('prod_vela').stock, 1);
  });

  test('PayPal capture rejects unauthenticated requests', async () => {
    const response = await route(makeRequest({
      method: 'POST',
      url: '/api/paypal/capture-order',
      headers: { host: 'localhost:4000', 'content-type': 'application/json' },
      body: { paypalOrderId: 'PAYPALTEST123' }
    }));

    assert.equal(response.status, 401);
    assert.match(JSON.parse(response.body).error, /Authentication required/i);
  });

  test('PayPal create order rejects an invalid product without contacting PayPal', async () => {
    const response = await route(makeRequest({
      method: 'POST',
      url: '/api/paypal/create-order',
      headers: { host: 'localhost:4000', 'content-type': 'application/json' },
      body: {
        guest: true,
        shippingAddress: { fullName: 'Test Buyer', email: 'test@example.com', phone: '2025550147', addressLine1: '1 Main St', city: 'Austin', state: 'TX', country: 'US', postalCode: '78701' },
        items: [{ productId: 'missing-product', quantity: 1 }]
      }
    }));

    assert.equal(response.status, 422);
    assert.match(JSON.parse(response.body).error, /cart has changed|review your cart/i);
  });

  test('admin notifications reject unauthenticated access', async () => {
    const response = await route(makeRequest({
      method: 'GET',
      url: '/api/admin/notifications',
      headers: { host: 'localhost:4000' }
    }));

    assert.equal(response.status, 401);
    assert.match(JSON.parse(response.body).error, /Authentication required/i);
  });

  test('Successful PayPal payment creates a paid order, a dashboard notification, and one admin email', async () => {
    resetMarketplaceData();
    mockPayPalFlow({ orderId: 'PAYPAL_ORDER_SUCCESS_1' });
    const adminUser = createAdminUser();
    const authHeader = { host: 'localhost:4000', authorization: `Bearer ${issueToken(adminUser)}` };
    let emailCalls = 0;
    const restore = withMockedEmail(async order => {
      emailCalls += 1;
      return { data: { id: `email_${order.id}` } };
    });

    try {
      const createResponse = await route(makeRequest({
        method: 'POST',
        url: '/api/paypal/create-order',
        headers: { host: 'localhost:4000', 'content-type': 'application/json' },
        body: {
          guest: true,
          shippingAddress: { fullName: 'Nia Carter', email: 'nia@example.com', phone: '2025551234', addressLine1: '10 Main St', city: 'Austin', state: 'TX', country: 'US', postalCode: '78701' },
          items: [{ productId: 'prod_vela', quantity: 1 }]
        }
      }));

      assert.equal(createResponse.status, 201);
      const paypalOrderId = JSON.parse(createResponse.body).data.paypalOrderId;
      assert.equal(paypalOrderId, 'PAYPAL_ORDER_SUCCESS_1');

      const captureResponse = await route(makeRequest({
        method: 'POST',
        url: '/api/paypal/capture-order',
        headers: { host: 'localhost:4000', 'content-type': 'application/json' },
        body: { guest: true, paypalOrderId }
      }));

      assert.equal(captureResponse.status, 200);
      const { order } = JSON.parse(captureResponse.body).data;
      assert.equal(order.paymentStatus, 'paid');
      assert.equal(order.totalAmount, 42000);
      assert.equal(emailCalls, 1);
      assert.equal(repository.getProduct('prod_vela').stock, 119);

      const sentEmails = orderNotificationService.listNotifications().filter(entry => entry.type === 'paid_order_admin_email' && entry.status === 'sent');
      assert.equal(sentEmails.length, 1);
      assert.equal(sentEmails[0].orderId, order.id);

      const notifications = await route(makeRequest({ method: 'GET', url: '/api/admin/notifications', headers: authHeader }));
      const adminLog = JSON.parse(notifications.body).data;
      assert.ok(adminLog.some(entry => entry.type === 'new_order'));
    } finally {
      restore();
    }
  });

  test('Same PayPal order processed twice only triggers one successful email', async () => {
    resetMarketplaceData();
    mockPayPalFlow({ orderId: 'PAYPAL_ORDER_DUPLICATE_1' });
    let emailCalls = 0;
    const restore = withMockedEmail(async () => {
      emailCalls += 1;
      return { data: { id: 'duplicate-email' } };
    });

    try {
      const firstCapture = await route(makeRequest({
        method: 'POST',
        url: '/api/paypal/create-order',
        headers: { host: 'localhost:4000', 'content-type': 'application/json' },
        body: {
          guest: true,
          shippingAddress: { fullName: 'Same Buyer', email: 'same@example.com', phone: '2025554321', addressLine1: '20 Lake Rd', city: 'Austin', state: 'TX', country: 'US', postalCode: '78702' },
          items: [{ productId: 'prod_vela', quantity: 1 }]
        }
      }));
      assert.equal(firstCapture.status, 201);
      const paypalOrderId = JSON.parse(firstCapture.body).data.paypalOrderId;
      assert.equal(paypalOrderId, 'PAYPAL_ORDER_DUPLICATE_1');

      const payment = await route(makeRequest({
        method: 'POST',
        url: '/api/paypal/capture-order',
        headers: { host: 'localhost:4000', 'content-type': 'application/json' },
        body: { guest: true, paypalOrderId }
      }));
      assert.equal(payment.status, 200);
      const orderId = JSON.parse(payment.body).data.order.id;

      const duplicate = await route(makeRequest({
        method: 'POST',
        url: '/api/paypal/capture-order',
        headers: { host: 'localhost:4000', 'content-type': 'application/json' },
        body: { guest: true, paypalOrderId }
      }));
      assert.equal(duplicate.status, 200);
      assert.equal(JSON.parse(duplicate.body).data.order.id, orderId);
      assert.equal(emailCalls, 1);
      assert.equal(repository.getProduct('prod_vela').stock, 119);
    } finally {
      restore();
    }
  });

  test('PayPal payment fails without sending a paid-order email', async () => {
    resetMarketplaceData();
    mockPayPalFlow({ orderId: 'PAYPAL_ORDER_FAIL_1', captureStatus: 'FAILED' });
    let emailCalls = 0;
    const restore = withMockedEmail(async () => {
      emailCalls += 1;
      return { data: { id: 'failed-email' } };
    });

    try {
      const createResponse = await route(makeRequest({
        method: 'POST',
        url: '/api/paypal/create-order',
        headers: { host: 'localhost:4000', 'content-type': 'application/json' },
        body: {
          guest: true,
          shippingAddress: { fullName: 'No Pay', email: 'nopay@example.com', phone: '2025550101', addressLine1: '12 Fail St', city: 'Austin', state: 'TX', country: 'US', postalCode: '78703' },
          items: [{ productId: 'prod_vela', quantity: 1 }]
        }
      }));
      assert.equal(createResponse.status, 201);
      const paypalOrderId = JSON.parse(createResponse.body).data.paypalOrderId;
      assert.equal(paypalOrderId, 'PAYPAL_ORDER_FAIL_1');

      const captureResponse = await route(makeRequest({
        method: 'POST',
        url: '/api/paypal/capture-order',
        headers: { host: 'localhost:4000', 'content-type': 'application/json' },
        body: { guest: true, paypalOrderId }
      }));

      assert.equal(captureResponse.status, 402);
      assert.equal(emailCalls, 0);
      assert.equal(readStore().orders.filter(order => order.paypalOrderId === paypalOrderId).length, 0);
      assert.equal(repository.getProduct('prod_vela').stock, 120);
    } finally {
      restore();
    }
  });

  test('Payment verification failure prevents a paid-order email', async () => {
    resetMarketplaceData();
    mockPayPalFlow({ orderId: 'PAYPAL_ORDER_VERIFY_FAIL_1', verificationFailed: true });
    let emailCalls = 0;
    const restore = withMockedEmail(async () => {
      emailCalls += 1;
      return { data: { id: 'verification-email' } };
    });

    try {
      const createResponse = await route(makeRequest({
        method: 'POST',
        url: '/api/paypal/create-order',
        headers: { host: 'localhost:4000', 'content-type': 'application/json' },
        body: {
          guest: true,
          shippingAddress: { fullName: 'Bad Verify', email: 'badverify@example.com', phone: '2025550102', addressLine1: '13 Failed St', city: 'Austin', state: 'TX', country: 'US', postalCode: '78704' },
          items: [{ productId: 'prod_vela', quantity: 1 }]
        }
      }));
      assert.equal(createResponse.status, 201);
      const paypalOrderId = JSON.parse(createResponse.body).data.paypalOrderId;
      assert.equal(paypalOrderId, 'PAYPAL_ORDER_VERIFY_FAIL_1');

      const captureResponse = await route(makeRequest({
        method: 'POST',
        url: '/api/paypal/capture-order',
        headers: { host: 'localhost:4000', 'content-type': 'application/json' },
        body: { guest: true, paypalOrderId }
      }));

      assert.equal(captureResponse.status, 402);
      assert.equal(emailCalls, 0);
      assert.equal(repository.getProduct('prod_vela').stock, 120);
    } finally {
      restore();
    }
  });

  test('Email provider failure keeps the order paid and records a retryable failure', async () => {
    resetMarketplaceData();
    mockPayPalFlow({ orderId: 'PAYPAL_ORDER_EMAIL_FAIL_1' });
    const restore = withMockedEmail(async () => {
      throw new Error('Resend unavailable');
    });

    try {
      const createResponse = await route(makeRequest({
        method: 'POST',
        url: '/api/paypal/create-order',
        headers: { host: 'localhost:4000', 'content-type': 'application/json' },
        body: {
          guest: true,
          shippingAddress: { fullName: 'Failure Buyer', email: 'failure@example.com', phone: '2025550103', addressLine1: '14 Error Dr', city: 'Austin', state: 'TX', country: 'US', postalCode: '78705' },
          items: [{ productId: 'prod_vela', quantity: 1 }]
        }
      }));
      assert.equal(createResponse.status, 201);
      const paypalOrderId = JSON.parse(createResponse.body).data.paypalOrderId;
      assert.equal(paypalOrderId, 'PAYPAL_ORDER_EMAIL_FAIL_1');

      const captureResponse = await route(makeRequest({
        method: 'POST',
        url: '/api/paypal/capture-order',
        headers: { host: 'localhost:4000', 'content-type': 'application/json' },
        body: { guest: true, paypalOrderId }
      }));

      assert.equal(captureResponse.status, 200);
      const data = JSON.parse(captureResponse.body).data;
      assert.equal(data.order.paymentStatus, 'paid');
      const failureRecord = listNotifications().find(entry => entry.type === 'paid_order_admin_email' && entry.status === 'failed');
      assert.ok(failureRecord);
      assert.ok(failureRecord.retryAvailable === true || failureRecord.error);
    } finally {
      restore();
    }
  });

  test('Existing $420 and $150 PayPal orders remain unchanged', async () => {
    resetMarketplaceData();
    ensureLegacyPayPalOrders();
    const store = readStore();
    const first = store.orders.find(order => order.totalAmount === 42000 && order.paymentProvider === 'paypal');
    const second = store.orders.find(order => order.totalAmount === 15000 && order.paymentProvider === 'paypal');

    assert.ok(first);
    assert.ok(second);
    assert.equal(first.paypalCaptureId, '3HY75144RR6437611');
    assert.equal(second.paypalCaptureId, '8LH60836VC4980144');
  });

  test('Admin dashboard notifications remain active after a paid order', async () => {
    resetMarketplaceData();
    mockPayPalFlow({ orderId: 'PAYPAL_ORDER_DASHBOARD_1' });
    const adminUser = createAdminUser();
    const authHeader = { host: 'localhost:4000', authorization: `Bearer ${issueToken(adminUser)}` };
    const restore = withMockedEmail(async () => ({ data: { id: 'dashboard-email' } }));

    try {
      const createResponse = await route(makeRequest({
        method: 'POST',
        url: '/api/paypal/create-order',
        headers: { host: 'localhost:4000', 'content-type': 'application/json' },
        body: {
          guest: true,
          shippingAddress: { fullName: 'Admin Test', email: 'admintest@example.com', phone: '2025550104', addressLine1: '15 Dashboard St', city: 'Austin', state: 'TX', country: 'US', postalCode: '78706' },
          items: [{ productId: 'prod_kanso', quantity: 1 }]
        }
      }));
      const paypalOrderId = JSON.parse(createResponse.body).data.paypalOrderId;

      await route(makeRequest({
        method: 'POST',
        url: '/api/paypal/capture-order',
        headers: { host: 'localhost:4000', 'content-type': 'application/json' },
        body: { guest: true, paypalOrderId }
      }));

      const response = await route(makeRequest({ method: 'GET', url: '/api/admin/notifications', headers: authHeader }));
      const payload = JSON.parse(response.body);
      assert.equal(response.status, 200);
      assert.ok(Array.isArray(payload.data));
      assert.equal(typeof payload.unreadCount, 'number');
      assert.ok(payload.unreadCount >= 0);
    } finally {
      restore();
    }
  });

  test('Customers can only view their own orders and not another customer order', async () => {
    resetMarketplaceData();
    const firstCustomer = createUser({
      email: 'alice@example.com',
      name: 'Alice',
      role: 'customer',
      passwordHash: hashPassword('StrongPassword123!')
    });

    const secondCustomer = createUser({
      email: 'bob@example.com',
      name: 'Bob',
      role: 'customer',
      passwordHash: hashPassword('StrongPassword123!')
    });

    const orderForAlice = createOrder({
      buyerId: firstCustomer.id,
      items: [{ productId: 'prod_vela', quantity: 1, unitPrice: 42000, name: 'Vela sculptural table lamp' }],
      shippingAddress: { fullName: 'Alice Example', email: 'alice@example.com', phone: '2025550001', addressLine1: '1 Alice St', city: 'Austin', state: 'TX', country: 'US', postalCode: '78701' },
      currency: 'USD',
      totalAmount: 42000,
      paymentStatus: 'paid',
      status: 'shipped',
      shippingCarrier: 'DHL',
      trackingNumber: 'DHL123',
      trackingUrl: 'https://track.example/DHL123'
    });

    const orderForBob = createOrder({
      buyerId: secondCustomer.id,
      items: [{ productId: 'prod_kanso', quantity: 1, unitPrice: 18500, name: 'Kanso travel case' }],
      shippingAddress: { fullName: 'Bob Example', email: 'bob@example.com', phone: '2025550002', addressLine1: '2 Bob St', city: 'Austin', state: 'TX', country: 'US', postalCode: '78702' },
      currency: 'USD',
      totalAmount: 18500,
      paymentStatus: 'paid',
      status: 'processing'
    });

    const ownListResponse = await route(makeRequest({
      method: 'GET',
      url: '/api/orders',
      headers: { host: 'localhost:4000', authorization: `Bearer ${issueToken(firstCustomer)}` }
    }));

    assert.equal(ownListResponse.status, 200);
    const ownList = JSON.parse(ownListResponse.body).data;
    assert.equal(ownList.length, 1);
    assert.equal(ownList[0].id, orderForAlice.id);

    const blockedOrderResponse = await route(makeRequest({
      method: 'GET',
      url: `/api/orders/${orderForBob.id}`,
      headers: { host: 'localhost:4000', authorization: `Bearer ${issueToken(firstCustomer)}` }
    }));

    assert.equal(blockedOrderResponse.status, 403);
  });

  test('Legacy order without buyerId is visible only to matching customer email without changing stored order', async () => {
    resetMarketplaceData();
    const kelvin = createUser({
      email: 'bwoycavy05@gmail.com',
      name: 'Kelvin Shirima',
      role: 'customer',
      passwordHash: hashPassword('StrongPassword123!')
    });
    const admin = createAdminUser();
    const otherCustomer = createUser({
      email: 'other@example.com',
      name: 'Other Customer',
      role: 'customer',
      passwordHash: hashPassword('StrongPassword123!')
    });
    const legacyOrder = createOrder({
      id: 'ord_4231a529-da1f-49f3-ad1b-ef7915fe37bf',
      buyerId: null,
      items: [{ productId: 'prod_vela', quantity: 1, unitPrice: 10000 }],
      shippingAddress: { fullName: 'Kelvin Shirima', email: ' BWoyCavy05@gmail.com ', phone: '2025550100', addressLine1: '1 Market St', city: 'Austin', state: 'TX', country: 'US', postalCode: '78701' },
      currency: 'USD',
      totalAmount: 10000,
      paymentProvider: 'paypal',
      paymentStatus: 'paid',
      paypalOrderId: 'LEGACY_PAYPAL_ORDER_100',
      paypalCaptureId: 'LEGACY_CAPTURE_100'
    });

    const kelvinAuth = { host: 'localhost:4000', authorization: `Bearer ${issueToken(kelvin)}` };
    const otherAuth = { host: 'localhost:4000', authorization: `Bearer ${issueToken(otherCustomer)}` };
    const listResponse = await route(makeRequest({ method: 'GET', url: '/api/orders', headers: kelvinAuth }));
    assert.equal(listResponse.status, 200);
    assert.deepEqual(JSON.parse(listResponse.body).data.map(order => order.id), [legacyOrder.id]);

    const detailResponse = await route(makeRequest({ method: 'GET', url: `/api/orders/${legacyOrder.id}`, headers: kelvinAuth }));
    assert.equal(detailResponse.status, 200);
    assert.equal(JSON.parse(detailResponse.body).data.trackingNumber, undefined);

    const deniedResponse = await route(makeRequest({ method: 'GET', url: `/api/orders/${legacyOrder.id}`, headers: otherAuth }));
    assert.equal(deniedResponse.status, 403);

    const adminListResponse = await route(makeRequest({
      method: 'GET',
      url: '/api/orders',
      headers: { host: 'localhost:4000', authorization: `Bearer ${issueToken(admin)}` }
    }));
    assert.ok(JSON.parse(adminListResponse.body).data.some(order => order.id === legacyOrder.id));

    const unchangedOrder = readStore().orders.find(order => order.id === legacyOrder.id);
    assert.equal(unchangedOrder.buyerId, null);
    assert.equal(unchangedOrder.paypalCaptureId, 'LEGACY_CAPTURE_100');
    assert.equal(unchangedOrder.totalAmount, 10000);
  });

  test('Authenticated PayPal orders retain the customer account ID through capture', async () => {
    resetMarketplaceData();
    const customer = createUser({
      email: 'paypal.customer@example.com',
      name: 'PayPal Customer',
      role: 'customer',
      passwordHash: hashPassword('StrongPassword123!')
    });
    mockPayPalFlow({ orderId: 'PAYPAL_AUTHENTICATED_ORDER_1' });
    const restore = withMockedEmail(async () => ({ id: 'authenticated-order-email' }));
    const authHeader = { host: 'localhost:4000', authorization: `Bearer ${issueToken(customer)}`, 'content-type': 'application/json' };

    try {
      const createResponse = await route(makeRequest({
        method: 'POST',
        url: '/api/paypal/create-order',
        headers: authHeader,
        body: {
          shippingAddress: { fullName: 'PayPal Customer', email: 'paypal.customer@example.com', phone: '2025550101', addressLine1: '2 Main St', city: 'Austin', state: 'TX', country: 'US', postalCode: '78702' },
          items: [{ productId: 'prod_vela', quantity: 1 }]
        }
      }));
      assert.equal(createResponse.status, 201);
      const paypalOrderId = JSON.parse(createResponse.body).data.paypalOrderId;

      const captureResponse = await route(makeRequest({
        method: 'POST',
        url: '/api/paypal/capture-order',
        headers: authHeader,
        body: { paypalOrderId }
      }));
      assert.equal(captureResponse.status, 200);
      const order = JSON.parse(captureResponse.body).data.order;
      assert.equal(order.buyerId, customer.id);

      const listResponse = await route(makeRequest({ method: 'GET', url: '/api/orders', headers: authHeader }));
      assert.equal(JSON.parse(listResponse.body).data[0].id, order.id);
    } finally {
      restore();
    }
  });

  test('Admin shipment update records tracking data and sends a customer tracking email', async () => {
    resetMarketplaceData();
    const adminUser = createAdminUser();
    const customer = createUser({
      email: 'charlie@example.com',
      name: 'Charlie',
      role: 'customer',
      passwordHash: hashPassword('StrongPassword123!')
    });

    const order = createOrder({
      buyerId: customer.id,
      items: [{ productId: 'prod_forma', quantity: 1, unitPrice: 89000, name: 'Forma lounge chair' }],
      shippingAddress: { fullName: 'Charlie Example', email: 'charlie@example.com', phone: '2025550003', addressLine1: '3 Charlie St', city: 'Austin', state: 'TX', country: 'US', postalCode: '78703' },
      currency: 'USD',
      totalAmount: 89000,
      paymentStatus: 'paid',
      status: 'processing'
    });

    let emailCalls = 0;
    const originalTrackingEmail = emailService.sendCustomerTrackingEmail;
    emailService.sendCustomerTrackingEmail = async () => {
      emailCalls += 1;
      return { id: 'tracking_email_1', status: 'sent' };
    };

    try {
      const response = await route(makeRequest({
        method: 'PATCH',
        url: `/api/admin/orders/${order.id}`,
        headers: { host: 'localhost:4000', authorization: `Bearer ${issueToken(adminUser)}`, 'content-type': 'application/json' },
        body: {
          status: 'shipped',
          shippingStatus: 'shipped',
          shippingCarrier: 'UPS',
          trackingNumber: '1ZUPS123',
          trackingUrl: 'https://www.ups.com/track?loc=en_US&tracknum=1ZUPS123',
          estimatedDeliveryDate: '2026-10-04'
        }
      }));

      assert.equal(response.status, 200);
      const payload = JSON.parse(response.body).data;
      assert.equal(payload.status, 'shipped');
      assert.equal(payload.shippingCarrier, 'UPS');
      assert.equal(payload.trackingNumber, '1ZUPS123');
      assert.equal(payload.trackingUrl, 'https://www.ups.com/track?loc=en_US&tracknum=1ZUPS123');
      assert.equal(payload.shippingStatus, 'shipped');
      assert.equal(payload.estimatedDeliveryDate, '2026-10-04');
      assert.equal(emailCalls, 1);

      const adminRead = await route(makeRequest({
        method: 'GET',
        url: `/api/admin/orders/${order.id}`,
        headers: { host: 'localhost:4000', authorization: `Bearer ${issueToken(adminUser)}` }
      }));
      assert.equal(JSON.parse(adminRead.body).data.trackingNumber, '1ZUPS123');
      assert.equal(JSON.parse(adminRead.body).data.estimatedDeliveryDate, '2026-10-04');

      const customerRead = await route(makeRequest({
        method: 'GET',
        url: `/api/orders/${order.id}`,
        headers: { host: 'localhost:4000', authorization: `Bearer ${issueToken(customer)}` }
      }));
      assert.equal(customerRead.status, 200);
      const customerOrder = JSON.parse(customerRead.body).data;
      assert.equal(customerOrder.shippingCarrier, 'UPS');
      assert.equal(customerOrder.trackingNumber, '1ZUPS123');
      assert.equal(customerOrder.trackingUrl, 'https://www.ups.com/track?loc=en_US&tracknum=1ZUPS123');
      assert.equal(customerOrder.shippingStatus, 'shipped');
      assert.equal(customerOrder.estimatedDeliveryDate, '2026-10-04');
    } finally {
      emailService.sendCustomerTrackingEmail = originalTrackingEmail;
    }
  });

  test('Admin shipment update rejects invalid tracking URL without changing order', async () => {
    resetMarketplaceData();
    const adminUser = createAdminUser();
    const order = createOrder({
      buyerId: null,
      items: [{ productId: 'prod_vela', quantity: 1, unitPrice: 42000 }],
      shippingAddress: { fullName: 'Guest Buyer', email: 'guest@example.com' },
      currency: 'USD',
      totalAmount: 42000,
      paymentStatus: 'paid',
      status: 'processing'
    });

    const response = await route(makeRequest({
      method: 'PATCH',
      url: `/api/admin/orders/${order.id}`,
      headers: { host: 'localhost:4000', authorization: `Bearer ${issueToken(adminUser)}`, 'content-type': 'application/json' },
      body: { shippingStatus: 'processing', trackingUrl: 'javascript:alert(1)' }
    }));

    assert.equal(response.status, 422);
    assert.match(JSON.parse(response.body).error, /valid HTTPS URL/i);
    const unchanged = readStore().orders.find(entry => entry.id === order.id);
    assert.equal(unchanged.trackingUrl, undefined);
    assert.equal(unchanged.status, 'processing');
  });

  test('Admin can save a pre-shipment status without tracking number or URL', async () => {
    resetMarketplaceData();
    const adminUser = createAdminUser();
    const order = createOrder({
      buyerId: null,
      items: [{ productId: 'prod_vela', quantity: 1, unitPrice: 42000 }],
      shippingAddress: { fullName: 'Guest Buyer', email: '' },
      currency: 'USD',
      totalAmount: 42000,
      paymentStatus: 'paid',
      status: 'placed'
    });

    const response = await route(makeRequest({
      method: 'PATCH',
      url: `/api/admin/orders/${order.id}`,
      headers: { host: 'localhost:4000', authorization: `Bearer ${issueToken(adminUser)}`, 'content-type': 'application/json' },
      body: { status: 'processing', shippingStatus: 'processing', trackingUrl: '' }
    }));

    assert.equal(response.status, 200);
    const saved = JSON.parse(response.body).data;
    assert.equal(saved.status, 'processing');
    assert.equal(saved.shippingStatus, 'processing');
    assert.equal(saved.trackingNumber, undefined);
    assert.equal(saved.trackingUrl, '');
  });

  test('Products have safe inventory defaults and admins alone can change stock and threshold', async () => {
    resetMarketplaceData();
    const product = repository.getProduct('prod_vela');
    assert.equal(product.stock, 120);
    assert.equal(product.lowStockThreshold, 5);

    const unauthenticated = await route(makeRequest({ method: 'PATCH', url: '/api/admin/products/prod_vela', body: { stock: 10 } }));
    assert.equal(unauthenticated.status, 401);

    const customer = createUser({ email: 'stock.customer@example.com', name: 'Stock Customer', role: 'customer', passwordHash: hashPassword('StrongPassword123!') });
    const forbidden = await route(makeRequest({
      method: 'PATCH', url: '/api/admin/products/prod_vela',
      headers: { host: 'localhost:4000', authorization: `Bearer ${issueToken(customer)}`, 'content-type': 'application/json' },
      body: { stock: 10 }
    }));
    assert.equal(forbidden.status, 403);

    const admin = createAdminUser();
    const adminHeaders = { host: 'localhost:4000', authorization: `Bearer ${issueToken(admin)}`, 'content-type': 'application/json' };
    const negative = await route(makeRequest({ method: 'PATCH', url: '/api/admin/products/prod_vela', headers: adminHeaders, body: { stock: -1 } }));
    assert.equal(negative.status, 422);
    const updated = await route(makeRequest({ method: 'PATCH', url: '/api/admin/products/prod_vela', headers: adminHeaders, body: { stock: 8, lowStockThreshold: 3 } }));
    assert.equal(updated.status, 200);
    assert.equal(JSON.parse(updated.body).data.stock, 8);
    assert.equal(JSON.parse(updated.body).data.lowStockThreshold, 3);
  });

  test('Checkout rejects quantities beyond available stock and inactive products', async () => {
    resetMarketplaceData();
    repository.updateProduct('prod_vela', { stock: 2 });
    const shippingAddress = { fullName: 'Stock Buyer', email: 'stock@example.com', phone: '2025550100', addressLine1: '1 Main St', city: 'Austin', state: 'TX', country: 'US', postalCode: '78701' };
    const tooMany = await route(makeRequest({
      method: 'POST', url: '/api/paypal/create-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' },
      body: { guest: true, shippingAddress, items: [{ productId: 'prod_vela', quantity: 3 }] }
    }));
    assert.equal(tooMany.status, 422);
    assert.match(JSON.parse(tooMany.body).error, /Insufficient stock for Vela sculptural table lamp\. Only 2 available\./);

    repository.updateProduct('prod_vela', { status: 'inactive' });
    const inactive = await route(makeRequest({
      method: 'POST', url: '/api/paypal/create-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' },
      body: { guest: true, shippingAddress, items: [{ productId: 'prod_vela', quantity: 1 }] }
    }));
    assert.equal(inactive.status, 422);
    assert.match(JSON.parse(inactive.body).error, /not currently available/i);
  });

  test('Reservations prevent overselling and duplicate PayPal capture decrements only once', async () => {
    resetMarketplaceData();
    repository.updateProduct('prod_vela', { stock: 2 });
    mockPayPalFlow({ orderId: 'PAYPAL_INVENTORY_RESERVATION_1', captureAmount: '840.00' });
    const restore = withMockedEmail(async () => ({ id: 'inventory-paid-email' }));
    const address = { fullName: 'Inventory Buyer', email: 'inventory@example.com', phone: '2025550101', addressLine1: '2 Main St', city: 'Austin', state: 'TX', country: 'US', postalCode: '78702' };

    try {
      const first = await route(makeRequest({ method: 'POST', url: '/api/paypal/create-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body: { guest: true, shippingAddress: address, items: [{ productId: 'prod_vela', quantity: 2 }] } }));
      assert.equal(first.status, 201);
      const firstData = JSON.parse(first.body).data;
      assert.equal(firstData.reservationId.startsWith('inv_'), true);
      assert.equal(repository.getProduct('prod_vela').availableStock, 0);

      const second = await route(makeRequest({ method: 'POST', url: '/api/paypal/create-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body: { guest: true, shippingAddress: address, items: [{ productId: 'prod_vela', quantity: 1 }] } }));
      assert.equal(second.status, 422);
      assert.match(JSON.parse(second.body).error, /Only 0 available/);

      const capture = await route(makeRequest({ method: 'POST', url: '/api/paypal/capture-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body: { guest: true, paypalOrderId: firstData.paypalOrderId } }));
      assert.equal(capture.status, 200);
      assert.equal(repository.getProduct('prod_vela').stock, 0);
      const duplicate = await route(makeRequest({ method: 'POST', url: '/api/paypal/capture-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body: { guest: true, paypalOrderId: firstData.paypalOrderId } }));
      assert.equal(duplicate.status, 200);
      assert.equal(repository.getProduct('prod_vela').stock, 0);
      assert.equal(readStore().orders.filter(order => order.paypalOrderId === firstData.paypalOrderId).length, 1);
    } finally {
      restore();
    }
  });

  test('Cancelled checkout releases its reservation without reducing physical stock', async () => {
    resetMarketplaceData();
    repository.updateProduct('prod_vela', { stock: 2 });
    mockPayPalFlow({ orderId: 'PAYPAL_INVENTORY_CANCEL_1' });
    const address = { fullName: 'Cancel Buyer', email: 'cancel@example.com', phone: '2025550102', addressLine1: '3 Main St', city: 'Austin', state: 'TX', country: 'US', postalCode: '78703' };
    const response = await route(makeRequest({ method: 'POST', url: '/api/paypal/create-order', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body: { guest: true, shippingAddress: address, items: [{ productId: 'prod_vela', quantity: 2 }] } }));
    const { reservationId } = JSON.parse(response.body).data;
    assert.equal(repository.getProduct('prod_vela').stock, 2);
    assert.equal(repository.getProduct('prod_vela').availableStock, 0);

    const released = await route(makeRequest({ method: 'POST', url: '/api/checkout/release-reservation', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, body: { reservationId } }));
    assert.equal(released.status, 200);
    assert.equal(repository.getProduct('prod_vela').stock, 2);
    assert.equal(repository.getProduct('prod_vela').availableStock, 2);
    assert.equal(readStore().orders.length, 0);
  });

  test('Verified Stripe session consumes inventory once and duplicate finalization is idempotent', async () => {
    resetMarketplaceData();
    const customer = createUser({ email: 'stripe.stock@example.com', name: 'Stripe Stock', role: 'customer', passwordHash: hashPassword('StrongPassword123!') });
    const reservationId = 'inv_99999999-9999-4999-8999-999999999999';
    const reservation = repository.reserveInventory(reservationId, [{ productId: 'prod_vela', quantity: 2 }], { provider: 'stripe' });
    assert.equal(reservation.ok, true);
    const restore = withMockedEmail(async () => ({ id: 'stripe-stock-email' }));
    const session = {
      id: 'cs_test_inventory_1',
      payment_status: 'paid',
      currency: 'usd',
      amount_total: 84000,
      payment_intent: 'pi_inventory_1',
      customer_details: { email: customer.email },
      metadata: { userId: customer.id, cartItems: JSON.stringify([{ productId: 'prod_vela', quantity: 2 }]), inventoryReservationId: reservationId }
    };

    try {
      const order = await verifiedOrderFromSession(session);
      assert.equal(order.paymentStatus, 'paid');
      assert.equal(order.buyerId, customer.id);
      assert.equal(repository.getProduct('prod_vela').stock, 118);
      const duplicate = await verifiedOrderFromSession(session);
      assert.equal(duplicate.id, order.id);
      assert.equal(repository.getProduct('prod_vela').stock, 118);
      assert.equal(readStore().orders.filter(entry => entry.stripeSessionId === session.id).length, 1);
    } finally {
      restore();
    }
  });

  test('Low-stock notifications fire on threshold crossings only', () => {
    resetMarketplaceData();
    repository.updateProduct('prod_vela', { lowStockThreshold: 2, stock: 2 });
    repository.updateProduct('prod_vela', { stock: 1 });
    repository.updateProduct('prod_vela', { stock: 0 });
    repository.updateProduct('prod_vela', { stock: 0 });
    const notifications = listNotifications().filter(entry => entry.productId === 'prod_vela');
    assert.equal(notifications.filter(entry => entry.type === 'low_stock').length, 1);
    assert.equal(notifications.filter(entry => entry.type === 'out_of_stock').length, 1);
  });
});
