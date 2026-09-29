const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('../customer-session');

class MemoryStorage {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function token(role, subject = 'user_1') {
  const payload = Buffer.from(JSON.stringify({ role, sub: subject })).toString('base64url');
  return `${payload}.signature`;
}

test('legacy customer token migrates to isolated customer storage', () => {
  const legacyCustomerToken = token('customer', 'kelvin');
  const storage = new MemoryStorage({ [session.legacyTokenKey]: legacyCustomerToken });

  assert.equal(session.getToken(storage), legacyCustomerToken);
  assert.equal(storage.getItem(session.customerTokenKey), legacyCustomerToken);
});

test('legacy admin token is never adopted as the customer session', () => {
  const adminToken = token('admin', 'admin_1');
  const storage = new MemoryStorage({ [session.legacyTokenKey]: adminToken });

  assert.equal(session.getToken(storage), '');
  assert.equal(storage.getItem(session.customerTokenKey), null);
});

test('saving a customer login preserves an existing admin token in legacy storage', () => {
  const adminToken = token('admin', 'admin_1');
  const customerToken = token('customer', 'kelvin');
  const storage = new MemoryStorage({ [session.legacyTokenKey]: adminToken });

  session.saveToken(storage, customerToken);

  assert.equal(storage.getItem(session.customerTokenKey), customerToken);
  assert.equal(storage.getItem(session.legacyTokenKey), adminToken);
});

test('customer session remains selected after the shared legacy key is removed or replaced', () => {
  const customerToken = token('customer', 'kelvin');
  const adminToken = token('admin', 'admin_1');
  const storage = new MemoryStorage({
    [session.customerTokenKey]: customerToken,
    [session.legacyTokenKey]: customerToken
  });

  storage.removeItem(session.legacyTokenKey);
  assert.equal(session.getToken(storage), customerToken);
  storage.setItem(session.legacyTokenKey, adminToken);
  assert.equal(session.getToken(storage), customerToken);
});

test('clearing a customer session does not clear another role token in legacy storage', () => {
  const customerToken = token('customer', 'kelvin');
  const adminToken = token('admin', 'admin_1');
  const storage = new MemoryStorage({
    [session.customerTokenKey]: customerToken,
    [session.legacyTokenKey]: adminToken
  });

  session.clearToken(storage, customerToken);

  assert.equal(storage.getItem(session.customerTokenKey), null);
  assert.equal(storage.getItem(session.legacyTokenKey), adminToken);
});

test('clearing an invalid migrated customer token removes only its matching legacy copy', () => {
  const customerToken = token('customer', 'kelvin');
  const storage = new MemoryStorage({
    [session.customerTokenKey]: customerToken,
    [session.legacyTokenKey]: customerToken
  });

  session.clearToken(storage, customerToken);

  assert.equal(storage.getItem(session.customerTokenKey), null);
  assert.equal(storage.getItem(session.legacyTokenKey), null);
});

test('a route 401 is not treated as logout when /api/me still validates the session', async () => {
  const result = await session.verifyToken(async () => ({ ok: true, status: 200 }), 'http://localhost:4000', token('customer'));
  assert.equal(result, 'valid');
});

test('only a 401 from /api/me marks a customer session invalid', async () => {
  const invalid = await session.verifyToken(async () => ({ ok: false, status: 401 }), 'http://localhost:4000', token('customer'));
  const forbidden = await session.verifyToken(async () => ({ ok: false, status: 403 }), 'http://localhost:4000', token('customer'));
  const unavailable = await session.verifyToken(async () => { throw new Error('network unavailable'); }, 'http://localhost:4000', token('customer'));
  assert.equal(invalid, 'invalid');
  assert.equal(forbidden, 'unavailable');
  assert.equal(unavailable, 'unavailable');
});

test('route-level 401 preserves customer storage while session is valid or unverifiable', async () => {
  const customerToken = token('customer', 'kelvin');
  const storage = new MemoryStorage({ [session.customerTokenKey]: customerToken });
  const valid = await session.handleUnauthorized(async () => ({ ok: true, status: 200 }), 'http://localhost:4000', storage, customerToken);
  assert.equal(valid, 'valid');
  assert.equal(storage.getItem(session.customerTokenKey), customerToken);

  const unavailable = await session.handleUnauthorized(async () => { throw new Error('offline'); }, 'http://localhost:4000', storage, customerToken);
  assert.equal(unavailable, 'unavailable');
  assert.equal(storage.getItem(session.customerTokenKey), customerToken);
});

test('customer storage is cleared only when `/api/me` confirms 401', async () => {
  const customerToken = token('customer', 'kelvin');
  const storage = new MemoryStorage({ [session.customerTokenKey]: customerToken });
  const state = await session.handleUnauthorized(async () => ({ ok: false, status: 401 }), 'http://localhost:4000', storage, customerToken);
  assert.equal(state, 'invalid');
  assert.equal(storage.getItem(session.customerTokenKey), null);
});
