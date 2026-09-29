const test = require('node:test');
const assert = require('node:assert/strict');
const tracking = require('../order-tracking');

test('tracking links require a valid HTTPS URL', () => {
  assert.equal(tracking.normalizeTrackingUrl('https://carrier.example/track?id=123'), 'https://carrier.example/track?id=123');
  assert.equal(tracking.normalizeTrackingUrl('javascript:alert(1)'), '');
  assert.equal(tracking.normalizeTrackingUrl('http://carrier.example/track'), '');
  assert.equal(tracking.normalizeTrackingUrl('not a url'), '');
  assert.equal(tracking.normalizeTrackingUrl(''), '');
});

test('paid pending order shows confirmation without inventing shipment progress', () => {
  const timeline = tracking.buildTimeline({ status: 'placed', paymentStatus: 'paid', createdAt: '2026-09-27T12:00:00.000Z' });
  assert.equal(timeline.length, 6);
  assert.deepEqual(timeline.filter(stage => stage.complete).map(stage => stage.id), ['placed', 'confirmed']);
  assert.equal(timeline[0].label, 'Pending');
  assert.equal(timeline[1].label, 'Confirmed');
  assert.equal(timeline[0].occurredAt, '2026-09-27T12:00:00.000Z');
  assert.equal(timeline[2].occurredAt, null);
});

test('shipment timeline marks prior stages complete and preserves only provided event details', () => {
  const timeline = tracking.buildTimeline({
    status: 'in_transit',
    paymentStatus: 'paid',
    shippedAt: '2026-09-26T09:00:00.000Z',
    shipmentEvents: [{ status: 'processing', timestamp: '2026-09-25T09:00:00.000Z', customerNote: 'Prepared for dispatch.' }]
  });
  assert.deepEqual(timeline.filter(stage => stage.complete).map(stage => stage.id), ['placed', 'confirmed', 'processing', 'shipped', 'in_transit']);
  assert.equal(timeline.find(stage => stage.id === 'processing').note, 'Prepared for dispatch.');
  assert.equal(timeline.find(stage => stage.id === 'shipped').occurredAt, '2026-09-26T09:00:00.000Z');
  assert.equal(timeline.find(stage => stage.id === 'delivered').occurredAt, null);
});

test('delivery exception keeps the underlying shipment progress in the timeline', () => {
  assert.equal(tracking.statusLabel('delivery_exception'), 'Delivery Exception');
  assert.equal(tracking.orderStatus({ shippingStatus: 'delivery_exception', status: 'shipped' }), 'shipped');
});