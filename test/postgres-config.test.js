const test = require('node:test');
const assert = require('node:assert/strict');

const { getStorageMode, buildHealthStatus } = require('../server/db/postgres');

test('default storage mode stays JSON unless explicitly set to postgres', () => {
  const previous = process.env.STORAGE_MODE;
  delete process.env.STORAGE_MODE;
  try {
    assert.equal(getStorageMode(), 'json');
  } finally {
    if (previous === undefined) delete process.env.STORAGE_MODE;
    else process.env.STORAGE_MODE = previous;
  }
});

test('postgres mode reports a clear health status when DATABASE_URL is missing', () => {
  const previousMode = process.env.STORAGE_MODE;
  const previousUrl = process.env.DATABASE_URL;
  process.env.STORAGE_MODE = 'postgres';
  delete process.env.DATABASE_URL;
  try {
    const status = buildHealthStatus();
    assert.equal(status.database, 'not_configured');
    assert.equal(status.ok, false);
  } finally {
    if (previousMode === undefined) delete process.env.STORAGE_MODE;
    else process.env.STORAGE_MODE = previousMode;
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});

test('production storage mode never silently defaults to JSON', () => {
  const previousMode = process.env.STORAGE_MODE;
  const previousEnvironment = process.env.NODE_ENV;
  delete process.env.STORAGE_MODE;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => getStorageMode(), /STORAGE_MODE=postgres is required in production/);
  } finally {
    if (previousMode === undefined) delete process.env.STORAGE_MODE;
    else process.env.STORAGE_MODE = previousMode;
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  }
});
