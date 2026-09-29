(function (root, factory) {
  const session = factory();
  if (typeof module === 'object' && module.exports) module.exports = session;
  if (root) root.LexoraCustomerSession = session;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const customerTokenKey = 'lexora-customer-token';
  const legacyTokenKey = 'lexora-token';

  function tokenRole(token) {
    try {
      const encoded = String(token || '').split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(encoded)).role || '';
    } catch {
      return '';
    }
  }

  function getToken(storage) {
    const customerToken = storage.getItem(customerTokenKey) || '';
    if (customerToken) return customerToken;
    const legacyToken = storage.getItem(legacyTokenKey) || '';
    if (legacyToken && tokenRole(legacyToken) === 'customer') {
      storage.setItem(customerTokenKey, legacyToken);
      return legacyToken;
    }
    return '';
  }

  function saveToken(storage, token) {
    storage.setItem(customerTokenKey, token);
    if (!storage.getItem(legacyTokenKey) || tokenRole(storage.getItem(legacyTokenKey)) === 'customer') {
      storage.setItem(legacyTokenKey, token);
    }
  }

  function clearToken(storage, token = storage.getItem(customerTokenKey) || '') {
    storage.removeItem(customerTokenKey);
    if (token && storage.getItem(legacyTokenKey) === token) storage.removeItem(legacyTokenKey);
  }

  async function verifyToken(fetchImpl, apiBase, token) {
    if (!token) return 'invalid';
    try {
      const response = await fetchImpl(`${apiBase}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.ok) return 'valid';
      if (response.status === 401) return 'invalid';
      return 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  async function handleUnauthorized(fetchImpl, apiBase, storage, token) {
    const state = await verifyToken(fetchImpl, apiBase, token);
    if (state === 'invalid') clearToken(storage, token);
    return state;
  }

  return { customerTokenKey, legacyTokenKey, tokenRole, getToken, saveToken, clearToken, verifyToken, handleUnauthorized };
});
