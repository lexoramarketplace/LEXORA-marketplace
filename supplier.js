(() => {
  const apiBase = 'http://localhost:4000';
  const supplierSession = window.LexoraSupplierSession;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(value || 0));
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const token = () => supplierSession?.getToken(localStorage) || '';

  let dashboard = null;
  let supplierProducts = [];
  let editingProductId = null;

  function setAuthView(message = 'Supplier sign-in required.') {
    $('#authView').hidden = false;
    $('#dashboardView').hidden = true;
    $('#loginStatus').textContent = message;
    $('#storeSettingsLink').hidden = true;
    $('#signOutButton').hidden = true;
  }

  function setDashboardView() {
    $('#authView').hidden = true;
    $('#dashboardView').hidden = false;
    $('#storeSettingsLink').hidden = false;
    $('#signOutButton').hidden = false;
  }

  async function api(path, options = {}) {
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error('Your supplier session has expired. Please sign in again.');
    if (response.status === 403) throw new Error(payload.error || 'Supplier access required.');
    if (!response.ok) throw new Error(payload.error || 'Request failed.');
    return payload;
  }

  function renderSummary(data) {
    const items = [
      ['Total products', data.totalProducts || 0],
      ['Active products', data.activeProducts || 0],
      ['Out of stock', data.outOfStockProducts || 0],
      ['Sales', money(data.totalSales || 0)]
    ];
    $('#supplierSummary').innerHTML = items.map(([label, value]) => `
      <div class="metric-card">
        <span class="label">${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `).join('');
  }

  function renderRecentOrders(data) {
    const orders = Array.isArray(data.recentOrders) ? data.recentOrders : [];
    $('#recentOrders').innerHTML = orders.length ? orders.map(order => `
      <div class="supplier-panel" style="padding:14px 0; border-width:0; border-bottom:1px solid rgba(17,17,17,.08); margin:0;">
        <strong>${escapeHtml(order.customer)}</strong>
        <div class="muted">${escapeHtml(order.id)} · ${new Date(order.createdAt).toLocaleDateString()}</div>
        <div style="margin-top:10px; display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <span class="status-pill ${order.paymentStatus === 'paid' ? 'good' : 'neutral'}">${escapeHtml(order.paymentStatus || 'pending')}</span>
          <strong>${money(order.total || 0)}</strong>
        </div>
      </div>
    `).join('') : '<p class="muted">No orders yet.</p>';
  }

  function renderProducts() {
    if (!supplierProducts.length) {
      $('#productsTableWrap').innerHTML = '<p class="empty-state">No products yet. Add your first listing to begin selling.</p>';
      return;
    }
    $('#productsTableWrap').innerHTML = `
      <table>
        <thead>
          <tr><th>Product</th><th>Category</th><th>Price</th><th>Stock</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>
          ${supplierProducts.map(product => `
            <tr>
              <td><strong>${escapeHtml(product.name)}</strong><br><span class="muted">${escapeHtml(product.id)}</span></td>
              <td>${escapeHtml(product.category || '—')}</td>
              <td>${money(product.price || 0)}</td>
              <td>${Number(product.stock || 0)}</td>
              <td><span class="status-pill ${String(product.status || 'active') === 'active' ? 'good' : 'neutral'}">${escapeHtml(product.status || 'active')}</span></td>
              <td>
                <div class="actions-row">
                  <button type="button" class="text-button" data-edit-product="${escapeHtml(product.id)}">Edit</button>
                  <button type="button" class="text-button" data-delete-product="${escapeHtml(product.id)}">Delete</button>
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function setFormMessage(message = '', type = 'neutral') {
    const element = $('#productFormMessage');
    element.textContent = message;
    element.style.color = type === 'error' ? '#8f2d2d' : '#4b4b4b';
  }

  function resetForm() {
    editingProductId = null;
    $('#productEditorTitle').textContent = 'Add a product';
    $('#supplierProductForm').reset();
    $('#productId').value = '';
    $('#productStatus').value = 'active';
    $('#productPrice').value = '';
    $('#productWholesalePrice').value = '';
    $('#productMoq').value = '1';
    $('#productStock').value = '0';
    setFormMessage('');
  }

  function fillForm(product) {
    editingProductId = product.id;
    $('#productEditorTitle').textContent = 'Edit product';
    $('#productId').value = product.id || '';
    $('#productName').value = product.name || '';
    $('#productCategory').value = product.category || '';
    $('#productSupplier').value = product.supplier || '';
    $('#productLocation').value = product.location || '';
    $('#productPrice').value = product.price ?? '';
    $('#productWholesalePrice').value = product.wholesalePrice ?? '';
    $('#productMoq').value = product.moq ?? 1;
    $('#productStock').value = product.stock ?? 0;
    $('#productStatus').value = product.status || 'active';
    $('#productDescription').value = product.description || '';
    setFormMessage('');
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  async function loadDashboard() {
    const result = await api('/api/supplier/dashboard');
    dashboard = result.data;
    const supplier = dashboard;
    $('#storeName').textContent = supplier.storeName || 'Supplier store';
    $('#verificationLabel').textContent = supplier.verificationStatus || 'pending';
    $('#verificationBadge').textContent = supplier.verificationStatus || 'pending';
    $('#verificationBadge').className = `status-pill ${supplier.verificationStatus === 'approved' ? 'good' : supplier.verificationStatus === 'pending' ? 'warn' : 'neutral'}`;
    $('#supplierProfile').innerHTML = `
      <strong>${escapeHtml(supplier.storeName || 'Supplier store')}</strong><br />
      <span class="muted">Owner: ${escapeHtml(supplier.owner?.name || supplier.owner?.email || 'Supplier owner')}</span><br />
      <span class="muted">Verification: ${escapeHtml(supplier.verificationStatus || 'pending')}</span>
    `;
    $('#storefrontLink').href = `supplier-storefront.html?id=${encodeURIComponent(supplier.id)}`;
    renderSummary(supplier);
    renderRecentOrders(supplier);
    const storefront = await api(`/api/suppliers/${encodeURIComponent(supplier.id)}`);
    supplierProducts = Array.isArray(storefront.data?.products) ? storefront.data.products : [];
    renderProducts();
  }

  async function saveProduct(event) {
    event.preventDefault();
    const id = $('#productId').value;
    const payload = {
      name: $('#productName').value.trim(),
      category: $('#productCategory').value.trim(),
      supplier: $('#productSupplier').value.trim(),
      location: $('#productLocation').value.trim(),
      price: Number($('#productPrice').value),
      wholesalePrice: $('#productWholesalePrice').value === '' ? undefined : Number($('#productWholesalePrice').value),
      moq: Number($('#productMoq').value),
      stock: Number($('#productStock').value),
      status: $('#productStatus').value,
      description: $('#productDescription').value.trim()
    };
    if (!payload.name || !payload.category || !payload.supplier || !payload.location || !payload.description) {
      setFormMessage('Please complete every field before saving.', 'error');
      return;
    }

    $('#saveProductButton').disabled = true;
    setFormMessage('Saving…');
    try {
      if (id) {
        await api(`/api/supplier/products/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        await api('/api/supplier/products', { method: 'POST', body: JSON.stringify(payload) });
      }
      resetForm();
      await loadDashboard();
      setFormMessage('Saved successfully.');
    } catch (error) {
      setFormMessage(error.message, 'error');
    } finally {
      $('#saveProductButton').disabled = false;
    }
  }

  async function deleteProduct(productId) {
    if (!confirm('Delete this product from your storefront?')) return;
    try {
      await api(`/api/supplier/products/${encodeURIComponent(productId)}`, { method: 'DELETE' });
      await loadDashboard();
      if (editingProductId === productId) resetForm();
    } catch (error) {
      setFormMessage(error.message, 'error');
    }
  }

  async function boot() {
    if (!token()) {
      setAuthView('Please sign in with your supplier account.');
      return;
    }
    try {
      const me = await api('/api/me');
      if (me.data.role !== 'supplier') {
        supplierSession.clearToken(localStorage);
        setAuthView('This page is for supplier accounts.');
        return;
      }
      setDashboardView();
      await loadDashboard();
    } catch (error) {
      supplierSession.clearToken(localStorage);
      setAuthView(error.message);
    }
  }

  $('#supplierLoginForm').addEventListener('submit', async event => {
    event.preventDefault();
    const email = $('#supplierEmail').value.trim();
    const password = $('#supplierPassword').value;
    $('#loginStatus').textContent = 'Signing in…';
    try {
      const response = await fetch(`${apiBase}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Supply sign-in failed.');
      if (payload.data.user.role !== 'supplier') throw new Error('This page is for supplier accounts.');
      supplierSession.saveToken(localStorage, payload.data.token);
      $('#supplierLoginForm').reset();
      setDashboardView();
      await loadDashboard();
    } catch (error) {
      $('#loginStatus').textContent = error.message;
    }
  });

  $('#signOutButton').addEventListener('click', () => {
    supplierSession.clearToken(localStorage);
    resetForm();
    setAuthView('You have been signed out.');
  });

  $('#addProductButton').addEventListener('click', resetForm);
  $('#cancelEditButton').addEventListener('click', resetForm);
  $('#supplierProductForm').addEventListener('submit', saveProduct);
  document.addEventListener('click', async event => {
    const editButton = event.target.closest('[data-edit-product]');
    const deleteButton = event.target.closest('[data-delete-product]');
    if (editButton) {
      const product = supplierProducts.find(item => String(item.id) === String(editButton.dataset.editProduct));
      if (product) fillForm(product);
      return;
    }
    if (deleteButton) {
      await deleteProduct(deleteButton.dataset.deleteProduct);
    }
  });

  boot();
})();
