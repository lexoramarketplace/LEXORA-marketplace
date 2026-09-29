function readSharedCart() {
  try { const raw = JSON.parse(localStorage.getItem('lexora-cart') || '[]'); if (!Array.isArray(raw)) return []; return raw.filter(item => item && item.id != null && Number.isInteger(Number(item.qty)) && Number(item.qty) > 0).map(item => ({ id: String(item.id), qty: Number(item.qty) })); } catch { return []; }
}
function sharedCartProduct(id) { return products.find(product => String(product.id) === String(id)); }
function updateSharedCartCount() { const count = document.querySelector('#cartCount'); if (count) count.textContent = readSharedCart().reduce((total, item) => total + item.qty, 0); }
function renderSharedCart() {
  const currentCart = readSharedCart();
  const entries = currentCart.map(item => ({ item, product: sharedCartProduct(item.id) })).filter(entry => entry.product);
  const repairedCart = entries.map(entry => entry.item);
  const count = repairedCart.reduce((total, item) => total + item.qty, 0);
  if (repairedCart.length !== currentCart.length) localStorage.setItem('lexora-cart', JSON.stringify(repairedCart));
  const cartItems = document.querySelector('#cartItems');
  if (!cartItems) return updateSharedCartCount();
  cartItems.innerHTML = entries.length ? entries.map(({ item, product }) => `<div class="cart-item"><img src="${product.image || 'product-fallback.svg'}" alt="${product.name}"/><div><h3>${product.name}</h3><p>${product.supplier} · Qty ${item.qty}</p><strong>${money(product.price * item.qty)}</strong></div><button class="cart-remove" data-remove="${product.id}" aria-label="Remove ${product.name}">×</button></div>`).join('') : '<p style="color:var(--muted);line-height:1.8">Your selection is empty.<br/>Start with something considered.</p>';
  const subtotal = entries.reduce((total, { item, product }) => total + Number(product.price || 0) * item.qty, 0);
  updateSharedCartCount();
  const subtotalElement = document.querySelector('#cartSubtotal');
  if (subtotalElement) subtotalElement.textContent = money(subtotal);
  cartItems.querySelectorAll('[data-remove]').forEach(button => button.addEventListener('click', () => { const next = readSharedCart().filter(item => String(item.id) !== String(button.dataset.remove)); localStorage.setItem('lexora-cart', JSON.stringify(next)); renderSharedCart(); }));
}
function addSharedToCart(id, quantity = 1) { const next = readSharedCart(); const item = next.find(entry => String(entry.id) === String(id)); if (item) item.qty += Number(quantity); else next.push({ id: String(id), qty: Number(quantity) }); localStorage.setItem('lexora-cart', JSON.stringify(next)); updateSharedCartCount(); renderSharedCart(); }
window.addToCart = addSharedToCart;
window.renderCart = renderSharedCart;
window.addEventListener('storage', event => { if (event.key === 'lexora-cart') renderSharedCart(); });
updateSharedCartCount();
renderSharedCart();
