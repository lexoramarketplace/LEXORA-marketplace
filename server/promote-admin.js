const { getStorageMode, getDatabaseUrl, pingDatabase } = require('./db/postgres');
const { withPostgresStore } = require('./db/postgres-store');
const { findUserByEmail, updateUser } = require('./db/repository');
const email = String(process.argv[2] || '').trim().toLowerCase();

async function promoteAdmin() {
  if (!email) throw new Error('Usage: node server/promote-admin.js admin@example.com');
  const promote = () => {
    const user = findUserByEmail(email);
    if (!user) throw new Error('No user found for that email. Register the account first.');
    return updateUser(user.id, { role: 'admin' });
  };

  if (getStorageMode() !== 'postgres') {
    promote();
    return;
  }
  if (!getDatabaseUrl()) throw new Error('DATABASE_URL is required when STORAGE_MODE=postgres.');
  const health = await pingDatabase();
  if (!health.ok) throw new Error('PostgreSQL is not reachable.');
  await require('./db/migrate').runMigrations();
  await withPostgresStore(promote);
}

promoteAdmin()
  .then(() => console.log('Admin role granted.'))
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
