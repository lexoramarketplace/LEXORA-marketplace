const fs = require('node:fs');
const path = require('node:path');
const { createPool, getDatabaseUrl, getStorageMode } = require('./postgres');

async function runMigrations(options = {}) {
  if (getStorageMode() !== 'postgres') {
    throw new Error('Database migration requires STORAGE_MODE=postgres.');
  }

  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl && !options.pool) {
    throw new Error('DATABASE_URL is required before running migrations.');
  }

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort()
    : [];

  if (!files.length) throw new Error(`No SQL migrations found in ${migrationsDir}.`);

  const pool = options.pool || createPool();
  const closePool = !options.pool;
  const client = await pool.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');

    const applied = [];
    for (const file of files) {
      const migrationId = file.replace(/\.sql$/i, '');
      const exists = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [migrationId]);
      if (exists.rowCount > 0) {
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migrationId]);
        await client.query('COMMIT');
        applied.push(migrationId);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${migrationId} failed: ${error.message}`);
      }
    }

    return { applied, total: files.length, message: 'Migrations completed successfully.' };
  } finally {
    client.release();
    if (closePool) await pool.end();
  }
}

if (require.main === module) {
  runMigrations()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}

module.exports = { runMigrations };
