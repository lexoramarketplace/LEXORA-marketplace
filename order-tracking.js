(function (root, factory) {
  const tracking = factory();
  if (typeof module === 'object' && module.exports) module.exports = tracking;
  if (root) root.LexoraOrderTracking = tracking;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const stages = [
     { id: 'placed', label: 'Pending' },
     { id: 'confirmed', label: 'Confirmed' },
     { id: 'processing', label: 'Processing' },
     { id: 'shipped', label: 'Shipped' },
     { id: 'in_transit', label: 'In transit' },
     { id: 'delivered', label: 'Delivered' }
  ];

  const statusRank = {
     pending: 0,
     placed: 0,
     confirmed: 1,
     processing: 2,
     packed: 2,
     shipped: 3,
     in_transit: 4,
     out_for_delivery: 4,
     delivered: 5
  };

  function normalizeTrackingUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
      const url = new URL(value.trim());
      return url.protocol === 'https:' && url.hostname ? url.href : '';
    } catch {
      return '';
    }
  }

  function orderStatus(order) {
    let status = String(order?.shippingStatus || order?.status || 'placed').toLowerCase();
    if (status === 'delivery_exception' || status === 'cancelled' || status === 'refunded') {
      status = String(order?.status || 'placed').toLowerCase();
    }
    if (statusRank[status] === undefined) return 'placed';
    return status;
  }

  function statusLabel(value) {
    const labels = {
      pending: 'Pending',
      placed: 'Pending',
      confirmed: 'Confirmed',
      processing: 'Processing',
      packed: 'Packed',
      shipped: 'Shipped',
      in_transit: 'In transit',
      out_for_delivery: 'In transit',
      delivered: 'Delivered',
      cancelled: 'Cancelled',
      refunded: 'Refunded',
      delivery_exception: 'Delivery Exception'
    };
    const normalized = String(value || '').toLowerCase();
    return labels[normalized] || String(value || 'Pending').replace(/[_-]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
  }

  function eventForStage(order, stageId) {
    const events = Array.isArray(order?.shipmentEvents) ? order.shipmentEvents : [];
    const matching = events.find(event => String(event.status || event.type || '').toLowerCase() === stageId);
    if (matching) return matching;
    if (stageId === 'placed') return { occurredAt: order?.createdAt || null };
    if (stageId === 'shipped') return { occurredAt: order?.shippedAt || null };
    if (stageId === 'delivered') return { occurredAt: order?.deliveredAt || null };
    return null;
  }

  function buildTimeline(order) {
    const currentStatus = orderStatus(order);
    const currentRank = statusRank[currentStatus];
    const isPaid = String(order?.paymentStatus || '').toLowerCase() === 'paid';
    return stages.map((stage, index) => {
      const complete = stage.id === 'placed'
        ? true
        : stage.id === 'confirmed'
          ? isPaid || currentRank >= statusRank.confirmed
          : currentRank >= index;
      const event = eventForStage(order, stage.id);
      const active = complete && (stage.id === currentStatus || (stage.id === 'confirmed' && currentStatus === 'placed' && isPaid));
      return { ...stage, complete, active, occurredAt: event?.occurredAt || event?.timestamp || event?.createdAt || null, note: event?.customerNote || event?.note || '' };
    });
  }

  return { stages, normalizeTrackingUrl, orderStatus, statusLabel, buildTimeline };
});