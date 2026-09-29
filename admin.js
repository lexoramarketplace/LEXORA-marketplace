const apiBase = 'http://localhost:4000';
const adminSession = window.LexoraAdminSession;
const adminApiErrors = window.LexoraAdminApiErrors;
const tokenKey = adminSession.adminTokenKey;
let token = adminSession.getToken(localStorage);
let dashboard = null;
let products = [];
let currentSection = 'overview';
let reviewPage = 1;
let reviewTotal = 0;
let imageState = { existing: [], newFiles: [], primary: '', changed: false };
let authEpoch = 0;
let notificationTimer = null;
const $ = selector => document.querySelector(selector);
const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(value || 0));
const date = value => value ? new Date(value).toLocaleDateString() : '—';
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('visible'), 2800);
}
function setAuthView(message = 'Sign in with an administrator account to manage the marketplace.') {
  $('#dashboardView').hidden = true;
  $('#authView').hidden = false;
  $('#authMessage').textContent = message;
}
function setDashboardView(user) {
  $('#authView').hidden = true;
  $('#dashboardView').hidden = false;
  $('#adminIdentity').textContent = `${user.name || user.email} · administrator`;
  $('#identityButton').textContent = (user.name || 'A').slice(0, 1).toUpperCase();
}
async function api(path, options = {}) {
  const { handleAuth = true, ...requestOptions } = options;
  let response;
  try {
    response = await fetch(`${apiBase}${path}`, { ...requestOptions, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(requestOptions.headers || {}) } });
  } catch (error) {
    throw new Error(adminApiErrors.networkMessage(apiBase, error));
  }
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (response.status === 401) { if (handleAuth) { token = ''; adminSession.clearToken(localStorage); setAuthView('Your session expired. Sign in again.'); } throw new Error(payload.error || 'Authentication required.'); }
  if (response.status === 403) throw new Error(payload.error || 'Administrator access required.');
  if (!response.ok) throw new Error(payload.error || 'Request failed.');
  return payload;
}
function renderNotifications(notifications = []) {
  const list = $('#notificationList');
  list.innerHTML = notifications.length ? notifications.map(notification => `<button type="button" class="notification-item ${notification.read ? '' : 'unread'}" data-notification-id="${escapeHtml(notification.id)}"><strong>${escapeHtml(notification.title)}</strong><span>${escapeHtml(notification.message)}</span><span>${date(notification.createdAt)}${notification.read ? '' : ' · Unread'}</span></button>`).join('') : '<p class="empty-state" style="padding:16px">No notifications yet.</p>';
}
function updateNotificationBadge(unreadCount) { const badge = $('#notificationBadge'); if (!badge) return; badge.textContent = unreadCount; badge.hidden = unreadCount < 1; }
async function loadNotifications() { try { const result = await api('/api/admin/notifications'); renderNotifications(result.data); updateNotificationBadge(result.unreadCount); } catch (error) { if (token) showToast(error.message); } }
function startNotificationPolling() { if (notificationTimer) clearInterval(notificationTimer); loadNotifications(); notificationTimer = setInterval(loadNotifications, 30000); }
function stopNotificationPolling() { if (notificationTimer) { clearInterval(notificationTimer); notificationTimer = null; } }
function renderMetrics(metrics, inventory = {}) {
  const values = [['Total sales', money(metrics.totalSales)], ['Total orders', metrics.totalOrders], ['Products', metrics.totalProducts], ['Customers', metrics.totalCustomers], ['Suppliers', metrics.totalSuppliers], ['Pending orders', metrics.pendingOrders], ['Completed orders', metrics.completedOrders], ['Refunds', metrics.refunds], ['Units available', inventory.totalUnitsInStock || 0], ['In-stock products', inventory.inStockProducts || 0], ['Low-stock products', inventory.lowStockProducts || 0], ['Out of stock', inventory.outOfStockProducts || 0]];
  $('#metricGrid').innerHTML = values.map(([label, value]) => `<div class="metric"><span class="metric-label">${label}</span><strong class="metric-value">${escapeHtml(value)}</strong></div>`).join('');
}
function renderBars(target, entries, currency = false) {
  if (!entries.length) { target.className = 'bar-chart empty-state'; target.textContent = 'No data available yet'; return; }
  target.className = 'bar-chart';
  const max = Math.max(...entries.map(entry => Number(entry.value || 0)), 1);
  target.innerHTML = entries.map(entry => `<div class="bar" style="height:${Math.max(8, Number(entry.value || 0) / max * 140)}px"><span>${currency ? money(entry.value) : escapeHtml(entry.value)}</span><small>${escapeHtml(entry.month || entry.label || '')}</small></div>`).join('');
}
function renderStatuses(target, entries) {
  if (!entries.length) { target.className = 'status-chart empty-state'; target.textContent = 'No data available yet'; return; }
  const max = Math.max(...entries.map(entry => entry.count), 1);
  target.className = 'status-chart';
  target.innerHTML = entries.map(entry => `<div class="status-row"><span>${escapeHtml(entry.status)}</span><div class="status-track"><div class="status-fill" style="width:${entry.count / max * 100}%"></div></div><strong>${entry.count}</strong></div>`).join('');
}
function renderOverview(data) {
  dashboard = data;
  renderMetrics(data.metrics, data.inventory);
  renderBars($('#revenueChart'), data.charts.revenueByMonth, true);
  renderBars($('#analyticsRevenue'), data.charts.revenueByMonth, true);
  renderStatuses($('#statusChart'), data.charts.ordersByStatus);
  renderStatuses($('#analyticsStatuses'), data.charts.ordersByStatus);
  $('#topProducts').className = data.charts.topProducts.length ? 'rank-list' : 'rank-list empty-state';
  $('#topProducts').innerHTML = data.charts.topProducts.length ? data.charts.topProducts.map((entry, index) => `<div class="rank-item"><span><span class="rank-number">0${index + 1}</span> ${escapeHtml(entry.product)}</span><span class="rank-quantity">${entry.quantity} units</span></div>`).join('') : 'No paid order items yet';
  $('#dataAvailability').innerHTML = [['Payments', data.availableData.payments ? 'Records available' : 'No records yet'], ['Reviews', data.availableData.reviews ? 'Records available' : 'No records yet'], ['Messages', 'Not implemented in runtime']].map(([label, value]) => `<div class="availability-item"><strong>${label}</strong><span>${value}</span></div>`).join('');
  $('#analyticsSummary').textContent = data.metrics.totalOrders ? `${data.metrics.totalOrders} real order record(s) currently available.` : 'No historical order data is available yet.';
}
async function loadOverview() { renderOverview((await api('/api/admin/dashboard')).data); }
function stockState(product) { const available = Number(product.availableStock ?? product.stock ?? 0); if (available <= 0) return ['Out of stock', 'stock-out']; if (available <= Number(product.lowStockThreshold ?? 5)) return ['Low stock', 'stock-low']; return ['In stock', 'stock-good']; }
async function loadProducts() { products = (await api(`/api/admin/products?search=${encodeURIComponent($('#productSearch').value)}`)).data; $('#productsTable').innerHTML = products.length ? products.map(product => { const [inventoryLabel, inventoryClass] = stockState(product); return `<tr><td class="product-cell"><strong>${escapeHtml(product.name)}</strong><span>${escapeHtml(product.id)}</span></td><td>${escapeHtml(product.category)}</td><td>${escapeHtml(product.supplier)}</td><td>${money(product.price)}</td><td><strong>${Number(product.availableStock ?? product.stock ?? 0)} available</strong><br><span class="subtle">${Number(product.reservedStock || 0)} reserved · threshold ${Number(product.lowStockThreshold ?? 5)}</span></td><td><span class="status-pill ${inventoryClass}">${inventoryLabel}</span><br><span class="subtle">${escapeHtml(product.status || 'active')}</span></td><td><div class="row-actions"><button class="text-action" data-edit-product="${escapeHtml(product.id)}">Edit</button><button class="text-action" data-delete-product="${escapeHtml(product.id)}">Delete</button></div></td></tr>`; }).join('') : '<tr><td colspan="7" class="empty-state">No products found.</td></tr>'; }
async function loadOrders() {
  const orders = (await api('/api/admin/orders')).data;
  const shipmentStatuses = ['processing', 'confirmed', 'shipped', 'in_transit', 'out_for_delivery', 'delivered', 'cancelled', 'refunded'];
  $('#ordersTable').innerHTML = orders.length ? orders.map(order => `
    <tr>
      <td><strong>${escapeHtml(order.id)}</strong><br><span class="subtle">${(order.items || []).length} line item(s)</span></td>
      <td>${escapeHtml(order.customer?.name || order.shippingAddress?.fullName || 'Guest')}</td>
      <td>${money(Number(order.totalAmount || 0) / 100)}</td>
      <td><span class="status-pill ${order.paymentStatus === 'paid' ? 'good' : ''}">${escapeHtml(order.paymentProvider || '—')} · ${escapeHtml(order.paymentStatus || 'pending')}</span><br><span class="subtle">${escapeHtml(order.paypalOrderId || order.stripeSessionId || '')}</span></td>
      <td><select data-order-status="${escapeHtml(order.id)}">${['pending','placed','confirmed','processing','shipped','in_transit','out_for_delivery','delivered','cancelled','refunded'].map(status => `<option value="${status}" ${order.status === status ? 'selected' : ''}>${status.replaceAll('_', ' ')}</option>`).join('')}</select></td>
      <td>${date(order.createdAt)}</td>
    </tr>
    <tr class="shipment-editor-row"><td colspan="6"><details class="shipment-editor">
      <summary><span>Shipment management</span><span class="shipment-summary-status">${escapeHtml(order.shippingCarrier || 'Carrier not set')}${order.trackingNumber ? ` · ${escapeHtml(order.trackingNumber)}` : ''}</span></summary>
      <form class="shipment-form" data-shipment-form="${escapeHtml(order.id)}" novalidate>
        <label>Carrier<input name="shippingCarrier" type="text" maxlength="100" placeholder="DHL, FedEx, UPS, USPS…" value="${escapeHtml(order.shippingCarrier || '')}" /></label>
        <label>Tracking number<input name="trackingNumber" type="text" maxlength="200" placeholder="Enter tracking number" value="${escapeHtml(order.trackingNumber || '')}" /></label>
        <label class="shipment-url-field">Tracking URL<input name="trackingUrl" type="url" inputmode="url" placeholder="https://carrier.example/track/…" value="${escapeHtml(order.trackingUrl || '')}" aria-describedby="shipment-url-help-${escapeHtml(order.id)}" /><small id="shipment-url-help-${escapeHtml(order.id)}">Use the carrier’s secure HTTPS tracking page.</small></label>
        <label>Estimated delivery<input name="estimatedDeliveryDate" type="date" value="${escapeHtml(String(order.estimatedDeliveryDate || '').slice(0, 10))}" /></label>
        <label>Shipment status<select name="shippingStatus">${shipmentStatuses.map(status => `<option value="${status}" ${(order.shippingStatus || order.status) === status ? 'selected' : ''}>${status.replaceAll('_', ' ')}</option>`).join('')}</select></label>
        <div class="shipment-form-actions"><p class="form-status shipment-save-status" role="status" aria-live="polite"></p><button class="primary-button" type="submit">Save shipment update</button></div>
      </form>
    </details></td></tr>`).join('') : '<tr><td colspan="6" class="empty-state">No orders recorded yet.</td></tr>';
}

function validShipmentUrl(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

async function saveShipment(form) {
  const orderId = form.dataset.shipmentForm;
  const values = Object.fromEntries(new FormData(form).entries());
  const status = form.elements.shippingStatus.value;
  const statusNode = form.querySelector('.shipment-save-status');
  const button = form.querySelector('button[type="submit"]');
  if (!validShipmentUrl(values.trackingUrl.trim())) {
    statusNode.textContent = 'Enter a valid HTTPS tracking URL or leave it blank.';
    return;
  }

  button.disabled = true;
  button.textContent = 'Saving…';
  statusNode.textContent = '';
  try {
    await api(`/api/admin/orders/${encodeURIComponent(orderId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status,
        shippingStatus: status,
        shippingCarrier: values.shippingCarrier.trim(),
        trackingNumber: values.trackingNumber.trim(),
        trackingUrl: values.trackingUrl.trim(),
        estimatedDeliveryDate: values.estimatedDeliveryDate
      })
    });
    showToast('Shipment details saved.');
    await loadOrders();
  } catch (error) {
    statusNode.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Save shipment update';
  }
}
async function loadCustomers() { const customers = (await api(`/api/admin/customers?search=${encodeURIComponent($('#customerSearch').value)}`)).data; $('#customersTable').innerHTML = customers.length ? customers.map(customer => `<tr><td>${escapeHtml(customer.name)}</td><td>${escapeHtml(customer.email)}</td><td>${date(customer.createdAt)}</td><td><span class="status-pill ${customer.status === 'active' ? 'good' : ''}">${escapeHtml(customer.status)}</span></td><td><button class="text-action" data-toggle-customer="${escapeHtml(customer.id)}">${customer.status === 'disabled' ? 'Enable' : 'Disable'}</button></td></tr>`).join('') : '<tr><td colspan="5" class="empty-state">No customers recorded yet.</td></tr>'; }
async function loadSuppliers() { const suppliers = (await api('/api/admin/suppliers')).data; $('#suppliersTable').innerHTML = suppliers.length ? suppliers.map(supplier => `<tr><td>${escapeHtml(supplier.businessName)}</td><td>${escapeHtml(supplier.country || '—')}</td><td>${supplier.productCount || 0}</td><td>${escapeHtml(supplier.verificationStatus || '—')}</td><td>${supplier.id?.startsWith('sup_demo_') ? '<span class="subtle">Demo record</span>' : `<select data-supplier-status="${escapeHtml(supplier.id)}"><option value="pending_review">Pending review</option><option value="approved">Approved</option><option value="suspended">Suspended</option></select>`}</td></tr>`).join('') : '<tr><td colspan="5" class="empty-state">No suppliers recorded yet.</td></tr>'; }
async function loadCategories() { const categories = (await api('/api/admin/categories')).data; $('#categoriesTable').innerHTML = categories.length ? categories.map(category => `<tr><td>${escapeHtml(category.name)}</td><td>${category.productCount || 0}</td><td>${category.system ? 'Catalogue-derived' : 'Managed'}</td><td>${category.system ? '<span class="subtle">Protected</span>' : `<button class="text-action" data-delete-category="${escapeHtml(category.id)}">Delete</button>`}</td></tr>`).join('') : '<tr><td colspan="4" class="empty-state">No categories found.</td></tr>'; }
async function loadPayments() { const result = await api('/api/admin/payments'); $('#paymentsTable').innerHTML = result.data.length ? result.data.map(payment => `<tr><td>${escapeHtml(payment.id)}</td><td>${escapeHtml(payment.orderId)}</td><td>${escapeHtml(payment.provider || '—')}</td><td>${money(payment.amount)}</td><td>${escapeHtml(payment.currency)}</td><td><span class="status-pill ${payment.status === 'paid' ? 'good' : ''}">${escapeHtml(payment.status)}</span></td><td>${date(payment.createdAt)}</td></tr>`).join('') : '<tr><td colspan="7" class="empty-state">No payment records available yet.</td></tr>'; }
async function loadReviews() { const result = await api(`/api/admin/reviews?page=${reviewPage}&limit=50`); reviewTotal = result.total; const pageCount = Math.max(1, Math.ceil(reviewTotal / result.pageSize)); $('#reviewsTable').innerHTML = result.data.length ? result.data.map(review => `<tr><td><strong>${escapeHtml(review.productName)}</strong><br><span class="subtle">${escapeHtml(review.productId)}</span></td><td>${escapeHtml(review.customer.name)}<br><span class="subtle">${escapeHtml(review.customer.email || '')}</span></td><td><span class="admin-review-stars" aria-label="${review.rating} out of 5 stars">${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)}</span> ${review.rating}</td><td><details class="admin-review-copy"><summary>${escapeHtml(review.title || 'View review')}</summary><p>${escapeHtml(review.comment)}</p></details></td><td>${review.verifiedPurchase ? '<span class="status-pill good">Verified</span>' : '<span class="subtle">Unverified</span>'}</td><td><select data-review-status="${escapeHtml(review.id)}" aria-label="Moderation status for ${escapeHtml(review.productName)}"><option value="pending" ${review.status === 'pending' ? 'selected' : ''}>Pending</option><option value="approved" ${review.status === 'approved' ? 'selected' : ''}>Approved</option><option value="hidden" ${review.status === 'hidden' ? 'selected' : ''}>Hidden</option></select></td><td><button type="button" class="text-action danger-action" data-delete-review="${escapeHtml(review.id)}">Delete</button></td></tr>`).join('') : '<tr><td colspan="7" class="empty-state">No customer reviews have been submitted.</td></tr>'; $('#reviewPageStatus').textContent = `${reviewPage} / ${pageCount} · ${reviewTotal} review${reviewTotal === 1 ? '' : 's'}`; $('#reviewPrevPage').disabled = reviewPage <= 1; $('#reviewNextPage').disabled = reviewPage >= pageCount; }
async function loadSection(section = currentSection) { currentSection = section; try { if (section === 'overview' || section === 'analytics') await loadOverview(); if (section === 'products') await loadProducts(); if (section === 'orders') await loadOrders(); if (section === 'customers') await loadCustomers(); if (section === 'suppliers') await loadSuppliers(); if (section === 'categories') await loadCategories(); if (section === 'payments') await loadPayments(); if (section === 'reviews') await loadReviews(); } catch (error) { showToast(error.message); } }
function imageItems() { return [...imageState.existing.map(url => ({ type: 'existing', value: url, src: url })), ...imageState.newFiles.map((file, index) => ({ type: 'new', value: `new:${index}`, src: URL.createObjectURL(file), file }))]; }
function renderImagePreviews() { const items = imageItems(); if (imageState.primary && !items.some(item => item.value === imageState.primary)) imageState.primary = items[0]?.value || ''; const grid = $('#imagePreviewGrid'); grid.innerHTML = items.length ? items.map((item, index) => { const primary = imageState.primary === item.value || (!imageState.primary && index === 0); return `<div class="image-preview ${primary ? 'primary' : ''}"><img src="${item.src}" alt="Product image ${index + 1}" /><button type="button" class="image-primary" data-primary-image="${escapeHtml(item.value)}" aria-label="Make image primary">${primary ? '★' : '☆'}</button><button type="button" class="image-remove" data-remove-image="${escapeHtml(item.value)}" aria-label="Remove image">×</button>${primary ? '<span class="image-badge">Primary</span>' : ''}</div>`; }).join('') : '<p class="empty-state">No images selected yet.</p>'; }
function validateImageFile(file) { if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return 'Only JPG, JPEG, PNG, and WEBP images are accepted.'; if (file.size > 5 * 1024 * 1024) return 'Each image must be 5 MB or smaller.'; return ''; }
function addImageFiles(files) { const incoming = [...files]; const error = incoming.map(validateImageFile).find(Boolean); if (error) { $('#imageStatusMessage').textContent = error; return; } if (imageState.existing.length + imageState.newFiles.length + incoming.length > 10) { $('#imageStatusMessage').textContent = 'A maximum of 10 images is allowed.'; return; } imageState.newFiles.push(...incoming); imageState.changed = true; if (!imageState.primary) imageState.primary = 'new:0'; $('#imageStatusMessage').textContent = `${imageState.existing.length + imageState.newFiles.length} image(s) ready.`; renderImagePreviews(); }
function openProductDialog(product = null) { const existing = Array.isArray(product?.images) ? product.images : product?.image ? [product.image] : []; imageState = { existing: [...existing], newFiles: [], primary: product?.image || existing[0] || '' }; $('#productDialogTitle').textContent = product ? 'Edit product' : 'Add product'; $('#productId').value = product?.id || ''; $('#productName').value = product?.name || ''; $('#productCategory').value = product?.category || ''; $('#productSupplier').value = product?.supplier || ''; $('#productLocation').value = product?.location || ''; $('#productPrice').value = product?.price ?? ''; $('#productWholesalePrice').value = product?.wholesalePrice ?? ''; $('#productMoq').value = product?.moq ?? 1; $('#productStock').value = product?.stock ?? 0; $('#productLowStockThreshold').value = product?.lowStockThreshold ?? 5; $('#productImage').value = product?.image || ''; $('#productStatus').value = product?.status || 'active'; $('#productDescription').value = product?.description || ''; $('#productStatusMessage').textContent = ''; $('#imageStatusMessage').textContent = ''; $('#productImages').value = ''; renderImagePreviews(); $('#productDialog').showModal(); }
async function uploadProductImages(id) { if (!imageState.changed) return null; const formData = new FormData(); imageState.newFiles.forEach(file => formData.append('images', file)); formData.append('keepImages', JSON.stringify(imageState.existing)); const newPrimaryIndex = imageState.primary.startsWith('new:') ? Number.parseInt(imageState.primary.slice(4), 10) : -1; if (imageState.primary && imageState.existing.includes(imageState.primary)) formData.append('primaryImage', imageState.primary); else if (newPrimaryIndex >= 0) formData.append('primaryNewIndex', String(newPrimaryIndex)); const response = await fetch(`${apiBase}/api/admin/products/${encodeURIComponent(id)}/images`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: formData }); let payload = {}; try { payload = await response.json(); } catch {} if (!response.ok) throw new Error(payload.error || 'Images could not be uploaded.'); return payload.data; }
async function saveProduct(event) { event.preventDefault(); const id = $('#productId').value; const imageUrl = $('#productImage').value.trim(); const body = { name: $('#productName').value, category: $('#productCategory').value, supplier: $('#productSupplier').value, location: $('#productLocation').value, price: Number($('#productPrice').value), wholesalePrice: $('#productWholesalePrice').value ? Number($('#productWholesalePrice').value) : undefined, moq: Number($('#productMoq').value), stock: Number($('#productStock').value), lowStockThreshold: Number($('#productLowStockThreshold').value), image: imageUrl, imageUrl, status: $('#productStatus').value, description: $('#productDescription').value }; const saveButton = $('#saveProductButton'); saveButton.disabled = true; saveButton.textContent = 'Saving…'; try { const result = await api(id ? `/api/admin/products/${encodeURIComponent(id)}` : '/api/admin/products', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) }); const savedProduct = result.data; await uploadProductImages(savedProduct.id); $('#productDialog').close(); showToast(id ? 'Product updated.' : 'Product added.'); await loadProducts(); } catch (error) { $('#productStatusMessage').textContent = error.message; } finally { saveButton.disabled = false; saveButton.textContent = 'Save product'; } }
async function downloadReport(type) { const path = type === 'orders' ? '/api/admin/orders' : type === 'products' ? '/api/admin/products' : '/api/admin/customers'; const rows = (await api(path)).data; if (!rows.length) return showToast('No data available to export.'); const keys = type === 'customers' ? ['id', 'name', 'email', 'role', 'status', 'createdAt'] : Object.keys(rows[0]).filter(key => !['passwordHash', 'sessions'].includes(key)); const csv = [keys.join(','), ...rows.map(row => keys.map(key => JSON.stringify(row[key] ?? '')).join(','))].join('\n'); const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); link.download = `lexora-${type}.csv`; link.click(); URL.revokeObjectURL(link.href); }

$('.side-nav').addEventListener('click', event => { const button = event.target.closest('[data-section]'); if (!button) return; document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item === button)); document.querySelectorAll('.dashboard-section').forEach(section => section.classList.remove('active-section')); $(`#section-${button.dataset.section}`).classList.add('active-section'); $('#pageTitle').textContent = button.querySelector('span').textContent; loadSection(button.dataset.section); $('#sidebar').classList.remove('open'); $('#sidebarScrim').classList.remove('open'); });
$('#openSidebar').addEventListener('click', () => { $('#sidebar').classList.add('open'); $('#sidebarScrim').classList.add('open'); });
$('#closeSidebar').addEventListener('click', () => { $('#sidebar').classList.remove('open'); $('#sidebarScrim').classList.remove('open'); });
$('#sidebarScrim').addEventListener('click', () => { $('#sidebar').classList.remove('open'); $('#sidebarScrim').classList.remove('open'); });
$('#logoutButton').addEventListener('click', () => { stopNotificationPolling(); token = ''; adminSession.clearToken(localStorage); setAuthView('You have been signed out.'); });
$('#loginForm').addEventListener('submit', async event => { event.preventDefault(); authEpoch += 1; const loginEpoch = authEpoch; $('#loginStatus').textContent = ''; const button = $('#loginForm button[type="submit"]'); button.disabled = true; button.textContent = 'Signing in…'; try { const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: $('#loginEmail').value, password: $('#loginPassword').value }) }); if (loginEpoch !== authEpoch) return; if (result.data.user.role !== 'admin') { $('#loginStatus').textContent = 'Access denied. This account is not an administrator.'; return; } token = result.data.token; adminSession.saveToken(localStorage, token); setDashboardView(result.data.user); await loadSection(); startNotificationPolling(); } catch (error) { if (loginEpoch === authEpoch) $('#loginStatus').textContent = error.message; } finally { button.disabled = false; button.textContent = 'Sign in securely'; } });
$('#addProductButton').addEventListener('click', () => openProductDialog());
$('#productForm').addEventListener('submit', saveProduct);
$('#productImages').addEventListener('change', event => { addImageFiles(event.target.files); event.target.value = ''; });
$('#imageDropzone').addEventListener('dragover', event => { event.preventDefault(); $('#imageDropzone').classList.add('dragging'); });
$('#imageDropzone').addEventListener('dragleave', () => $('#imageDropzone').classList.remove('dragging'));
$('#imageDropzone').addEventListener('drop', event => { event.preventDefault(); $('#imageDropzone').classList.remove('dragging'); addImageFiles(event.dataTransfer.files); });
$('#imageDropzone').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') $('#productImages').click(); });
$('#imagePreviewGrid').addEventListener('click', event => { const primary = event.target.closest('[data-primary-image]'); const remove = event.target.closest('[data-remove-image]'); if (primary) { imageState.primary = primary.dataset.primaryImage; imageState.changed = true; renderImagePreviews(); } if (remove) { const value = remove.dataset.removeImage; if (value.startsWith('new:')) imageState.newFiles.splice(Number.parseInt(value.slice(4), 10), 1); else imageState.existing = imageState.existing.filter(image => image !== value); if (imageState.primary === value) imageState.primary = imageItems()[0]?.value || ''; imageState.changed = true; renderImagePreviews(); } });
$('#notificationButton').addEventListener('click', () => { const panel = $('#notificationPanel'); const opening = panel.hidden; panel.hidden = !opening; $('#notificationButton').setAttribute('aria-expanded', String(opening)); if (opening) loadNotifications(); });
$('#notificationList').addEventListener('click', async event => { const item = event.target.closest('[data-notification-id]'); if (!item) return; try { await api(`/api/admin/notifications/${encodeURIComponent(item.dataset.notificationId)}`, { method: 'PATCH' }); await loadNotifications(); } catch (error) { showToast(error.message); } });
$('#markAllNotificationsRead').addEventListener('click', async () => { try { await api('/api/admin/notifications/mark-all-read', { method: 'POST' }); await loadNotifications(); } catch (error) { showToast(error.message); } });
$('#productSearch').addEventListener('input', () => loadProducts());
$('#customerSearch').addEventListener('input', () => loadCustomers());
$('#reviewsTable').addEventListener('change', async event => { const select = event.target.closest('[data-review-status]'); if (!select) return; try { await api(`/api/admin/reviews/${encodeURIComponent(select.dataset.reviewStatus)}`, { method: 'PATCH', body: JSON.stringify({ status: select.value }) }); showToast('Review moderation updated.'); await loadReviews(); } catch (error) { showToast(error.message); await loadReviews(); } });
$('#reviewsTable').addEventListener('click', async event => { const button = event.target.closest('[data-delete-review]'); if (!button || !confirm('Delete this review?')) return; try { await api(`/api/admin/reviews/${encodeURIComponent(button.dataset.deleteReview)}`, { method: 'DELETE' }); if (reviewPage > 1 && reviewTotal === (reviewPage - 1) * 50 + 1) reviewPage -= 1; showToast('Review deleted.'); await loadReviews(); } catch (error) { showToast(error.message); } });
$('#reviewPrevPage').addEventListener('click', () => { if (reviewPage > 1) { reviewPage -= 1; loadReviews(); } });
$('#reviewNextPage').addEventListener('click', () => { if (reviewPage * 50 < reviewTotal) { reviewPage += 1; loadReviews(); } });
document.addEventListener('click', async event => { const edit = event.target.closest('[data-edit-product]'); const remove = event.target.closest('[data-delete-product]'); const toggle = event.target.closest('[data-toggle-customer]'); const category = event.target.closest('[data-delete-category]'); const refresh = event.target.closest('[data-refresh]'); const report = event.target.closest('[data-export]'); try { if (edit) openProductDialog(products.find(product => product.id === edit.dataset.editProduct)); if (remove && confirm('Delete this product from the catalogue?')) { await api(`/api/admin/products/${encodeURIComponent(remove.dataset.deleteProduct)}`, { method: 'DELETE' }); showToast('Product deleted.'); await loadProducts(); } if (toggle) { const row = toggle.closest('tr'); const isDisabled = row.querySelector('.status-pill').textContent === 'disabled'; await api(`/api/admin/customers/${encodeURIComponent(toggle.dataset.toggleCustomer)}`, { method: 'PATCH', body: JSON.stringify({ status: isDisabled ? 'active' : 'disabled' }) }); await loadCustomers(); } if (category && confirm('Delete this category?')) { await api(`/api/admin/categories/${encodeURIComponent(category.dataset.deleteCategory)}`, { method: 'DELETE' }); showToast('Category deleted.'); await loadCategories(); } if (refresh) await loadSection(); if (report) await downloadReport(report.dataset.export); } catch (error) { showToast(error.message); } });
document.addEventListener('change', async event => { const order = event.target.closest('[data-order-status]'); const supplier = event.target.closest('[data-supplier-status]'); try { if (order) { await api(`/api/admin/orders/${encodeURIComponent(order.dataset.orderStatus)}`, { method: 'PATCH', body: JSON.stringify({ status: order.value }) }); showToast('Order status updated.'); } if (supplier) { await api(`/api/admin/suppliers/${encodeURIComponent(supplier.dataset.supplierStatus)}`, { method: 'PATCH', body: JSON.stringify({ status: supplier.value }) }); showToast('Supplier status updated.'); await loadSuppliers(); } } catch (error) { showToast(error.message); } });
document.addEventListener('submit', event => { const shipmentForm = event.target.closest('[data-shipment-form]'); if (!shipmentForm) return; event.preventDefault(); saveShipment(shipmentForm); });
$('#categoryForm').addEventListener('submit', async event => { event.preventDefault(); try { await api('/api/admin/categories', { method: 'POST', body: JSON.stringify({ name: $('#categoryName').value }) }); $('#categoryName').value = ''; showToast('Category added.'); await loadCategories(); } catch (error) { showToast(error.message); } });

async function boot() { if (!token) return setAuthView(); const epoch = authEpoch; try { const result = await api('/api/me', { handleAuth: false }); if (epoch !== authEpoch) return; if (result.data.role !== 'admin') return setAuthView('Access denied. Only users with the admin role can enter this workspace.'); setDashboardView(result.data); await loadSection(); startNotificationPolling(); } catch (error) { if (epoch === authEpoch && !token) setAuthView(error.message); } }
boot();
