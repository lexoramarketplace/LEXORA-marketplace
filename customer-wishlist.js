(() => {
  const apiBase = 'http://localhost:4000';
  const guestKey = 'lexora-wishlist';
  const syncKey = 'lexora-wishlist-sync';
  const customerSession = window.LexoraCustomerSession;
  let activeToken = '';
  let items = [];
  let loading = null;
  let loadingToken = '';

  function token() { return customerSession?.getToken(localStorage) || ''; }
  function uniqueIds(values) { return [...new Set((Array.isArray(values) ? values : []).map(value => String(value || '')).filter(Boolean))]; }
  function readGuestIds() {
    try { return uniqueIds(JSON.parse(localStorage.getItem(guestKey) || '[]')); } catch { return []; }
  }
  function snapshot() { return token() ? (activeToken === token() ? uniqueIds(items.map(item => item.productId)) : []) : readGuestIds(); }
  function notify(authenticated = Boolean(token())) {
    window.dispatchEvent(new CustomEvent('lexora:wishlist-change', { detail: { ids: snapshot(), items: [...items], authenticated } }));
  }
  function headers(currentToken = token()) { return currentToken ? { Authorization: `Bearer ${currentToken}` } : {}; }
  async function responsePayload(response) { return response.json().catch(() => ({})); }

  async function load({ force = false } = {}) {
    const currentToken = token();
    if (!currentToken) {
      activeToken = '';
      items = readGuestIds().map(productId => ({ productId }));
      notify(false);
      return { ids: snapshot(), items: [...items], authenticated: false };
    }
    if (loading && loadingToken === currentToken) return loading;
    if (!force && activeToken === currentToken) return { ids: snapshot(), items: [...items], authenticated: true };
    activeToken = currentToken;
    loadingToken = currentToken;
    loading = (async () => {
      try {
        const response = await fetch(`${apiBase}/api/wishlist`, { headers: headers(currentToken) });
        const payload = await responsePayload(response);
        if (response.status === 401) {
          const state = await customerSession.handleUnauthorized(fetch, apiBase, localStorage, currentToken);
          if (state === 'invalid') {
            activeToken = '';
            items = readGuestIds().map(productId => ({ productId }));
            notify(false);
            return { ids: snapshot(), items: [...items], authenticated: false };
          }
        }
        if (!response.ok) throw new Error(payload.error || 'Your wishlist could not be loaded.');
        if (token() !== currentToken) return load({ force: true });
        items = Array.isArray(payload.data) ? payload.data : [];
        activeToken = currentToken;
        notify(true);
        return { ids: snapshot(), items: [...items], authenticated: true };
      } catch (error) {
        return { ids: snapshot(), items: [...items], authenticated: true, error };
      } finally {
        if (loadingToken === currentToken) {
          loading = null;
          loadingToken = '';
        }
      }
    })();
    return loading;
  }

  async function toggle(productId) {
    const key = String(productId || '');
    if (!key) throw new Error('Product is unavailable.');
    const currentToken = token();
    if (!currentToken) {
      const current = readGuestIds();
      const next = current.includes(key) ? current.filter(id => id !== key) : [...current, key];
      localStorage.setItem(guestKey, JSON.stringify(next));
      activeToken = '';
      items = next.map(id => ({ productId: id }));
      notify(false);
      return { ids: next, saved: next.includes(key), authenticated: false };
    }

    const loaded = await load();
    if (loaded.error) throw loaded.error;
    const exists = loaded.ids.includes(key);
    const response = await fetch(`${apiBase}/api/wishlist/${encodeURIComponent(key)}`, {
      method: exists ? 'DELETE' : 'POST',
      headers: headers(currentToken)
    });
    const payload = await responsePayload(response);
    if (!response.ok) throw new Error(payload.error || 'Your wishlist could not be updated.');
    items = exists ? items.filter(item => String(item.productId) !== key) : [...items, payload.data];
    activeToken = currentToken;
    localStorage.setItem(syncKey, String(Date.now()));
    notify(true);
    return { ids: snapshot(), saved: !exists, authenticated: true };
  }

  window.addEventListener('storage', event => {
    if (event.key === syncKey && token()) load({ force: true });
    if ([customerSession?.customerTokenKey, customerSession?.legacyTokenKey].includes(event.key)) {
      activeToken = '';
      items = [];
      load({ force: true });
    }
    if (event.key === guestKey && !token()) {
      activeToken = '';
      items = readGuestIds().map(productId => ({ productId }));
      notify(false);
    }
  });

  window.LexoraWishlist = { load, snapshot, toggle, isSaved: productId => snapshot().includes(String(productId)) };
})();
