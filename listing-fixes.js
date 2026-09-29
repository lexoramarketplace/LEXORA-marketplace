const clearHomepageFilters = document.querySelector('#clearFilters');
document.addEventListener('error', event => {
  const image = event.target;
  if (image instanceof HTMLImageElement && image.src !== new URL('product-fallback.svg', document.baseURI).href) {
    image.onerror = null;
    image.src = 'product-fallback.svg';
    image.classList.add('image-fallback');
  }
}, true);
if (clearHomepageFilters) {
  clearHomepageFilters.onclick = () => {
    document.querySelector('#searchInput').value = '';
    document.querySelector('#locationFilter').value = 'all';
    document.querySelector('#priceFilter').value = 'all';
    document.querySelector('#verifiedFilter').checked = false;
    document.querySelector('#wholesaleFilter').checked = false;
    activeFilter = 'All';
    activeCategory = 'all';
    document.querySelectorAll('.filter-button').forEach(button => button.classList.toggle('active', button.dataset.filter === 'All'));
    renderCategories();
    renderProducts();
  };
}
