const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mappedRows, stableId, normalizeJsonStore, backupJsonSource, shipmentsFromStore } = require('../server/db/import-json');

const source = {
  users: [{ id: 'usr_existing', email: 'person@example.test' }],
  suppliers: [{ id: 'sup_existing', ownerId: 'usr_existing' }],
  products: [{ id: 'prod_existing', supplierId: 'sup_existing', stock: 12 }],
  orders: [{ id: 'ord_existing', buyerId: 'usr_existing', totalAmount: 2500, paypalOrderId: 'PAY-existing', items: [{ productId: 'prod_existing', quantity: 2 }] }],
  inventoryReservations: [{ id: 'res_existing', items: [{ productId: 'prod_existing', quantity: 3 }] }],
  pendingPayPalOrders: [{ id: 'ppp_existing', buyerId: 'usr_existing', reservationId: 'res_existing' }],
  reviews: [{ id: 'rev_existing', authorId: 'usr_existing', productId: 'prod_existing', rating: 5 }],
  addresses: [{ id: 'adr_existing', customerId: 'usr_existing' }],
  wishlist: [{ customerId: 'usr_existing', productId: 'prod_existing' }],
  sessions: [{ tokenHash: 'token_hash_existing', userId: 'usr_existing', expiresAt: '2030-01-01' }],
  notifications: [{ id: 'ntf_existing', userId: 'usr_existing' }],
  customCollection: [{ id: 'custom_existing', nested: { retained: true } }]
};

test('JSON source normalization preserves all collections and row mapping rejects malformed collections', () => {
  assert.equal(normalizeJsonStore(source), source);
  assert.throws(() => mappedRows({ users: {} }), /must be an array/);
});

test('mapping preserves source IDs and creates stable IDs for derived records', () => {
  const first = mappedRows(source);
  const second = mappedRows(source);
  assert.deepEqual(first.map(row => [row.collection, row.sourceKey, row.id, row.table]), second.map(row => [row.collection, row.sourceKey, row.id, row.table]));
  assert.equal(first.find(row => row.collection === 'users').id, 'usr_existing');
  assert.equal(first.find(row => row.collection === 'orders:payments').value.orderId, 'ord_existing');
  assert.equal(first.find(row => row.collection === 'orders:shipments'), undefined);
  assert.equal(first.find(row => row.collection === 'wishlist').id, stableId('wishlist', 'usr_existing:prod_existing'));
  assert.deepEqual(first.find(row => row.collection === 'inventoryReservations').value.items, source.inventoryReservations[0].items);
});

test('derived payment and shipment imports preserve provider and tracking identifiers', () => {
  const rows = mappedRows({
    orders: [{ id: 'ord_tracking', paypalOrderId: 'PAY-123', paypalCaptureId: 'CAP-456', shippingCarrier: 'DHL', trackingNumber: 'TRACK-789', totalAmount: 8400 }]
  });
  const payment = rows.find(row => row.collection === 'orders:payments');
  const shipment = rows.find(row => row.collection === 'orders:shipments');
  assert.equal(payment.value.providerOrderId, 'PAY-123');
  assert.equal(payment.value.providerCaptureId, 'CAP-456');
  assert.equal(shipment.value.trackingNumber, 'TRACK-789');
});

test('Stripe payment-intent-only orders still produce a payment row', () => {
  const rows = mappedRows({ orders: [{ id: 'ord_stripe_intent', stripePaymentIntentId: 'pi_existing', totalAmount: 3100 }] });
  const payment = rows.find(row => row.collection === 'orders:payments');
  assert.equal(payment.value.provider, 'stripe');
  assert.equal(payment.value.providerCaptureId, 'pi_existing');
});

test('order tracking updates synchronize into the existing shipment identity', () => {
  const shipments = shipmentsFromStore({
    shipments: [{ id: 'shipment_existing', orderId: 'ord_tracking', carrier: 'Old Carrier', trackingNumber: 'OLD' }],
    orders: [{ id: 'ord_tracking', shippingCarrier: 'New Carrier', trackingNumber: 'NEW', shippingStatus: 'in_transit' }]
  });
  assert.equal(shipments.length, 1);
  assert.equal(shipments[0].id, 'shipment_existing');
  assert.equal(shipments[0].value.trackingNumber, 'NEW');
  assert.equal(shipments[0].value.status, 'in_transit');
});

test('source backup is exclusive, owner-only, and leaves the JSON source unchanged', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lexora-source-backup-'));
  const sourcePath = path.join(directory, 'dev.json');
  const original = JSON.stringify({ users: [{ id: 'usr_preserved' }] });
  fs.writeFileSync(sourcePath, original);
  try {
    const firstBackup = backupJsonSource(sourcePath);
    const secondBackup = backupJsonSource(sourcePath);
    assert.notEqual(firstBackup, secondBackup);
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), original);
    assert.equal(fs.readFileSync(firstBackup, 'utf8'), original);
    assert.equal(fs.statSync(firstBackup).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
