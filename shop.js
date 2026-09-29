const apiBase = 'http://localhost:4000';
const imageFallbacks = {
  'Vela sculptural table lamp': 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=900&q=85',
  'Kanso travel case': 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=900&q=85',
  'Forma lounge chair': 'https://images.unsplash.com/photo-1592078615290-033ee584e267?auto=format&fit=crop&w=900&q=85'
};
let products = [];
let wishlist = window.LexoraWishlist?.snapshot() || JSON.parse(localStorage.getItem('lexora-wishlist') || '[]');
let cart = readCart();
const $ = selector => document.querySelector(selector);
const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value || 0);
function imageFor(product) { return product.images?.[0] || product.imageUrl || product.image || imageFallbacks[product.name] || 'product-fallback.svg'; }
function imageAttrs(image) { return `src="${image}" onerror="this.onerror=null;this.src='product-fallback.svg';this.classList.add('image-fallback')" onload="this.classList.add('image-loaded')"`; }
function setState(message, state = '') { const element = $('#shopState') || $('#productState'); if (element) { element.textContent = message; element.className = `api-state ${state}`.trim(); } }
function wholesalePrice(product) { return Number(product.wholesalePrice ?? product.wholesale ?? 0); }
function availableUnits(product) { const stock = Number(product.availableStock ?? product.stock); return Number.isSafeInteger(stock) && stock >= 0 ? stock : null; }
function stockMessage(product) { const stock = availableUnits(product); if (stock === null) return 'Availability confirmed at checkout'; if (stock === 0) return 'Out of stock'; if (stock <= Number(product.lowStockThreshold ?? 5)) return `Only ${stock} left`; return 'In stock'; }
function stockTone(product) { const stock = availableUnits(product); return stock === 0 ? 'stock-out' : stock !== null && stock <= Number(product.lowStockThreshold ?? 5) ? 'stock-low' : 'stock-good'; }
function isWishlisted(id) { return wishlist.some(item => String(item) === String(id)); }
function updateWishlistCount() { const count = $('#wishlistCount'); if (count) count.textContent = wishlist.length; }
function readCart() { try { return JSON.parse(localStorage.getItem('lexora-cart') || '[]').filter(item => item && item.id != null && Number(item.qty) > 0).map(item => ({ ...item, id: String(item.id), qty: Number(item.qty) })); } catch { return []; } }
function repairCartAgainstProducts() { const validIds = new Set(products.map(product => String(product.id))); const repaired = cart.filter(item => validIds.has(String(item.id))); if (repaired.length !== cart.length) { cart = repaired; localStorage.setItem('lexora-cart', JSON.stringify(cart)); } updateCartCount(); }
function updateCartCount() { const count = $('#cartCount'); if (count) count.textContent = cart.reduce((total, item) => total + item.qty, 0); }
function addToCart(id, quantity = 1) { const key = String(id); const item = cart.find(entry => String(entry.id) === key); if (item) item.qty += quantity; else cart.push({ id: key, qty: quantity }); localStorage.setItem('lexora-cart', JSON.stringify(cart)); updateCartCount(); }
function ensureCartNav() { const headerActions = $('.header-actions'); if (headerActions && !$('#cartCount')) headerActions.insertAdjacentHTML('afterbegin', '<a class="cart-nav" href="cart.html" aria-label="Shopping cart"><span aria-hidden="true">⌂</span> Cart <span class="wishlist-count" id="cartCount">0</span></a>'); updateCartCount(); }
function syncWishlistButtons() { document.querySelectorAll('[data-wishlist]').forEach(button => { const saved = isWishlisted(button.dataset.wishlist); button.classList.toggle('saved', saved); button.textContent = saved ? '♥' : '♡'; button.setAttribute('aria-label', `${saved ? 'Remove' : 'Save'} ${button.dataset.name} ${saved ? 'from' : 'to'} wishlist`); }); updateWishlistCount(); }
async function toggleWishlist(id) { try { const result = await window.LexoraWishlist.toggle(id); wishlist = result.ids; syncWishlistButtons(); } catch (error) { setState(error.message, 'error'); } }
function priceMatches(product, range) { const price = Number(product.price || 0); return range === 'all' || (range === 'under-100' && price < 100) || (range === '100-500' && price >= 100 && price <= 500) || (range === 'over-500' && price > 500); }
function renderShop() {
  const term = ($('#shopSearch').value || '').trim().toLowerCase(); const category = $('#shopCategory').value; const location = $('#shopLocation').value; const price = $('#shopPrice').value; const verified = $('#shopVerified').checked; const wholesale = $('#shopWholesale').checked;
  let visible = products.filter(product => `${product.name} ${product.brand || ''} ${product.category} ${product.supplier} ${product.location}`.toLowerCase().includes(term) && (category === 'all' || product.category === category) && (location === 'all' || product.location === location) && priceMatches(product, price) && (!verified || product.verified === true) && (!wholesale || wholesalePrice(product) > 0));
  const sort = $('#shopSort').value; if (sort === 'price-low') visible.sort((a, b) => Number(a.price || 0) - Number(b.price || 0)); if (sort === 'price-high') visible.sort((a, b) => Number(b.price || 0) - Number(a.price || 0));
  $('#shopCount').textContent = `Showing ${visible.length} product${visible.length === 1 ? '' : 's'}`;
  $('#shopGrid').innerHTML = visible.length ? visible.map(product => `<article class="shop-card"><div class="shop-card-image"><button class="wishlist-button ${isWishlisted(product.id) ? 'saved' : ''}" type="button" data-wishlist="${product.id}" data-name="${product.name}" aria-label="${isWishlisted(product.id) ? 'Remove' : 'Save'} ${product.name} ${isWishlisted(product.id) ? 'from' : 'to'} wishlist">${isWishlisted(product.id) ? '♥' : '♡'}</button><img ${imageAttrs(imageFor(product))} alt="${product.name}" loading="lazy" /></div><a href="product.html?id=${encodeURIComponent(product.id)}&wishlist=20260927-r2" class="shop-card-link"><div class="shop-card-copy"><div class="product-top"><h2>${product.name}</h2><strong>${money(product.price)}</strong></div><p>by <b>${product.supplier}</b> · ${product.location}${product.verified ? ' · <span class="verified">✓ VERIFIED</span>' : ''}</p><div class="product-meta">${window.lexoraRatingMarkup(product)}<span class="moq">MOQ ${product.moq || 1}</span></div><span class="inventory-note ${stockTone(product)}">${stockMessage(product)}</span>${wholesalePrice(product) > 0 ? `<span class="wholesale-note">Wholesale from ${money(wholesalePrice(product))}</span>` : ''}
<span class="shop-card-action">View product ↗</span></div></a></article>`).join('') : '<div class="empty-state"><strong>No products match these filters.</strong><span>Try widening your search or clearing the filters.</span><button class="clear-filters" type="button" data-clear-empty>Clear filters</button></div>';
  document.querySelectorAll('[data-wishlist]').forEach(button => button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); toggleWishlist(button.dataset.wishlist); }));
  const emptyClear = $('[data-clear-empty]'); if (emptyClear) emptyClear.addEventListener('click', clearFilters);
}
function clearFilters() { $('#shopSearch').value = ''; $('#shopCategory').value = 'all'; $('#shopLocation').value = 'all'; $('#shopPrice').value = 'all'; $('#shopVerified').checked = false; $('#shopWholesale').checked = false; $('#shopSort').value = 'featured'; renderShop(); }
async function loadShop() {
  const saved = await window.LexoraWishlist?.load(); if (saved) wishlist = saved.ids;
  try { const response = await fetch(`${apiBase}/api/products`); if (!response.ok) throw new Error(`Products request failed (${response.status})`); const payload = await response.json(); if (!Array.isArray(payload.data)) throw new Error('Products response was invalid'); products = payload.data; repairCartAgainstProducts(); setState('Product catalogue ready', 'success'); const categories = [...new Set(products.map(product => product.category))]; const locations = [...new Set(products.map(product => product.location))]; $('#shopCategory').innerHTML += categories.map(category => `<option value="${category}">${category}</option>`).join(''); $('#shopLocation').innerHTML += locations.map(location => `<option value="${location}">${location}</option>`).join(''); renderShop(); } catch (error) { setState('Products could not be loaded. Please refresh and try again.', 'error'); $('#shopGrid').innerHTML = '<p class="empty-state">The catalogue is temporarily unavailable.</p>'; console.error(error); }
}
async function loadProduct() {
  const saved = await window.LexoraWishlist?.load(); if (saved) wishlist = saved.ids;
  const id = new URLSearchParams(location.search).get('id');
  const headerActions = $('.header-actions'); if (headerActions && !$('#wishlistCount')) headerActions.insertAdjacentHTML('afterbegin', '<a class="wishlist-nav" href="wishlist.html" aria-label="Wishlist"><span aria-hidden="true">♡</span> Wishlist <span class="wishlist-count" id="wishlistCount">0</span></a>'); ensureCartNav();
  try { const response = await fetch(`${apiBase}/api/products/${encodeURIComponent(id || '')}`); if (!response.ok) throw new Error(`Product request failed (${response.status})`); const payload = await response.json(); const product = payload.data; const productStock = availableUnits(product); document.title = `${product.name} | LEXORA`; setState('Product loaded', 'success'); $('#productDetail').innerHTML = `<div class="product-detail-image"><img ${imageAttrs(imageFor(product))} alt="${product.name}" /></div><div class="product-detail-copy"><div class="detail-actions"><button class="wishlist-button product-wishlist ${isWishlisted(product.id) ? 'saved' : ''}" type="button" data-wishlist="${product.id}" data-name="${product.name}" aria-label="${isWishlisted(product.id) ? 'Remove' : 'Save'} ${product.name} ${isWishlisted(product.id) ? 'from' : 'to'} wishlist">${isWishlisted(product.id) ? '♥' : '♡'}</button><a class="text-button" href="mailto:trade@lexora.example?subject=${encodeURIComponent(`Supplier enquiry: ${product.name}`)}">Contact supplier ↗</a></div><p class="eyebrow">${product.category.toUpperCase()} · ${product.location.toUpperCase()}</p><h1>${product.name}</h1><p class="supplier-line">by <b>${product.supplier}</b> ${product.verified ? '· <span class="verified">✓ VERIFIED SUPPLIER</span>' : ''}</p>${product.supplierId ? `<a class="text-button" href="supplier-storefront.html?id=${encodeURIComponent(product.supplierId)}">Visit supplier storefront ↗</a>` : ''}<p class="detail-description">A considered product from the LEXORA marketplace, selected for retail and trade buyers.</p><div class="detail-price">${money(product.price)} <span>retail</span></div><div class="tier-table"><div><span>Wholesale from ${product.moq || 1} units</span><b>${money(product.wholesalePrice || product.price)} / unit</b></div><div><span>Availability</span><b>${stockMessage(product)}</b></div></div><div class="product-options">

  <label for="productColor">Choose Color</label>
  <select id="productColor">
    <option value="">Select color</option>
    <option value="Black">Black</option>
    <option value="White">White</option>
    <option value="Brown">Brown</option>
  </select>

  <label for="productSize">Choose Size</label>
  <select id="productSize">
    <option value="">Select size</option>
    <option value="40">40</option>
    <option value="41">41</option>
    <option value="42">42</option>
    <option value="43">43</option>
    <option value="44">44</option>
    <option value="45">45</option>
  </select>

 </div><div class="product-cart-controls"><button type="button" id="productQtyMinus" aria-label="Decrease quantity">−</button><strong id="productQty">1</strong><button type="button" id="productQtyPlus" aria-label="Increase quantity">＋</button><button class="button button-dark" type="button" id="addProductToCart" ${productStock === 0 ? 'disabled' : ''}>${productStock === 0 ? 'Out of stock' : 'Add to cart <span>＋</span>'}</button></div><a class="button button-light" href="shop.html">Continue shopping <span>↗</span></a></div>`; const wishlistButton = $('[data-wishlist]'); wishlistButton.addEventListener('click', () => toggleWishlist(product.id, wishlistButton)); let quantity = 1; $('#productQtyMinus').addEventListener('click', () => { quantity = Math.max(1, quantity - 1); $('#productQty').textContent = quantity; }); $('#productQtyPlus').addEventListener('click', () => { quantity = Math.min(productStock ?? (Number(product.stock) || 1), quantity + 1); $('#productQty').textContent = quantity; }); $('#addProductToCart').addEventListener('click', () => { if (productStock === 0 || (productStock !== null && productStock < quantity)) { setState(productStock === 0 ? 'This product is currently out of stock.' : `Only ${productStock} units are available.`, 'error'); return; } addToCart(product.id, quantity); setState(`${quantity} item${quantity === 1 ? '' : 's'} added to cart`, 'success'); }); updateWishlistCount(); } catch (error) { setState('Product could not be loaded. Please return to the Shop.', 'error'); $('#productDetail').innerHTML = '<a class="button button-dark" href="shop.html">Return to shop <span>↗</span></a>'; console.error(error); }
}
window.addEventListener('lexora:wishlist-change', event => { wishlist = event.detail.ids; syncWishlistButtons(); if ($('#shopGrid')) renderShop(); });
window.addEventListener('storage', event => { if (event.key === 'lexora-wishlist' && !window.LexoraCustomerSession?.getToken(localStorage)) { wishlist = window.LexoraWishlist.snapshot(); syncWishlistButtons(); if ($('#shopGrid')) renderShop(); } if (event.key === 'lexora-cart') { cart = readCart(); updateCartCount(); } });
updateWishlistCount();
ensureCartNav();
if ($('#shopGrid')) { ['shopSearch', 'shopCategory', 'shopLocation', 'shopPrice', 'shopVerified', 'shopWholesale', 'shopSort'].forEach(id => $(`#${id}`).addEventListener(id === 'shopSearch' ? 'input' : 'change', renderShop)); $('#shopClear').addEventListener('click', clearFilters); window.addEventListener('pageshow', event => { if (event.persisted) { wishlist = JSON.parse(localStorage.getItem('lexora-wishlist') || '[]'); cart = readCart(); updateWishlistCount(); updateCartCount(); renderShop(); clearFilters(); } }); loadShop(); } else {
  const productId = new URLSearchParams(location.search).get('id');
  const productDetail = $('#productDetail');
  const observer = new MutationObserver(() => {
    const actions = $('.detail-actions');
    if (!actions || !productId || actions.querySelector('[data-visual-search-product]')) return;
    const link = document.createElement('a');
    link.className = 'text-button';
    link.href = `visual-search.html?v=visual-search-20260927-r2&productId=${encodeURIComponent(productId)}`;
    link.dataset.visualSearchProduct = '';
    link.textContent = 'Find Similar ↗';
    actions.append(link);
    observer.disconnect();
  });
  observer.observe(productDetail, { childList: true, subtree: true });
  loadProduct();
}
