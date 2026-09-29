const crypto = require('node:crypto');

const { readStore, writeStore } = require('../db/repository');
const { withPostgresExternalCall } = require('../db/postgres-store');
const emailService = require('./email');

function listNotifications() {
  return readStore().notifications || [];
}

function findNotificationByOrderAndType(orderId, type) {
  const store = readStore();
  return (store.notifications || []).find(notification => notification.orderId === orderId && notification.type === type) || null;
}

function upsertNotification(notification) {
  const store = readStore();
  const existingIndex = (store.notifications || []).findIndex(entry => entry.orderId === notification.orderId && entry.type === notification.type);

  if (existingIndex >= 0) {
    const existing = store.notifications[existingIndex];
    Object.assign(existing, {
      ...notification,
      id: existing.id,
      orderId: existing.orderId,
      type: existing.type,
      key: notification.key || existing.key,
      eventType: notification.eventType || existing.eventType,
      sentAt: notification.sentAt || existing.sentAt,
      failedAt: notification.failedAt || existing.failedAt,
      updatedAt: new Date().toISOString()
    });
    writeStore(store);
    return existing;
  }

  const record = {
    id: `ntf_${crypto.randomUUID()}`,
    orderId: notification.orderId,
    type: notification.type,
    key: notification.key || null,
    eventType: notification.eventType || null,
    title: notification.title || 'Notification',
    message: notification.message || '',
    status: notification.status || 'pending',
    retryAvailable: Boolean(notification.retryAvailable),
    error: notification.error || null,
    sentAt: notification.sentAt || null,
    failedAt: notification.failedAt || null,
    read: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  store.notifications.push(record);
  writeStore(store);
  return record;
}

async function processPaidOrderAdminEmail(order) {
  if (!order || !order.id) {
    throw new Error('Order is required to send the admin email.');
  }

  const existing = findNotificationByOrderAndType(order.id, 'paid_order_admin_email');
  if (existing && existing.status === 'sent') {
    return { sent: false, skipped: true, notification: existing };
  }

  const pending = upsertNotification({
    orderId: order.id,
    type: 'paid_order_admin_email',
    title: 'Paid order email',
    message: `Order #${order.id} is waiting to send the admin notification email.`,
    status: 'pending',
    retryAvailable: false,
    error: null
  });

  try {
    const result = await withPostgresExternalCall(() => emailService.sendPaidOrderAdminEmail(order));
    const notification = upsertNotification({
      orderId: order.id,
      type: 'paid_order_admin_email',
      title: 'Paid order email',
      message: `Order #${order.id} admin email successfully sent.`,
      status: 'sent',
      retryAvailable: false,
      error: null,
      sentAt: new Date().toISOString()
    });
    return { sent: true, notification, result };
  } catch (error) {
    const failureMessage = error?.message || 'Email delivery failed.';
    const notification = upsertNotification({
      orderId: order.id,
      type: 'paid_order_admin_email',
      title: 'Paid order email failed',
      message: `Order #${order.id} admin email failed. Retry available.`,
      status: 'failed',
      retryAvailable: true,
      error: failureMessage,
      failedAt: new Date().toISOString()
    });
    return { sent: false, skipped: false, notification, error: failureMessage };
  }
}

async function processOrderTrackingCustomerEmail(order, eventType, details = {}) {
  if (!order || !order.id) {
    throw new Error('Order is required to send the tracking email.');
  }

  const key = `customer_tracking:${order.id}:${eventType}`;
  const existing = (readStore().notifications || []).find(notification => notification.key === key || (notification.orderId === order.id && notification.type === 'customer_tracking_email' && notification.eventType === eventType));
  if (existing && existing.status === 'sent') {
    return { sent: false, skipped: true, notification: existing };
  }

  const pending = upsertNotification({
    orderId: order.id,
    type: 'customer_tracking_email',
    eventType,
    key,
    title: 'Order update email',
    message: `Order #${order.id} is waiting to send a customer tracking update.`,
    status: 'pending',
    retryAvailable: false,
    error: null
  });

  try {
    const result = await withPostgresExternalCall(() => emailService.sendCustomerTrackingEmail(order, eventType, details));
    const notification = upsertNotification({
      orderId: order.id,
      type: 'customer_tracking_email',
      eventType,
      key,
      title: 'Order update email',
      message: `Order #${order.id} tracking update email successfully sent.`,
      status: 'sent',
      retryAvailable: false,
      error: null,
      sentAt: new Date().toISOString()
    });
    return { sent: true, notification, result };
  } catch (error) {
    const failureMessage = error?.message || 'Email delivery failed.';
    const notification = upsertNotification({
      orderId: order.id,
      type: 'customer_tracking_email',
      eventType,
      key,
      title: 'Order update email failed',
      message: `Order #${order.id} tracking update email failed. Retry available.`,
      status: 'failed',
      retryAvailable: true,
      error: failureMessage,
      failedAt: new Date().toISOString()
    });
    return { sent: false, skipped: false, notification, error: failureMessage };
  }
}

module.exports = {
  listNotifications,
  findNotificationByOrderAndType,
  upsertNotification,
  processPaidOrderAdminEmail,
  processOrderTrackingCustomerEmail
};
