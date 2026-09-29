(() => {
  const apiBase = 'http://localhost:4000';
  const customerSession = window.LexoraCustomerSession;
  const tokenKey = customerSession.customerTokenKey;
  const tracking = window.LexoraOrderTracking;
  const wishlist = window.LexoraWishlist;
  const $ = selector => document.querySelector(selector);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const money = (amount, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(amount || 0) / 100);
  const date = value => {
    if (!value) return '';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '' : new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(parsed);
  };

  let orders = [];

  const getCustomerToken = () => customerSession.getToken(localStorage);
  function updateWishlistCount(ids = wishlist?.snapshot() || []) { const count = $('#wishlistCount'); if (count) count.textContent = String(ids.length); }
  window.addEventListener('lexora:wishlist-change', event => updateWishlistCount(event.detail.ids));
  wishlist?.load().then(result => updateWishlistCount(result.ids));

  async function api(path, options = {}) {
    const token = getCustomerToken();
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      const sessionState = await customerSession.handleUnauthorized(fetch, apiBase, localStorage, token);
      if (sessionState === 'invalid') {
        throw new Error('Sign in to view your orders.');
      }
      throw new Error(sessionState === 'valid'
        ? payload.error || 'This order request was unauthorized. Your session is still active.'
        : 'The order service is temporarily unavailable. Your sign-in is still saved; please try again.');
    }
    if (response.status === 404 && payload.error === 'Route not found.' && (path === '/api/orders' || path.startsWith('/api/orders/'))) {
      throw new Error('The order API route is unavailable. Restart the LEXORA API server from the current project source, then reload this page.');
    }
    if (!response.ok) throw new Error(payload.error || 'Your orders could not be loaded.');
    return payload;
  }

  function setMessage(text, type = '') {
    const message = $('#ordersMessage');
    message.textContent = text;
    message.className = `orders-message ${type}`.trim();
    message.hidden = !text;
  }

  function showAuth(message = '') {
    $('#ordersContent').hidden = true;
    $('#ordersAuth').hidden = false;
    $('#loginMessage').textContent = message;
    setMessage('');
  }

  function showStatus(order) {
    const state = order.shippingStatus || order.status || 'placed';
    const paymentPaid = String(order.paymentStatus || '').toLowerCase() === 'paid';
    return state === 'placed' && paymentPaid ? 'Payment Confirmed' : tracking.statusLabel(state);
  }

  function orderProducts(order) {
    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) return 'Product details unavailable';
    return items.map(item => `${item.name || item.productName || item.productId || 'Marketplace item'} × ${Number(item.quantity || 1)}`).join(', ');
  }

  function renderOrders() {
    const target = $('#ordersList');
    if (!orders.length) {
      target.innerHTML = '<div class="empty-orders"><p class="eyebrow">NO ORDERS YET</p><h2>Your next find starts here.</h2><p>Orders placed while signed in to this account will appear here.</p><a class="button button-dark" href="shop.html">Explore the shop <span>↗</span></a></div>';
      return;
    }
    target.innerHTML = orders.map(order => `
      <article class="order-row">
        <div class="order-row-main"><div class="order-number">ORDER ${escapeHtml(order.id)}</div><div class="order-date">Placed ${escapeHtml(date(order.createdAt) || 'Date unavailable')}</div><div class="order-items">${escapeHtml(orderProducts(order))}</div></div>
        <div class="order-row-status"><span class="status-pill" data-status="${escapeHtml(order.shippingStatus || order.status || 'placed')}">${escapeHtml(showStatus(order))}</span><span class="payment-state">Payment: ${escapeHtml(tracking.statusLabel(order.paymentStatus || 'pending'))}</span></div>
        <div class="order-row-total"><div class="order-total">${escapeHtml(money(order.totalAmount, order.currency || 'USD'))}</div></div>
        <div class="order-row-action"><button class="open-order" type="button" data-open-order="${escapeHtml(order.id)}">Order details <span aria-hidden="true">↗</span></button></div>
      </article>`).join('');
  }

  function renderTimeline(order) {
    return tracking.buildTimeline(order).map(stage => `
      <li class="timeline-step ${stage.complete ? 'complete' : ''} ${stage.active ? 'active' : ''}">
        <span class="timeline-marker" aria-hidden="true"></span>
        <div class="timeline-copy"><strong>${escapeHtml(stage.label)}</strong>${stage.occurredAt ? `<time datetime="${escapeHtml(stage.occurredAt)}">${escapeHtml(date(stage.occurredAt))}</time>` : ''}${stage.note ? `<p>${escapeHtml(stage.note)}</p>` : ''}</div>
      </li>`).join('');
  }

  function renderOrder(order) {
    const url = tracking.normalizeTrackingUrl(order.trackingUrl);
    const shipmentStarted = ['shipped', 'in_transit', 'out_for_delivery', 'delivered'].includes(String(order.shippingStatus || order.status || '').toLowerCase());
    const carrier = order.shippingCarrier ? escapeHtml(order.shippingCarrier) : 'Not added yet';
    const trackingNumber = order.trackingNumber ? escapeHtml(order.trackingNumber) : 'Not added yet';
    const eta = date(order.estimatedDeliveryDate);
    const orderItems = Array.isArray(order.items) ? order.items : [];
    const itemSubtotal = orderItems.reduce((sum, item) => sum + Number(item.unitPrice ?? item.unitCents ?? 0) * Number(item.quantity || 1), 0);
    const subtotal = Number(order.subtotalAmount ?? order.subtotalCents ?? itemSubtotal);
    const shippingCost = order.shippingCostCents ?? order.shippingCents ?? order.shippingCost ?? order.shippingAmount;
    const customer = order.shippingAddress || {};
    const paymentMethod = String(order.paymentProvider || 'Not specified').replace(/\b\w/g, character => character.toUpperCase());
    const items = orderItems.map(item => {
      const productId = String(item.productId || item.id || '');
      const productName = item.name || item.productName || item.productId || 'Marketplace item';
      const reviewLink = order.paymentStatus === 'paid' && order.status !== 'refunded' && productId
        ? `<a class="order-review-link" href="product.html?id=${escapeHtml(encodeURIComponent(productId))}&wishlist=20260927-r2#productReviews" aria-label="Review ${escapeHtml(productName)}">Review product ↗</a>`
        : '';
      return `<div class="order-item"><span>${escapeHtml(productName)}<small>Quantity ${escapeHtml(item.quantity || 1)} · ${escapeHtml(money(Number(item.unitPrice ?? item.unitCents ?? 0), order.currency || 'USD'))} each</small>${reviewLink}</span><strong>${escapeHtml(money(Number(item.unitPrice ?? item.unitCents ?? 0) * Number(item.quantity || 1), order.currency || 'USD'))}</strong></div>`;
    }).join('');
    $('#orderDetail').innerHTML = `
      <header class="order-detail-header"><div><p class="eyebrow">ORDER DETAILS</p><h2>Order ${escapeHtml(order.id)}</h2><div class="detail-meta">Placed ${escapeHtml(date(order.createdAt) || 'Date unavailable')}</div></div><div class="detail-total"><strong>${escapeHtml(money(order.totalAmount, order.currency || 'USD'))}</strong><span>${escapeHtml(String(order.paymentStatus || 'Payment status unavailable').replace(/\b\w/g, character => character.toUpperCase()))}</span></div></header>
      <div class="tracking-layout">
        <section class="tracking-section"><h3>Order journey</h3><ol class="timeline">${renderTimeline(order)}</ol></section>
        <section class="shipment-section"><h3>Shipment details</h3><dl class="shipment-facts">
          <div class="shipment-fact"><dt>Order status</dt><dd>${escapeHtml(tracking.statusLabel(order.status || 'placed'))}</dd></div>
          <div class="shipment-fact"><dt>Shipment status</dt><dd>${escapeHtml(showStatus(order))}</dd></div>
          <div class="shipment-fact"><dt>Carrier</dt><dd>${carrier}</dd></div>
          <div class="shipment-fact"><dt>Tracking number</dt><dd>${trackingNumber}</dd></div>
          <div class="shipment-fact"><dt>Estimated delivery</dt><dd>${escapeHtml(eta || 'Not available yet')}</dd></div>
        </dl>
        ${order.shipmentNotes ? `<div class="shipment-note"><h4>Shipping note</h4><p>${escapeHtml(order.shipmentNotes)}</p></div>` : ''}
        ${url ? `<a class="track-button" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Track shipment <span aria-hidden="true">↗</span></a>` : `<div class="tracking-pending"><strong>${shipmentStarted ? 'Tracking information temporarily unavailable' : 'Awaiting shipment'}</strong><p>${shipmentStarted ? 'Your shipment is underway, but tracking details are not available right now.' : 'Tracking information will appear here once your order ships.'}</p></div>`}
        </section>
      </div>
      <section class="order-items-panel"><h3>Items in this order</h3>${items || '<p class="detail-meta">No item details are available.</p>'}<div class="order-costs"><div><span>Subtotal</span><strong>${escapeHtml(money(subtotal, order.currency || 'USD'))}</strong></div><div><span>Shipping</span><strong>${escapeHtml(shippingCost == null ? 'Not specified' : money(Number(shippingCost), order.currency || 'USD'))}</strong></div><div><span>Payment method</span><strong>${escapeHtml(paymentMethod)}</strong></div><div><span>Order total</span><strong>${escapeHtml(money(order.totalAmount, order.currency || 'USD'))}</strong></div></div>${customer.fullName || customer.email ? `<div class="customer-order-contact"><h4>Shipping to</h4><p>${escapeHtml(customer.fullName || '')}${customer.email ? `<br />${escapeHtml(customer.email)}` : ''}${customer.addressLine1 ? `<br />${escapeHtml(customer.addressLine1)}` : ''}${customer.city || customer.country ? `<br />${escapeHtml([customer.city, customer.state, customer.postalCode, customer.country].filter(Boolean).join(', '))}` : ''}</p></div>` : ''}</section>`;
  }

  async function openOrder(orderId, { updateUrl = true } = {}) {
    if (!orders.some(entry => String(entry.id) === String(orderId))) {
      setMessage('That order is not available in your account.', 'error');
      return;
    }
    setMessage('Loading order details…');
    try {
      const result = await api(`/api/orders/${encodeURIComponent(orderId)}`);
      renderOrder(result.data);
      $('#ordersListView').hidden = true;
      $('#orderDetailView').hidden = false;
      if (updateUrl) history.replaceState(null, '', `orders.html?order=${encodeURIComponent(result.data.id)}`);
      setMessage('');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      if (error.message === 'Sign in to view your orders.') return showAuth(error.message);
      setMessage(error.message, 'error');
    }
  }

  function showOrders() {
    $('#orderDetailView').hidden = true;
    $('#ordersListView').hidden = false;
    history.replaceState(null, '', 'orders.html');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function loadAccount() {
    const token = getCustomerToken();
    if (!token) return showAuth();
    setMessage('Loading your account…');
    try {
      const accountResult = await api('/api/me');
      if (accountResult.data.role !== 'customer') {
        customerSession.clearToken(localStorage, token);
        return showAuth('This page is for customer accounts. Sign in with a customer account.');
      }
      $('#customerGreeting').textContent = `Signed in as ${accountResult.data.name || accountResult.data.email}`;
      $('#customerProfileName').textContent = accountResult.data.name || 'Name not provided';
      $('#customerProfileEmail').textContent = accountResult.data.email || '';
      $('#ordersAuth').hidden = true;
      $('#ordersContent').hidden = false;
      try {
        const ordersResult = await api('/api/orders');
        orders = Array.isArray(ordersResult.data) ? ordersResult.data : [];
      } catch (error) {
        if (error.message === 'Sign in to view your orders.') return showAuth(error.message);
        orders = [];
        renderOrders();
        setMessage(error.message, 'error');
        return;
      }
      renderOrders();
      setMessage('');
      const requestedOrder = new URLSearchParams(window.location.search).get('order');
      if (requestedOrder) await openOrder(requestedOrder, { updateUrl: false });
    } catch (error) {
      if (error.message === 'Sign in to view your orders.') return showAuth(error.message);
      setMessage(error.message, 'error');
    }
  }

  $('#ordersLoginForm').addEventListener('submit', async event => {
    event.preventDefault();
    $('#loginMessage').textContent = 'Signing in…';
    try {
      const response = await fetch(`${apiBase}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: $('#ordersEmail').value.trim(), password: $('#ordersPassword').value })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Sign in failed.');
      if (payload.data.user.role !== 'customer') throw new Error('This page is for customer accounts.');
      customerSession.saveToken(localStorage, payload.data.token);
      $('#ordersLoginForm').reset();
      await loadAccount();
    } catch (error) {
      $('#loginMessage').textContent = error.message;
    }
  });

  $('#ordersList').addEventListener('click', event => {
    const button = event.target.closest('[data-open-order]');
    if (button) openOrder(button.dataset.openOrder);
  });
  $('#backToOrders').addEventListener('click', showOrders);
  $('#signOutButton').addEventListener('click', async () => {
    const token = getCustomerToken();
    try {
      if (token) {
        await fetch(`${apiBase}/api/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` }
        });
      }
    } catch (error) {
      console.warn('Customer logout request failed:', error);
    }
    customerSession.clearToken(localStorage);
    orders = [];
    showAuth('You have been signed out.');
  });
  window.addEventListener('storage', event => {
    if (event.key === tokenKey) {
      if (!event.newValue) {
        orders = [];
        showAuth('You have been signed out.');
      } else {
        loadAccount();
      }
    }
  });
  loadAccount();
})();