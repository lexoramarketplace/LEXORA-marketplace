(function (root, factory) {
  const session = factory();
  if (typeof module === 'object' && module.exports) module.exports = session;
  if (root) root.LexoraAdminSession = session;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const adminTokenKey = 'lexora-admin-token';
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
    const adminToken = storage.getItem(adminTokenKey) || '';
    if (adminToken) return adminToken;
    const legacyToken = storage.getItem(legacyTokenKey) || '';
    if (legacyToken && tokenRole(legacyToken) === 'admin') {
      storage.setItem(adminTokenKey, legacyToken);
      return legacyToken;
    }
    return '';
  }

  function saveToken(storage, token) {
    storage.setItem(adminTokenKey, token);
    if (!storage.getItem(legacyTokenKey) || tokenRole(storage.getItem(legacyTokenKey)) === 'admin') {
      storage.setItem(legacyTokenKey, token);
    }
  }

  function clearToken(storage, token = storage.getItem(adminTokenKey) || '') {
    storage.removeItem(adminTokenKey);
    if (token && storage.getItem(legacyTokenKey) === token) storage.removeItem(legacyTokenKey);
  }

  return { adminTokenKey, legacyTokenKey, tokenRole, getToken, saveToken, clearToken };
});