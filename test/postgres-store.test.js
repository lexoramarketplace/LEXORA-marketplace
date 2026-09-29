const test = require('node:test');
const assert = require('node:assert/strict');

const previousMode = process.env.STORAGE_MODE;
process.env.STORAGE_MODE = 'postgres';
const repository = require('../server/db/repository');
const { withPostgresStore, withPostgresExternalCall } = require('../server/db/postgres-store');

class FakePool {
  constructor(initialRows = []) {
    this.rows = new Map(initialRows.map(([collection, payload]) => [collection, payload]));
    this.transactions = [];
    this.openConnections = 0;
  }

  async connect() {
    const pool = this;
    pool.openConnections += 1;
    let transactionRows;
    let committed = false;
    return {
      async query(sql, values = []) {
        if (sql === 'BEGIN') {
          transactionRows = new Map([...pool.rows].map(([collection, payload]) => [collection, structuredClone(payload)]));
          pool.transactions.push('begin');
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
          pool.transactions.push('commit');
          return { rows: [] };
        }
        if (sql === 'ROLLBACK') {
          pool.transactions.push('rollback');
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL in fake pool: ${sql}`);
      },
      release() {
        pool.openConnections -= 1;
        if (!committed && pool.transactions.at(-1) !== 'rollback') pool.transactions.push('released');
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

test('PostgreSQL repository state commits collection writes before returning', async () => {
  const pool = new FakePool([['users', [{ id: 'usr_existing', email: 'existing@example.test' }]]]);
  const result = await withPostgresStore(() => {
    const store = repository.readStore();
    store.users.push({ id: 'usr_new', email: 'new@example.test' });
    repository.writeStore(store);
    return store.users.length;
  }, { pool, storeAdapter: storeAdapter() });

  assert.equal(result, 2);
  assert.equal(pool.rows.get('users').length, 2);
  assert.deepEqual(pool.transactions, ['begin', 'commit']);
  assert.ok(pool.rows.has('inventoryReservations'));
});

test('PostgreSQL repository rolls back failed request mutations', async () => {
  const pool = new FakePool([['users', [{ id: 'usr_existing' }]]]);
  await assert.rejects(withPostgresStore(() => {
    const store = repository.readStore();
    store.users.push({ id: 'usr_uncommitted' });
    repository.writeStore(store);
    throw new Error('request failure');
  }, { pool, storeAdapter: storeAdapter() }), /request failure/);

  assert.equal(pool.rows.get('users').length, 1);
  assert.deepEqual(pool.transactions, ['begin', 'rollback']);
});

test('external provider calls see committed state without holding a connection and resume a transaction afterward', async () => {
  const pool = new FakePool([['users', [{ id: 'usr_existing' }]]]);
  const result = await withPostgresStore(async () => {
    const store = repository.readStore();
    store.users.push({ id: 'usr_reserved' });
    repository.writeStore(store);
    return withPostgresExternalCall(async () => {
      assert.equal(pool.rows.get('users').length, 2);
      assert.equal(pool.openConnections, 0);
      return 'provider-result';
    });
  }, { pool, storeAdapter: storeAdapter() });

  assert.equal(result, 'provider-result');
  assert.equal(pool.openConnections, 0);
  assert.deepEqual(pool.transactions, ['begin', 'commit', 'begin', 'commit']);
});

test('PostgreSQL mode refuses repository access outside a database request context', () => {
  assert.throws(() => repository.readStore(), /inside a PostgreSQL request transaction/);
  assert.throws(() => repository.writeStore({ users: [] }), /inside a PostgreSQL request transaction/);
});

test.after(() => {
  if (previousMode === undefined) delete process.env.STORAGE_MODE;
  else process.env.STORAGE_MODE = previousMode;
});
