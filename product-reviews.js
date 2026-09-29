(() => {
  const apiBase = 'http://localhost:4000';
  const target = document.querySelector('#productReviews');
  const productId = new URLSearchParams(location.search).get('id');
  const customerSession = window.LexoraCustomerSession;
  let page = 1;
  let sort = 'recent';
  let reviewData = null;
  let notice = '';
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const token = () => customerSession?.getToken(localStorage) || '';
  const authHeaders = () => token() ? { Authorization: `Bearer ${token()}` } : {};
  const date = value => {
    const parsed = new Date(value);
    return value && !Number.isNaN(parsed.getTime()) ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(parsed) : 'Date unavailable';
  };
  const stars = rating => `${'★'.repeat(Math.max(0, Math.min(5, Number(rating) || 0)))}${'☆'.repeat(5 - Math.max(0, Math.min(5, Number(rating) || 0)))}`;

  function renderReview(review) {
    return `<article class="review-item"><div class="review-item-head"><div><span class="reviews-stars" role="img" aria-label="${escapeHtml(review.rating)} out of 5 stars">${stars(review.rating)}</span><h3>${escapeHtml(review.title || 'Customer review')}</h3><span class="review-author">${escapeHtml(review.displayName)}</span>${review.verifiedPurchase ? ' <span class="review-verified">Verified purchase</span>' : ''}</div><time class="review-date" datetime="${escapeHtml(review.createdAt)}">${escapeHtml(date(review.createdAt))}</time></div><p>${escapeHtml(review.comment)}</p></article>`;
  }

  function renderForm() {
    if (!reviewData.eligible) {
      const message = token() ? 'Reviews are available to customers with a verified paid purchase of this product.' : 'Sign in with the customer account used for your purchase to write a review.';
      return `<div class="review-form-wrap"><h3>Write a review</h3><p>${message}</p>${token() ? '' : '<a class="review-login-link" href="orders.html">Customer sign in ↗</a>'}</div>`;
    }
    const ownReview = reviewData.myReview;
    const moderationText = ownReview?.status === 'approved' ? 'Your published review will return to moderation when edited.' : ownReview ? 'Your review is awaiting approval.' : 'Reviews are checked before they appear publicly.';
    return `<div class="review-form-wrap"><h3>${ownReview ? 'Edit your review' : 'Write a review'}</h3><p>${moderationText}</p>${notice ? `<p class="review-notice" role="status">${escapeHtml(notice)}</p>` : ''}<form id="reviewForm" class="review-form"><label>Rating<select name="rating" required>${[5, 4, 3, 2, 1].map(rating => `<option value="${rating}" ${Number(ownReview?.rating || 5) === rating ? 'selected' : ''}>${rating} star${rating === 1 ? '' : 's'}</option>`).join('')}</select></label><label>Title <span>(optional)</span><input name="title" maxlength="120" value="${escapeHtml(ownReview?.title || '')}" /></label><label class="wide">Your review<textarea name="comment" maxlength="2000" required>${escapeHtml(ownReview?.comment || '')}</textarea></label><button class="button button-dark" type="submit">${ownReview ? 'Save changes' : 'Submit review'} <span aria-hidden="true">↗</span></button><p id="reviewFormStatus" class="review-form-status" role="status" aria-live="polite"></p></form>${ownReview ? '<button class="review-delete" type="button" data-delete-review>Delete my review</button>' : ''}</div>`;
  }

  function render() {
    const summary = reviewData.summary;
    const count = Number(summary.reviewCount || 0);
    const average = Number(summary.averageRating || 0);
    const maxCount = Math.max(1, ...Object.values(summary.distribution || {}).map(Number));
    const distribution = [5, 4, 3, 2, 1].map(rating => {
      const amount = Number(summary.distribution?.[rating] || 0);
      return `<div class="rating-row"><span>${rating} ★</span><div class="rating-track"><span style="width:${Math.min(100, amount / maxCount * 100)}%"></span></div><small>${amount}</small></div>`;
    }).join('');
    const reviews = reviewData.reviews.length ? reviewData.reviews.map(renderReview).join('') : '<p class="reviews-empty">No approved reviews yet.</p>';
    const pageCount = Math.max(1, Math.ceil(reviewData.total / reviewData.pageSize));
    target.innerHTML = `<div class="reviews-heading"><div><p class="eyebrow">CUSTOMER REVIEWS</p><h2 id="reviewsHeading">Considered by customers</h2></div><div class="reviews-summary"><strong class="reviews-average">${count ? average.toFixed(1) : '—'}</strong><div><div class="reviews-stars" role="img" aria-label="${count ? `${average.toFixed(1)} out of 5 stars` : 'No ratings yet'}">${stars(Math.round(average))}</div><span class="reviews-count">${count} approved review${count === 1 ? '' : 's'}</span></div></div></div><div class="reviews-layout"><aside class="rating-distribution" aria-label="Rating distribution">${distribution}</aside><div><div class="reviews-toolbar"><strong>${reviewData.total} review${reviewData.total === 1 ? '' : 's'}</strong><label>Sort <select class="review-sort" id="reviewSort" aria-label="Sort reviews"><option value="recent" ${sort === 'recent' ? 'selected' : ''}>Most recent</option><option value="highest" ${sort === 'highest' ? 'selected' : ''}>Highest rated</option><option value="lowest" ${sort === 'lowest' ? 'selected' : ''}>Lowest rated</option></select></label></div><div class="review-list">${reviews}</div>${pageCount > 1 ? `<nav class="review-pagination" aria-label="Review pages"><button type="button" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>Previous</button><span>Page ${page} of ${pageCount}</span><button type="button" data-page="${page + 1}" ${page >= pageCount ? 'disabled' : ''}>Next</button></nav>` : ''}</div></div>${renderForm()}`;
    target.hidden = false;
  }

  async function loadReviews() {
    if (!productId || !target) return;
    try {
      const query = new URLSearchParams({ page: String(page), limit: '10', sort });
      const response = await fetch(`${apiBase}/api/products/${encodeURIComponent(productId)}/reviews?${query}`, { headers: authHeaders() });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Reviews could not be loaded.');
      reviewData = payload.data;
      render();
    } catch (error) {
      target.hidden = false;
      target.textContent = error.message || 'Reviews could not be loaded.';
    }
  }

  target.addEventListener('change', event => {
    if (event.target.id === 'reviewSort') {
      sort = event.target.value;
      page = 1;
      loadReviews();
    }
  });
  target.addEventListener('click', async event => {
    const pageButton = event.target.closest('[data-page]');
    if (pageButton && !pageButton.disabled) {
      page = Number(pageButton.dataset.page);
      loadReviews();
      return;
    }
    if (event.target.closest('[data-delete-review]') && reviewData?.myReview) {
      if (!window.confirm('Delete your review?')) return;
      try {
        const response = await fetch(`${apiBase}/api/reviews/${encodeURIComponent(reviewData.myReview.id)}`, { method: 'DELETE', headers: authHeaders() });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'Review could not be deleted.');
        notice = 'Your review has been deleted.';
        await loadReviews();
      } catch (error) {
        notice = error.message;
        render();
      }
    }
  });
  target.addEventListener('submit', async event => {
    if (event.target.id !== 'reviewForm') return;
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type="submit"]');
    const status = form.querySelector('#reviewFormStatus');
    button.disabled = true;
    status.textContent = 'Saving…';
    const ownReview = reviewData?.myReview;
    try {
      const response = await fetch(ownReview ? `${apiBase}/api/reviews/${encodeURIComponent(ownReview.id)}` : `${apiBase}/api/products/${encodeURIComponent(productId)}/reviews`, {
        method: ownReview ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ rating: Number(form.elements.rating.value), title: form.elements.title.value, comment: form.elements.comment.value })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Review could not be saved.');
      notice = ownReview ? 'Your changes are saved and awaiting approval.' : 'Your review is saved and awaiting approval.';
      await loadReviews();
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  });

  loadReviews();
})();
