const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('../admin-session');

class MemoryStorage {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function token(role, subject) {
  const payload = Buffer.from(JSON.stringify({ role, sub: subject })).toString('base64url');
  return `${payload}.signature`;
}

test('admin token migrates only from a legacy admin token', () => {
  const adminToken = token('admin', 'admin_1');
  const storage = new MemoryStorage({ [session.legacyTokenKey]: adminToken });
  assert.equal(session.getToken(storage), adminToken);
  assert.equal(storage.getItem(session.adminTokenKey), adminToken);
});

test('admin session ignores and does not clear a legacy customer token', () => {
  const customerToken = token('customer', 'customer_1');
  const storage = new MemoryStorage({ [session.legacyTokenKey]: customerToken });
  assert.equal(session.getToken(storage), '');
  session.clearToken(storage);
  assert.equal(storage.getItem(session.legacyTokenKey), customerToken);
});

test('admin login and logout use isolated storage without overwriting customer token', () => {
  const adminToken = token('admin', 'admin_1');
  const customerToken = token('customer', 'customer_1');
  const storage = new MemoryStorage({ [session.legacyTokenKey]: customerToken });
  session.saveToken(storage, adminToken);
  assert.equal(storage.getItem(session.adminTokenKey), adminToken);
  assert.equal(storage.getItem(session.legacyTokenKey), customerToken);
  session.clearToken(storage, adminToken);
  assert.equal(storage.getItem(session.adminTokenKey), null);
  assert.equal(storage.getItem(session.legacyTokenKey), customerToken);
});