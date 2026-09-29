(() => {
  const apiBase = 'http://localhost:4000';
  const session = window.LexoraSupplierSession;
  const $ = selector => document.querySelector(selector);
  const token = () => session?.getToken(localStorage) || '';
  let supplierProfile = null;

  function showAuth(message) {
    $('#profileView').hidden = true;
    $('#authNotice').hidden = false;
    $('#authMessage').textContent = message;
    $('#settingsSignOut').hidden = !token();
  }

  function showMessage(message = '', type = '') {
    const status = $('#profileMessage');
    status.textContent = message;
    status.className = `form-status ${type}`.trim();
  }

  async function api(path, options = {}) {
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error('Your supplier session has expired. Please sign in again.');
    if (response.status === 403) throw new Error(payload.error || 'Supplier access required.');
    if (!response.ok) throw new Error(payload.error || 'Request failed.');
    return payload;
  }

  function setLogoPreview(value) {
    const preview = $('#logoPreview');
    const url = String(value || '').trim();
    preview.hidden = !url;
    preview.onerror = () => { preview.hidden = true; };
    if (url) preview.src = url;
    else preview.removeAttribute('src');
  }

  function renderCategories(available, selected) {
    const select = $('#categories');
    const names = [...new Set([...available, ...selected])].sort((left, right) => left.localeCompare(right));
    select.replaceChildren(...names.map(name => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      option.selected = selected.includes(name);
      return option;
    }));
  }

  function fillProfile(profile, availableCategories) {
    supplierProfile = profile;
    $('#businessName').value = profile.businessName || profile.companyName || '';
    $('#logoUrl').value = profile.logoUrl || '';
    $('#businessDescription').value = profile.businessDescription || '';
    $('#country').value = profile.country || '';
    $('#state').value = profile.state || '';
    $('#city').value = profile.city || '';
    $('#businessAddress').value = profile.businessAddress || '';
    $('#phone').value = profile.phone || '';
    $('#businessEmail').value = profile.businessEmail || '';
    renderCategories(availableCategories, Array.isArray(profile.categories) ? profile.categories : []);
    setLogoPreview(profile.logoUrl);
    const status = profile.verificationStatus || 'pending';
    $('#verificationStatus').textContent = `Verification: ${status}`;
    $('#verificationStatus').className = `status-pill ${status === 'approved' ? 'good' : ''}`.trim();
    $('#publicStoreLink').href = `supplier-storefront.html?id=${encodeURIComponent(profile.id)}`;
    $('#publicStoreLink').hidden = false;
  }

  async function loadProfile() {
    if (!token()) {
      showAuth('Sign in with a supplier account to manage this store profile.');
      return;
    }
    try {
      const identity = await api('/api/me');
      if (identity.data?.role !== 'supplier') {
        showAuth('This page is only available to supplier accounts.');
        return;
      }
      const [profileResult, categoryResponse] = await Promise.all([
        api('/api/supplier/profile'),
        fetch(`${apiBase}/api/categories`).then(response => response.ok ? response.json() : { data: [] })
      ]);
      const categories = Array.isArray(categoryResponse.data) ? categoryResponse.data.map(category => category.name).filter(Boolean) : [];
      fillProfile(profileResult.data, categories);
      $('#authNotice').hidden = true;
      $('#profileView').hidden = false;
      $('#settingsSignOut').hidden = false;
    } catch (error) {
      showAuth(error.message);
    }
  }

  $('#logoUrl').addEventListener('input', event => setLogoPreview(event.currentTarget.value));
  $('#supplierProfileForm').addEventListener('submit', async event => {
    event.preventDefault();
    const saveButton = $('#saveProfileButton');
    const payload = {
      businessName: $('#businessName').value.trim(),
      logoUrl: $('#logoUrl').value.trim(),
      businessDescription: $('#businessDescription').value.trim(),
      country: $('#country').value.trim(),
      state: $('#state').value.trim(),
      city: $('#city').value.trim(),
      businessAddress: $('#businessAddress').value.trim(),
      phone: $('#phone').value.trim(),
      businessEmail: $('#businessEmail').value.trim(),
      categories: [...$('#categories').selectedOptions].map(option => option.value)
    };
    saveButton.disabled = true;
    showMessage('Saving profile…');
    try {
      const result = await api('/api/supplier/profile', { method: 'PATCH', body: JSON.stringify(payload) });
      fillProfile(result.data, [...$('#categories').options].map(option => option.value));
      showMessage('Store profile saved. Public storefront updated.', 'success');
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      saveButton.disabled = false;
    }
  });

  $('#settingsSignOut').addEventListener('click', () => {
    session.clearToken(localStorage);
    window.location.href = 'supplier-dashboard.html';
  });

  loadProfile();
})();