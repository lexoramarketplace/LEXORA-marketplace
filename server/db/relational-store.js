const { mappedRows, insertRow, stableId, inventoryRows } = require('./import-json');

const asArray = value => Array.isArray(value) ? value : [];
const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const iso = value => value instanceof Date ? value.toISOString() : value || null;
const cents = value => Math.round(Number(value || 0) * 100);
const jsonEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function loadRelationalStore(client) {
  const store = {};
  const load = async (sql, map) => (await client.query(sql)).rows.map(map);
  const payload = row => asObject(row.payload);

  store.users = await load('SELECT id,email,password_hash,name,role,created_at,updated_at,payload FROM users ORDER BY created_at,id', row => ({
    ...payload(row), id: row.id, email: row.email, passwordHash: row.password_hash, name: row.name,
    role: row.role, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  }));
  store.suppliers = await load(`SELECT s.id,s.owner_id,s.business_name,s.business_type,s.country,s.address,s.description,s.website,
    s.verification_status,s.status,s.created_at,s.updated_at,s.payload,st.store_name,st.logo_url,st.settings
    FROM suppliers s LEFT JOIN supplier_stores st ON st.supplier_id=s.id ORDER BY s.created_at,s.id`, row => ({
    ...payload(row), id: row.id, ownerId: row.owner_id, businessName: row.business_name, companyName: row.business_name,
    businessType: row.business_type, country: row.country, businessAddress: row.address, description: row.description,
    businessDescription: row.description, website: row.website, verificationStatus: row.verification_status,
    status: row.status, storeName: row.store_name || undefined, logoUrl: row.logo_url || payload(row).logoUrl,
    storefront: asObject(row.settings), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  }));
  store.categories = await load('SELECT id,name,slug,parent_id,active,created_at,updated_at,payload FROM categories ORDER BY name,id', row => ({
    ...payload(row), id: row.id, name: row.name, slug: row.slug, parentId: row.parent_id,
    active: row.active, status: row.active ? 'active' : 'inactive', createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  }));

  const images = await load('SELECT product_id,image_url,sort_order FROM product_images ORDER BY product_id,sort_order', row => row);
  const variations = await load('SELECT id,product_id,sku,attributes,stock,payload FROM product_variations ORDER BY product_id,id', row => ({ ...payload(row), id: row.id, sku: row.sku, attributes: asObject(row.attributes), stock: row.stock, productId: row.product_id }));
  const inventory = new Map((await client.query('SELECT product_id,available_quantity,reserved_quantity,low_stock_threshold FROM inventory')).rows.map(row => [row.product_id, row]));
  const imagesByProduct = new Map();
  for (const image of images) imagesByProduct.set(image.product_id, [...(imagesByProduct.get(image.product_id) || []), image.image_url]);
  const variationsByProduct = new Map();
  for (const variation of variations) variationsByProduct.set(variation.product_id, [...(variationsByProduct.get(variation.product_id) || []), variation]);
  store.products = await load(`SELECT id,supplier_id,supplier_name,category_id,category_name,name,slug,description,retail_price,wholesale_price,currency,moq,stock,low_stock_threshold,status,approved_at,created_at,updated_at,payload
    FROM products WHERE status <> 'deleted' ORDER BY created_at,id`, row => {
    const payloadValue = payload(row);
    const productImages = imagesByProduct.get(row.id) || [];
    const stock = inventory.get(row.id)?.available_quantity ?? row.stock;
    return {
      ...payloadValue, id: row.id, supplierId: row.supplier_id, supplier: row.supplier_name || payloadValue.supplier,
      categoryId: row.category_id, category: row.category_name || payloadValue.category, name: row.name,
      slug: row.slug, description: row.description, price: Number(row.retail_price),
      wholesalePrice: row.wholesale_price == null ? null : Number(row.wholesale_price), currency: row.currency.trim(),
      moq: row.moq, stock, lowStockThreshold: inventory.get(row.id)?.low_stock_threshold ?? row.low_stock_threshold,
      status: row.status, approvedAt: iso(row.approved_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      images: productImages, image: productImages[0] || '', imageUrl: productImages[0] || '',
      variations: variationsByProduct.get(row.id) || []
    };
  });

  const orderItemRows = await client.query('SELECT id,order_id,product_id,supplier_id,product_name_snapshot,quantity,selected_size,selected_color,unit_price,line_total,created_at,payload FROM order_items ORDER BY order_id,created_at,id');
  const itemsByOrder = new Map();
  for (const row of orderItemRows.rows) {
    const item = {
      ...payload(row), id: row.id, productId: row.product_id || payload(row).productId || null,
      supplierId: row.supplier_id || payload(row).supplierId || null,
      name: row.product_name_snapshot || payload(row).name || '', quantity: row.quantity,
      size: row.selected_size || payload(row).size || null, color: row.selected_color || payload(row).color || null,
      unitPrice: cents(row.unit_price), lineTotal: cents(row.line_total), createdAt: iso(row.created_at)
    };
    itemsByOrder.set(row.order_id, [...(itemsByOrder.get(row.order_id) || []), item]);
  }
  store.orders = await load(`SELECT id,customer_id,status,currency,subtotal,shipping_total,grand_total,payment_status,payment_provider,paypal_order_id,paypal_capture_id,stripe_session_id,stripe_payment_intent_id,paypal_status,shipping_address,created_at,updated_at,payload FROM orders ORDER BY created_at DESC,id`, row => {
    const orderPayload = payload(row);
    const items = itemsByOrder.get(row.id) || [];
    return {
      ...orderPayload, id: row.id, buyerId: row.customer_id, status: row.status, currency: row.currency.trim(),
      subtotal: cents(row.subtotal), shippingTotal: cents(row.shipping_total), totalAmount: cents(row.grand_total),
      paymentStatus: row.payment_status, paymentProvider: row.payment_provider, paypalOrderId: row.paypal_order_id,
      paypalCaptureId: row.paypal_capture_id, stripeSessionId: row.stripe_session_id,
      stripePaymentIntentId: row.stripe_payment_intent_id, paypalStatus: row.paypal_status,
      shippingAddress: asObject(row.shipping_address), items, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
    };
  });
  const shipmentRows = await client.query('SELECT order_id,carrier,tracking_number,tracking_url,estimated_delivery,status,payload FROM shipments');
  const ordersById = new Map(store.orders.map(order => [order.id, order]));
  for (const row of shipmentRows.rows) {
    const order = ordersById.get(row.order_id);
    if (!order) continue;
    const shipment = payload(row);
    order.shippingCarrier = row.carrier;
    order.trackingNumber = row.tracking_number;
    order.trackingUrl = row.tracking_url;
    order.estimatedDeliveryDate = iso(row.estimated_delivery);
    order.shippingStatus = row.status;
    if (shipment.shipmentEvents) order.shipmentEvents = shipment.shipmentEvents;
  }

  store.addresses = await load('SELECT id,customer_id,full_name,phone,country,country_code,state,city,postal_code,address_line_1,address_line_2,label,is_default,created_at,updated_at,payload FROM addresses ORDER BY created_at,id', row => ({
    ...payload(row), id: row.id, customerId: row.customer_id, fullName: row.full_name, phone: row.phone,
    country: row.country, countryCode: row.country_code, state: row.state, city: row.city,
    postalCode: row.postal_code, addressLine1: row.address_line_1, addressLine2: row.address_line_2,
    label: row.label, isDefault: row.is_default, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  }));
  store.reviews = await load('SELECT id,customer_id,product_id,supplier_id,order_id,rating,title,review_text,status,verified_purchase,created_at,updated_at,payload FROM reviews ORDER BY created_at,id', row => ({
    ...payload(row), id: row.id, authorId: row.customer_id, productId: row.product_id, supplierId: row.supplier_id,
    orderId: row.order_id, rating: row.rating, title: row.title, comment: row.review_text,
    status: row.status, verifiedPurchase: row.verified_purchase, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  }));
  store.wishlist = await load('SELECT id,customer_id,product_id,created_at,payload FROM wishlist_items ORDER BY created_at,id', row => ({
    ...payload(row), id: row.id, customerId: row.customer_id, productId: row.product_id || payload(row).productId, createdAt: iso(row.created_at)
  }));
  store.notifications = await load('SELECT id,recipient_id,order_id,product_id,type,title,message,read,read_at,created_at,updated_at,payload FROM notifications ORDER BY created_at,id', row => ({
    ...payload(row), id: row.id, userId: row.recipient_id, orderId: row.order_id, productId: row.product_id,
    type: row.type, title: row.title, message: row.message, read: row.read, readAt: iso(row.read_at),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  }));
  store.rfqs = await load('SELECT id,buyer_id,product_required,quantity,target_price,preferred_supplier_location,shipping_destination,requirements,status,created_at,updated_at,payload FROM rfqs ORDER BY created_at,id', row => ({
    ...payload(row), id: row.id, buyerId: row.buyer_id, productRequired: row.product_required, quantity: row.quantity,
    targetPrice: row.target_price == null ? null : Number(row.target_price), preferredSupplierLocation: row.preferred_supplier_location,
    shippingDestination: row.shipping_destination, requirements: row.requirements, status: row.status,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  }));
  store.sessions = await load('SELECT token_hash,user_id,expires_at,created_at,payload FROM sessions ORDER BY created_at,token_hash', row => ({
    ...payload(row), tokenHash: row.token_hash, userId: row.user_id, expiresAt: iso(row.expires_at), createdAt: iso(row.created_at)
  }));

  const reservationRows = await client.query('SELECT id,provider,order_id,status,total_cents,expires_at,created_at,updated_at,released_at,committed_at,payload FROM inventory_reservations ORDER BY created_at,id');
  const reservationItems = await client.query('SELECT reservation_id,product_id,quantity,product_name,unit_cents,payload FROM inventory_reservation_items ORDER BY reservation_id,id');
  const itemsByReservation = new Map();
  for (const row of reservationItems.rows) itemsByReservation.set(row.reservation_id, [...(itemsByReservation.get(row.reservation_id) || []), {
    ...payload(row), productId: row.product_id || payload(row).productId, quantity: row.quantity,
    name: row.product_name, unitCents: row.unit_cents == null ? undefined : Number(row.unit_cents)
  }]);
  store.inventoryReservations = reservationRows.rows.map(row => ({
    ...payload(row), id: row.id, provider: row.provider, orderId: row.order_id, status: row.status,
    totalCents: Number(row.total_cents), expiresAt: iso(row.expires_at), createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at), releasedAt: iso(row.released_at), committedAt: iso(row.committed_at),
    items: itemsByReservation.get(row.id) || []
  }));
  store.pendingPayPalOrders = await load('SELECT id,paypal_order_id,buyer_id,reservation_id,status,total_cents,currency,created_at,updated_at,payload FROM pending_paypal_orders ORDER BY created_at,id', row => ({
    ...payload(row), id: row.id, paypalOrderId: row.paypal_order_id, buyerId: row.buyer_id,
    reservationId: row.reservation_id, status: row.status, totalCents: Number(row.total_cents),
    currency: row.currency.trim(), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  }));
  store.payments = await load('SELECT id,order_id,provider,provider_order_id,provider_capture_id,amount,currency,status,created_at,updated_at,payload FROM payments ORDER BY created_at,id', row => ({
    ...payload(row), id: row.id, orderId: row.order_id, provider: row.provider,
    providerOrderId: row.provider_order_id, providerCaptureId: row.provider_capture_id,
    amount: Number(row.amount), currency: row.currency.trim(), status: row.status,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  }));
  store.shipments = await load('SELECT id,order_id,carrier,tracking_number,tracking_url,estimated_delivery,status,created_at,updated_at,payload FROM shipments ORDER BY created_at,id', row => ({
    ...payload(row), id: row.id, orderId: row.order_id, carrier: row.carrier,
    trackingNumber: row.tracking_number, trackingUrl: row.tracking_url, estimatedDelivery: iso(row.estimated_delivery),
    status: row.status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  }));
  return store;
}

async function replaceOrderItems(client, order) {
  await client.query('DELETE FROM order_items WHERE order_id=$1', [order.id]);
  for (const [index, item] of asArray(order.items).entries()) {
    const itemId = item.id || stableId('order_item', `${order.id}:${index}`);
    const product = (await client.query('SELECT supplier_id FROM products WHERE id=$1', [item.productId || item.product_id || null])).rows[0];
    const supplierId = item.supplierId || product?.supplier_id || null;
    const unitCents = item.unitPrice ?? item.price ?? item.unitCents ?? 0;
    const quantity = Math.max(1, Number(item.quantity || 1));
    await client.query(`INSERT INTO order_items (id,order_id,product_id,supplier_id,product_name_snapshot,quantity,selected_size,selected_color,unit_price,line_total,created_at,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`, [
      itemId, order.id, item.productId || item.product_id || null, supplierId, item.name || item.productName || null,
      quantity, item.size || null, item.color || null, Number((Number(unitCents) / 100).toFixed(2)),
      Number((Number(item.lineTotal ?? Number(unitCents) * quantity) / 100).toFixed(2)),
      item.createdAt || order.createdAt || new Date().toISOString(), JSON.stringify(item)
    ]);
  }
}

async function replaceProductChildren(client, product) {
  await client.query('DELETE FROM product_images WHERE product_id=$1', [product.id]);
  const images = Array.isArray(product.images) && product.images.length ? product.images : [product.image || product.imageUrl].filter(Boolean);
  for (const [index, imageUrl] of images.filter(Boolean).entries()) {
    const id = stableId('product_image', `${product.id}:${index}:${imageUrl}`);
    await client.query('INSERT INTO product_images (id,product_id,image_url,sort_order) VALUES ($1,$2,$3,$4)', [id, product.id, imageUrl, index]);
  }

  await client.query('DELETE FROM product_variations WHERE product_id=$1', [product.id]);
  for (const [index, variation] of asArray(product.variations).entries()) {
    await client.query(`INSERT INTO product_variations (id,product_id,sku,attributes,stock,payload)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb)`, [
      variation.id || stableId('product_variation', `${product.id}:${index}`), product.id, variation.sku || null,
      JSON.stringify(variation.attributes || variation), Math.max(0, Number(variation.stock || 0)), JSON.stringify(variation)
    ]);
  }
}

async function replaceReservationItems(client, reservation) {
  await client.query('DELETE FROM inventory_reservation_items WHERE reservation_id=$1', [reservation.id]);
  for (const [index, item] of asArray(reservation.items).entries()) {
    const productId = item.productId || item.product_id || null;
    await client.query(`INSERT INTO inventory_reservation_items (id,reservation_id,product_id,quantity,product_name,unit_cents,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [
      stableId('reservation_item', `${reservation.id}:${productId || index}`), reservation.id, productId,
      Math.max(1, Number(item.quantity || 1)), item.name || item.productName || null,
      item.unitCents == null ? null : Math.max(0, Number(item.unitCents)), JSON.stringify(item)
    ]);
  }
}

async function upsertSupplierStore(client, supplier) {
  await client.query(`INSERT INTO supplier_stores (supplier_id,store_name,description,logo_url,website,settings,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT (supplier_id) DO UPDATE SET
    store_name=EXCLUDED.store_name,description=EXCLUDED.description,logo_url=EXCLUDED.logo_url,
    website=EXCLUDED.website,settings=EXCLUDED.settings,updated_at=EXCLUDED.updated_at`, [
    supplier.id, supplier.storeName || supplier.storefrontName || supplier.businessName || supplier.companyName || null,
    supplier.storeDescription || supplier.businessDescription || supplier.description || null,
    supplier.logoUrl || supplier.storeLogo || null, supplier.website || null,
    JSON.stringify(supplier.storefront || supplier.store || supplier.storeSettings || {}),
    supplier.updatedAt || supplier.createdAt || new Date().toISOString()
  ]);
}

async function persistRelationalStore(client, previous, current) {
  const oldRows = mappedRows(previous || {});
  const nextRows = mappedRows(current);
  const oldByTableId = new Map(oldRows.map(row => [`${row.table}\0${row.id}`, row]));
  const nextByTableId = new Map(nextRows.map(row => [`${row.table}\0${row.id}`, row]));
  const changedRows = nextRows.filter(row => {
    const old = oldByTableId.get(`${row.table}\0${row.id}`);
    return !old || !jsonEqual(old.value, row.value);
  });
  const changedProducts = new Set(changedRows.filter(row => row.table === 'products').map(row => row.id));
  const changedOrders = new Set(changedRows.filter(row => row.table === 'orders').map(row => row.id));
  const changedReservations = new Set(changedRows.filter(row => row.table === 'inventory_reservations').map(row => row.id));

  const changedAddresses = changedRows.filter(row => row.table === 'addresses');
  const addressCustomers = new Set(changedAddresses.filter(row => row.value.isDefault === true).map(row => row.value.customerId || row.value.userId).filter(Boolean));
  for (const customerId of addressCustomers) await client.query('UPDATE addresses SET is_default=false WHERE customer_id=$1', [customerId]);

  for (const row of changedRows) {
    await insertRow(client, row);
    if (row.table === 'suppliers') await upsertSupplierStore(client, row.value);
  }
  for (const orderId of changedOrders) {
    const order = current.orders.find(value => String(value.id) === String(orderId));
    if (order) await replaceOrderItems(client, order);
  }
  for (const productId of changedProducts) {
    const product = current.products.find(value => String(value.id) === String(productId));
    if (product) await replaceProductChildren(client, product);
  }
  for (const reservationId of changedReservations) {
    const reservation = current.inventoryReservations.find(value => String(value.id) === String(reservationId));
    if (reservation) await replaceReservationItems(client, reservation);
  }

  const removedRows = oldRows.filter(row => !nextByTableId.has(`${row.table}\0${row.id}`));
  const deleteOrder = ['order_items','inventory_reservation_items','product_images','product_variations','wishlist_items','reviews','addresses','notifications','payments','shipments','pending_paypal_orders','inventory_reservations','sessions','rfqs','categories','products','suppliers','orders','users'];
  const removed = new Map(removedRows.map(row => [`${row.table}\0${row.id}`, row]));
  for (const table of deleteOrder) {
    for (const row of removed.values()) {
      if (row.table !== table) continue;
      const pk = table === 'sessions' ? 'token_hash' : 'id';
      await client.query(`DELETE FROM ${table} WHERE ${pk}=$1`, [row.id]);
      removed.delete(`${row.table}\0${row.id}`);
    }
  }

  if (changedProducts.size || changedReservations.size) {
    const inventory = inventoryRows(current);
    for (const entry of inventory) {
      if (!entry.productId) continue;
      await client.query(`INSERT INTO inventory (product_id,available_quantity,reserved_quantity,low_stock_threshold,updated_at)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (product_id) DO UPDATE SET
        available_quantity=EXCLUDED.available_quantity,reserved_quantity=EXCLUDED.reserved_quantity,
        low_stock_threshold=EXCLUDED.low_stock_threshold,updated_at=EXCLUDED.updated_at`, [
        entry.productId, entry.available, entry.reserved, entry.threshold, entry.updatedAt
      ]);
    }
  }
}

module.exports = { loadRelationalStore, persistRelationalStore };
