(function (root, factory) {
  const session = factory();
  if (typeof module === 'object' && module.exports) module.exports = session;
  if (root) root.LexoraSupplierSession = session;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const tokenKey = 'lexora-supplier-token';

  function decodeRole(token) {
    try {
      const encoded = String(token || '').split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(encoded));
      return payload.role || '';
    } catch {
      return '';
    }
  }

  function getToken(storage) {
    return storage.getItem(tokenKey) || '';
  }

  function saveToken(storage, token) {
    storage.setItem(tokenKey, token);
  }

  function clearToken(storage) {
    storage.removeItem(tokenKey);
  }

  function userRole(storage) {
    return decodeRole(getToken(storage));
  }

  return { tokenKey, getToken, saveToken, clearToken, userRole };
});
