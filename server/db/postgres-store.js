const { AsyncLocalStorage } = require('node:async_hooks');
const { createPool, getStorageMode } = require('./postgres');
const { loadRelationalStore, persistRelationalStore } = require('./relational-store');

const requestStorage = new AsyncLocalStorage();
let pool;

function getPool() {
  if (!pool) pool = createPool();
  return pool;
}

function getPostgresRequestContext() {
  return requestStorage.getStore() || null;
}

async function flushContext(context) {
  if (!context.dirty) return;
  await context.storeAdapter.persist(context.client, context.originalState, context.state);
  context.originalState = structuredClone(context.state);
  context.dirty = false;
}

async function openContextTransaction(context) {
  context.client = await context.pool.connect();
  try {
    await context.client.query('BEGIN');
    await context.client.query('SELECT pg_advisory_xact_lock(7142389001261)');
    context.state = await context.storeAdapter.load(context.client);
    context.originalState = structuredClone(context.state);
    context.dirty = false;
  } catch (error) {
    context.client.release();
    context.client = null;
    throw error;
  }
}

async function withPostgresExternalCall(operation) {
  const context = getPostgresRequestContext();
  if (!context) return operation();

  await flushContext(context);
  await context.client.query('COMMIT');
  context.client.release();
  context.client = null;

  let result;
  let operationError;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  await openContextTransaction(context);
  if (operationError) throw operationError;
  return result;
}

async function withPostgresStore(operation, options = {}) {
  if (getStorageMode() !== 'postgres') throw new Error('PostgreSQL request storage requires STORAGE_MODE=postgres.');

  const clientPool = options.pool || getPool();
  const storeAdapter = options.storeAdapter || { load: loadRelationalStore, persist: persistRelationalStore };
  const context = { client: await clientPool.connect(), pool: clientPool, storeAdapter, state: {}, originalState: {}, dirty: false };
  try {
    await context.client.query('BEGIN');
    const lockFunction = options.lockMode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
    await context.client.query(`SELECT ${lockFunction}(7142389001261)`);
    context.state = await storeAdapter.load(context.client);
    context.originalState = structuredClone(context.state);

    return await requestStorage.run(context, async () => {
      const response = await operation();
      await flushContext(context);
      await context.client.query('COMMIT');
      return response;
    });
  } catch (error) {
    if (context.client) await context.client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    if (context.client) context.client.release();
  }
}

module.exports = { withPostgresStore, withPostgresExternalCall, getPostgresRequestContext };