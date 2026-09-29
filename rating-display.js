window.lexoraRatingMarkup = product => {
  const rating = Number(product?.rating);
  const count = Number(product?.reviews || 0);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5 || !Number.isSafeInteger(count) || count < 1) {
    return '<span class="rating">No reviews yet</span>';
  }
  const filled = Math.round(rating);
  return `<span class="rating"><span role="img" aria-label="${rating.toFixed(1)} out of 5 stars">${'★'.repeat(filled)}${'☆'.repeat(5 - filled)}</span> ${rating.toFixed(1)} (${count})</span>`;
};
