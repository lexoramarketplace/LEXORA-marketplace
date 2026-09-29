const fs = require('node:fs');
const pathModule = require('node:path');
const crypto = require('node:crypto');

const serverEnvPath = pathModule.join(__dirname, '.env');
const projectEnvPath = pathModule.join(__dirname, '..', '.env');
const activeEnvPath = fs.existsSync(serverEnvPath) ? serverEnvPath : projectEnvPath;
require('dotenv').config({ path: activeEnvPath });

if (!process.env.LEXORA_SESSION_SECRET) {
  const generatedSessionSecret = crypto.randomBytes(48).toString('base64url');
  fs.appendFileSync(activeEnvPath, `\nLEXORA_SESSION_SECRET=${generatedSessionSecret}\n`, { mode: 0o600 });
  try { fs.chmodSync(activeEnvPath, 0o600); } catch {}
  process.env.LEXORA_SESSION_SECRET = generatedSessionSecret;
}
const http = require('node:http');
const { URL } = require('node:url');
const Stripe = require('stripe');
const {
  findUserByEmail,
  createUser,
  listAddresses,
  getAddress,
  createAddress,
  updateAddress,
  setDefaultAddress,
  deleteAddress,
  createSession,
  deleteSession,
  readStore,
  listProducts,
  listCategories,
  listSuppliers,
  findSupplierById,
  findSupplierByOwnerId,
  getProduct,
  summarizeProductReviews,
  listReviews,
  getReview,
  createReview,
  updateReview,
  deleteReview,
  listWishlist,
  addWishlistItem,
  removeWishlistItem,
  createOrder,
  createNewOrderNotification,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  findOrderByStripeSessionId,
  findOrderByPayPalOrderId,
  hasProductOrders,
  createPendingPayPalOrder,
  findPendingPayPalOrder,
  updatePendingPayPalOrder,
  reserveInventory,
  releaseInventoryReservation,
  getInventoryReservation,
  finalizePaidOrder,
  inventorySummary,
  listUsers,
  listOrders,
  listRfqs,
  getOrder,
  createProduct,
  updateProduct,
  deleteProduct,
  updateOrder,
  updateUser,
  updateSupplier,
  listAdminCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  createRfq,
  createSupplier
} = require('./db/repository');
const { getStorageMode, getDatabaseUrl, pingDatabase } = require('./db/postgres');
const { withPostgresStore, withPostgresExternalCall } = require('./db/postgres-store');
const { getMediaStore, assertProductionMediaConfigured } = require('./media');
const { hashPassword, verifyPassword, issueToken, requireRole } = require('./auth');
const { processPaidOrderAdminEmail, processOrderTrackingCustomerEmail } = require('./services/order-notifications');
const {
  MAX_UPLOAD_BYTES: maxVisualSearchImageSize,
  MIME_FORMATS: visualSearchMimeFormats,
  identifyImageFormat,
  providerMode: visualSearchProviderMode,
  searchVisualCatalog
} = require('./services/visual-search');

const port = Number(process.env.PORT || 4000);
const origin = process.env.LEXORA_ORIGIN || 'http://localhost:4173';
const productUploadDir = pathModule.join(__dirname, '..', 'uploads', 'products');
const maxImageSize = 5 * 1024 * 1024;
const maxImageCount = 10;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
const hasValidStripeKey = /^sk_(test|live)_[^\s]+$/.test(stripeSecretKey.trim());
const stripe = hasValidStripeKey ? new Stripe(stripeSecretKey) : null;
const paypalClientId = String(process.env.PAYPAL_CLIENT_ID || '').trim();
const paypalClientSecret = String(process.env.PAYPAL_CLIENT_SECRET || '').trim();
const paypalEnvironment = process.env.PAYPAL_ENVIRONMENT === 'live' ? 'live' : 'sandbox';
const paypalBaseUrl = paypalEnvironment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const paypalConfigured = Boolean(paypalClientId && paypalClientSecret);
let paypalTokenCache = null;

const json = (value, status = 200) => ({ status, body: JSON.stringify(value) });

function headers() {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Stripe-Signature',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };
}

function send(response, result) {
  const payload = Buffer.isBuffer(result.body) || typeof result.body === 'string' ? result.body : JSON.stringify(result.body || {});
  response.writeHead(result.status || 200, { ...headers(), ...(result.headers || {}) });
  response.end(payload);
}

function parseBody(request, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;

    request.on('data', (chunk) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      totalSize += value.length;

      if (totalSize > 1024 * 1024) {
        reject(new Error('Payload too large'));
        return;
      }

      chunks.push(value);
    });

    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');

      if (!rawBody) {
        resolve(raw ? '' : {});
        return;
      }

      if (raw) {
        resolve(rawBody);
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    request.on('error', reject);
  });
}

function parseMultipart(request, { maxBytes = maxImageSize * maxImageCount + 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const contentType = request.headers['content-type'] || '';
    const match = contentType.match(/^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!match) return reject(new Error('Multipart form data is required.'));
    const boundary = Buffer.from(`--${match[1] || match[2]}`);
    const chunks = [];
    let totalSize = 0;
    let uploadTooLarge = false;

    request.on('data', chunk => {
      if (uploadTooLarge) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalSize += value.length;
      if (totalSize > maxBytes) {
        uploadTooLarge = true;
        chunks.length = 0;
        return reject(new Error('Upload payload too large.'));
      }
      chunks.push(value);
    });
    request.on('error', reject);
    request.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const fields = {};
        const files = [];
        let cursor = buffer.indexOf(boundary);
        while (cursor !== -1) {
          const partStart = cursor + boundary.length;
          if (buffer.slice(partStart, partStart + 2).toString() === '--') break;
          const contentStart = partStart + 2;
          const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), contentStart);
          if (headerEnd === -1) break;
          const nextBoundary = buffer.indexOf(boundary, headerEnd + 4);
          if (nextBoundary === -1) break;
          const bodyEnd = nextBoundary - 2;
          const headersText = buffer.slice(contentStart, headerEnd).toString('utf8');
          const disposition = headersText.match(/content-disposition:\s*form-data;\s*([^\r\n]+)/i)?.[1] || '';
          const name = disposition.match(/name="([^"]+)"/)?.[1];
          const filename = disposition.match(/filename="([^"]*)"/)?.[1];
          const content = buffer.slice(headerEnd + 4, bodyEnd);
          if (name && filename !== undefined) files.push({ fieldName: name, filename, contentType: headersText.match(/content-type:\s*([^\r\n]+)/i)?.[1] || '', buffer: content });
          else if (name) fields[name] = content.toString('utf8');
          cursor = nextBoundary;
        }
        resolve({ fields, files });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function imageType(buffer, contentType) {
  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
  if (buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

function safeImageReference(reference, productId) {
  if (typeof reference !== 'string' || !reference) return false;
  if (/^https?:\/\//i.test(reference)) return true;
  return reference.startsWith(`/uploads/products/${productId}_`) && !reference.includes('..');
}

function productImages(product) {
  const values = Array.isArray(product.images) ? product.images : product.image || product.imageUrl ? [product.image || product.imageUrl] : [];
  return [...new Set(values.filter(image => safeImageReference(image, product.id)))];
}

function checkoutItems(items, { excludingReservationId = null } = {}) {
  if (!Array.isArray(items) || !items.length || items.length > 50) return { error: 'Please add a product to your cart before checkout.' };
  const requested = new Map();
  for (const item of items) {
    const productId = String(item?.productId || '');
    const quantity = Number(item?.quantity);
    if (!productId || !Number.isSafeInteger(quantity) || quantity < 1) return { error: 'Product quantities must be positive whole numbers.' };
    const combinedQuantity = (requested.get(productId) || 0) + quantity;
    if (!Number.isSafeInteger(combinedQuantity)) return { error: 'Requested product quantity is too large.' };
    requested.set(productId, combinedQuantity);
  }
  const normalized = [];
  let totalCents = 0;
  for (const [productId, quantity] of requested) {
    const product = getProduct(productId, { excludingReservationId });
    if (!product) return { error: 'Your cart has changed. Please review your cart before continuing.' };
    if (product.status && product.status !== 'active') return { error: `${product.name} is not currently available.` };
    const available = Number(product.availableStock);
    if (!Number.isSafeInteger(available) || available < 0 || quantity > available) {
      return { error: `Insufficient stock for ${product.name}. Only ${Math.max(0, Number.isSafeInteger(available) ? available : 0)} available.` };
    }
    const unitCents = Math.round(Number(product.price) * 100);
    if (!Number.isSafeInteger(unitCents) || unitCents < 0) return { error: `The price for ${product.name} is unavailable. Please contact support.` };
    totalCents += unitCents * quantity;
    if (!Number.isSafeInteger(totalCents)) return { error: 'Cart total is too large to process.' };
    normalized.push({ productId: product.id, name: product.name, quantity, unitCents });
  }
  return { items: normalized, totalCents };
}

function validShippingAddress(address) {
  if (!address || typeof address !== 'object') return false;
  return ['fullName', 'email', 'phone', 'addressLine1', 'country', 'state', 'city', 'postalCode'].every(field => typeof address[field] === 'string' && address[field].trim());
}

const countryNameKey = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const nonCountryRegionCodes = new Set(['AC', 'CP', 'DG', 'EA', 'EU', 'EZ', 'IC', 'TA', 'UN', 'XA', 'XB', 'XK', 'ZZ']);
const paypalCountryCodesByName = (() => {
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const countryCodes = new Map();
  for (let first = 65; first <= 90; first += 1) {
    for (let second = 65; second <= 90; second += 1) {
      const code = String.fromCharCode(first, second);
      if (nonCountryRegionCodes.has(code)) continue;
      if (new Intl.Locale(`und-${code}`).maximize().region !== code) continue;
      const name = names.of(code);
      if (!name || name === code || name.startsWith('Pseudo-')) continue;
      if (!countryCodes.has(countryNameKey(name))) countryCodes.set(countryNameKey(name), code);
      countryCodes.set(countryNameKey(code), code);
    }
  }
  countryCodes.set('uk', 'GB');
  countryCodes.set('usa', 'US');
  countryCodes.set('unitedstatesofamerica', 'US');
  countryCodes.set('uae', 'AE');
  return countryCodes;
})();

function paypalCountryCode(country) {
  return paypalCountryCodesByName.get(countryNameKey(country)) || '';
}

function addressInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Address data is invalid.' };
  const serverFields = ['customerId', 'userId', 'ownerId', 'id', 'createdAt', 'updatedAt', 'isDefault'];
  if (serverFields.some(field => Object.prototype.hasOwnProperty.call(body, field))) return { error: 'Address ownership, ID, timestamps, and default status are managed by LEXORA.' };
  const allowed = ['label', 'fullName', 'phone', 'addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'country'];
  if (partial && !allowed.some(field => Object.prototype.hasOwnProperty.call(body, field))) return { error: 'Provide at least one address field to update.' };
  const limits = { label: 60, fullName: 120, phone: 32, addressLine1: 160, addressLine2: 160, city: 100, state: 100, postalCode: 20, country: 80 };
  const normalized = {};
  for (const field of allowed) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    if (typeof body[field] !== 'string') return { error: `${field} must be text.` };
    const value = body[field].trim().replace(/\s+/g, ' ');
    if (value.length > limits[field]) return { error: `${field} must be ${limits[field]} characters or fewer.` };
    if (/[\u0000-\u001f\u007f]/.test(value)) return { error: `${field} contains invalid characters.` };
    normalized[field] = value;
  }
  if (!partial && !normalized.label) normalized.label = 'Home';
  const required = ['fullName', 'phone', 'addressLine1', 'city', 'state', 'postalCode', 'country'];
  if (!partial) {
    const missing = required.filter(field => !normalized[field]);
    if (missing.length) return { error: 'Please complete all required address fields.' };
  } else if (required.some(field => Object.prototype.hasOwnProperty.call(normalized, field) && !normalized[field])) {
    return { error: 'Required address fields cannot be empty.' };
  }
  if (normalized.phone !== undefined) {
    const digits = normalized.phone.replace(/\D/g, '');
    if (!/^\+?[0-9][0-9\s().-]*$/.test(normalized.phone) || digits.length < 7 || digits.length > 15) return { error: 'Please enter a valid phone number.' };
  }
  if (normalized.postalCode && !/^[A-Za-z0-9][A-Za-z0-9 -]{0,19}$/.test(normalized.postalCode)) return { error: 'Please enter a valid postal or ZIP code.' };
  return { updates: normalized };
}

async function parseAddressBody(request) {
  try { return { body: await parseBody(request) }; }
  catch (error) {
    const tooLarge = error.message === 'Payload too large';
    return { error: json({ error: tooLarge ? 'Address request must be 1 MB or smaller.' : 'Address request must contain valid JSON.' }, tooLarge ? 413 : 400) };
  }
}

function publicAddress(address) {
  return { id: address.id, label: address.label, fullName: address.fullName, phone: address.phone, addressLine1: address.addressLine1, addressLine2: address.addressLine2, city: address.city, state: address.state, postalCode: address.postalCode, country: address.country, isDefault: address.isDefault === true, createdAt: address.createdAt, updatedAt: address.updatedAt || null };
}

function checkoutShippingAddress(user, body) {
  body = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (Object.prototype.hasOwnProperty.call(body, 'savedAddressId')) {
    if (!user || user.role !== 'customer') return { error: json({ error: 'Customer sign-in is required to use a saved address.' }, 401) };
    if (typeof body.savedAddressId !== 'string' || !body.savedAddressId.trim() || body.savedAddressId.length > 200) return { error: json({ error: 'Please select a valid shipping address.' }, 422) };
    const address = getAddress(user.sub, body.savedAddressId.trim());
    if (!address) return { error: json({ error: 'Address not found.' }, 404) };
    const account = listUsers().find(entry => entry.id === user.sub);
    const shippingAddress = { fullName: address.fullName, email: account?.email || '', phone: address.phone, addressLine1: address.addressLine1, addressLine2: address.addressLine2 || '', city: address.city, state: address.state, country: address.country, postalCode: address.postalCode };
    return validShippingAddress(shippingAddress) ? { shippingAddress } : { error: json({ error: 'Please complete all required address fields.' }, 422) };
  }
  if (!validShippingAddress(body.shippingAddress)) return { error: json({ error: 'Complete shipping information is required.' }, 422) };
  const shippingAddress = {};
  for (const field of ['fullName', 'email', 'phone', 'addressLine1', 'addressLine2', 'city', 'state', 'country', 'postalCode']) shippingAddress[field] = String(body.shippingAddress[field] || '').trim();
  return { shippingAddress };
}

async function paypalAccessToken() {
  if (!paypalConfigured) throw new Error('PayPal is not configured.');
  if (paypalTokenCache && paypalTokenCache.expiresAt > Date.now()) return paypalTokenCache.value;
  const response = await fetch(`${paypalBaseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${paypalClientId}:${paypalClientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!response.ok) throw new Error('PayPal authentication failed.');
  const payload = await response.json();
  paypalTokenCache = { value: payload.access_token, expiresAt: Date.now() + Math.max(60, Number(payload.expires_in || 300) - 60) * 1000 };
  return paypalTokenCache.value;
}

async function paypalClientToken() {
  if (!paypalConfigured) throw new Error('PayPal is not configured.');
  return withPostgresExternalCall(async () => {
    const response = await fetch(`${paypalBaseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${paypalClientId}:${paypalClientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials&response_type=client_token&intent=sdk_init'
    });
    if (!response.ok) throw new Error('PayPal client token could not be generated.');
    const payload = await response.json();
    if (!payload.access_token) throw new Error('PayPal client token was not returned.');
    return payload.access_token;
  });
}

async function paypalRequest(endpoint, options = {}) {
  return withPostgresExternalCall(async () => {
    const token = await paypalAccessToken();
    const response = await fetch(`${paypalBaseUrl}${endpoint}`, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.message || 'PayPal request failed.');
      error.paypalStatusCode = response.status;
      throw error;
    }
    return payload;
  });
}

function paypalAmount(cents) { return (Number(cents) / 100).toFixed(2); }

function paypalOrderFromCapture(pending, capture) {
  return {
    buyerId: pending.buyerId,
    items: pending.items.map(item => ({ productId: item.productId, quantity: item.quantity, unitPrice: item.unitCents })),
    shippingAddress: pending.shippingAddress,
    currency: pending.currency,
    totalAmount: pending.totalCents,
    paymentProvider: 'paypal',
    paymentStatus: 'paid',
    paypalOrderId: pending.paypalOrderId,
    paypalCaptureId: capture.id,
    paypalStatus: capture.status,
    paymentMethod: pending.paymentMethod || 'paypal'
  };
}

function required(body, fields) {
  return fields.filter((field) => typeof body[field] !== 'string' || !body[field].trim());
}

function supplierProfileSnapshot(supplier) {
  return {
    id: supplier.id,
    businessName: supplier.businessName || supplier.companyName || '',
    companyName: supplier.companyName || supplier.businessName || '',
    logoUrl: supplier.logoUrl || '',
    businessDescription: supplier.businessDescription || supplier.description || '',
    country: supplier.country || '',
    state: supplier.state || '',
    city: supplier.city || '',
    businessAddress: supplier.businessAddress || '',
    phone: supplier.phone || '',
    businessEmail: supplier.businessEmail || '',
    categories: Array.isArray(supplier.categories) ? [...supplier.categories] : [],
    verificationStatus: supplier.verificationStatus || supplier.status || 'pending'
  };
}

function publicSupplierSnapshot(supplier) {
  const profile = supplierProfileSnapshot(supplier);
  return {
    id: profile.id,
    businessName: profile.businessName,
    companyName: profile.companyName,
    logoUrl: profile.logoUrl,
    description: profile.businessDescription,
    country: profile.country,
    state: profile.state,
    city: profile.city,
    phone: profile.phone,
    businessEmail: profile.businessEmail,
    categories: profile.categories,
    verificationStatus: profile.verificationStatus,
    verified: String(profile.verificationStatus).toLowerCase() === 'approved',
    productCount: supplier.productCount || 0,
    rating: supplier.rating || null,
    ...(supplier.demo ? { demo: true } : {})
  };
}

function supplierProfileInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'A supplier profile object is required.' };
  const protectedFields = ['id', 'supplierId', 'ownerId', 'status', 'verificationStatus', 'verified', 'createdAt', 'createdByRegistration'];
  if (protectedFields.some(field => Object.prototype.hasOwnProperty.call(body, field))) {
    return { error: 'Supplier ownership and verification fields cannot be changed.' };
  }

  const limits = {
    businessName: 120,
    logoUrl: 2048,
    businessDescription: 3000,
    country: 100,
    state: 100,
    city: 100,
    businessAddress: 255,
    phone: 40,
    businessEmail: 254
  };
  const updates = {};
  for (const [field, maximum] of Object.entries(limits)) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    if (typeof body[field] !== 'string') return { error: `${field} must be text.` };
    const value = body[field].trim();
    if (value.length > maximum) return { error: `${field} is too long.` };
    if (field === 'businessName' && !value) return { error: 'Store name is required.' };
    if (field === 'businessEmail' && value && !emailPattern.test(value)) return { error: 'Enter a valid business email.' };
    if (field === 'logoUrl' && value) {
      let parsed;
      try { parsed = new URL(value); } catch { return { error: 'Store logo must be an absolute HTTP or HTTPS URL.' }; }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        return { error: 'Store logo must be an absolute HTTP or HTTPS URL.' };
      }
      updates.logoUrl = parsed.href;
    } else {
      updates[field] = value;
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'businessName')) updates.companyName = updates.businessName;
  if (Object.prototype.hasOwnProperty.call(updates, 'businessDescription')) updates.description = updates.businessDescription;
  if (Object.prototype.hasOwnProperty.call(body, 'categories')) {
    if (!Array.isArray(body.categories) || body.categories.length > 20 || body.categories.some(category => typeof category !== 'string')) {
      return { error: 'Choose up to 20 valid business categories.' };
    }
    const categories = [];
    const seen = new Set();
    for (const category of body.categories) {
      const value = category.trim();
      if (!value || value.length > 80) return { error: 'Business categories must be between 1 and 80 characters.' };
      const key = value.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        categories.push(value);
      }
    }
    updates.categories = categories;
  }
  if (!Object.keys(updates).length) return { error: 'Provide at least one editable supplier profile field.' };
  return { updates };
}

function safeUser(user) {
  return { id: user.id, email: user.email, name: user.name, role: user.role, createdAt: user.createdAt };
}

function supplierDashboardSnapshot(supplier, ownerUser) {
  const products = readStore().products.filter(product => String(product.supplierId || '') === String(supplier.id));
  const orders = listOrders().filter(order => (order.items || []).some(item => {
    const product = readStore().products.find(entry => String(entry.id) === String(item.productId));
    return product && String(product.supplierId || '') === String(supplier.id);
  }));
  const totalSales = orders.filter(order => order.paymentStatus === 'paid').reduce((sum, order) => sum + Number(order.totalAmount || 0) / 100, 0);
  const totalProducts = products.length;
  const activeProducts = products.filter(product => (product.status || 'active') === 'active').length;
  const outOfStockProducts = products.filter(product => Number(product.stock || 0) === 0).length;
  return {
    id: supplier.id,
    storeName: supplier.businessName || supplier.companyName || ownerUser?.name || 'Supplier store',
    verificationStatus: supplier.verificationStatus || supplier.status || 'pending',
    status: supplier.status || supplier.verificationStatus || 'pending',
    totalProducts,
    activeProducts,
    outOfStockProducts,
    totalOrders: orders.length,
    totalSales,
    owner: safeUser(ownerUser || { id: supplier.ownerId, email: '', name: '', role: 'supplier' }),
    recentOrders: orders.slice(-5).map(order => ({
      id: order.id,
      status: order.status,
      paymentStatus: order.paymentStatus,
      total: Number(order.totalAmount || 0) / 100,
      createdAt: order.createdAt,
      customer: order.shippingAddress?.fullName || order.shippingAddress?.email || 'Customer'
    }))
  };
}

function supplierOwnsProduct(product, user) {
  if (!product || !user) return false;
  if (user.role === 'admin') return true;
  if (product.supplierId) {
    const supplier = findSupplierById(product.supplierId);
    return supplier && String(supplier.ownerId) === String(user.sub);
  }
  if (user.role === 'supplier') {
    const supplier = findSupplierByOwnerId(user.sub);
    return supplier && String(supplier.businessName || supplier.companyName || '') === String(product.supplier || '');
  }
  return false;
}

function customerOwnsOrder(order, user) {
  if (!order || !user) return false;
  if (order.buyerId) return order.buyerId === user.sub;
  if (user.role !== 'customer') return false;
  const account = listUsers().find(entry => entry.id === user.sub);
  const accountEmail = String(account?.email || '').trim().toLowerCase();
  const orderEmail = String(order.shippingAddress?.email || '').trim().toLowerCase();
  return Boolean(accountEmail && orderEmail && accountEmail === orderEmail);
}

function customerPurchasedProduct(user, productId) {
  if (!user || user.role !== 'customer') return false;
  return listOrders().some(order =>
    order.paymentStatus === 'paid' && order.status !== 'refunded' && customerOwnsOrder(order, user) &&
    (order.items || []).some(item => String(item.productId || item.id || '') === productId)
  );
}

function reviewInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Review data is invalid.' };
  if (['customerId', 'authorId', 'verifiedPurchase', 'status', 'productId'].some(field => Object.prototype.hasOwnProperty.call(body, field))) {
    return { error: 'Review ownership, product, verification, and moderation fields are managed by LEXORA.' };
  }
  if (typeof body.rating !== 'number' || !Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) {
    return { error: 'Rating must be a whole number from 1 to 5.' };
  }
  if (body.title !== undefined && typeof body.title !== 'string') return { error: 'Review title must be text.' };
  if (body.comment !== undefined && typeof body.comment !== 'string') return { error: 'Review text must be text.' };
  const title = String(body.title || '').trim();
  const comment = String(body.comment || '').trim();
  if (title.length > 120) return { error: 'Review title must be 120 characters or fewer.' };
  if (!comment || comment.length > 2000) return { error: 'Review text must be between 1 and 2000 characters.' };
  return { updates: { rating: body.rating, title, comment } };
}

async function parseReviewBody(request) {
  try {
    return { body: await parseBody(request) };
  } catch (error) {
    const tooLarge = error.message === 'Payload too large';
    return { error: json({ error: tooLarge ? 'Review payload must be 1 MB or smaller.' : 'Review request must contain valid JSON.' }, tooLarge ? 413 : 400) };
  }
}

function publicReview(review, { includeStatus = false } = {}) {
  const result = {
    id: review.id,
    productId: review.productId,
    displayName: review.authorName || 'LEXORA customer',
    rating: review.rating,
    title: review.title,
    comment: review.comment,
    verifiedPurchase: review.verifiedPurchase === true,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt || null
  };
  if (includeStatus) result.status = review.status;
  return result;
}

function adminGuard(request) {
  const user = requireRole(request);
  if (!user) return { error: json({ error: 'Authentication required.' }, 401) };
  if (user.role !== 'admin') return { error: json({ error: 'Administrator access required.' }, 403) };
  return { user };
}

function safeAdminUser(user) {
  return { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status || 'active', createdAt: user.createdAt, updatedAt: user.updatedAt };
}

async function notifyPaidOrder(order) {
  try {
    createNewOrderNotification(order);
  } catch (error) {
    console.error('Order notification creation failed:', safeStripeErrorMessage(error));
  }

  try {
    const result = await processPaidOrderAdminEmail(order);
    return result;
  } catch (error) {
    console.error('Paid order email notification failed:', safeStripeErrorMessage(error));
    return { sent: false, skipped: false, error: error.message || 'Unknown email failure' };
  }
}

function productInput(body, { partial = false } = {}) {
  const fields = ['name', 'description', 'category', 'supplier', 'location', 'image', 'imageUrl', 'sku', 'status', 'featured', 'verified', 'price', 'wholesalePrice', 'moq', 'stock', 'lowStockThreshold', 'variations'];
  const updates = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(body, field)) updates[field] = body[field];
  }
  if (!partial) {
    const missing = ['name', 'category', 'supplier', 'location'].filter(field => typeof updates[field] !== 'string' || !updates[field].trim());
    if (missing.length) return { error: `Missing fields: ${missing.join(', ')}` };
  }
  if (updates.name !== undefined) updates.name = String(updates.name).trim();
  if (updates.category !== undefined) updates.category = String(updates.category).trim();
  if (updates.supplier !== undefined) updates.supplier = String(updates.supplier).trim();
  if (updates.location !== undefined) updates.location = String(updates.location).trim();
  if (updates.imageUrl !== undefined) updates.imageUrl = String(updates.imageUrl).trim();
  if (updates.image !== undefined) updates.image = String(updates.image).trim();
  for (const field of ['price', 'wholesalePrice']) {
    if (updates[field] !== undefined && (!Number.isFinite(Number(updates[field])) || Number(updates[field]) < 0)) return { error: `${field} must be a non-negative number.` };
    if (updates[field] !== undefined) updates[field] = Number(updates[field]);
  }
  for (const field of ['moq', 'stock', 'lowStockThreshold']) {
    if (updates[field] !== undefined && (!Number.isSafeInteger(Number(updates[field])) || Number(updates[field]) < 0)) return { error: `${field} must be a non-negative integer.` };
    if (updates[field] !== undefined) updates[field] = Number(updates[field]);
  }
  if (updates.status !== undefined && !['active', 'inactive', 'draft'].includes(updates.status)) return { error: 'Invalid product status.' };
  if (updates.variations !== undefined && !Array.isArray(updates.variations)) return { error: 'variations must be an array.' };
  return { updates };
}

function adminDashboardData() {
  const store = readStore();
  const orders = listOrders();
  const products = store.products;
  const users = listUsers();
  const suppliers = listSuppliers();
  const paidOrders = orders.filter(order => order.paymentStatus === 'paid');
  const totalSales = paidOrders.reduce((sum, order) => sum + Number(order.totalAmount || 0) / 100, 0);
  const productCounts = new Map();
  for (const order of orders) {
    for (const item of order.items || []) {
      const productId = String(item.productId || item.id || 'unknown');
      productCounts.set(productId, (productCounts.get(productId) || 0) + Number(item.quantity || item.qty || 0));
    }
  }
  const topProducts = [...productCounts.entries()].map(([productId, quantity]) => ({ product: products.find(product => product.id === productId)?.name || productId, quantity })).sort((a, b) => b.quantity - a.quantity).slice(0, 5);
  const monthly = new Map();
  for (const order of paidOrders) {
    const month = String(order.createdAt || '').slice(0, 7);
    if (month) monthly.set(month, (monthly.get(month) || 0) + Number(order.totalAmount || 0) / 100);
  }
  return {
    metrics: { totalSales, totalOrders: orders.length, totalProducts: products.length, totalCustomers: users.filter(user => user.role === 'customer').length, totalSuppliers: suppliers.length, pendingOrders: orders.filter(order => ['pending', 'placed'].includes(order.status)).length, completedOrders: orders.filter(order => ['delivered', 'completed'].includes(order.status)).length, refunds: orders.filter(order => order.status === 'refunded' || order.paymentStatus === 'refunded').length },
    charts: { revenueByMonth: [...monthly.entries()].map(([month, value]) => ({ month, value })), topProducts, ordersByStatus: [...new Set(orders.map(order => order.status))].map(status => ({ status, count: orders.filter(order => order.status === status).length })) },
    inventory: inventorySummary(),
    availableData: { payments: paidOrders.length > 0, reviews: (store.reviews || []).length > 0, messages: false }
  };
}

function safeStripeErrorMessage(error) {
  return String(error?.message || error || 'Unknown Stripe error')
    .replace(/sk_(?:test|live)_[^\s,]+/g, 'Stripe secret')
    .replace(/rk_(?:test|live)_[^\s,]+/g, 'Stripe restricted key')
    .replace(/whsec_[^\s,]+/g, 'Stripe webhook secret');
}

async function verifiedOrderFromSession(session) {
  if (!session || session.payment_status !== 'paid' || !session.id) return null;

  const existingOrder = findOrderByStripeSessionId(session.id);
  if (existingOrder) return existingOrder;

  let items = [];
  try {
    items = JSON.parse(session.metadata?.cartItems || '[]');
  } catch {
    items = [];
  }

  const metadata = session.metadata || {};
  const reservation = metadata.inventoryReservationId ? getInventoryReservation(metadata.inventoryReservationId) : null;
  const cart = reservation?.status === 'reserved'
    ? { items: reservation.items, totalCents: reservation.totalCents }
    : checkoutItems(items);
  if (cart.error) throw new Error(cart.error);
  if (String(session.currency || '').toLowerCase() !== 'usd' || Number(session.amount_total) !== cart.totalCents) {
    throw new Error('Stripe amount does not match the server-calculated cart total.');
  }

  const orderData = {
    buyerId: metadata.userId && metadata.userId !== 'guest-checkout' ? metadata.userId : null,
    items: cart.items.map(item => ({ productId: item.productId, name: item.name, quantity: item.quantity, unitPrice: item.unitCents })),
    shippingAddress: {
      fullName: metadata.shippingName || '',
      email: session.customer_details?.email || '',
      phone: session.customer_details?.phone || metadata.shippingPhone || '',
      addressLine1: metadata.shippingAddressLine1 || session.shipping_details?.address?.line1 || '',
      addressLine2: metadata.shippingAddressLine2 || session.shipping_details?.address?.line2 || '',
      city: metadata.shippingCity || session.shipping_details?.address?.city || '',
      state: metadata.shippingState || session.shipping_details?.address?.state || '',
      country: metadata.shippingCountry || session.shipping_details?.address?.country || '',
      postalCode: metadata.shippingPostalCode || session.shipping_details?.address?.postal_code || ''
    },
    currency: String(session.currency || 'usd').toUpperCase(),
    totalAmount: session.amount_total,
    paymentStatus: 'paid',
    stripeSessionId: session.id,
    stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null
  };
  const finalized = finalizePaidOrder(orderData, reservation?.id || null);
  if (!finalized.ok) throw new Error(finalized.error || 'Inventory could not be finalized for this payment.');
  if (!finalized.duplicate) await notifyPaidOrder(finalized.order);
  return finalized.order;
}

async function retrievePaidCheckoutSession(sessionId) {
  if (!stripe || !/^cs_(test|live)_[A-Za-z0-9_]+$/.test(String(sessionId || ''))) return null;
  const session = await withPostgresExternalCall(() => stripe.checkout.sessions.retrieve(sessionId));
  return session.payment_status === 'paid' ? session : null;
}

async function route(request) {
  const host = request.headers.host || 'localhost';
  const url = new URL(request.url, `http://${host}`);
  const path = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') {
    return { status: 204, body: '' };
  }

  if (method === 'GET' && path === '/') {
    return json({
      name: 'LEXORA Marketplace API',
      message: 'Welcome to the LEXORA Marketplace API.',
      docs: '/api/health'
    });
  }

  if (method === 'GET' && path === '/health') {
    return json({ ok: true, service: 'lexora-api', time: new Date().toISOString() });
  }

  if (method === 'GET' && path === '/api/health') {
    return json({ ok: true, service: 'lexora-api', storageMode: getStorageMode(), database: getStorageMode() === 'postgres' ? 'connected' : 'json', time: new Date().toISOString() });
  }

  if (method === 'GET' && path.startsWith('/uploads/products/')) {
    const filename = decodeURIComponent(path.slice('/uploads/products/'.length));
    if (!filename || filename !== pathModule.basename(filename) || !/^[A-Za-z0-9_-]+\.(?:jpg|png|webp)$/.test(filename)) return json({ error: 'Image not found.' }, 404);
    const image = await withPostgresExternalCall(() => getMediaStore().getProductImage(`/uploads/products/${filename}`));
    if (!image) return json({ error: 'Image not found.' }, 404);
    return { status: 200, body: image.body, headers: { 'Content-Type': image.contentType, 'Cache-Control': 'public, max-age=31536000, immutable' } };
  }

  if (method === 'GET' && path === '/api/paypal/config') {
    return json({ data: { configured: paypalConfigured, environment: paypalEnvironment, clientId: paypalConfigured ? paypalClientId : '' } });
  }

  if (method === 'GET' && path === '/api/paypal/client-token') {
    if (!paypalConfigured) return json({ error: 'PayPal is not configured.' }, 503);
    try {
      return json({ data: { clientToken: await paypalClientToken() } });
    } catch {
      return json({ error: 'PayPal card checkout could not be initialized.' }, 502);
    }
  }

  if (method === 'POST' && path === '/api/paypal/create-order') {
    const body = await parseBody(request);
    const user = requireRole(request, ['customer', 'supplier', 'admin']);
    const isGuestCheckout = !request.headers.authorization && body.guest === true;
    if (!user && !isGuestCheckout) return json({ error: 'Authentication required.' }, 401);
    const addressResult = checkoutShippingAddress(user, body);
    if (addressResult.error) return addressResult.error;
    const shippingAddress = addressResult.shippingAddress;
    const cart = checkoutItems(body.items);
    if (cart.error) return json({ error: cart.error }, 422);
    if (body.paymentMethod !== undefined && !['paypal', 'card'].includes(body.paymentMethod)) return json({ error: 'Invalid PayPal payment method.' }, 422);
    const paymentMethod = body.paymentMethod === 'card' ? 'card' : 'paypal';
    const billingCountryCode = paymentMethod === 'card' ? paypalCountryCode(shippingAddress.country) : '';
    if (paymentMethod === 'card' && !billingCountryCode) return json({ error: 'Enter a valid country for card billing.' }, 422);
    if (!paypalConfigured) return json({ error: 'PayPal is not configured. Add PayPal Sandbox credentials to the server environment.' }, 503);

    const reservationId = `inv_${crypto.randomUUID()}`;
    const reservation = reserveInventory(reservationId, cart.items, { provider: 'paypal' });
    if (!reservation.ok) return json({ error: reservation.error }, 409);

    try {
      const orderBody = {
        intent: 'CAPTURE',
        purchase_units: [{
          custom_id: `lexora-${Date.now()}`,
          amount: { currency_code: 'USD', value: paypalAmount(cart.totalCents), breakdown: { item_total: { currency_code: 'USD', value: paypalAmount(cart.totalCents) } } },
          items: cart.items.map(item => ({ name: item.name.slice(0, 127), quantity: String(item.quantity), unit_amount: { currency_code: 'USD', value: paypalAmount(item.unitCents) }, category: 'PHYSICAL_GOODS' }))
        }]
      };
      if (paymentMethod === 'card') {
        orderBody.payment_source = {
          card: {
            billing_address: {
              address_line_1: shippingAddress.addressLine1,
              ...(shippingAddress.addressLine2 ? { address_line_2: shippingAddress.addressLine2 } : {}),
              admin_area_1: shippingAddress.state,
              admin_area_2: shippingAddress.city,
              postal_code: shippingAddress.postalCode,
              country_code: billingCountryCode
            },
            attributes: { verification: { method: 'SCA_WHEN_REQUIRED' } },
            experience_context: {
              return_url: `${origin}/checkout-success.html?provider=paypal&method=card`,
              cancel_url: `${origin}/checkout-cancelled.html?provider=paypal&method=card`
            }
          }
        };
      } else {
        orderBody.application_context = { brand_name: 'LEXORA', user_action: 'PAY_NOW', return_url: `${origin}/checkout-success.html?provider=paypal`, cancel_url: `${origin}/checkout-cancelled.html?provider=paypal` };
      }
      const paypalRequestBody = JSON.stringify(orderBody);
      if (paymentMethod === 'card') {
        const finalCardSource = JSON.parse(paypalRequestBody).payment_source?.card;
        const finalBillingAddress = finalCardSource?.billing_address;
        const finalCountryCode = finalBillingAddress?.country_code || '';
        console.info(`[PayPal card order] ${JSON.stringify({
          hasBillingAddress: Boolean(finalBillingAddress),
          hasCountryCode: Boolean(finalCountryCode),
          countryCodeLength: finalCountryCode.length,
          countryCode: finalCountryCode || 'missing'
        })}`);
        if (!/^[A-Z]{2}$/.test(finalCountryCode)) throw new Error('Validated card billing country is missing from the PayPal order request.');
      }
      const paypalOrder = await paypalRequest('/v2/checkout/orders', {
        method: 'POST',
        headers: { 'PayPal-Request-Id': `lexora-${crypto.randomUUID()}` },
        body: paypalRequestBody
      });
      const approvalUrl = paypalOrder.links?.find(link => link.rel === 'approve')?.href;
      if (!paypalOrder.id || (paymentMethod === 'paypal' && !approvalUrl)) throw new Error('PayPal order details were not returned.');
      createPendingPayPalOrder({ paypalOrderId: paypalOrder.id, reservationId, buyerId: user?.sub || null, guest: isGuestCheckout, paymentMethod, email: shippingAddress.email, shippingAddress, items: cart.items, totalCents: cart.totalCents, currency: 'USD' });
      if (paymentMethod === 'card') return json({ data: { paypalOrderId: paypalOrder.id } }, 201);
      return json({ data: { paypalOrderId: paypalOrder.id, reservationId, approvalUrl, amount: paypalAmount(cart.totalCents), currency: 'USD' } }, 201);
    } catch (error) {
      releaseInventoryReservation(reservationId);
      console.error('PayPal order creation failed:', safeStripeErrorMessage(error));
      return json({ error: 'PayPal checkout could not be started. Verify the Sandbox configuration.' }, 502);
    }
  }

  if (method === 'POST' && path === '/api/checkout/release-reservation') {
    const body = await parseBody(request);
    const reservationId = String(body.reservationId || '');
    if (!/^inv_[0-9a-f-]{36}$/i.test(reservationId)) return json({ error: 'Invalid checkout reservation.' }, 422);
    releaseInventoryReservation(reservationId);
    return json({ data: { released: true } });
  }

  if (method === 'POST' && path === '/api/paypal/cancel-order') {
    const body = await parseBody(request);
    const user = requireRole(request, ['customer', 'supplier', 'admin']);
    const isGuestCheckout = !request.headers.authorization && body.guest === true;
    if (!user && !isGuestCheckout) return json({ error: 'Authentication required.' }, 401);
    const paypalOrderId = String(body.paypalOrderId || '').trim();
    if (!/^[A-Za-z0-9_-]{10,100}$/.test(paypalOrderId)) return json({ error: 'Invalid PayPal order ID.' }, 422);
    const pending = findPendingPayPalOrder(paypalOrderId);
    if (!pending || pending.paymentMethod !== 'card') return json({ error: 'PayPal card checkout session not found.' }, 404);
    if ((pending.buyerId && pending.buyerId !== user?.sub) || (pending.guest && !isGuestCheckout)) return json({ error: 'Payment ownership could not be verified.' }, 403);
    if (pending.status === 'captured' || pending.status === 'capturing') return json({ error: 'This payment can no longer be cancelled safely.' }, 409);
    if (pending.status !== 'failed') {
      releaseInventoryReservation(pending.reservationId);
      updatePendingPayPalOrder(pending.id, { status: 'failed' });
    }
    return json({ data: { released: true } });
  }

  if (method === 'POST' && path === '/api/paypal/capture-order') {
    const body = await parseBody(request);
    const user = requireRole(request, ['customer', 'supplier', 'admin']);
    const isGuestCheckout = !request.headers.authorization && body.guest === true;
    if (!user && !isGuestCheckout) return json({ error: 'Authentication required.' }, 401);
    if (!paypalConfigured) return json({ error: 'PayPal is not configured.' }, 503);
    const paypalOrderId = String(body.paypalOrderId || '').trim();
    if (!/^[A-Za-z0-9_-]{10,100}$/.test(paypalOrderId)) return json({ error: 'Invalid PayPal order ID.' }, 422);
    const existingOrder = findOrderByPayPalOrderId(paypalOrderId);
    if (existingOrder) return json({ data: { order: existingOrder, paymentStatus: existingOrder.paymentStatus } });
    const pending = findPendingPayPalOrder(paypalOrderId);
    if (!pending) return json({ error: 'PayPal checkout session not found or expired.' }, 404);
    if (pending.status === 'capturing') return json({ error: 'This PayPal payment is already being processed.' }, 409);
    if (pending.status === 'captured') {
      const completedOrder = findOrderByPayPalOrderId(paypalOrderId);
      if (completedOrder) return json({ data: { order: completedOrder, paymentStatus: completedOrder.paymentStatus } });
      const finalizeResult = finalizePaidOrder(paypalOrderFromCapture(pending, { id: pending.paypalCaptureId, status: 'COMPLETED' }), pending.reservationId);
      if (!finalizeResult.ok) return json({ error: `Payment was captured but inventory finalization needs attention: ${finalizeResult.error}` }, 409);
      await notifyPaidOrder(finalizeResult.order);
      return json({ data: { order: finalizeResult.order, paymentStatus: finalizeResult.order.paymentStatus } });
    }
    if (pending.paymentMethod === 'card') {
      if (pending.guest ? !isGuestCheckout : (!user || pending.buyerId !== user.sub)) return json({ error: 'Payment ownership could not be verified.' }, 403);
    } else if (!isGuestCheckout && pending.buyerId && pending.buyerId !== user?.sub) {
      return json({ error: 'Payment ownership could not be verified.' }, 403);
    }
    const reservationId = pending.reservationId || `inv_${crypto.randomUUID()}`;
    const reservation = reserveInventory(reservationId, pending.items, { provider: 'paypal' });
    if (!reservation.ok) return json({ error: reservation.error }, 409);
    if (!pending.reservationId) updatePendingPayPalOrder(pending.id, { reservationId });
    const currentCart = checkoutItems(pending.items, { excludingReservationId: reservationId });
    if (currentCart.error || currentCart.totalCents !== pending.totalCents) {
      releaseInventoryReservation(reservationId);
      updatePendingPayPalOrder(pending.id, { status: 'failed' });
      return json({ error: 'One or more products are no longer available in the requested quantity.' }, 409);
    }

    let paypalCaptureRequestStarted = false;
    try {
      updatePendingPayPalOrder(pending.id, { status: 'capturing' });
      if (pending.paymentMethod === 'card') {
        const verifiedOrder = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, { method: 'GET' });
        const verifiedAmount = verifiedOrder.purchase_units?.[0]?.amount;
        if (verifiedOrder.id !== paypalOrderId || verifiedOrder.status !== 'APPROVED' || !verifiedAmount || verifiedAmount.currency_code !== pending.currency || Math.round(Number(verifiedAmount.value) * 100) !== pending.totalCents) {
          releaseInventoryReservation(reservationId);
          updatePendingPayPalOrder(pending.id, { status: 'failed' });
          return json({ error: 'PayPal card payment could not be verified.' }, 402);
        }
      }
      paypalCaptureRequestStarted = true;
      const captureResponse = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, { method: 'POST', headers: { 'PayPal-Request-Id': `lexora-capture-${paypalOrderId}` }, body: '{}' });
      const capture = captureResponse.purchase_units?.[0]?.payments?.captures?.[0];
      const capturedAmount = capture?.amount;
      if (captureResponse.status !== 'COMPLETED' || capture?.status !== 'COMPLETED' || !capturedAmount || capturedAmount.currency_code !== pending.currency || Math.round(Number(capturedAmount.value) * 100) !== pending.totalCents) {
        releaseInventoryReservation(reservationId);
        updatePendingPayPalOrder(pending.id, { status: 'failed' });
        return json({ error: 'PayPal payment could not be verified.' }, 402);
      }
      updatePendingPayPalOrder(pending.id, { status: 'captured', paypalCaptureId: capture.id });
      const orderData = paypalOrderFromCapture(pending, capture);
      const result = finalizePaidOrder(orderData, reservationId);
      if (!result.ok) return json({ error: `Payment was captured but inventory finalization needs attention: ${result.error}` }, 409);
      await notifyPaidOrder(result.order);
      return json({ data: { order: result.order, paymentStatus: result.order.paymentStatus } });
    } catch (error) {
      if (pending.paymentMethod === 'card' && (!paypalCaptureRequestStarted || (error.paypalStatusCode >= 400 && error.paypalStatusCode < 500))) {
        releaseInventoryReservation(reservationId);
        updatePendingPayPalOrder(pending.id, { status: 'failed' });
      }
      console.error('PayPal capture failed:', safeStripeErrorMessage(error));
      return json({ error: 'PayPal payment capture could not be completed. Check payment status before retrying.' }, 502);
    }
  }

  if (path.startsWith('/api/admin/')) {
    const access = adminGuard(request);
    if (access.error) return access.error;

    if (method === 'GET' && path === '/api/admin/notifications') {
      return json({ data: listNotifications(), unreadCount: listNotifications({ unreadOnly: true }).length });
    }

    if (method === 'PATCH' && path.startsWith('/api/admin/notifications/')) {
      const notificationId = decodeURIComponent(path.slice('/api/admin/notifications/'.length));
      const notification = markNotificationRead(notificationId);
      return notification ? json({ data: notification }) : json({ error: 'Notification not found.' }, 404);
    }

    if (method === 'POST' && path === '/api/admin/notifications/mark-all-read') {
      return json({ data: markAllNotificationsRead() });
    }

    if (method === 'GET' && path === '/api/admin/dashboard') return json({ data: adminDashboardData() });

    if (method === 'GET' && path === '/api/admin/products') {
      return json({ data: listProducts({ search: url.searchParams.get('search'), category: url.searchParams.get('category'), location: url.searchParams.get('location'), includeReservationDetails: true }) });
    }

    if (method === 'GET' && path.startsWith('/api/admin/products/') && path.endsWith('/images')) {
      const productId = decodeURIComponent(path.slice('/api/admin/products/'.length, -'/images'.length));
      const product = getProduct(productId);
      return product ? json({ data: { images: productImages(product), primary: product.image || productImages(product)[0] || '' } }) : json({ error: 'Product not found.' }, 404);
    }

    if (method === 'POST' && path === '/api/admin/products') {
      const body = await parseBody(request);
      const result = productInput(body);
      if (result.error) return json({ error: result.error }, 422);
      return json({ data: createProduct(result.updates) }, 201);
    }

    if (path.startsWith('/api/admin/products/')) {
      const productId = decodeURIComponent(path.slice('/api/admin/products/'.length));
      if (method === 'PATCH') {
        const body = await parseBody(request);
        const result = productInput(body, { partial: true });
        if (result.error) return json({ error: result.error }, 422);
        if (result.updates.stock !== undefined) {
          const currentProduct = listProducts({ includeReservationDetails: true }).find(product => product.id === productId);
          if (!currentProduct) return json({ error: 'Product not found.' }, 404);
          if (result.updates.stock < Number(currentProduct.reservedStock || 0)) return json({ error: `Stock cannot be lower than ${currentProduct.reservedStock} unit(s) currently reserved for checkout.` }, 409);
        }
        const product = updateProduct(productId, result.updates);
        return product ? json({ data: product }) : json({ error: 'Product not found.' }, 404);
      }
      if (method === 'DELETE') {
        const product = getProduct(productId);
        if (!product) return json({ error: 'Product not found.' }, 404);
        if (hasProductOrders(productId)) return json({ error: 'This product is referenced by an existing order and cannot be deleted. Mark it inactive instead.' }, 409);
        deleteProduct(productId);
        await withPostgresExternalCall(async () => {
          const mediaStore = getMediaStore();
          for (const image of productImages(product)) await mediaStore.deleteProductImage(image);
        });
        return json({ data: { deleted: true, id: productId } });
      }
    }

    if (method === 'POST' && path.startsWith('/api/admin/products/') && path.endsWith('/images')) {
      const productId = decodeURIComponent(path.slice('/api/admin/products/'.length, -'/images'.length));
      const product = getProduct(productId);
      if (!product) return json({ error: 'Product not found.' }, 404);

      let upload;
      try {
        upload = await parseMultipart(request);
      } catch (error) {
        return json({ error: error.message || 'Invalid image upload.' }, 422);
      }

      const imageFiles = upload.files.filter(file => file.fieldName === 'images');
      if (imageFiles.length > maxImageCount) return json({ error: `A maximum of ${maxImageCount} images can be uploaded at once.` }, 422);
      const existingImages = productImages(product);
      let keepImages = existingImages;
      if (upload.fields.keepImages) {
        try { keepImages = JSON.parse(upload.fields.keepImages); } catch { return json({ error: 'Invalid existing image list.' }, 422); }
        if (!Array.isArray(keepImages) || keepImages.some(image => !safeImageReference(image, productId))) return json({ error: 'Invalid existing image reference.' }, 422);
        keepImages = [...new Set(keepImages)];
      }
      const savedImages = [];
      try {
        const mediaStore = getMediaStore();
        for (const file of imageFiles) {
          if (file.buffer.length < 1 || file.buffer.length > maxImageSize) return json({ error: 'Each image must be between 1 byte and 5 MB.' }, 422);
          const format = imageType(file.buffer, file.contentType);
          if (!format) return json({ error: 'Only valid JPG, PNG, and WEBP images are accepted.' }, 422);
          const filename = `${productId}_${crypto.randomUUID()}.${format}`;
          const contentType = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';
          const saved = await withPostgresExternalCall(() => mediaStore.putProductImage({ productId, filename, extension: format, contentType, body: file.buffer }));
          savedImages.push(saved.url);
        }
      } catch (error) {
        const mediaStore = getMediaStore();
        for (const image of savedImages) await withPostgresExternalCall(() => mediaStore.deleteProductImage(image)).catch(() => undefined);
        console.error('Product image upload failed:', error.message);
        return json({ error: 'Product images could not be saved.' }, 500);
      }

      const allImages = [...keepImages, ...savedImages];
      const newIndex = Number.parseInt(upload.fields.primaryNewIndex, 10);
      const requestedPrimary = upload.fields.primaryImage;
      const primary = requestedPrimary && allImages.includes(requestedPrimary) ? requestedPrimary : savedImages[newIndex] || allImages[0] || '';
      const orderedImages = primary ? [primary, ...allImages.filter(image => image !== primary)] : [];
      const updated = updateProduct(productId, { images: orderedImages, image: primary, imageUrl: primary });
      const removedImages = existingImages.filter(image => !keepImages.includes(image));
      await withPostgresExternalCall(async () => {
        const mediaStore = getMediaStore();
        for (const image of removedImages) await mediaStore.deleteProductImage(image);
      });
      return json({ data: updated });
    }

    if (method === 'GET' && path === '/api/admin/orders') {
      const store = readStore();
      const users = new Map(store.users.map(user => [user.id, safeAdminUser(user)]));
      return json({ data: listOrders().map(order => ({ ...order, customer: order.buyerId ? users.get(order.buyerId) || null : null })) });
    }

    if (path.startsWith('/api/admin/orders/')) {
      const orderId = decodeURIComponent(path.slice('/api/admin/orders/'.length));
      if (method === 'GET') {
        const order = getOrder(orderId);
        return order ? json({ data: order }) : json({ error: 'Order not found.' }, 404);
      }
      if (method === 'PATCH') {
        const body = await parseBody(request);
        const allowed = ['pending', 'placed', 'confirmed', 'processing', 'shipped', 'in_transit', 'out_for_delivery', 'delivered', 'cancelled', 'refunded'];
        if (body.status !== undefined && !allowed.includes(body.status)) return json({ error: 'Invalid order status.' }, 422);
        if (body.shippingStatus !== undefined && !allowed.includes(body.shippingStatus)) return json({ error: 'Invalid shipment status.' }, 422);
        if (body.trackingUrl !== undefined && body.trackingUrl !== '') {
          if (typeof body.trackingUrl !== 'string') return json({ error: 'Tracking URL must be a valid HTTPS URL.' }, 422);
          try {
            const trackingUrl = new URL(body.trackingUrl);
            if (trackingUrl.protocol !== 'https:' || !trackingUrl.hostname) return json({ error: 'Tracking URL must be a valid HTTPS URL.' }, 422);
          } catch {
            return json({ error: 'Tracking URL must be a valid HTTPS URL.' }, 422);
          }
        }

        const update = {};
        if (body.status !== undefined) update.status = body.status;
        const trackingFields = ['shippingCarrier', 'trackingNumber', 'trackingUrl', 'estimatedDeliveryDate', 'shippedAt', 'deliveredAt', 'shippingStatus', 'shipmentNotes'];
        for (const field of trackingFields) {
          if (Object.prototype.hasOwnProperty.call(body, field)) update[field] = body[field];
        }
        if (body.shipmentEvents !== undefined) update.shipmentEvents = Array.isArray(body.shipmentEvents) ? body.shipmentEvents : [];
        if (body.lastTrackingUpdateAt !== undefined) update.lastTrackingUpdateAt = body.lastTrackingUpdateAt;

        const order = updateOrder(orderId, update);
        if (!order) return json({ error: 'Order not found.' }, 404);

        const orderForEmail = getOrder(orderId);
        const shipmentStatus = orderForEmail?.status || body.status || order.status;
        if (orderForEmail && orderForEmail.shippingAddress?.email) {
          const eventType = shipmentStatus === 'shipped' ? 'shipped' : shipmentStatus === 'delivered' ? 'delivered' : shipmentStatus === 'in_transit' || shipmentStatus === 'out_for_delivery' ? 'in_transit' : 'updated';
          const emailDetails = {
            carrier: orderForEmail.shippingCarrier || body.shippingCarrier || '',
            trackingNumber: orderForEmail.trackingNumber || body.trackingNumber || '',
            trackingUrl: orderForEmail.trackingUrl || body.trackingUrl || '',
            estimatedDeliveryDate: orderForEmail.estimatedDeliveryDate || body.estimatedDeliveryDate || ''
          };

          try {
            await processOrderTrackingCustomerEmail(orderForEmail, eventType, emailDetails);
          } catch (error) {
            console.error('Customer tracking email failed:', error.message);
          }
        }
        return order ? json({ data: order }) : json({ error: 'Order not found.' }, 404);
      }
    }

    if (method === 'GET' && path === '/api/admin/customers') {
      const search = (url.searchParams.get('search') || '').toLowerCase();
      return json({ data: listUsers().filter(user => user.role === 'customer' && (!search || `${user.name} ${user.email}`.toLowerCase().includes(search))).map(safeAdminUser) });
    }

    if (path.startsWith('/api/admin/customers/')) {
      const customerId = decodeURIComponent(path.slice('/api/admin/customers/'.length));
      if (method === 'PATCH') {
        const body = await parseBody(request);
        if (!['active', 'disabled'].includes(body.status)) return json({ error: 'Invalid customer status.' }, 422);
        const customer = listUsers().find(user => user.id === customerId && user.role === 'customer');
        if (!customer) return json({ error: 'Customer not found.' }, 404);
        return json({ data: safeAdminUser(updateUser(customerId, { status: body.status })) });
      }
    }

    if (method === 'GET' && path === '/api/admin/suppliers') return json({ data: listSuppliers() });

    if (path.startsWith('/api/admin/suppliers/')) {
      const supplierId = decodeURIComponent(path.slice('/api/admin/suppliers/'.length));
      if (method === 'PATCH') {
        const body = await parseBody(request);
        if (!['pending_review', 'approved', 'suspended'].includes(body.status)) return json({ error: 'Invalid supplier status.' }, 422);
        const supplier = updateSupplier(supplierId, { status: body.status, verificationStatus: body.status });
        return supplier ? json({ data: supplier }) : json({ error: 'Supplier not found.' }, 404);
      }
    }

    if (method === 'GET' && path === '/api/admin/categories') return json({ data: listAdminCategories() });

    if (method === 'POST' && path === '/api/admin/categories') {
      const body = await parseBody(request);
      if (typeof body.name !== 'string' || !body.name.trim()) return json({ error: 'Category name is required.' }, 422);
      if (listAdminCategories().some(category => category.name.toLowerCase() === body.name.trim().toLowerCase())) return json({ error: 'Category already exists.' }, 409);
      return json({ data: createCategory({ name: body.name.trim() }) }, 201);
    }

    if (path.startsWith('/api/admin/categories/')) {
      const categoryId = decodeURIComponent(path.slice('/api/admin/categories/'.length));
      if (method === 'PATCH') {
        const body = await parseBody(request);
        if (typeof body.name !== 'string' || !body.name.trim()) return json({ error: 'Category name is required.' }, 422);
        const category = updateCategory(categoryId, { name: body.name.trim() });
        return category ? json({ data: category }) : json({ error: 'Category not found or system category.' }, 404);
      }
      if (method === 'DELETE') {
        const category = deleteCategory(categoryId);
        return category ? json({ data: { deleted: true, id: category.id } }) : json({ error: 'Category not found or still used by products.' }, 409);
      }
    }

    if (method === 'GET' && path === '/api/admin/payments') {
      const payments = listOrders().filter(order => order.paymentStatus || order.stripePaymentIntentId || order.paypalOrderId).map(order => ({ id: order.stripePaymentIntentId || order.paypalCaptureId || order.paypalOrderId || order.stripeSessionId || order.id, orderId: order.id, provider: order.paymentProvider || (order.stripeSessionId ? 'stripe' : 'unknown'), amount: Number(order.totalAmount || 0) / 100, currency: order.currency || 'USD', status: order.paymentStatus || 'unknown', createdAt: order.createdAt }));
      return json({ data: payments, available: payments.length > 0 });
    }

    if (method === 'GET' && path === '/api/admin/reviews') {
      const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
      const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '50', 10) || 50));
      const result = listReviews({ offset: (page - 1) * pageSize, limit: pageSize });
      const store = readStore();
      const users = new Map(store.users.map(user => [user.id, user]));
      const products = new Map(store.products.map(product => [product.id, product]));
      return json({ data: result.data.map(review => ({ ...publicReview(review, { includeStatus: true }), productName: products.get(review.productId)?.name || 'Removed product', customer: { name: users.get(review.authorId)?.name || review.authorName || 'LEXORA customer', email: users.get(review.authorId)?.email || '' } })), total: result.total, page, pageSize });
    }

    const adminReviewMatch = path.match(/^\/api\/admin\/reviews\/([^/]+)$/);
    if (adminReviewMatch && method === 'PATCH') {
      const reviewId = decodeURIComponent(adminReviewMatch[1]);
      const parsed = await parseReviewBody(request);
      if (parsed.error) return parsed.error;
      const body = parsed.body;
      if (!['pending', 'approved', 'hidden'].includes(body.status)) return json({ error: 'Review status must be pending, approved, or hidden.' }, 422);
      const review = updateReview(reviewId, { status: body.status });
      return review ? json({ data: publicReview(review, { includeStatus: true }) }) : json({ error: 'Review not found.' }, 404);
    }
    if (adminReviewMatch && method === 'DELETE') {
      const review = deleteReview(decodeURIComponent(adminReviewMatch[1]));
      return review ? json({ data: { deleted: true } }) : json({ error: 'Review not found.' }, 404);
    }

    if (method === 'GET' && path === '/api/admin/rfqs') return json({ data: listRfqs() });

    if (method === 'GET' && path === '/api/admin/messages') return json({ data: [], available: false, message: 'This runtime repository does not contain this feature yet.' });

    return json({ error: 'Admin route not found.' }, 404);
  }

  if (method === 'GET' && path === '/api/products') {
    return json({
      data: listProducts({
        search: url.searchParams.get('search'),
        category: url.searchParams.get('category'),
        location: url.searchParams.get('location'),
        verified: url.searchParams.get('verified') === 'true'
      })
    });
  }

  if (method === 'GET' && path === '/api/categories') {
    return json({ data: listCategories() });
  }

  if (method === 'GET' && path === '/api/visual-search') {
    return json({ data: { provider: visualSearchProviderMode(), maxUploadBytes: maxVisualSearchImageSize, acceptedTypes: Object.keys(visualSearchMimeFormats) } });
  }

  if (method === 'POST' && path === '/api/visual-search') {
    let multipart;
    try {
      multipart = await parseMultipart(request, { maxBytes: maxVisualSearchImageSize + 512 * 1024 });
    } catch (error) {
      const status = /too large/i.test(error.message) ? 413 : 400;
      return json({ error: status === 413 ? 'The image exceeds the 5 MB limit.' : 'Upload a single JPG, PNG, or WEBP image.' }, status);
    }
    const productId = String(multipart.fields.productId || '').trim();
    const sourceProduct = productId ? listProducts().find(product => String(product.id) === productId && (product.status || 'active') === 'active') : null;
    if (multipart.files.length === 0 && productId) {
      if (!sourceProduct) return json({ error: 'Catalog product not found.' }, 404);
    } else if (multipart.files.length !== 1 || multipart.files[0].fieldName !== 'image' || productId) {
      return json({ error: 'Upload one image using the image field or provide a catalog product ID.' }, 400);
    }
    let upload = null;
    let format = null;
    if (multipart.files.length) {
      upload = multipart.files[0];
      if (!upload.buffer.length) return json({ error: 'The image is empty.' }, 422);
      if (upload.buffer.length > maxVisualSearchImageSize) return json({ error: 'The image exceeds the 5 MB limit.' }, 413);
      format = identifyImageFormat(upload.filename, upload.contentType);
      if (!format) return json({ error: 'Only JPG, PNG, and WEBP images are supported.' }, 415);
      if (imageType(upload.buffer, upload.contentType) !== format) {
        return json({ error: 'The file extension, MIME type, and image contents must match.' }, 415);
      }
    }

    try {
      const searchOptions = {
        buffer: upload?.buffer,
        format,
        sourceProduct,
        products: listProducts(),
        imageDirectory: productUploadDir,
        loadCatalogImage: product => getMediaStore().readCatalogImage(product),
        hasCatalogImage: product => [...(Array.isArray(product.images) ? product.images : []), product.image, product.imageUrl].some(reference => getMediaStore().hasProductImage(reference))
      };
      const result = await withPostgresExternalCall(() => searchVisualCatalog(searchOptions));
      return json({ success: true, data: result });
    } catch (error) {
      const status = /provider/i.test(error.message) ? 503 : 422;
      return json({ error: status === 503 ? error.message : 'We could not analyze this image. Try another clear product photo.' }, status);
    }
  }

  if (method === 'GET' && path === '/api/suppliers') {
    return json({ data: listSuppliers().map(publicSupplierSnapshot) });
  }

  if (method === 'GET' && path.startsWith('/api/suppliers/')) {
    const supplierId = decodeURIComponent(path.slice('/api/suppliers/'.length));
    const supplier = findSupplierById(supplierId);
    if (!supplier) return json({ error: 'Supplier not found.' }, 404);
    const products = readStore().products.filter(product => String(product.supplierId || '') === String(supplier.id) || (!product.supplierId && String(product.supplier || '').toLowerCase() === String(supplier.businessName || supplier.companyName || '').toLowerCase()));
    const verified = String(supplier.verificationStatus || supplier.status || 'pending') === 'approved';
    return json({ data: {
      ...publicSupplierSnapshot(supplier),
      businessName: supplier.businessName || supplier.companyName || 'Supplier',
      companyName: supplier.companyName || supplier.businessName || 'Supplier',
      description: supplier.description || supplier.businessDescription || '',
      verified,
      productCount: products.length,
      products: products.map(product => ({
        id: product.id,
        name: product.name,
        category: product.category || '',
        supplier: product.supplier || supplier.businessName || supplier.companyName || 'Supplier',
        location: product.location || supplier.country || 'Global',
        description: product.description || '',
        price: Number(product.price || 0),
        wholesalePrice: Number(product.wholesalePrice || 0),
        moq: Number(product.moq || 1),
        stock: Number(product.stock || 0),
        status: product.status || 'active',
        image: product.image || product.imageUrl || ''
      }))
    } });
  }

  if (method === 'GET' && path === '/api/supplier/dashboard') {
    const sessionUser = requireRole(request);
    if (!sessionUser) return json({ error: 'Authentication required.' }, 401);
    if (sessionUser.role !== 'supplier') return json({ error: 'Supplier access required.' }, 403);
    const supplier = findSupplierByOwnerId(sessionUser.sub);
    if (!supplier) return json({ error: 'Supplier profile not found.' }, 404);
    const ownerUser = listUsers().find(entry => entry.id === sessionUser.sub) || { id: sessionUser.sub, email: '', name: '', role: 'supplier' };
    return json({ data: supplierDashboardSnapshot(supplier, ownerUser) });
  }

  if (path === '/api/supplier/profile' && ['GET', 'PATCH'].includes(method)) {
    const sessionUser = requireRole(request);
    if (!sessionUser) return json({ error: 'Authentication required.' }, 401);
    if (sessionUser.role !== 'supplier') return json({ error: 'Supplier access required.' }, 403);
    const supplier = findSupplierByOwnerId(sessionUser.sub);
    if (!supplier) return json({ error: 'Supplier profile not found.' }, 404);
    if (method === 'GET') return json({ data: supplierProfileSnapshot(supplier) });

    const parsed = supplierProfileInput(await parseBody(request));
    if (parsed.error) return json({ error: parsed.error }, 422);
    const updated = updateSupplier(supplier.id, parsed.updates);
    return json({ data: supplierProfileSnapshot(updated) });
  }

  if (method === 'POST' && path === '/api/supplier/products') {
    const sessionUser = requireRole(request);
    if (!sessionUser) return json({ error: 'Authentication required.' }, 401);
    if (sessionUser.role !== 'supplier') return json({ error: 'Supplier access required.' }, 403);
    const supplier = findSupplierByOwnerId(sessionUser.sub);
    if (!supplier) return json({ error: 'Supplier profile not found.' }, 404);
    const body = await parseBody(request);
    const result = productInput(body, { partial: false });
    if (result.error) return json({ error: result.error }, 422);
    const product = createProduct({ ...result.updates, supplierId: supplier.id, supplier: supplier.businessName || supplier.companyName || 'Supplier', location: supplier.country || String(result.updates.location || '').trim() || 'Global', verified: String(supplier.verificationStatus || supplier.status || 'pending') === 'approved', status: result.updates.status || 'active' });
    return json({ data: product }, 201);
  }

  if (path.startsWith('/api/supplier/products/') && ['PATCH', 'DELETE'].includes(method)) {
    const sessionUser = requireRole(request);
    if (!sessionUser) return json({ error: 'Authentication required.' }, 401);
    if (sessionUser.role !== 'supplier') return json({ error: 'Supplier access required.' }, 403);
    const productId = decodeURIComponent(path.slice('/api/supplier/products/'.length));
    const product = getProduct(productId);
    if (!product) return json({ error: 'Product not found.' }, 404);
    if (!supplierOwnsProduct(product, sessionUser)) return json({ error: 'You do not have access to this product.' }, 403);
    if (method === 'DELETE') {
      if (hasProductOrders(productId)) return json({ error: 'This product is referenced by an existing order and cannot be deleted. Mark it inactive instead.' }, 409);
      deleteProduct(productId);
      return json({ data: { deleted: true, id: productId } });
    }
    const body = await parseBody(request);
    const result = productInput(body, { partial: true });
    if (result.error) return json({ error: result.error }, 422);
    const updated = updateProduct(productId, { ...result.updates, supplierId: product.supplierId || findSupplierByOwnerId(sessionUser.sub)?.id || product.supplierId, supplier: product.supplier, location: product.location, verified: product.verified });
    return json({ data: updated });
  }

  if (method === 'PATCH' && path.startsWith('/api/admin/suppliers/')) {
    const sessionUser = requireRole(request);
    if (!sessionUser) return json({ error: 'Authentication required.' }, 401);
    if (sessionUser.role !== 'admin') return json({ error: 'Administrator access required.' }, 403);
    const supplierId = decodeURIComponent(path.slice('/api/admin/suppliers/'.length));
    const body = await parseBody(request);
    const allowedStates = ['pending', 'pending_review', 'approved', 'suspended'];
    const normalizedStatus = body.status === 'pending_review' ? 'pending' : body.status;
    if (!allowedStates.includes(body.status) && !allowedStates.includes(normalizedStatus)) return json({ error: 'Invalid supplier status.' }, 422);
    const supplier = findSupplierById(supplierId);
    if (!supplier) return json({ error: 'Supplier not found.' }, 404);
    const updated = updateSupplier(supplierId, { status: normalizedStatus, verificationStatus: normalizedStatus, verified: normalizedStatus === 'approved' });
    return json({ data: updated });
  }

  if (path === '/api/wishlist' && method === 'GET') {
    const user = requireRole(request, ['customer']);
    if (!user) return json({ error: 'Customer sign-in is required to access your wishlist.' }, 401);
    const data = listWishlist(user.sub).map(({ customerId, ...item }) => item);
    return json({ data });
  }

  const wishlistProductMatch = path.match(/^\/api\/wishlist\/([^/]+)$/);
  if (wishlistProductMatch && ['POST', 'DELETE'].includes(method)) {
    const user = requireRole(request, ['customer']);
    if (!user) return json({ error: 'Customer sign-in is required to update your wishlist.' }, 401);
    let productId;
    try { productId = decodeURIComponent(wishlistProductMatch[1]); } catch { return json({ error: 'Invalid product ID.' }, 400); }
    if (!productId || productId.length > 200) return json({ error: 'Invalid product ID.' }, 400);
    if (method === 'POST') {
      const result = addWishlistItem(user.sub, productId);
      if (!result.ok) return json({ error: result.error }, 404);
      return json({ data: { productId: result.item.productId, createdAt: result.item.createdAt, added: result.added } }, result.added ? 201 : 200);
    }
    const removed = removeWishlistItem(user.sub, productId);
    return removed ? json({ data: { productId, removed: true } }) : json({ error: 'Wishlist item not found.' }, 404);
  }

  const productReviewsMatch = path.match(/^\/api\/products\/([^/]+)\/reviews$/);
  if (productReviewsMatch) {
    const productId = decodeURIComponent(productReviewsMatch[1]);
    if (!getProduct(productId)) return json({ error: 'Product not found.' }, 404);
    if (method === 'GET') {
      const sort = ['recent', 'highest', 'lowest'].includes(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'recent';
      const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
      const pageSize = Math.min(20, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '10', 10) || 10));
      const result = listReviews({ productId, status: 'approved', sort, offset: (page - 1) * pageSize, limit: pageSize });
      const viewer = requireRole(request, ['customer']);
      const myReview = viewer ? listReviews({ productId, customerId: viewer.sub, limit: 1 }).data[0] : null;
      const productReviews = readStore().reviews;
      return json({ data: { reviews: result.data.map(review => publicReview(review)), total: result.total, page, pageSize, summary: summarizeProductReviews(productReviews, productId), eligible: Boolean(viewer && customerPurchasedProduct(viewer, productId)), myReview: myReview ? publicReview(myReview, { includeStatus: true }) : null } });
    }
    if (method === 'POST') {
      const user = requireRole(request, ['customer']);
      if (!user) return json({ error: 'Customer sign-in is required to write a review.' }, 401);
      const parsed = await parseReviewBody(request);
      if (parsed.error) return parsed.error;
      const body = parsed.body;
      const input = reviewInput(body);
      if (input.error) return json({ error: input.error }, 422);
      if (!customerPurchasedProduct(user, productId)) return json({ error: 'A verified paid purchase of this product is required to write a review.' }, 403);
      const author = listUsers().find(entry => entry.id === user.sub);
      const created = createReview({ productId, authorId: user.sub, authorName: String(author?.name || 'LEXORA customer').trim().slice(0, 100), ...input.updates, verifiedPurchase: true, status: 'pending' });
      if (!created.ok) return json({ error: 'You have already reviewed this product. Edit your existing review instead.' }, 409);
      return json({ data: publicReview(created.review, { includeStatus: true }) }, 201);
    }
  }

  const customerReviewMatch = path.match(/^\/api\/reviews\/([^/]+)$/);
  if (customerReviewMatch && ['PUT', 'PATCH', 'DELETE'].includes(method)) {
    const user = requireRole(request, ['customer']);
    if (!user) return json({ error: 'Customer sign-in is required.' }, 401);
    const reviewId = decodeURIComponent(customerReviewMatch[1]);
    const existing = getReview(reviewId);
    if (!existing) return json({ error: 'Review not found.' }, 404);
    if (existing.authorId !== user.sub) return json({ error: 'You do not have access to this review.' }, 403);
    if (method === 'DELETE') {
      deleteReview(reviewId);
      return json({ data: { deleted: true } });
    }
    const parsed = await parseReviewBody(request);
    if (parsed.error) return parsed.error;
    const body = parsed.body;
    const input = reviewInput(body);
    if (input.error) return json({ error: input.error }, 422);
    const review = updateReview(reviewId, { ...input.updates, status: 'pending' });
    return json({ data: publicReview(review, { includeStatus: true }) });
  }

  if (method === 'GET' && path.startsWith('/api/products/')) {
    const productId = decodeURIComponent(path.split('/').filter(Boolean).slice(2).join('/'));
    const product = getProduct(productId);
    return product ? json({ data: product }) : json({ error: 'Product not found' }, 404);
  }

  if (method === 'POST' && path === '/api/auth/register') {
    const body = await parseBody(request);
    const missing = required(body, ['email', 'password', 'name']);

    if (missing.length || !emailPattern.test(body.email) || String(body.password).length < 12) {
      return json({ error: 'Name, valid email, and a password of at least 12 characters are required.' }, 422);
    }

    if (findUserByEmail(body.email)) {
      return json({ error: 'An account already exists for this email.' }, 409);
    }

    const role = body.role === 'supplier' ? 'supplier' : 'customer';
    const user = createUser({
      email: String(body.email).toLowerCase(),
      name: String(body.name).trim(),
      role,
      passwordHash: hashPassword(String(body.password))
    });

    if (role === 'supplier') {
      const supplierBody = {
        ownerId: user.id,
        businessName: String(body.businessName || body.companyName || body.name || '').trim(),
        companyName: String(body.companyName || body.businessName || body.name || '').trim(),
        ownerName: String(body.fullName || body.name || '').trim(),
        phone: String(body.phone || '').trim(),
        country: String(body.country || '').trim(),
        state: String(body.state || '').trim(),
        city: String(body.city || '').trim(),
        businessAddress: String(body.businessAddress || body.address || '').trim(),
        description: String(body.businessDescription || body.description || '').trim(),
        businessDescription: String(body.businessDescription || body.description || '').trim(),
        categories: Array.isArray(body.categories) ? body.categories : [],
        verificationStatus: 'pending',
        status: 'pending',
        verified: false,
        createdByRegistration: true
      };
      if (!supplierBody.businessName) supplierBody.businessName = String(body.name).trim();
      if (!supplierBody.companyName) supplierBody.companyName = supplierBody.businessName;
      if (!supplierBody.description) supplierBody.description = 'Wholesale supplier profile pending approval.';
      if (!supplierBody.businessDescription) supplierBody.businessDescription = supplierBody.description;
      createSupplier(supplierBody);
    }

    return json({ data: { user: safeUser(user), token: issueToken(user) } }, 201);
  }

  if (method === 'POST' && path === '/api/auth/login') {
    const body = await parseBody(request);
    const user = findUserByEmail(String(body.email || ''));

    if (!user || !body.password || !verifyPassword(body.password, user.passwordHash)) {
      return json({ error: 'Invalid email or password.' }, 401);
    }

    return json({ data: { user: safeUser(user), token: issueToken(user) } });
  }

  if (method === 'GET' && path === '/api/me') {
    const user = requireRole(request);
    const account = user && listUsers().find(entry => entry.id === user.sub);
    return user ? json({ data: account ? safeUser(account) : user }) : json({ error: 'Authentication required.' }, 401);
  }

  if (method === 'POST' && path === '/api/auth/logout') {
    const user = requireRole(request, ['customer', 'supplier', 'admin']);
    if (!user) return json({ error: 'Authentication required.' }, 401);

    const authHeader = request.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) return json({ error: 'Authentication required.' }, 401);

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const revoked = deleteSession(tokenHash);
    return json({ data: { loggedOut: true, revoked } });
  }

  if (path === '/api/addresses' && ['GET', 'POST'].includes(method)) {
    const user = requireRole(request, ['customer']);
    if (!user) return json({ error: 'Customer sign-in is required to access saved addresses.' }, 401);
    if (method === 'GET') return json({ data: listAddresses(user.sub).map(publicAddress) });
    const parsed = await parseAddressBody(request);
    if (parsed.error) return parsed.error;
    const input = addressInput(parsed.body);
    if (input.error) return json({ error: input.error }, 422);
    return json({ data: publicAddress(createAddress(user.sub, input.updates)) }, 201);
  }

  const defaultAddressMatch = path.match(/^\/api\/addresses\/([^/]+)\/default$/);
  if (defaultAddressMatch && method === 'POST') {
    const user = requireRole(request, ['customer']);
    if (!user) return json({ error: 'Customer sign-in is required.' }, 401);
    let addressId;
    try { addressId = decodeURIComponent(defaultAddressMatch[1]); } catch { return json({ error: 'Address not found.' }, 404); }
    const address = setDefaultAddress(user.sub, addressId);
    return address ? json({ data: publicAddress(address) }) : json({ error: 'Address not found.' }, 404);
  }

  const addressMatch = path.match(/^\/api\/addresses\/([^/]+)$/);
  if (addressMatch && ['PUT', 'PATCH', 'DELETE'].includes(method)) {
    const user = requireRole(request, ['customer']);
    if (!user) return json({ error: 'Customer sign-in is required.' }, 401);
    let addressId;
    try { addressId = decodeURIComponent(addressMatch[1]); } catch { return json({ error: 'Address not found.' }, 404); }
    const existing = getAddress(user.sub, addressId);
    if (!existing) return json({ error: 'Address not found.' }, 404);
    if (method === 'DELETE') {
      deleteAddress(user.sub, addressId);
      return json({ data: { deleted: true, id: addressId } });
    }
    const parsed = await parseAddressBody(request);
    if (parsed.error) return parsed.error;
    const input = addressInput(parsed.body, { partial: true });
    if (input.error) return json({ error: input.error }, 422);
    const merged = addressInput({
      label: existing.label,
      fullName: existing.fullName,
      phone: existing.phone,
      addressLine1: existing.addressLine1,
      addressLine2: existing.addressLine2 || '',
      city: existing.city,
      state: existing.state,
      postalCode: existing.postalCode,
      country: existing.country,
      ...input.updates
    });
    if (merged.error) return json({ error: merged.error }, 422);
    const address = updateAddress(user.sub, addressId, merged.updates);
    return address ? json({ data: publicAddress(address) }) : json({ error: 'Address not found.' }, 404);
  }

  if (method === 'POST' && path === '/api/webhook') {
    if (!stripe || !stripeWebhookSecret) {
      return json({ error: 'Stripe webhook is not configured.' }, 503);
    }

    const signature = request.headers['stripe-signature'];
    const rawBody = await parseBody(request, { raw: true });

    if (!signature) {
      return json({ error: 'Missing Stripe signature.' }, 400);
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, stripeWebhookSecret);
    } catch {
      return json({ error: 'Invalid Stripe signature.' }, 400);
    }
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      try {
        await verifiedOrderFromSession(event.data.object);
      } catch (error) {
        console.error('Stripe paid order finalization failed:', safeStripeErrorMessage(error));
        return json({ error: 'Verified payment could not be finalized. The event can be retried safely.' }, 409);
      }
    }
    return json({ received: true, type: event.type }, 200);
  }

  if (method === 'POST' && path === '/api/checkout') {
    const body = await parseBody(request);
    const user = requireRole(request, ['customer', 'supplier', 'admin']);
    const isGuestCheckout = !request.headers.authorization && body.guest === true;

    if (!user && !isGuestCheckout) {
      return json({ error: 'Authentication required.' }, 401);
    }

    const addressResult = checkoutShippingAddress(user, body);
    if (addressResult.error) return addressResult.error;
    const shippingAddress = addressResult.shippingAddress;
    const cart = checkoutItems(body.items);
    if (cart.error) return json({ error: cart.error }, 422);
    if (!stripe) {
      return json({ error: 'Stripe is not configured. Add a valid STRIPE_SECRET_KEY in the server environment to enable checkout.' }, 503);
    }

    const inventoryReservationId = `inv_${crypto.randomUUID()}`;
    const reservation = reserveInventory(inventoryReservationId, cart.items, { provider: 'stripe' });
    if (!reservation.ok) return json({ error: reservation.error }, 409);

    const lineItems = cart.items.map(item => ({
        price_data: {
          currency: 'usd',
          product_data: { name: item.name },
          unit_amount: item.unitCents
        },
        quantity: item.quantity
      }));

    try {
      const session = await withPostgresExternalCall(() => stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: lineItems,
        submit_type: 'pay',
        shipping_address_collection: {
          allowed_countries: ['US', 'GB', 'AE', 'JP', 'IT', 'DK', 'CA', 'AU', 'FR', 'DE', 'ES', 'NL', 'SE', 'NO', 'FI', 'IE', 'NZ']
        },
        success_url: `${origin}/checkout-success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/checkout-cancelled.html`,
        client_reference_id: String(user ? user.sub : 'guest-checkout'),
        customer_email: shippingAddress.email || undefined,
        metadata: {
          userId: String(user ? user.sub : 'guest-checkout'),
          isGuest: String(isGuestCheckout),
          shippingName: shippingAddress?.fullName || '',
          shippingPhone: shippingAddress?.phone || '',
          shippingAddressLine1: shippingAddress?.addressLine1 || '',
          shippingAddressLine2: shippingAddress?.addressLine2 || '',
          shippingCity: shippingAddress?.city || '',
          shippingState: shippingAddress?.state || '',
          shippingCountry: shippingAddress?.country || '',
          shippingPostalCode: shippingAddress?.postalCode || '',
          cartItems: JSON.stringify(cart.items.map(item => ({ productId: item.productId, quantity: item.quantity }))),
          inventoryReservationId
        }
      }));

      return json({
        data: {
          checkoutUrl: session.url,
          sessionId: session.id,
          inventoryReservationId
        }
      }, 201);
    } catch (error) {
      releaseInventoryReservation(inventoryReservationId);
      console.error('Stripe checkout session creation failed:', safeStripeErrorMessage(error));
      return json({ error: 'Stripe checkout failed. Verify the Stripe test key and Stripe account configuration.' }, 502);
    }
  }

  if (method === 'GET' && path.startsWith('/api/checkout/session/')) {
    const sessionId = decodeURIComponent(path.slice('/api/checkout/session/'.length));

    if (!stripe) {
      return json({ error: 'Stripe is not configured.' }, 503);
    }

    try {
      const session = await retrievePaidCheckoutSession(sessionId);
      if (!session) return json({ error: 'Payment has not been verified.' }, 402);

      const order = await verifiedOrderFromSession(session);
      return json({ data: { order, paymentStatus: session.payment_status } });
    } catch (error) {
      console.error('Stripe checkout verification failed:', safeStripeErrorMessage(error));
      return json({ error: 'Unable to verify this payment.' }, 502);
    }
  }

  if (method === 'POST' && path === '/api/orders') {
    const user = requireRole(request, ['customer', 'supplier', 'admin']);
    if (!user) return json({ error: 'Authentication required.' }, 401);

    const body = await parseBody(request);
    if (!Array.isArray(body.items) || !body.items.length || !body.shippingAddress) {
      return json({ error: 'Order items and shipping address are required.' }, 422);
    }

    return json({
      data: createOrder({
        buyerId: user.sub,
        items: body.items,
        shippingAddress: body.shippingAddress,
        currency: body.currency || 'USD',
        paymentStatus: 'pending'
      })
    }, 201);
  }

  if (method === 'GET' && path === '/api/orders') {
    const user = requireRole(request, ['customer', 'supplier', 'admin']);
    if (!user) return json({ error: 'Authentication required.' }, 401);
    const scope = user.role === 'admin' ? listOrders() : listOrders().filter(order => customerOwnsOrder(order, user));
    return json({ data: scope.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)) });
  }

  if (method === 'GET' && path.startsWith('/api/orders/')) {
    const user = requireRole(request, ['customer', 'supplier', 'admin']);
    if (!user) return json({ error: 'Authentication required.' }, 401);
    const orderId = decodeURIComponent(path.slice('/api/orders/'.length));
    const order = getOrder(orderId);
    if (!order) return json({ error: 'Order not found.' }, 404);
    if (user.role !== 'admin' && !customerOwnsOrder(order, user)) return json({ error: 'You do not have access to this order.' }, 403);
    return json({ data: order });
  }

  if (method === 'POST' && path === '/api/rfqs') {
    const user = requireRole(request, ['customer', 'supplier', 'admin']);
    if (!user) return json({ error: 'Authentication required.' }, 401);

    const body = await parseBody(request);
    const missing = required(body, ['productRequired', 'quantity', 'shippingDestination']);

    if (missing.length) {
      return json({ error: `Missing fields: ${missing.join(', ')}` }, 422);
    }

    return json({
      data: createRfq({
        buyerId: user.sub,
        productRequired: String(body.productRequired).trim(),
        quantity: Number(body.quantity),
        targetPrice: Number(body.targetPrice || 0),
        shippingDestination: String(body.shippingDestination).trim(),
        requirements: String(body.requirements || '')
      })
    }, 201);
  }

  if (method === 'POST' && path === '/api/suppliers/apply') {
    const user = requireRole(request, ['supplier', 'admin']);
    if (!user) return json({ error: 'Supplier authentication required.' }, 401);

    const body = await parseBody(request);
    const missing = required(body, ['businessName', 'country', 'businessType', 'description']);

    if (missing.length) {
      return json({ error: `Missing fields: ${missing.join(', ')}` }, 422);
    }

    return json({
      data: createSupplier({
        ownerId: user.sub,
        businessName: String(body.businessName).trim(),
        country: String(body.country).trim(),
        businessType: String(body.businessType).trim(),
        description: String(body.description).trim(),
        categories: Array.isArray(body.categories) ? body.categories : []
      })
    }, 201);
  }

  return json({ error: 'Route not found.' }, 404);
}

function createServer({ postgresPool, postgresStoreAdapter } = {}) {
  const postgresOptions = {
    ...(postgresPool ? { pool: postgresPool } : {}),
    ...(postgresStoreAdapter ? { storeAdapter: postgresStoreAdapter } : {})
  };
  return http.createServer(async (request, response) => {
    try {
      let result;
      if (getStorageMode() === 'postgres') {
        const isReadRequest = request.method === 'GET' && !String(request.url || '').startsWith('/api/checkout/session/');
        result = await withPostgresStore(() => route(request), { ...postgresOptions, lockMode: isReadRequest ? 'shared' : 'exclusive' });
      } else {
        result = await route(request);
      }
      send(response, result);
    } catch (error) {
      console.error(error);
      send(response, { status: 500, body: JSON.stringify({ error: 'Internal server error.' }) });
    }
  });
}

if (require.main === module) {
  const server = createServer();
  const start = async () => {
    const storageMode = getStorageMode();
    if (process.env.NODE_ENV === 'production' && storageMode !== 'postgres') {
      throw new Error('STORAGE_MODE=postgres is required in production.');
    }
    if (storageMode === 'postgres') {
      if (process.env.NODE_ENV === 'production') assertProductionMediaConfigured();
      if (!getDatabaseUrl()) throw new Error('DATABASE_URL is required when STORAGE_MODE=postgres.');
      const health = await pingDatabase();
      if (!health.ok) throw new Error('PostgreSQL is not reachable; refusing production startup.');
      await require('./db/migrate').runMigrations();
      if (process.env.NODE_ENV === 'production') {
        const { createPool } = require('./db/postgres');
        const bootstrapPool = createPool();
        try {
          const result = await bootstrapPool.query('SELECT success FROM migration_import_runs ORDER BY completed_at DESC, id DESC LIMIT 1');
          if (!result.rows[0]?.success) throw new Error('Production PostgreSQL has no successful verified JSON import; run npm run db:import-json and resolve all reported errors before startup.');
        } finally {
          await bootstrapPool.end();
        }
      }
    }
    server.listen(port, () => {
      console.log(`LEXORA API listening on http://localhost:${port}`);
    });
  };
  start().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { route, createServer, port, origin, verifiedOrderFromSession };
