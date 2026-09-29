const { URL } = require('node:url');

const adminNotificationEmail = String(process.env.LEXORA_ADMIN_NOTIFICATION_EMAIL || 'lexora.market@gmail.com').trim();
const emailFrom = String(process.env.LEXORA_EMAIL_FROM || 'LEXORA <noreply@lexora.test>').trim();
const resendApiKey = String(process.env.RESEND_API_KEY || '').trim();

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function formatMoney(value) {
  const numeric = Number(value || 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(numeric / 100);
}

function toTitleCase(value) {
  return safeText(value).replace(/\b\w/g, char => char.toUpperCase());
}

function formatProductRows(items = []) {
  if (!Array.isArray(items) || !items.length) return '<p>No products available.</p>';
  return items.map(item => {
    const name = escapeHtml(safeText(item.name || item.productId || 'Product'));
    const quantity = Number(item.quantity || 0) || 0;
    const unitPrice = Number(item.unitPrice || item.unitCents || 0);
    const total = Number(quantity) * Number(unitPrice);
    return `
      <tr>
        <td>${name}</td>
        <td>${quantity}</td>
        <td>${formatMoney(unitPrice)}</td>
        <td>${formatMoney(total)}</td>
      </tr>`;
  }).join('');
}

function shippingSummary(order) {
  const shipping = order?.shippingAddress || {};
  return {
    customerName: safeText(shipping.fullName || 'Guest customer'),
    address: safeText(`${shipping.addressLine1 || ''} ${shipping.addressLine2 || ''}`),
    city: safeText(shipping.city || ''),
    country: safeText(shipping.country || ''),
    postalCode: safeText(shipping.postalCode || ''),
    phone: safeText(shipping.phone || '')
  };
}

function statusLabel(value) {
  const map = {
    placed: 'Order Placed',
    confirmed: 'Payment Confirmed',
    processing: 'Processing',
    packed: 'Packed',
    shipped: 'Shipped',
    in_transit: 'In Transit',
    out_for_delivery: 'Out for Delivery',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
    delivery_exception: 'Delivery Exception'
  };
  return map[String(value || '').toLowerCase()] || safeText(value || 'Order Update');
}

function buildTrackingEmailHtml(order, eventType, details = {}) {
  const shipping = order?.shippingAddress || {};
  const trackingNumber = safeText(details.trackingNumber || order?.trackingNumber || '');
  const carrier = safeText(details.carrier || order?.shippingCarrier || '');
  const estimatedDelivery = safeText(details.estimatedDeliveryDate || order?.estimatedDeliveryDate || '');
  const trackHref = details.trackingUrl || order?.trackingUrl || '';
  const productName = safeText((order?.items || [{}])[0]?.name || 'your order');
  const total = formatMoney(order?.totalAmount || 0);
  const subject = eventType === 'shipped' ? 'LEXORA — Your Order Has Shipped' : `LEXORA — Order Update #${safeText(order?.id || 'N/A')}`;
  const actionText = trackHref ? '<p><a href="' + escapeHtml(trackHref) + '" style="display:inline-block;padding:12px 18px;background:#111827;color:#ffffff;text-decoration:none;border-radius:8px;">Track Shipment</a></p>' : '';
  return `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 680px; margin: 0 auto; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
      <div style="font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: #6b7280; font-weight: 700;">LEXORA</div>
      <h1 style="margin: 10px 0 16px; font-size: 28px;">${escapeHtml(subject)}</h1>
      <p style="margin: 0 0 18px;">Hello ${escapeHtml(safeText(shipping.fullName || 'there'))},</p>
      <p style="margin: 0 0 18px;">Your LEXORA order <strong>#${escapeHtml(order?.id || 'N/A')}</strong> has an update: <strong>${escapeHtml(statusLabel(eventType))}</strong>.</p>
      <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; padding: 18px; margin-bottom: 18px;">
        <div><strong>Product:</strong> ${escapeHtml(productName)}</div>
        <div><strong>Order Total:</strong> ${escapeHtml(total)}</div>
        <div><strong>Carrier:</strong> ${escapeHtml(carrier || 'Information will be available once shipped')}</div>
        <div><strong>Tracking Number:</strong> ${escapeHtml(trackingNumber || 'Tracking information will appear once available')}</div>
        <div><strong>Estimated Delivery:</strong> ${escapeHtml(estimatedDelivery || 'Pending')}</div>
      </div>
      ${actionText}
      <p style="margin: 0 0 12px;">For support, contact the LEXORA team at ${escapeHtml(adminNotificationEmail)}.</p>
      <p style="margin: 0; color: #374151;">This is an automated order update from LEXORA.</p>
    </div>
  `;
}

function buildAdminEmailHtml(order) {
  const shipping = shippingSummary(order);
  const orderDate = new Date(order.createdAt || Date.now()).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const productRows = formatProductRows(order?.items || []);
  return `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 700px; margin: 0 auto; background: #ffffff; padding: 32px; border: 1px solid #e5e7eb; border-radius: 12px;">
      <div style="padding-bottom: 16px; border-bottom: 1px solid #e5e7eb; margin-bottom: 24px;">
        <div style="font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: #6b7280; font-weight: 700;">LEXORA</div>
        <h1 style="margin: 10px 0 0; font-size: 30px; line-height: 1.2; color: #111827;">New Paid Order</h1>
      </div>
      <p style="margin: 0 0 18px; color: #374151;">A new customer order has been successfully paid and verified.</p>
      <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; padding: 18px; margin-bottom: 24px;">
        <div style="display: block; margin-bottom: 12px;"><strong>Order ID:</strong> ${escapeHtml(order.id || 'N/A')}</div>
        <div style="display: block; margin-bottom: 12px;"><strong>Order Date:</strong> ${escapeHtml(orderDate)}</div>
        <div style="display: block; margin-bottom: 12px;"><strong>Customer:</strong> ${escapeHtml((order.shippingAddress && order.shippingAddress.fullName) || 'Guest customer')}</div>
        <div style="display: block; margin-bottom: 12px;"><strong>Customer Email:</strong> ${escapeHtml((order.shippingAddress && order.shippingAddress.email) || 'Not provided')}</div>
      </div>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
        <thead>
          <tr style="background: #f3f4f6; text-align: left;">
            <th style="padding: 12px; border: 1px solid #e5e7eb;">Product</th>
            <th style="padding: 12px; border: 1px solid #e5e7eb;">Qty</th>
            <th style="padding: 12px; border: 1px solid #e5e7eb;">Unit Price</th>
            <th style="padding: 12px; border: 1px solid #e5e7eb;">Total</th>
          </tr>
        </thead>
        <tbody>${productRows}</tbody>
      </table>
      <div style="margin-bottom: 24px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; padding: 18px;">
        <div style="font-size: 18px; font-weight: 700; margin-bottom: 8px;">Order Total: ${formatMoney(order.totalAmount || 0)}</div>
        <div><strong>Payment Method:</strong> PayPal</div>
        <div><strong>Payment Status:</strong> PAID / VERIFIED</div>
        <div><strong>PayPal Transaction/Capture ID:</strong> ${escapeHtml(order.paypalCaptureId || order.paypalOrderId || 'N/A')}</div>
      </div>
      <div style="margin-bottom: 24px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; padding: 18px;">
        <h2 style="margin: 0 0 12px; font-size: 20px;">Shipping Information</h2>
        <div><strong>Customer:</strong> ${escapeHtml(shipping.customerName)}</div>
        <div><strong>Address:</strong> ${escapeHtml(shipping.address)}</div>
        <div><strong>City:</strong> ${escapeHtml(shipping.city)}</div>
        <div><strong>Country:</strong> ${escapeHtml(shipping.country)}</div>
        <div><strong>Postal Code:</strong> ${escapeHtml(shipping.postalCode)}</div>
        <div><strong>Phone:</strong> ${escapeHtml(shipping.phone || 'Not provided')}</div>
      </div>
      <p style="margin: 0; color: #374151;">This order is ready for fulfillment and should be processed according to the marketplace workflow.</p>
    </div>
  `;
}

async function sendPaidOrderAdminEmail(order) {
  if (!resendApiKey) {
    throw new Error('RESEND_API_KEY is not configured.');
  }

  const normalizedOrder = order || {};
  const shippingAddress = normalizedOrder.shippingAddress || {};
  const customerName = safeText(shippingAddress.fullName || 'Guest customer');
  const customerEmail = safeText(shippingAddress.email || '');
  const subject = `LEXORA — New Paid Order #${safeText(normalizedOrder.id || 'N/A')}`;
  const html = buildAdminEmailHtml(normalizedOrder);
  const text = [
    'LEXORA — New Paid Order',
    `Order ID: ${normalizedOrder.id || 'N/A'}`,
    `Order Date: ${new Date(normalizedOrder.createdAt || Date.now()).toISOString()}`,
    `Customer: ${customerName}`,
    `Customer Email: ${customerEmail || 'Not provided'}`,
    `Order Total: ${formatMoney(normalizedOrder.totalAmount || 0)}`,
    'Payment Method: PayPal',
    'Payment Status: PAID / VERIFIED',
    `PayPal Transaction/Capture ID: ${normalizedOrder.paypalCaptureId || normalizedOrder.paypalOrderId || 'N/A'}`,
    '',
    'A new customer order has been successfully paid and verified.',
    '',
    'Shipping Information:',
    `Customer: ${shippingAddress.fullName || 'Guest customer'}`,
    `Address: ${shippingAddress.addressLine1 || ''} ${shippingAddress.addressLine2 || ''}`.trim(),
    `City: ${shippingAddress.city || ''}`,
    `Country: ${shippingAddress.country || ''}`,
    `Postal code: ${shippingAddress.postalCode || ''}`,
    `Phone: ${shippingAddress.phone || 'Not provided'}`
  ].join('\n');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: emailFrom,
      to: [adminNotificationEmail],
      subject,
      html,
      text
    })
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload?.message || 'Unknown Resend error';
    throw new Error(`Resend email failed: ${message}`);
  }

  return { id: payload.id || null, status: 'sent', to: adminNotificationEmail, subject };
}

async function sendCustomerTrackingEmail(order, eventType, details = {}) {
  if (!resendApiKey) {
    throw new Error('RESEND_API_KEY is not configured.');
  }

  const shipping = order?.shippingAddress || {};
  const customerEmail = safeText(shipping.email || '');
  if (!customerEmail) {
    throw new Error('Customer email is required for shipping notifications.');
  }

  const normalizedEvent = String(eventType || 'updated').trim();
  const subject = normalizedEvent === 'shipped'
    ? 'LEXORA — Your Order Has Shipped'
    : `LEXORA — Order Update #${safeText(order?.id || 'N/A')}`;
  const html = buildTrackingEmailHtml(order, normalizedEvent, details);
  const text = [
    normalizedEvent === 'shipped' ? 'LEXORA — Your Order Has Shipped' : `LEXORA — Order Update #${order?.id || 'N/A'}`,
    '',
    `Hello ${shipping.fullName || 'there'},`,
    `Your LEXORA order #${order?.id || 'N/A'} has an update: ${statusLabel(normalizedEvent)}.`,
    `Carrier: ${details.carrier || order?.shippingCarrier || 'Information will be available once shipped'}`,
    `Tracking Number: ${details.trackingNumber || order?.trackingNumber || 'Tracking information will appear once available'}`,
    `Estimated Delivery: ${details.estimatedDeliveryDate || order?.estimatedDeliveryDate || 'Pending'}`,
    '',
    'For support, contact the LEXORA team at lexora.market@gmail.com.',
    'This is an automated order update from LEXORA.'
  ].join('\n');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: emailFrom,
      to: [customerEmail],
      subject,
      html,
      text
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.message || 'Unknown Resend error';
    throw new Error(`Resend email failed: ${message}`);
  }

  return { id: payload.id || null, status: 'sent', to: customerEmail, subject };
}

module.exports = {
  adminNotificationEmail,
  emailFrom,
  sendPaidOrderAdminEmail,
  sendCustomerTrackingEmail,
  buildAdminEmailHtml,
  buildTrackingEmailHtml,
  formatMoney,
  shippingSummary,
  statusLabel
};
