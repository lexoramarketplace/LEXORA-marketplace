(function (root, factory) {
  const errors = factory();
  if (typeof module === 'object' && module.exports) module.exports = errors;
  if (root) root.LexoraAdminApiErrors = errors;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function networkMessage(apiBase, error) {
    const detail = String(error?.message || error || 'Network request failed.');
    return `Cannot reach the LEXORA API at ${apiBase}. Check that the API server is running, then retry. (${detail})`;
  }

  return { networkMessage };
});