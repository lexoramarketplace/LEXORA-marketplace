const crypto = require('node:crypto');
const { createSession, findSession } = require('./db/repository');

const sessionSecret = process.env.LEXORA_SESSION_SECRET;
if (!sessionSecret) throw new Error('LEXORA_SESSION_SECRET is required.');
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, expected] = stored.split(':');
  if (!salt || !expected || !/^[a-f0-9]{128}$/i.test(expected)) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
function issueToken(user) {
  const payload = Buffer.from(JSON.stringify({ sub: user.id, role: user.role, exp: Date.now() + 1000 * 60 * 60 * 24 * 7 })).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  const token = `${payload}.${signature}`;
  createSession({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'), userId: user.id, expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString() });
  return token;
}
function authenticate(request) {
  const header = request.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!claims.exp || claims.exp < Date.now()) return null;
  return findSession(crypto.createHash('sha256').update(token).digest('hex')) ? claims : null;
}
function requireRole(request, roles = []) {
  const user = authenticate(request);
  if (!user || (roles.length && !roles.includes(user.role))) return null;
  return user;
}
module.exports = { hashPassword, verifyPassword, issueToken, authenticate, requireRole };
