const apiBase = 'http://localhost:4000';
let products = [];
let wishlistItems = [];
let wishlistIds = [];
const $ = selector => document.querySelector(selector);
const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(value || 0));
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
function imageFor(product) { return product?.images?.[0] || product?.imageUrl || product?.image || 'product-fallback.svg'; }
function imageAttrs(image) { return `src="${escapeHtml(image)}" onerror="this.onerror=null;this.src='product-fallback.svg';this.classList.add('image-fallback')" onload="this.classList.add('image-loaded')"`; }
function updateCount() { const count = $('#wishlistCount'); if (count) count.textContent = String(wishlistIds.length); }
function readCart() { try { const saved = JSON.parse(localStorage.getItem('lexora-cart') || '[]'); return Array.isArray(saved) ? saved.filter(item => item && item.id != null && Number.isSafeInteger(Number(item.qty)) && Number(item.qty) > 0).map(item => ({ ...item, id: String(item.id), qty: Number(item.qty) })) : []; } catch { return []; } }
function setMessage(text, type = '') { const node = $('#wishlistMessage'); node.textContent = text; node.className = `wishlist-message ${type}`.trim(); node.hidden = !text; }
function cardProduct(item) { return item.product || products.find(product => String(product.id) === String(item.productId)) || null; }
function renderWishlist() {
  wishlistIds = [...new Set(wishlistItems.map(item => String(item.productId)).filter(Boolean))];
  updateCount();
  $('#wishlistSummary').textContent = `${wishlistIds.length} saved product${wishlistIds.length === 1 ? '' : 's'}`;
  const saved = wishlistItems.map(item => ({ item, product: cardProduct(item) }));
  $('#wishlistGrid').innerHTML = saved.length ? saved.map(({ item, product }) => {
    const productId = String(item.productId);
    const productName = product?.name || 'Product no longer available';
    const available = Number(product?.availableStock);
    const unavailable = !product || product.status === 'inactive' || product.status === 'draft';
    const stockLabel = unavailable ? 'Product unavailable' : available === 0 ? 'Out of stock' : available > 0 && available <= Number(product.lowStockThreshold || 5) ? `Only ${available} left` : 'In stock';
    const stockClass = unavailable || available === 0 ? 'stock-out' : available > 0 && available <= Number(product.lowStockThreshold || 5) ? 'stock-low' : 'stock-good';
    return `<article class="wishlist-card ${unavailable ? 'unavailable' : ''}"><div class="wishlist-card-image">${product ? `<img ${imageAttrs(imageFor(product))} alt="${escapeHtml(productName)}" loading="lazy" />` : '<div class="wishlist-unavailable-image" role="img" aria-label="Product image unavailable">Image unavailable</div>'}</div><div class="wishlist-card-copy"><div class="product-top"><h2>${escapeHtml(productName)}</h2>${product ? `<strong>${escapeHtml(money(product.price))}</strong>` : ''}</div>${product ? `<p class="supplier-line">by <b>${escapeHtml(product.supplier || 'LEXORA')}</b> · ${escapeHtml(product.location || 'Global')}</p><div class="product-meta">${window.lexoraRatingMarkup(product)}<span class="moq">MOQ ${Number(product.moq || 1)}</span></div>` : '<p class="supplier-line">This product is no longer in the catalogue.</p>'}<p class="wishlist-stock ${stockClass}">${stockLabel}</p><div class="wishlist-card-actions">${product ? `<a class="button button-dark" href="product.html?id=${encodeURIComponent(productId)}&wishlist=20260927-r2">View product <span>↗</span></a><button class="button button-light" type="button" data-add-cart="${escapeHtml(productId)}" ${unavailable || available === 0 ? 'disabled' : ''}>Add to cart <span>＋</span></button>` : ''}<button class="text-button" type="button" data-remove="${escapeHtml(productId)}">Remove</button></div></div></article>`;
  }).join('') : '<div class="wishlist-empty"><p class="eyebrow">NOTHING SAVED YET</p><h2>Your considered edit<br /><em>starts here.</em></h2><p>Save products from the Shop and they will stay here across your visits.</p><a class="button button-dark" href="shop.html">Explore the shop <span>↗</span></a></div>';
}
async function loadWishlist() {
  setMessage('');
  const result = await window.LexoraWishlist.load({ force: true });
  if (result.error) {
    $('#wishlistSummary').textContent = 'Wishlist unavailable';
    $('#wishlistGrid').innerHTML = '<div class="wishlist-empty"><h2>We could not load your saved products.</h2><p>Please refresh and try again.</p></div>';
    setMessage(result.error.message, 'error');
    return;
  }
  if (result.authenticated) {
    wishlistItems = result.items;
    products = [];
    renderWishlist();
    return;
  }
  wishlistIds = result.ids;
  try {
    const response = await fetch(`${apiBase}/api/products`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(payload.data)) throw new Error(payload.error || 'Products could not be loaded.');
    products = payload.data;
    wishlistItems = wishlistIds.map(productId => ({ productId }));
    renderWishlist();
  } catch (error) {
    $('#wishlistSummary').textContent = `${wishlistIds.length} saved product${wishlistIds.length === 1 ? '' : 's'}`;
    $('#wishlistGrid').innerHTML = '<div class="wishlist-empty"><h2>Saved products are temporarily unavailable.</h2><p>Your guest wishlist remains saved in this browser.</p></div>';
    setMessage(error.message, 'error');
  }
}
async function removeWishlist(productId) {
  try {
    await window.LexoraWishlist.toggle(productId);
    await loadWishlist();
    setMessage('Product removed from your wishlist.');
  } catch (error) { setMessage(error.message, 'error'); }
}
function addWishlistProductToCart(productId) {
  const product = cardProduct(wishlistItems.find(item => String(item.productId) === String(productId)) || {});
  if (!product || product.status === 'inactive' || product.status === 'draft') return setMessage('This product is no longer available.', 'error');
  const stock = Number(product.availableStock);
  if (!Number.isSafeInteger(stock) || stock <= 0) return setMessage('This product is out of stock.', 'error');
  const cart = readCart();
  const existing = cart.find(item => item.id === String(productId));
  if (existing && existing.qty >= stock) return setMessage(`Only ${stock} units are available.`, 'error');
  if (existing) existing.qty += 1;
  else cart.push({ id: String(productId), qty: 1 });
  localStorage.setItem('lexora-cart', JSON.stringify(cart));
  window.dispatchEvent(new CustomEvent('lexora:cart-change', { detail: { cart } }));
  updateCartCount();
  setMessage(`${product.name} added to your cart.`);
}
$('#wishlistGrid').addEventListener('click', event => {
  const remove = event.target.closest('[data-remove]');
  const add = event.target.closest('[data-add-cart]');
  if (remove) removeWishlist(remove.dataset.remove);
  if (add) addWishlistProductToCart(add.dataset.addCart);
});
window.addEventListener('lexora:wishlist-change', event => {
  wishlistIds = event.detail.ids;
  wishlistItems = event.detail.authenticated ? event.detail.items : wishlistIds.map(productId => ({ productId }));
  if (event.detail.authenticated || products.length) renderWishlist();
});
window.addEventListener('lexora:cart-change', updateCartCount);
window.addEventListener('storage', event => { if (event.key === 'lexora-cart') updateCartCount(); });
function updateCartCount() { const count = $('#cartCount'); if (count) count.textContent = String(readCart().reduce((total, item) => total + item.qty, 0)); }
window.addEventListener('pageshow', event => { if (event.persisted) loadWishlist(); updateCartCount(); });
updateCartCount();
loadWishlist();