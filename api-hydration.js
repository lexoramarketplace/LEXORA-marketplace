const marketplaceApi = 'http://localhost:4000';

function setApiState(id, message, state = '') {
  const element = document.querySelector(`#${id}`);
  if (element) {
    element.textContent = message;
    element.className = `api-state ${state}`.trim();
  }
}

async function fetchPayload(endpoint, stateId, label) {
  setApiState(stateId, `Loading ${label}...`);
  const response = await fetch(`${marketplaceApi}/api/${endpoint}`);
  if (!response.ok) throw new Error(`${label} request failed (${response.status})`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.data)) throw new Error(`${label} response was invalid`);
  setApiState(stateId, `${label[0].toUpperCase()}${label.slice(1)} catalogue ready`, 'success');
  return payload.data;
}

async function hydrateHomepageFromApi() {
  fallbackProducts.forEach(product => { product.rating = '—'; product.reviews = 0; });
  products.forEach(product => { product.rating = '—'; product.reviews = 0; });
  renderProducts();
  const watch = fallbackProducts.find(product => product.name === 'Arco automatic watch');
  if (watch) watch.image = 'https://images.unsplash.com/photo-1524805444758-089113d48a6d?auto=format&fit=crop&w=900&q=85';
  const productRequest = fetchPayload('products', 'productsState', 'products');
  const categoryRequest = fetchPayload('categories', 'categoriesState', 'categories');
  const supplierRequest = fetchPayload('suppliers', 'suppliersState', 'suppliers');

  try {
    const apiProducts = await productRequest;

    const liveByName = new Map(apiProducts.map(product => [product.name, { ...product, rating: product.rating ?? '—' }]));
    products = fallbackProducts.map(fallback => {
      const live = liveByName.get(fallback.name) || {};
      return {
        ...fallback,
        ...live,
        id: live.id || fallback.id,
        wholesale: live.wholesalePrice || fallback.wholesale,
        description: fallback.description
      };
    });

    apiProducts.filter(product => !products.some(existing => existing.name === product.name)).forEach(product => {
      products.push({
        ...product,
        rating: product.rating ?? '—',
        wholesale: product.wholesalePrice || product.price,
        image: fallbackCategories.find(category => category[0] === product.category)?.[1] || fallbackProducts[0].image,
        description: 'A considered product from the LEXORA marketplace.'
      });
    });

    renderCategories();
    renderProducts();
    renderWholesale();
    renderCart();
  } catch (error) {
    setApiState('productsState', 'Live products unavailable. Showing curated demo products.', 'error');
    console.warn('LEXORA products API unavailable; using curated demo data.', error);
  }
  try {
    const apiCategories = await categoryRequest;
    const liveCategoryNames = new Set(apiCategories.map(category => category.name));
    const liveCategories = apiCategories.map(category => [category.name, fallbackCategories.find(item => item[0] === category.name)?.[1] || fallbackCategories[0][1], products.filter(product => product.category === category.name).length]);
    const curatedCategories = fallbackCategories.filter(category => !liveCategoryNames.has(category[0]));
    categories = [...liveCategories, ...curatedCategories];
    renderCategories();
  } catch (error) {
    setApiState('categoriesState', 'Live categories unavailable. Showing curated categories.', 'error');
    console.warn('LEXORA categories API unavailable; using curated demo data.', error);
  }
  try {
    suppliers = await supplierRequest;
    renderSuppliers();
  } catch (error) {
    suppliers = [
      { businessName: 'Atelier Nera', country: 'Italy', verificationStatus: 'verified', productCount: 1, rating: 4.9 },
      { businessName: 'Kanso Works', country: 'Japan', verificationStatus: 'verified', productCount: 1, rating: 4.8 }
    ];
    setApiState('suppliersState', 'Live suppliers unavailable. Showing curated demo suppliers.', 'error');
    renderWholesale();
    renderSuppliers();
    console.warn('LEXORA suppliers API unavailable; using curated demo data.', error);
  }
}

hydrateHomepageFromApi();
