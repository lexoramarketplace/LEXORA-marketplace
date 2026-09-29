const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');

const serverEnvPath = path.join(__dirname, '..', '.env');
const projectEnvPath = path.join(__dirname, '..', '..', '.env');
require('dotenv').config({ path: fs.existsSync(serverEnvPath) ? serverEnvPath : projectEnvPath });

function getStorageMode() {
  const raw = String(process.env.STORAGE_MODE || '').trim().toLowerCase();
  if (raw === 'postgres' || raw === 'json') return raw;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('STORAGE_MODE=postgres is required in production.');
  }
  return 'json';
}

function getDatabaseUrl() {
  return String(process.env.DATABASE_URL || '').trim();
}

function buildHealthStatus() {
  let mode;
  try {
    mode = getStorageMode();
  } catch (error) {
    return { ok: false, mode: 'unconfigured', database: 'not_configured', message: error.message };
  }
  if (mode !== 'postgres') {
    return { ok: false, mode, database: 'disabled', message: 'PostgreSQL is not enabled. Set STORAGE_MODE=postgres and DATABASE_URL.' };
  }

  if (!getDatabaseUrl()) {
    return { ok: false, mode, database: 'not_configured', message: 'DATABASE_URL is missing.' };
  }

  return { ok: true, mode, database: 'configured', message: 'Database is configured for PostgreSQL.' };
}

function createPool(overrides = {}) {
  if (process.env.NODE_ENV === 'production' && getStorageMode() !== 'postgres') {
    throw new Error('STORAGE_MODE=postgres is required in production; JSON storage is disabled.');
  }
  const databaseUrl = String(overrides.connectionString || getDatabaseUrl()).trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required when STORAGE_MODE=postgres.');
  }

  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'connectionString'))
  });
}

async function pingDatabase() {
  const mode = getStorageMode();
  if (mode !== 'postgres') {
    return { ok: false, mode, database: 'disabled', message: 'PostgreSQL is disabled.' };
  }

  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) {
    return { ok: false, mode, database: 'not_configured', message: 'DATABASE_URL is missing.' };
  }

  let pool;
  try {
    pool = createPool();
    const result = await pool.query('SELECT 1 AS ok');
    return { ok: true, mode, database: 'connected', message: 'Database connection successful.', rows: result.rows.length };
  } catch (error) {
    return { ok: false, mode, database: 'connection_failed', message: 'Database connection failed.' };
  } finally {
    if (pool) await pool.end().catch(() => undefined);
  }
}

module.exports = {
  getStorageMode,
  getDatabaseUrl,
  buildHealthStatus,
  createPool,
  pingDatabase
};
