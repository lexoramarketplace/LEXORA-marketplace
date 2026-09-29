(() => {
  const apiBase = 'http://localhost:4000';
  const existingProductPreviewImages = {
    prod_vela: 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=900&q=85',
    prod_kanso: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=900&q=85',
    prod_forma: 'https://images.unsplash.com/photo-1592078615290-033ee584e267?auto=format&fit=crop&w=900&q=85'
  };
  const maxUploadBytes = 5 * 1024 * 1024;
  const acceptedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const $ = selector => document.querySelector(selector);
  let selectedFile = null;
  let selectedProductId = '';
  let previewUrl = '';
  let searchResults = [];
  let searchResult = null;
  let toastTimer = null;
  let activeCameraStream = null;
  let cameraPreviewUrl = '';
  let currentSearchSource = 'upload';

  const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(value || 0));
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

  function updateWishlistCount(ids) {
    const count = $('#wishlistCount');
    if (count) count.textContent = String(ids?.length ?? window.LexoraWishlist?.snapshot()?.length ?? 0);
  }

  function setStatus(message = '', type = '', loading = false) {
    const status = $('#visualSearchStatus');
    status.textContent = message;
    status.className = `visual-search-status ${type} ${loading ? 'visual-loading' : ''}`.trim();
  }

  function showToast(message) {
    const toast = $('#visualSearchToast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2400);
  }

  function stopCameraStream() {
    if (!activeCameraStream) return;
    activeCameraStream.getTracks().forEach(track => track.stop());
    activeCameraStream = null;
    const video = $('#cameraVideo');
    if (video) video.srcObject = null;
  }

  function hideCameraScanner() {
    stopCameraStream();
    const scanner = $('#cameraScanner');
    if (scanner) scanner.hidden = true;
    const preview = $('#cameraCapturePreview');
    if (preview) preview.hidden = true;
    const permissionMessage = $('#cameraPermissionMessage');
    if (permissionMessage) permissionMessage.hidden = true;
    const postCapture = $('#cameraPostCaptureActions');
    if (postCapture) postCapture.hidden = true;
    const captureButton = $('#capturePhotoButton');
    if (captureButton) captureButton.hidden = false;
    const video = $('#cameraVideo');
    if (video) video.style.display = 'block';
    if (cameraPreviewUrl) {
      URL.revokeObjectURL(cameraPreviewUrl);
      cameraPreviewUrl = '';
    }
    const image = $('#cameraCapturedImage');
    if (image) image.removeAttribute('src');
  }

  async function openCameraScanner() {
    const camera = $('#cameraScanner');
    const video = $('#cameraVideo');
    const permissionMessage = $('#cameraPermissionMessage');
    const captureButton = $('#capturePhotoButton');
    if (!camera || !video || !captureButton) return;
    camera.hidden = false;
    permissionMessage.hidden = true;
    $('#cameraCapturePreview').hidden = true;
    $('#cameraPostCaptureActions').hidden = true;
    captureButton.hidden = false;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      permissionMessage.hidden = false;
      permissionMessage.innerHTML = '<p>Camera access is unavailable on this browser. You can upload an image instead.</p><button id="cameraUploadFallbackButton" class="button button-dark" type="button">Upload Image</button>';
      const fallback = $('#cameraUploadFallbackButton');
      if (fallback) fallback.addEventListener('click', () => {
        $('#visualImageInput').click();
        hideCameraScanner();
      }, { once: true });
      return;
    }

    try {
      stopCameraStream();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false
      }).catch(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false }));
      activeCameraStream = stream;
      video.srcObject = stream;
      await video.play().catch(() => {});
      permissionMessage.hidden = true;
    } catch {
      permissionMessage.hidden = false;
      permissionMessage.innerHTML = '<p>Camera access was denied. You can upload an image instead.</p><button id="cameraUploadFallbackButton" class="button button-dark" type="button">Upload Image</button>';
      const fallback = $('#cameraUploadFallbackButton');
      if (fallback) fallback.addEventListener('click', () => {
        $('#visualImageInput').click();
        hideCameraScanner();
      }, { once: true });
      stopCameraStream();
    }
  }

  function clearPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
    selectedFile = null;
    selectedProductId = '';
    currentSearchSource = 'upload';
    $('#visualImageInput').value = '';
    $('#selectedImagePanel').hidden = true;
    $('#selectedImagePreview').removeAttribute('src');
    $('#findSimilarButton').disabled = true;
  }

  function setPreview({ source, name, sizeText }) {
    $('#selectedImagePreview').src = source;
    $('#selectedImageName').textContent = name;
    $('#selectedImageMetadata').textContent = sizeText;
    $('#selectedImagePanel').hidden = false;
    $('#findSimilarButton').disabled = false;
    $('#visualResultsSection').hidden = true;
    searchResult = null;
    searchResults = [];
    setStatus('');
  }

  function formatBytes(bytes) {
    return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function validateFile(file) {
    if (!file || file.size === 0) return 'Choose an image that is not empty.';
    if (file.size > maxUploadBytes) return 'Images must be 5 MB or smaller.';
    if (!acceptedTypes.has(file.type)) return 'Choose a JPG, PNG, or WEBP image.';
    const extension = file.name.split('.').pop()?.toLowerCase();
    const expected = file.type === 'image/jpeg' ? ['jpg', 'jpeg'] : file.type === 'image/png' ? ['png'] : ['webp'];
    if (!expected.includes(extension)) return 'The file extension must match the image type.';
    return '';
  }

  function chooseFile(file) {
    clearPreview();
    const error = validateFile(file);
    if (error) {
      setStatus(error, 'error');
      return;
    }
    selectedFile = file;
    currentSearchSource = 'upload';
    previewUrl = URL.createObjectURL(file);
    setPreview({ source: previewUrl, name: file.name, sizeText: `${formatBytes(file.size)} · ${file.type.split('/')[1].toUpperCase()}` });
  }

  async function captureCameraPhoto() {
    const video = $('#cameraVideo');
    const captureButton = $('#capturePhotoButton');
    const preview = $('#cameraCapturePreview');
    const postCapture = $('#cameraPostCaptureActions');
    if (!video || !captureButton || !preview || !postCapture) return;
    if (!video.videoWidth || !video.videoHeight) {
      setStatus('Something went wrong while capturing the image. Please try again.', 'error');
      return;
    }
    const canvas = document.createElement('canvas');
    const maxDimension = 1600;
    const scale = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob) {
      setStatus('Something went wrong while capturing the image. Please try again.', 'error');
      return;
    }
    const file = new File([blob], `camera-capture-${Date.now()}.jpg`, { type: 'image/jpeg' });
    const objectUrl = URL.createObjectURL(file);
    if (cameraPreviewUrl) URL.revokeObjectURL(cameraPreviewUrl);
    cameraPreviewUrl = objectUrl;
    $('#cameraCapturedImage').src = objectUrl;
    preview.hidden = false;
    captureButton.hidden = true;
    postCapture.hidden = false;
    selectedFile = file;
    currentSearchSource = 'camera';
    setStatus('Captured image ready for review.');
  }

  function retakeCameraPhoto() {
    const preview = $('#cameraCapturePreview');
    const postCapture = $('#cameraPostCaptureActions');
    const captureButton = $('#capturePhotoButton');
    if (preview) preview.hidden = true;
    if (postCapture) postCapture.hidden = true;
    if (captureButton) captureButton.hidden = false;
    if (cameraPreviewUrl) {
      URL.revokeObjectURL(cameraPreviewUrl);
      cameraPreviewUrl = '';
    }
    const image = $('#cameraCapturedImage');
    if (image) image.removeAttribute('src');
    selectedFile = null;
    currentSearchSource = 'upload';
    setStatus('Camera ready.');
  }

  function useCameraPhoto() {
    if (!selectedFile) {
      setStatus('Please capture a product photo before searching.', 'error');
      return;
    }
    hideCameraScanner();
    const previewSource = cameraPreviewUrl || URL.createObjectURL(selectedFile);
    previewUrl = previewSource;
    setPreview({
      source: previewSource,
      name: selectedFile.name || 'Captured product image',
      sizeText: `${formatBytes(selectedFile.size)} · ${selectedFile.type?.split('/')[1]?.toUpperCase() || 'JPEG'}`
    });
    currentSearchSource = 'camera';
  }

  async function loadProductSource(productId) {
    try {
      const response = await fetch(`${apiBase}/api/products/${encodeURIComponent(productId)}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.data) throw new Error('This product image is not available for visual search.');
      const product = payload.data;
      const imageSource = product.images?.[0] || product.imageUrl || product.image || existingProductPreviewImages[product.id] || '';
      selectedProductId = product.id;
      setPreview({
        source: imageSource || 'product-fallback.svg',
        name: product.name || 'Selected catalog product',
        sizeText: imageSource ? 'Existing LEXORA catalog image · processed from catalog storage' : 'Existing LEXORA catalog product'
      });
      setStatus('Using the existing catalog product image; no duplicate image is created.', 'success');
    } catch (error) {
      setStatus(error.message || 'This product image is not available for visual search.', 'error');
    }
  }

  function renderAttributes(result) {
    const analysis = result.analysis || {};
    const attributes = [];
    if (analysis.category) attributes.push(['Category', analysis.category]);
    if (analysis.colors?.length) attributes.push(['Color', analysis.colors.join(', ')]);
    if (analysis.style) attributes.push(['Style', analysis.style]);
    if (analysis.material) attributes.push(['Material', analysis.material]);
    if (analysis.attributes?.length) attributes.push(['Visible features', analysis.attributes.join(', ')]);
    if (analysis.dominantColors?.length) attributes.push(['Measured dominant colors', analysis.dominantColors.map(color => `${color.name} ${color.share}%`).join(', ')]);
    $('#detectedAttributes').innerHTML = attributes.length
      ? `<strong>Detected:</strong>${attributes.map(([label, value]) => `<span class="detected-chip">${escapeHtml(label)}: ${escapeHtml(value)}</span>`).join('')}`
      : '<span class="detected-chip">No visual attributes were confidently identified.</span>';
    $('#visualResultNotice').textContent = analysis.note || '';
    $('#visualMatchMethod').textContent = result.fallback
      ? `CATALOG COLOR COMPARISON · NOT AI · ${result.matching?.definition || ''}`
      : `VISION ANALYSIS · ${result.matching?.definition || ''}`;
  }

  function filteredResults() {
    const category = $('#visualCategoryFilter').value;
    const color = $('#visualColorFilter').value;
    const supplier = $('#visualSupplierFilter').value;
    const productType = $('#visualTypeFilter').value;
    const material = $('#visualMaterialFilter').value;
    const minimumRating = Number($('#visualRatingFilter').value || 0);
    const maxPrice = Number($('#visualMaxPrice').value);
    const availableOnly = $('#visualAvailableOnly').checked;
    return searchResults.filter(product =>
      (category === 'all' || product.category === category) &&
      (color === 'all' || product.colors?.some(value => value.toLowerCase() === color)) &&
      (supplier === 'all' || product.supplier === supplier) &&
      (productType === 'all' || product.productType === productType) &&
      (material === 'all' || product.material === material) &&
      (Number(product.rating || 0) >= minimumRating) &&
      (!$('#visualMaxPrice').value || Number(product.price || 0) <= maxPrice) &&
      (!availableOnly || product.available)
    );
  }

  async function toggleWishlist(productId, button) {
    try {
      const result = await window.LexoraWishlist.toggle(productId);
      updateWishlistCount(result.ids);
      button.classList.toggle('saved', result.ids.includes(String(productId)));
      button.textContent = result.ids.includes(String(productId)) ? '♥' : '♡';
      button.setAttribute('aria-label', result.ids.includes(String(productId)) ? 'Remove from wishlist' : 'Save to wishlist');
      showToast(result.ids.includes(String(productId)) ? 'Added to your wishlist' : 'Removed from your wishlist');
    } catch (error) {
      showToast(error.message || 'Wishlist could not be updated.');
    }
  }

  function addToCart(productId, button) {
    try {
      const cart = JSON.parse(localStorage.getItem('lexora-cart') || '[]');
      if (!Array.isArray(cart)) throw new Error('Cart is unavailable.');
      const item = cart.find(entry => String(entry.id) === String(productId));
      if (item) item.qty = Number(item.qty || 0) + 1;
      else cart.push({ id: String(productId), qty: 1 });
      localStorage.setItem('lexora-cart', JSON.stringify(cart));
      button.dispatchEvent(new CustomEvent('lexora:cart-change', { bubbles: true }));
      showToast('Added to your cart');
    } catch (error) {
      showToast(error.message || 'Cart could not be updated.');
    }
  }

  function renderResults() {
    const results = filteredResults();
    const savedIds = window.LexoraWishlist?.snapshot() || [];
    $('#visualResultCount').textContent = `${results.length} matching product${results.length === 1 ? '' : 's'}`;
    $('#visualResultsSummary').textContent = `We found ${searchResult.total} catalog product${searchResult.total === 1 ? '' : 's'} supported by the matching data.`;
    if (!results.length) {
      $('#visualResultsGrid').innerHTML = '<p class="empty-state"><strong>No catalog products match these filters.</strong><span>Try widening your selection or upload another image.</span></p>';
      return;
    }
    $('#visualResultsGrid').innerHTML = results.map(product => `
      <article class="shop-card">
        <div class="shop-card-image">
          <button class="wishlist-button ${savedIds.includes(String(product.id)) ? 'saved' : ''}" type="button" data-visual-wish="${escapeHtml(product.id)}" aria-label="${savedIds.includes(String(product.id)) ? 'Remove' : 'Save'} ${escapeHtml(product.name)} ${savedIds.includes(String(product.id)) ? 'from' : 'to'} wishlist">${savedIds.includes(String(product.id)) ? '♥' : '♡'}</button>
          <img src="${escapeHtml(product.image || 'product-fallback.svg')}" alt="${escapeHtml(product.name)}" loading="lazy" />
        </div>
        <div class="shop-card-copy">
          <div class="product-top"><h2>${escapeHtml(product.name)}</h2><strong>${money(product.price)}</strong></div>
          <p>by <b>${escapeHtml(product.supplier || 'LEXORA')}</b> · ${escapeHtml(product.location || 'Global')}${product.verified ? ' · <span class="verified">✓ VERIFIED</span>' : ''}</p>
          <div class="product-meta">${window.lexoraRatingMarkup(product)}<span class="moq">MOQ ${Number(product.moq || 1)}</span></div>
          <span class="inventory-note ${product.available ? 'stock-good' : 'stock-out'}">${product.available ? `${Number(product.availableStock)} available` : 'Currently unavailable'}</span>
          <div class="visual-result-copy"><strong>${escapeHtml(product.matchType)}</strong><span>${product.matchReasons.map(escapeHtml).join(' · ')}</span></div>
          <div class="visual-result-actions"><a class="button button-light" href="product.html?id=${encodeURIComponent(product.id)}&wishlist=20260927-r2">View product</a><button class="button button-dark" type="button" data-visual-cart="${escapeHtml(product.id)}" ${product.available ? '' : 'disabled'}>Add to cart</button></div>
        </div>
      </article>
    `).join('');

    document.querySelectorAll('.visual-results-grid img').forEach(image => image.addEventListener('error', () => { image.onerror = null; image.src = 'product-fallback.svg'; }));
    document.querySelectorAll('[data-visual-wish]').forEach(button => button.addEventListener('click', () => toggleWishlist(button.dataset.visualWish, button)));
    document.querySelectorAll('[data-visual-cart]').forEach(button => button.addEventListener('click', () => addToCart(button.dataset.visualCart, button)));
  }

  function populateFilters(products) {
    const categories = [...new Set(products.map(product => product.category).filter(Boolean))].sort();
    const suppliers = [...new Set(products.map(product => product.supplier).filter(Boolean))].sort();
    const colors = [...new Set(products.flatMap(product => product.colors || []).filter(Boolean).map(value => value.toLowerCase()))].sort();
    const types = [...new Set(products.map(product => product.productType).filter(Boolean))].sort();
    const materials = [...new Set(products.map(product => product.material).filter(Boolean))].sort();
    for (const [selector, values, label] of [
      ['#visualCategoryFilter', categories, 'All categories'],
      ['#visualColorFilter', colors, 'All colors'],
      ['#visualSupplierFilter', suppliers, 'All suppliers'],
      ['#visualTypeFilter', types, 'All types'],
      ['#visualMaterialFilter', materials, 'All materials']
    ]) {
      const select = $(selector);
      select.replaceChildren(new Option(label, 'all'), ...values.map(value => new Option(value, value)));
    }
    $('#visualMaterialFilterRow').hidden = materials.length === 0;
    $('#visualTypeFilter').closest('label').hidden = types.length === 0;
  }

  async function runSearch() {
    if (!selectedFile && !selectedProductId) return;
    const button = $('#findSimilarButton');
    button.disabled = true;
    $('#visualResultsSection').hidden = true;
    setStatus('Analyzing your image…', '', true);
    const progressTimer = setTimeout(() => setStatus('Finding similar products…', '', true), 650);
    try {
      const form = new FormData();
      if (selectedFile) {
        form.append('image', selectedFile, selectedFile.name || 'camera-photo.jpg');
        form.append('source', currentSearchSource === 'camera' ? 'camera' : 'upload');
      } else {
        form.append('productId', selectedProductId);
      }
      const response = await fetch(`${apiBase}/api/visual-search`, { method: 'POST', body: form });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.data) throw new Error('We couldn’t analyze this image. Please try another clear product photo.');
      searchResult = payload.data;
      searchResults = Array.isArray(searchResult.results) ? searchResult.results : [];
      populateFilters(searchResults);
      renderAttributes(searchResult);
      $('#visualResultsSection').hidden = false;
      renderResults();
      setStatus(searchResult.fallback ? 'Color comparison complete. No AI image analysis was performed.' : 'Image analysis complete.', 'success');
      stopCameraStream();
      $('#visualResultsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {
      setStatus('We couldn’t analyze this image. Please try another clear product photo.', 'error');
    } finally {
      clearTimeout(progressTimer);
      button.disabled = false;
    }
  }

  $('#cameraScanButton').addEventListener('click', openCameraScanner);
  $('#uploadTriggerButton').addEventListener('click', () => $('#visualImageInput').click());
  $('#closeCameraButton').addEventListener('click', hideCameraScanner);
  $('#capturePhotoButton').addEventListener('click', captureCameraPhoto);
  $('#retakeCameraButton').addEventListener('click', retakeCameraPhoto);
  $('#useCameraPhotoButton').addEventListener('click', useCameraPhoto);
  $('#visualImageInput').addEventListener('change', event => {
    const file = event.currentTarget.files?.[0];
    if (file) chooseFile(file);
    event.currentTarget.value = '';
  });
  $('#removeImageButton').addEventListener('click', () => { clearPreview(); setStatus('Image removed.'); });
  $('#findSimilarButton').addEventListener('click', runSearch);
  $('#uploadDropzone').addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('#visualImageInput').click(); }
  });
  $('#uploadDropzone').addEventListener('dragover', event => { event.preventDefault(); event.currentTarget.classList.add('dragging'); });
  $('#uploadDropzone').addEventListener('dragleave', event => event.currentTarget.classList.remove('dragging'));
  $('#uploadDropzone').addEventListener('drop', event => {
    event.preventDefault();
    event.currentTarget.classList.remove('dragging');
    if (event.dataTransfer.files.length !== 1) { setStatus('Choose one image at a time.', 'error'); return; }
    chooseFile(event.dataTransfer.files[0]);
  });
  ['#visualCategoryFilter', '#visualColorFilter', '#visualSupplierFilter', '#visualTypeFilter', '#visualMaterialFilter', '#visualMaxPrice', '#visualRatingFilter', '#visualAvailableOnly'].forEach(selector => $(selector).addEventListener(selector === '#visualMaxPrice' ? 'input' : 'change', () => searchResult && renderResults()));
  $('#clearVisualFilters').addEventListener('click', () => {
    $('#visualCategoryFilter').value = 'all';
    $('#visualColorFilter').value = 'all';
    $('#visualSupplierFilter').value = 'all';
    $('#visualTypeFilter').value = 'all';
    $('#visualMaterialFilter').value = 'all';
    $('#visualMaxPrice').value = '';
    $('#visualRatingFilter').value = '0';
    $('#visualAvailableOnly').checked = false;
    if (searchResult) renderResults();
  });
  window.addEventListener('lexora:wishlist-change', event => updateWishlistCount(event.detail.ids));
  window.LexoraWishlist?.load().then(result => updateWishlistCount(result.ids));
  fetch(`${apiBase}/api/visual-search`).then(response => response.json()).then(payload => {
    const provider = payload.data?.provider;
    $('#providerDescription').textContent = provider === 'catalog-fallback'
      ? 'No vision provider is configured. Search compares measured image colors to existing catalog photos only.'
      : 'A configured vision provider identifies visible product attributes before catalog matching.';
    $('#visualPrivacyNote').textContent = provider === 'catalog-fallback'
      ? 'Your image is processed temporarily on LEXORA, is not sent to a third party, and is not saved.'
      : 'Your image is sent to LEXORA’s configured vision provider for analysis, processed temporarily, and not saved.';
  }).catch(() => { $('#providerDescription').textContent = 'Visual search is temporarily unavailable.'; });

  window.addEventListener('beforeunload', stopCameraStream);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCameraStream();
  });

  const productId = new URLSearchParams(window.location.search).get('productId');
  if (productId) loadProductSource(productId);
})();
