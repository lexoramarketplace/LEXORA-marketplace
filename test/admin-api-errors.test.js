const test = require('node:test');
const assert = require('node:assert/strict');
const { networkMessage } = require('../admin-api-errors');

test('admin API connection failures explain how to recover from Failed to fetch', () => {
  const message = networkMessage('http://localhost:4000', new TypeError('Failed to fetch'));
  assert.match(message, /Cannot reach the LEXORA API at http:\/\/localhost:4000/i);
  assert.match(message, /API server is running/i);
  assert.match(message, /Failed to fetch/i);
});