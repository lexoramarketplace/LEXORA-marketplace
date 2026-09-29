const apiBase = 'http://localhost:4000';
const imageFallbacks = {
  'Vela sculptural table lamp': 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=900&q=85',
  'Kanso travel case': 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=900&q=85',
  'Forma lounge chair': 'https://images.unsplash.com/photo-1592078615290-033ee584e267?auto=format&fit=crop&w=900&q=85'
};
let products = [];
let cart = readCart();
const $ = selector => document.querySelector(selector);
const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value || 0);
function readCart() { try { const raw = JSON.parse(localStorage.getItem('lexora-cart') || '[]'); if (!Array.isArray(raw)) return []; return raw.filter(item => item && item.id != null && Number.isInteger(Number(item.qty)) && Number(item.qty) > 0).map(item => ({ id: String(item.id), qty: Number(item.qty) })); } catch { return []; } }
function syncCart(nextCart) { cart = nextCart; localStorage.setItem('lexora-cart', JSON.stringify(cart)); return cart; }
function imageFor(product) { return product.image || imageFallbacks[product.name] || 'product-fallback.svg'; }
function imageAttrs(image) { return `src="${image}" onerror="this.onerror=null;this.src='product-fallback.svg';this.classList.add('image-fallback')" onload="this.classList.add('image-loaded')"`; }
function updateCartCount() { const count = $('#cartCount'); if (count) count.textContent = readCart().reduce((total, item) => total + item.qty, 0); }
function updateWishlistCount() { const saved = window.LexoraWishlist?.snapshot(); if (saved) { $('#wishlistCount').textContent = String(saved.length); return; } try { $('#wishlistCount').textContent = JSON.parse(localStorage.getItem('lexora-wishlist') || '[]').length; } catch { $('#wishlistCount').textContent = '0'; } }
function updateItem(id, change) { const item = cart.find(entry => String(entry.id) === String(id)); if (!item) return; item.qty = Math.max(0, item.qty + change); cart = cart.filter(entry => entry.qty > 0); persistCart(); renderCart(); }
function removeItem(id) { cart = cart.filter(item => String(item.id) !== String(id)); persistCart(); renderCart(); }
function persistCart() { syncCart(cart); updateCartCount(); }
function renderCart() {
  const entries = cart.map(item => ({ item, product: products.find(product => String(product.id) === String(item.id)) })).filter(entry => entry.product);
  const subtotal = entries.reduce((total, entry) => total + Number(entry.product.price || 0) * entry.item.qty, 0);
  updateCartCount(); $('#cartSummary').textContent = `${entries.length} product${entries.length === 1 ? '' : 's'} · ${cart.reduce((total, item) => total + item.qty, 0)} item${cart.reduce((total, item) => total + item.qty, 0) === 1 ? '' : 's'}`; $('#cartSubtotalPage').textContent = money(subtotal);
  $('#cartItemsPage').innerHTML = entries.length ? entries.map(({ item, product }) => `<article class="cart-page-item"><img ${imageAttrs(imageFor(product))} alt="${product.name}" loading="lazy" /><div class="cart-page-item-copy"><div class="product-top"><h2>${product.name}</h2><strong>${money(product.price * item.qty)}</strong></div><p class="supplier-line">by <b>${product.supplier}</b> · ${product.location}</p><div class="cart-page-item-meta"><span>${money(product.price)} / unit</span>${window.lexoraRatingMarkup(product)}</div><div class="cart-page-actions"><div class="quantity-control"><button type="button" data-decrease="${product.id}" aria-label="Decrease ${product.name} quantity">−</button><strong>${item.qty}</strong><button type="button" data-increase="${product.id}" aria-label="Increase ${product.name} quantity">＋</button></div><button class="text-button" type="button" data-remove="${product.id}">Remove</button></div></div></article>`).join('') : '<div class="cart-empty"><p class="eyebrow">YOUR CART IS EMPTY</p><h2>Nothing selected<br /><em>yet.</em></h2><p>Explore the Shop and add products to begin your next order.</p><a class="button button-dark" href="shop.html">Explore the shop <span>↗</span></a></div>';
  document.querySelectorAll('[data-increase]').forEach(button => button.addEventListener('click', () => updateItem(button.dataset.increase, 1))); document.querySelectorAll('[data-decrease]').forEach(button => button.addEventListener('click', () => updateItem(button.dataset.decrease, -1))); document.querySelectorAll('[data-remove]').forEach(button => button.addEventListener('click', () => removeItem(button.dataset.remove)));
}
async function loadCart() { try { const response = await fetch(`${apiBase}/api/products`); if (!response.ok) throw new Error(`Products request failed (${response.status})`); const payload = await response.json(); if (!Array.isArray(payload.data)) throw new Error('Products response was invalid'); products = payload.data; const validIds = new Set(products.map(product => String(product.id))); syncCart(readCart().filter(item => validIds.has(item.id))); renderCart(); } catch (error) { $('#cartSummary').textContent = 'Cart unavailable'; $('#cartItemsPage').innerHTML = '<div class="cart-empty"><h2>We could not load your cart.</h2><p>Please refresh and try again.</p></div>'; console.error(error); } }
window.addEventListener('storage', event => { if (event.key === 'lexora-cart') { cart = readCart(); renderCart(); } if (event.key === 'lexora-wishlist') updateWishlistCount(); });
window.addEventListener('lexora:wishlist-change', updateWishlistCount);
window.addEventListener('pageshow', () => { cart = readCart(); if (products.length) renderCart(); });

function startCheckout() {
  const cartItems = readCart();

  if (!cartItems.length) {
    $('#cartSummary').textContent = 'Your cart is empty';
    return;
  }

  window.location.href = 'checkout.html?v=paypal-reservation-20260927-r1';
}

$('#checkoutPage').addEventListener('click', startCheckout);
updateWishlistCount();
window.LexoraWishlist?.load().then(updateWishlistCount);
loadCart();
