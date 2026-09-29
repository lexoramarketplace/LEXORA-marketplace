(() => {
  const apiBase = 'http://localhost:4000';
  const $ = selector => document.querySelector(selector);
  const supplierId = new URLSearchParams(window.location.search).get('id');

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  }

  function money(value) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(value || 0));
  }

  async function api(path) {
    const response = await fetch(`${apiBase}${path}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Storefront request failed.');
    return payload;
  }

  function renderStorefront(supplier, products) {
    const verified = supplier.verified || String(supplier.verificationStatus || '').toLowerCase() === 'approved';
    const categories = Array.isArray(supplier.categories) ? supplier.categories : [];
    $('#storefrontContent').innerHTML = `
      <section class="hero-banner">
        <div class="store-identity">
          ${supplier.logoUrl ? `<img class="store-logo" src="${escapeHtml(supplier.logoUrl)}" alt="${escapeHtml(supplier.businessName || supplier.companyName || 'Supplier')} logo" />` : ''}
          <div>
            <p class="eyebrow" style="color: rgba(255,255,255,.7);">${verified ? 'VERIFIED SUPPLIER' : 'SUPPLIER PROFILE'}</p>
            <h1>${escapeHtml(supplier.businessName || supplier.companyName || 'Supplier store')}</h1>
            <p>${escapeHtml(supplier.description || 'Wholesale products crafted with care for design-conscious buyers and retail partners.')}</p>
          </div>
        </div>
        <div>
          <p class="muted" style="color: rgba(255,255,255,.7);">${escapeHtml([supplier.city, supplier.state, supplier.country].filter(Boolean).join(' · ') || 'Worldwide shipping')}</p>
          <div style="margin-top:18px; display:flex; gap:12px; flex-wrap:wrap;">
            <span class="status-pill ${verified ? 'good' : 'neutral'}">${verified ? 'Verified' : 'Pending review'}</span>
            <span class="status-pill neutral">${products.length} products</span>
          </div>
          ${categories.length ? `<div class="store-categories">${categories.map(category => `<span class="store-category">${escapeHtml(category)}</span>`).join('')}</div>` : ''}
          ${supplier.businessEmail || supplier.phone ? `<div class="store-contacts">${supplier.businessEmail ? `<a href="mailto:${escapeHtml(supplier.businessEmail)}">${escapeHtml(supplier.businessEmail)}</a>` : ''}${supplier.phone ? `<a href="tel:${escapeHtml(supplier.phone)}">${escapeHtml(supplier.phone)}</a>` : ''}</div>` : ''}
        </div>
      </section>
      <section class="storefront-grid">
        ${products.length ? products.map(product => `
          <article class="product-card">
            <img src="${escapeHtml(product.image || 'product-fallback.svg')}" alt="${escapeHtml(product.name)}" onerror="this.onerror=null;this.src='product-fallback.svg';" />
            <p class="eyebrow">${escapeHtml(product.category || 'Marketplace')}</p>
            <h3>${escapeHtml(product.name)}</h3>
            <p class="muted">MOQ ${escapeHtml(product.moq || 1)} · ${escapeHtml(product.stock || 0)} in stock</p>
            <div class="meta">
              <strong>${money(product.price || 0)}</strong>
              <a class="text-button" href="product.html?id=${encodeURIComponent(product.id)}&wishlist=20260927-r2">View product ↗</a>
            </div>
          </article>
        `).join('') : '<div class="product-card" style="grid-column:1 / -1;"><p class="empty-state">This supplier has not published any products yet.</p></div>'}
      </section>
    `;
  }

  async function load() {
    try {
      let supplier = null;
      if (supplierId) {
        const result = await api(`/api/suppliers/${encodeURIComponent(supplierId)}`);
        supplier = result.data;
      } else {
        const list = await api('/api/suppliers');
        supplier = Array.isArray(list.data) ? list.data[0] : null;
        if (supplier) {
          const detail = await api(`/api/suppliers/${encodeURIComponent(supplier.id)}`);
          supplier = detail.data || supplier;
        }
      }
      if (!supplier) throw new Error('No supplier storefront is available.');
      const products = Array.isArray(supplier.products) ? supplier.products : [];
      document.title = `${supplier.businessName || supplier.companyName || 'Supplier'} | LEXORA`;
      renderStorefront(supplier, products);
    } catch (error) {
      $('#storefrontContent').innerHTML = `<div class="product-card"><p class="empty-state">${escapeHtml(error.message || 'Storefront unavailable.')}</p></div>`;
    }
  }

  load();
})();
