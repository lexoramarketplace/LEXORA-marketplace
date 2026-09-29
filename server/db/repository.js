const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getStorageMode } = require('./postgres');
const { getPostgresRequestContext } = require('./postgres-store');

const dataFile = process.env.LEXORA_DATA_FILE || path.join(process.cwd(), 'data', 'dev.json');
const seed = {
  users: [],
  products: [
    { id: 'prod_vela', name: 'Vela sculptural table lamp', category: 'Home & Furniture', price: 420, wholesalePrice: 280, moq: 10, supplier: 'Atelier Nera', location: 'Italy', verified: true, rating: 4.9, reviews: 38, stock: 120, lowStockThreshold: 5 },
    { id: 'prod_kanso', name: 'Kanso travel case', category: 'Bags & Accessories', price: 185, wholesalePrice: 112, moq: 25, supplier: 'Kanso Works', location: 'Japan', verified: true, rating: 4.8, reviews: 64, stock: 220, lowStockThreshold: 5 },
    { id: 'prod_forma', name: 'Forma lounge chair', category: 'Home & Furniture', price: 890, wholesalePrice: 590, moq: 5, supplier: 'Nord Form', location: 'Denmark', verified: true, rating: 4.7, reviews: 21, stock: 42, lowStockThreshold: 5 }
  ],
  addresses: [],
  wishlist: [],
  suppliers: [],
  orders: [],
  reviews: [],
  rfqs: [],
  sessions: []
};

function ensureStore() {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, JSON.stringify(seed, null, 2));
}
function normalizeStore(store) {
  let changed = false;
  for (const collection of ['users', 'products', 'addresses', 'wishlist', 'suppliers', 'orders', 'reviews', 'rfqs', 'sessions', 'categories', 'pendingPayPalOrders', 'inventoryReservations', 'notifications']) {
    if (!Array.isArray(store[collection])) {
      store[collection] = [];
      changed = true;
    }
  }
  for (const product of store.products) {
    if (!Number.isSafeInteger(product.stock) || product.stock < 0) {
      product.stock = 0;
      changed = true;
    }
    if (!Number.isSafeInteger(product.lowStockThreshold) || product.lowStockThreshold < 0) {
      product.lowStockThreshold = 5;
      changed = true;
    }
  }
  if (changed) writeStore(store);
  return store;
}
function readStore() {
  const context = getPostgresRequestContext();
  if (context) return normalizeStore(context.state);
  if (getStorageMode() === 'postgres') {
    throw new Error('PostgreSQL repository access must run inside a PostgreSQL request transaction.');
  }
  ensureStore();
  return normalizeStore(JSON.parse(fs.readFileSync(dataFile, 'utf8')));
}
function writeStore(store) {
  const context = getPostgresRequestContext();
  if (context) {
    context.state = store;
    context.dirty = true;
    return;
  }
  if (getStorageMode() === 'postgres') {
    throw new Error('PostgreSQL repository writes must run inside a PostgreSQL request transaction.');
  }
  const temporaryFile = `${dataFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(store, null, 2));
  fs.renameSync(temporaryFile, dataFile);
}
function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function findUserByEmail(email) { return readStore().users.find(user => user.email === email.toLowerCase()); }
function createUser(user) { const store = readStore(); const record = { id: id('usr'), createdAt: new Date().toISOString(), ...user }; store.users.push(record); writeStore(store); return record; }
function listAddresses(customerId) { return readStore().addresses.filter(address => address.customerId === customerId).sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || new Date(right.createdAt) - new Date(left.createdAt)); }
function getAddress(customerId, addressId) { return readStore().addresses.find(address => address.customerId === customerId && address.id === addressId) || null; }
function createAddress(customerId, address) {
  const store = readStore();
  const isDefault = !store.addresses.some(entry => entry.customerId === customerId);
  const record = { id: id('adr'), customerId, ...address, isDefault, createdAt: new Date().toISOString(), updatedAt: null };
  store.addresses.push(record);
  writeStore(store);
  return record;
}
function updateAddress(customerId, addressId, updates) {
  const store = readStore();
  const address = store.addresses.find(entry => entry.customerId === customerId && entry.id === addressId);
  if (!address) return null;
  Object.assign(address, updates, { updatedAt: new Date().toISOString() });
  writeStore(store);
  return address;
}
function setDefaultAddress(customerId, addressId) {
  const store = readStore();
  const selected = store.addresses.find(entry => entry.customerId === customerId && entry.id === addressId);
  if (!selected) return null;
  const now = new Date().toISOString();
  for (const address of store.addresses) {
    if (address.customerId !== customerId) continue;
    const isSelected = address.id === addressId;
    if (address.isDefault !== isSelected) Object.assign(address, { isDefault: isSelected, updatedAt: now });
  }
  writeStore(store);
  return selected;
}
function deleteAddress(customerId, addressId) {
  const store = readStore();
  const index = store.addresses.findIndex(entry => entry.customerId === customerId && entry.id === addressId);
  if (index === -1) return null;
  const [deleted] = store.addresses.splice(index, 1);
  if (deleted.isDefault) {
    const replacement = store.addresses.filter(entry => entry.customerId === customerId).sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))[0];
    if (replacement) Object.assign(replacement, { isDefault: true, updatedAt: new Date().toISOString() });
  }
  writeStore(store);
  return deleted;
}
function createSession(session) { const store = readStore(); store.sessions.push(session); writeStore(store); return session; }
function findSession(tokenHash) { return readStore().sessions.find(session => session.tokenHash === tokenHash && new Date(session.expiresAt) > new Date()); }
function deleteSession(tokenHash) {
  const store = readStore();
  const before = store.sessions.length;
  store.sessions = store.sessions.filter(session => session.tokenHash !== tokenHash);
  if (store.sessions.length !== before) writeStore(store);
  return before !== store.sessions.length;
}
function availableStock(store, productId, excludingReservationId = null) {
  const reservations = (store.inventoryReservations || []).filter(reservation =>
    reservation.status === 'reserved' && reservation.id !== excludingReservationId && new Date(reservation.expiresAt) > new Date()
  );
  return reservations.reduce((reserved, reservation) => reserved + (reservation.items || []).reduce((sum, item) =>
    sum + (String(item.productId) === String(productId) ? Number(item.quantity || 0) : 0), 0), 0);
}
function productVerified(product, store) {
  const supplier = product.supplierId && store.suppliers.find(entry => String(entry.id) === String(product.supplierId));
  return supplier ? String(supplier.verificationStatus || supplier.status || 'pending').toLowerCase() === 'approved' : product.verified === true;
}

function listProducts(filters = {}) {
  const store = readStore();
  return store.products.map(product => {
    const reserved = availableStock(store, product.id);
    const summary = summarizeProductReviews(store.reviews, product.id);
    const result = { ...product, verified: productVerified(product, store), rating: summary.averageRating || null, reviews: summary.reviewCount, availableStock: Math.max(0, product.stock - reserved) };
    if (filters.includeReservationDetails) result.reservedStock = reserved;
    return result;
  }).filter(product => {
    const haystack = `${product.name} ${product.category} ${product.supplier} ${product.location}`.toLowerCase();
    return (!filters.search || haystack.includes(filters.search.toLowerCase())) && (!filters.category || product.category === filters.category) && (!filters.location || product.location === filters.location) && (!filters.verified || product.verified === true);
  });
}
function listCategories() {
  const store = readStore();
  const categories = new Map();
  store.products.forEach(product => {
    if (!categories.has(product.category)) categories.set(product.category, { id: `cat_${product.category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name: product.category, productCount: 0 });
    categories.get(product.category).productCount += 1;
  });
  return [...categories.values()];
}
function findSupplierById(supplierId) {
  return readStore().suppliers.find(supplier => String(supplier.id) === String(supplierId)) || null;
}
function findSupplierByOwnerId(ownerId) {
  return readStore().suppliers.find(supplier => String(supplier.ownerId) === String(ownerId)) || null;
}
function listSuppliers() {
  const store = readStore();
  const suppliers = new Map();
  for (const supplier of store.suppliers) {
    const normalized = {
      ...supplier,
      id: String(supplier.id),
      businessName: supplier.businessName || supplier.companyName || 'Supplier',
      companyName: supplier.companyName || supplier.businessName || 'Supplier',
      verificationStatus: supplier.verificationStatus || supplier.status || 'pending',
      status: supplier.status || supplier.verificationStatus || 'pending',
      productCount: 0,
      rating: supplier.rating || null
    };
    suppliers.set(String(supplier.id), normalized);
  }
  for (const product of store.products) {
    const productSupplier = product.supplierId ? findSupplierById(product.supplierId) : null;
    const key = productSupplier ? String(productSupplier.id) : `demo:${String(product.supplier || 'supplier')}`;
    if (!suppliers.has(key)) {
      suppliers.set(key, {
        id: productSupplier ? String(productSupplier.id) : `sup_demo_${String(product.supplier || 'supplier').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        businessName: product.supplier || 'Marketplace supplier',
        companyName: product.supplier || 'Marketplace supplier',
        country: product.location || 'Global',
        verificationStatus: product.verified ? 'approved' : 'pending',
        status: product.verified ? 'approved' : 'pending',
        productCount: 0,
        rating: product.rating || null,
        demo: true
      });
    }
    suppliers.get(key).productCount += 1;
    if (productSupplier && Number.isFinite(Number(product.rating))) suppliers.get(key).rating = Number(product.rating);
  }
  return [...suppliers.values()].map(supplier => ({ ...supplier, verified: String(supplier.verificationStatus || supplier.status || 'pending') === 'approved' }));
}
function getProduct(productId, { excludingReservationId = null } = {}) {
  const store = readStore();
  const product = store.products.find(entry => entry.id === productId);
  const reserved = product ? availableStock(store, product.id, excludingReservationId) : 0;
  const summary = product ? summarizeProductReviews(store.reviews, product.id) : null;
  return product ? { ...product, verified: productVerified(product, store), rating: summary.averageRating || null, reviews: summary.reviewCount, availableStock: Math.max(0, product.stock - reserved) } : undefined;
}

function summarizeProductReviews(reviews, productId) {
  const approved = (reviews || []).filter(review => review.productId === productId && review.status === 'approved');
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let ratingTotal = 0;
  for (const review of approved) {
    if (Number.isInteger(review.rating) && review.rating >= 1 && review.rating <= 5) {
      distribution[review.rating] += 1;
      ratingTotal += review.rating;
    }
  }
  const reviewCount = Object.values(distribution).reduce((total, count) => total + count, 0);
  return { averageRating: reviewCount ? Math.round((ratingTotal / reviewCount) * 10) / 10 : 0, reviewCount, distribution };
}

function listReviews({ productId, customerId, status, sort = 'recent', offset = 0, limit = 10 } = {}) {
  const reviews = readStore().reviews.filter(review =>
    (productId === undefined || review.productId === productId) &&
    (customerId === undefined || review.authorId === customerId) &&
    (status === undefined || review.status === status)
  );
  const sorters = {
    recent: (left, right) => new Date(right.createdAt) - new Date(left.createdAt),
    highest: (left, right) => right.rating - left.rating || new Date(right.createdAt) - new Date(left.createdAt),
    lowest: (left, right) => left.rating - right.rating || new Date(right.createdAt) - new Date(left.createdAt)
  };
  reviews.sort(sorters[sort] || sorters.recent);
  const start = Math.max(0, Number(offset) || 0);
  const pageSize = Math.min(50, Math.max(1, Number(limit) || 10));
  return { data: reviews.slice(start, start + pageSize), total: reviews.length };
}
function getReview(reviewId) { return readStore().reviews.find(review => review.id === reviewId) || null; }
function createReview(review) {
  const store = readStore();
  const existing = store.reviews.find(entry => entry.productId === review.productId && entry.authorId === review.authorId);
  if (existing) return { ok: false, review: existing };
  const record = { id: id('rev'), status: 'pending', createdAt: new Date().toISOString(), updatedAt: null, ...review };
  store.reviews.push(record);
  writeStore(store);
  return { ok: true, review: record };
}
function updateReview(reviewId, updates) {
  const store = readStore();
  const review = store.reviews.find(entry => entry.id === reviewId);
  if (!review) return null;
  Object.assign(review, updates, { updatedAt: new Date().toISOString() });
  writeStore(store);
  return review;
}
function deleteReview(reviewId) {
  const store = readStore();
  const index = store.reviews.findIndex(entry => entry.id === reviewId);
  if (index === -1) return null;
  const [review] = store.reviews.splice(index, 1);
  writeStore(store);
  return review;
}
function listWishlist(customerId) {
  const store = readStore();
  return store.wishlist.filter(item => item.customerId === customerId)
    .sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0))
    .map(item => {
      const product = store.products.find(entry => String(entry.id) === String(item.productId));
      if (!product) return { ...item, product: null };
      const reserved = availableStock(store, product.id);
      const summary = summarizeProductReviews(store.reviews, product.id);
      return {
        ...item,
        product: {
          id: product.id,
          name: product.name,
          category: product.category,
          supplier: product.supplier,
          location: product.location,
          image: product.image,
          imageUrl: product.imageUrl,
          images: product.images,
          price: product.price,
          wholesalePrice: product.wholesalePrice,
          moq: product.moq,
          status: product.status || 'active',
          availableStock: Math.max(0, product.stock - reserved),
          rating: summary.averageRating || null,
          reviews: summary.reviewCount
        }
      };
    });
}
function addWishlistItem(customerId, productId) {
  const store = readStore();
  if (!store.products.some(product => String(product.id) === productId)) return { ok: false, error: 'Product not found.' };
  const existing = store.wishlist.find(item => item.customerId === customerId && item.productId === productId);
  if (existing) return { ok: true, added: false, item: existing };
  const item = { customerId, productId, createdAt: new Date().toISOString() };
  store.wishlist.push(item);
  writeStore(store);
  return { ok: true, added: true, item };
}
function removeWishlistItem(customerId, productId) {
  const store = readStore();
  const index = store.wishlist.findIndex(item => item.customerId === customerId && item.productId === productId);
  if (index === -1) return false;
  store.wishlist.splice(index, 1);
  writeStore(store);
  return true;
}

function addInventoryNotification(store, product, previousStock, orderReference) {
  const threshold = Number.isSafeInteger(product.lowStockThreshold) ? product.lowStockThreshold : 5;
  const status = product.stock === 0 ? 'out_of_stock' : product.stock <= threshold ? 'low_stock' : null;
  const crossed = status === 'out_of_stock' ? previousStock > 0 : status === 'low_stock' && previousStock > threshold;
  if (!status || !crossed) return;
  const key = `inventory:${product.id}:${status}:${orderReference}`;
  if (store.notifications.some(notification => notification.key === key)) return;
  store.notifications.push({
    id: id('ntf'),
    key,
    productId: product.id,
    type: status,
    title: status === 'out_of_stock' ? 'Product out of stock' : 'Low product stock',
    message: `${product.name} has ${product.stock} unit(s) remaining.`,
    read: false,
    createdAt: new Date().toISOString()
  });
}
function createOrder(order) { const store = readStore(); const record = { id: id('ord'), status: 'placed', createdAt: new Date().toISOString(), ...order }; store.orders.push(record); writeStore(store); return record; }
function createNewOrderNotification(order) {
  const store = readStore();
  const existing = store.notifications.find(notification => notification.orderId === order.id && notification.type === 'new_order');
  if (existing) return existing;
  const itemSummary = (order.items || []).map(item => `${item.name || item.productId} x${item.quantity}`).join(', ');
  const customerName = order.shippingAddress?.fullName || 'Guest customer';
  const amount = (Number(order.totalAmount || 0) / 100).toFixed(2);
  const record = { id: id('ntf'), orderId: order.id, type: 'new_order', title: 'New Order', message: `Order #${order.id} · ${customerName} · ${itemSummary || 'Order items'} · ${amount} ${order.currency || 'USD'}`, read: false, readAt: null, createdAt: new Date().toISOString() };
  store.notifications.push(record);
  writeStore(store);
  return record;
}
function listNotifications({ unreadOnly = false } = {}) { const notifications = readStore().notifications.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); return unreadOnly ? notifications.filter(notification => !notification.read) : notifications; }
function markNotificationRead(notificationId) { const store = readStore(); const notification = store.notifications.find(entry => entry.id === notificationId); if (!notification) return null; notification.read = true; notification.readAt = new Date().toISOString(); writeStore(store); return notification; }
function markAllNotificationsRead() { const store = readStore(); const now = new Date().toISOString(); let changed = false; for (const notification of store.notifications) { if (!notification.read) { notification.read = true; notification.readAt = now; changed = true; } } if (changed) writeStore(store); return store.notifications; }
function findOrderByStripeSessionId(stripeSessionId) { return readStore().orders.find(order => order.stripeSessionId === stripeSessionId); }
function findOrderByPayPalOrderId(paypalOrderId) { return readStore().orders.find(order => order.paypalOrderId === paypalOrderId); }
function hasProductOrders(productId) {
  const store = readStore();
  return store.orders.some(order => (order.items || []).some(item => String(item.productId) === String(productId))) ||
    store.inventoryReservations.some(reservation => reservation.status === 'reserved' && new Date(reservation.expiresAt) > new Date() && (reservation.items || []).some(item => String(item.productId) === String(productId)));
}
function createPendingPayPalOrder(payment) { const store = readStore(); const record = { id: id('ppp'), createdAt: new Date().toISOString(), status: 'created', ...payment }; store.pendingPayPalOrders.push(record); writeStore(store); return record; }
function findPendingPayPalOrder(paypalOrderId) { return readStore().pendingPayPalOrders.find(payment => payment.paypalOrderId === paypalOrderId); }
function updatePendingPayPalOrder(paymentId, updates) { const store = readStore(); const payment = store.pendingPayPalOrders.find(entry => entry.id === paymentId); if (!payment) return null; Object.assign(payment, updates, { updatedAt: new Date().toISOString() }); writeStore(store); return payment; }
function normalizeInventoryItems(items) {
  if (!Array.isArray(items) || !items.length) return null;
  const quantities = new Map();
  for (const item of items) {
    const productId = String(item?.productId || '');
    const quantity = Number(item?.quantity);
    if (!productId || !Number.isSafeInteger(quantity) || quantity < 1) return null;
    quantities.set(productId, (quantities.get(productId) || 0) + quantity);
  }
  return [...quantities.entries()].map(([productId, quantity]) => ({ productId, quantity }));
}

function inventoryAvailability(store, items, excludingReservationId = null) {
  for (const item of items) {
    const product = store.products.find(entry => String(entry.id) === item.productId);
    if (!product) return { ok: false, error: 'One or more products are no longer available.' };
    if (product.status && product.status !== 'active') return { ok: false, error: `${product.name} is not currently available.` };
    const stock = Number.isSafeInteger(product.stock) && product.stock >= 0 ? product.stock : 0;
    const available = Math.max(0, stock - availableStock(store, item.productId, excludingReservationId));
    if (item.quantity > available) return { ok: false, error: `Insufficient stock for ${product.name}. Only ${available} available.`, productId: item.productId, available };
  }
  return { ok: true };
}

function reserveInventory(reservationId, items, { provider, expiresAt } = {}) {
  const normalized = normalizeInventoryItems(items);
  if (!reservationId || !normalized) return { ok: false, error: 'Valid checkout items are required.' };
  const store = readStore();
  const existing = store.inventoryReservations.find(entry => entry.id === reservationId);
  if (existing?.status === 'reserved' && new Date(existing.expiresAt) > new Date()) return { ok: true, reservation: existing };
  const availability = inventoryAvailability(store, normalized, reservationId);
  if (!availability.ok) return availability;
  const reservedItems = normalized.map(item => {
    const product = store.products.find(entry => String(entry.id) === item.productId);
    return { ...item, name: product.name, unitCents: Math.round(Number(product.price) * 100) };
  });
  const reservation = {
    id: reservationId,
    provider: provider || 'checkout',
    items: reservedItems,
    totalCents: reservedItems.reduce((total, item) => total + item.unitCents * item.quantity, 0),
    status: 'reserved',
    createdAt: existing?.createdAt || new Date().toISOString(),
    expiresAt: expiresAt || new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
  };
  if (existing) Object.assign(existing, reservation);
  else store.inventoryReservations.push(reservation);
  writeStore(store);
  return { ok: true, reservation };
}

function releaseInventoryReservation(reservationId) {
  const store = readStore();
  const reservation = store.inventoryReservations.find(entry => entry.id === reservationId);
  if (!reservation || reservation.status !== 'reserved') return false;
  reservation.status = 'released';
  reservation.releasedAt = new Date().toISOString();
  writeStore(store);
  return true;
}

function getInventoryReservation(reservationId) {
  return readStore().inventoryReservations.find(entry => entry.id === reservationId) || null;
}

function finalizePaidOrder(orderData, reservationId = null) {
  const store = readStore();
  const duplicate = store.orders.find(order =>
    (orderData.paypalOrderId && order.paypalOrderId === orderData.paypalOrderId) ||
    (orderData.stripeSessionId && order.stripeSessionId === orderData.stripeSessionId)
  );
  if (duplicate) return { ok: true, duplicate: true, order: duplicate };

  const orderItems = normalizeInventoryItems((orderData.items || []).map(item => ({ productId: item.productId, quantity: item.quantity })));
  if (!orderItems) return { ok: false, error: 'Valid order items are required.' };
  const reservation = reservationId && store.inventoryReservations.find(entry => entry.id === reservationId && entry.status === 'reserved');
  const availability = inventoryAvailability(store, orderItems, reservation?.id || null);
  if (!availability.ok) return availability;
  if (reservation) {
    const reservedItems = normalizeInventoryItems(reservation.items);
    if (!reservedItems || JSON.stringify(reservedItems) !== JSON.stringify(orderItems)) return { ok: false, error: 'Inventory reservation does not match the paid order.' };
  }

  for (const item of orderItems) {
    const product = store.products.find(entry => String(entry.id) === item.productId);
    const previousStock = product.stock;
    product.stock -= item.quantity;
    addInventoryNotification(store, product, previousStock, orderData.paypalOrderId || orderData.stripeSessionId || 'order');
  }
  const record = { id: id('ord'), status: 'placed', createdAt: new Date().toISOString(), ...orderData };
  store.orders.push(record);
  if (reservation) {
    reservation.status = 'committed';
    reservation.committedAt = new Date().toISOString();
    reservation.orderId = record.id;
  }
  writeStore(store);
  return { ok: true, duplicate: false, order: record };
}
function inventorySummary() {
  const products = listProducts();
  return {
    totalProducts: products.length,
    inStockProducts: products.filter(product => product.availableStock > product.lowStockThreshold).length,
    lowStockProducts: products.filter(product => product.availableStock > 0 && product.availableStock <= product.lowStockThreshold).length,
    outOfStockProducts: products.filter(product => product.availableStock === 0).length,
    totalUnitsInStock: products.reduce((total, product) => total + product.availableStock, 0)
  };
}
function listUsers() { return readStore().users; }
function listOrders() { return readStore().orders; }
function listRfqs() { return readStore().rfqs; }
function getOrder(orderId) { return readStore().orders.find(order => order.id === orderId); }
function createProduct(product) { const store = readStore(); const record = { id: id('prod'), createdAt: new Date().toISOString(), status: 'active', stock: 0, lowStockThreshold: 5, ...product }; store.products.push(record); addInventoryNotification(store, record, record.lowStockThreshold + 1, 'created'); writeStore(store); return record; }
function updateProduct(productId, updates) {
  const store = readStore();
  const product = store.products.find(entry => entry.id === productId);
  if (!product) return null;
  const previousStock = product.stock;
  Object.assign(product, updates, { updatedAt: new Date().toISOString() });
  if (Object.prototype.hasOwnProperty.call(updates, 'stock')) addInventoryNotification(store, product, previousStock, `admin-${product.updatedAt}`);
  writeStore(store);
  return product;
}
function deleteProduct(productId) {
  const store = readStore();
  const index = store.products.findIndex(product => product.id === productId);
  if (index === -1) return null;
  const [product] = store.products.splice(index, 1);
  writeStore(store);
  return product;
}
function updateOrder(orderId, updates) {
  const store = readStore();
  const order = store.orders.find(entry => entry.id === orderId);
  if (!order) return null;
  Object.assign(order, updates, { updatedAt: new Date().toISOString() });
  writeStore(store);
  return order;
}
function updateUser(userId, updates) {
  const store = readStore();
  const user = store.users.find(entry => entry.id === userId);
  if (!user) return null;
  Object.assign(user, updates, { updatedAt: new Date().toISOString() });
  writeStore(store);
  return user;
}
function updateSupplier(supplierId, updates) {
  const store = readStore();
  const supplier = store.suppliers.find(entry => entry.id === supplierId);
  if (!supplier) return null;
  Object.assign(supplier, updates, { updatedAt: new Date().toISOString() });
  writeStore(store);
  return supplier;
}
function listAdminCategories() {
  const store = readStore();
  const explicit = store.categories.map(category => ({ ...category }));
  const known = new Set(explicit.map(category => category.name));
  for (const product of store.products) {
    if (!known.has(product.category)) {
      explicit.push({ id: `cat_${product.category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name: product.category, status: 'active', system: true });
      known.add(product.category);
    }
  }
  return explicit.map(category => ({ ...category, productCount: store.products.filter(product => product.category === category.name).length }));
}
function createCategory(category) { const store = readStore(); const record = { id: id('cat'), status: 'active', ...category }; store.categories.push(record); writeStore(store); return record; }
function updateCategory(categoryId, updates) {
  const store = readStore();
  const category = store.categories.find(entry => entry.id === categoryId);
  if (!category) return null;
  const previousName = category.name;
  Object.assign(category, updates, { updatedAt: new Date().toISOString() });
  if (updates.name && updates.name !== previousName) {
    store.products.forEach(product => {
      if (product.category === previousName) product.category = updates.name;
    });
  }
  writeStore(store);
  return category;
}
function deleteCategory(categoryId) { const store = readStore(); const category = store.categories.find(entry => entry.id === categoryId); if (!category || store.products.some(product => product.category === category.name)) return null; store.categories = store.categories.filter(entry => entry.id !== categoryId); writeStore(store); return category; }
function createRfq(rfq) { const store = readStore(); const record = { id: id('rfq'), status: 'open', createdAt: new Date().toISOString(), ...rfq }; store.rfqs.push(record); writeStore(store); return record; }
function createSupplier(supplier) { const store = readStore(); const record = { id: id('sup'), status: 'pending', verificationStatus: 'pending', createdAt: new Date().toISOString(), ...supplier }; if (!record.businessName && record.companyName) record.businessName = record.companyName; if (!record.companyName && record.businessName) record.companyName = record.businessName; if (!record.verificationStatus) record.verificationStatus = record.status || 'pending'; if (!record.status) record.status = record.verificationStatus || 'pending'; store.suppliers.push(record); writeStore(store); return record; }

module.exports = { readStore, writeStore, findUserByEmail, createUser, listAddresses, getAddress, createAddress, updateAddress, setDefaultAddress, deleteAddress, createSession, findSession, deleteSession, listProducts, listCategories, listSuppliers, findSupplierById, findSupplierByOwnerId, getProduct, summarizeProductReviews, listReviews, getReview, createReview, updateReview, deleteReview, listWishlist, addWishlistItem, removeWishlistItem, createOrder, createNewOrderNotification, listNotifications, markNotificationRead, markAllNotificationsRead, findOrderByStripeSessionId, findOrderByPayPalOrderId, hasProductOrders, createPendingPayPalOrder, findPendingPayPalOrder, updatePendingPayPalOrder, reserveInventory, releaseInventoryReservation, getInventoryReservation, finalizePaidOrder, inventorySummary, listUsers, listOrders, listRfqs, getOrder, createProduct, updateProduct, deleteProduct, updateOrder, updateUser, updateSupplier, listAdminCategories, createCategory, updateCategory, deleteCategory, createRfq, createSupplier };
