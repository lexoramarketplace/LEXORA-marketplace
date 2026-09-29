(() => {
  const apiBase = 'http://localhost:4000';
  const session = window.LexoraCustomerSession;
  const $ = selector => document.querySelector(selector);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  let addresses = [];

  function showMessage(message, type = '') {
    const node = $('#addressesMessage');
    node.textContent = message;
    node.className = `orders-message ${type}`.trim();
    node.hidden = !message;
  }
  function showAuth(message = '') {
    $('#addressAuth').hidden = false;
    $('#addressEditor').hidden = true;
    $('#addressesList').replaceChildren();
    $('#addressesList').hidden = true;
    showMessage(message);
  }
  async function request(path, options = {}) {
    const token = session.getToken(localStorage);
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      const state = await session.handleUnauthorized(fetch, apiBase, localStorage, token);
      if (state === 'invalid') throw new Error('Your session expired. Please sign in again.');
    }
    if (!response.ok) throw new Error(payload.error || 'Addresses could not be updated. Please try again.');
    return payload;
  }
  function addressBlock(address) {
    return [address.addressLine1, address.addressLine2, [address.city, address.state, address.postalCode].filter(Boolean).join(', '), address.country].filter(Boolean).map(escapeHtml).join('\n');
  }
  function renderAddresses() {
    $('#addressesList').hidden = false;
    if (!addresses.length) {
      $('#addressesList').innerHTML = '<p class="addresses-empty">No saved addresses yet. Add one to use it at checkout.</p>';
      $('#addAddressButton').hidden = false;
      return;
    }
    $('#addressesList').innerHTML = addresses.map(address => `<article class="address-card"><div class="address-card-head"><h3>${escapeHtml(address.label || 'Address')}</h3>${address.isDefault ? '<span class="address-default-badge">Default shipping</span>' : ''}</div><p class="address-details"><strong>${escapeHtml(address.fullName)}</strong><br />${escapeHtml(address.phone)}<br />${addressBlock(address)}</p><div class="address-card-actions"><a class="address-use" href="checkout.html?address=${encodeURIComponent(address.id)}&v=paypal-reservation-20260927-r1">Use at checkout ↗</a><button type="button" data-edit-address="${escapeHtml(address.id)}">Edit</button>${address.isDefault ? '' : `<button type="button" data-default-address="${escapeHtml(address.id)}">Set as default</button>`}<button class="address-delete" type="button" data-delete-address="${escapeHtml(address.id)}">Delete</button></div></article>`).join('');
  }
  function clearForm() {
    $('#addressForm').reset();
    $('#addressId').value = '';
    $('#addressEditorTitle').textContent = 'Add an address';
    $('#addressDefault').disabled = false;
    $('#addressDefault').checked = addresses.length === 0;
    $('#addressFormStatus').textContent = '';
    $('#addressFormStatus').className = 'login-message';
  }
  function openEditor(address = null) {
    clearForm();
    if (address) {
      $('#addressId').value = address.id;
      $('#addressEditorTitle').textContent = 'Edit address';
      const fieldIds = { label: 'addressLabel', fullName: 'addressFullName', phone: 'addressPhone', addressLine1: 'addressLine1', addressLine2: 'addressLine2', city: 'addressCity', state: 'addressState', postalCode: 'addressPostalCode', country: 'addressCountry' };
      Object.entries(fieldIds).forEach(([field, id]) => { $(`#${id}`).value = address[field] || ''; });
      $('#addressDefault').checked = address.isDefault;
      $('#addressDefault').disabled = address.isDefault;
    }
    $('#addressEditor').hidden = false;
    $('#addressEditor').scrollIntoView({ block: 'start' });
    $('#addressFullName').focus({ preventScroll: true });
  }
  async function loadAddresses() {
    if (!session.getToken(localStorage)) return showAuth();
    $('#addressAuth').hidden = true;
    showMessage('Loading your addresses…');
    try {
      const result = await request('/api/addresses');
      addresses = Array.isArray(result.data) ? result.data : [];
      showMessage('');
      renderAddresses();
      if (!addresses.length) openEditor();
    } catch (error) {
      if (!session.getToken(localStorage)) return showAuth(error.message);
      showMessage(error.message, 'error');
    }
  }
  async function saveAddress(event) {
    event.preventDefault();
    $('#addressFormStatus').textContent = 'Saving…';
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    const addressId = $('#addressId').value;
    try {
      const saved = await request(addressId ? `/api/addresses/${encodeURIComponent(addressId)}` : '/api/addresses', {
        method: addressId ? 'PATCH' : 'POST',
        body: JSON.stringify(body)
      });
      const address = saved.data;
      if ($('#addressDefault').checked && !address.isDefault) await request(`/api/addresses/${encodeURIComponent(address.id)}/default`, { method: 'POST', body: '{}' });
      $('#addressEditor').hidden = true;
      await loadAddresses();
      showMessage('Address saved.', 'success');
    } catch (error) {
      $('#addressFormStatus').textContent = error.message;
      $('#addressFormStatus').className = 'login-message address-message-error';
    }
  }
  async function makeDefault(addressId) {
    try { await request(`/api/addresses/${encodeURIComponent(addressId)}/default`, { method: 'POST', body: '{}' }); await loadAddresses(); }
    catch (error) { showMessage(error.message, 'error'); }
  }
  async function removeAddress(addressId) {
    if (!window.confirm('Delete this saved address?')) return;
    try { await request(`/api/addresses/${encodeURIComponent(addressId)}`, { method: 'DELETE' }); await loadAddresses(); showMessage('Address deleted.', 'success'); }
    catch (error) { showMessage(error.message, 'error'); }
  }

  $('#addAddressButton').addEventListener('click', () => openEditor());
  $('#cancelAddressButton').addEventListener('click', () => { $('#addressEditor').hidden = true; });
  $('#addressForm').addEventListener('submit', saveAddress);
  $('#addressesList').addEventListener('click', event => {
    const edit = event.target.closest('[data-edit-address]');
    const setDefault = event.target.closest('[data-default-address]');
    const remove = event.target.closest('[data-delete-address]');
    if (edit) openEditor(addresses.find(address => address.id === edit.dataset.editAddress));
    if (setDefault) makeDefault(setDefault.dataset.defaultAddress);
    if (remove) removeAddress(remove.dataset.deleteAddress);
  });
  window.addEventListener('storage', event => {
    if ([session.customerTokenKey, session.legacyTokenKey].includes(event.key)) loadAddresses();
  });
  const wishlist = window.LexoraWishlist;
  wishlist?.load().then(result => { const count = $('#wishlistCount'); if (count) count.textContent = String(result.ids.length); });
  loadAddresses();
})();
