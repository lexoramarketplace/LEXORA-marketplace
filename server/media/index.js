const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const localDirectory = path.resolve(process.env.LEXORA_MEDIA_DIRECTORY || path.join(__dirname, '..', '..', 'uploads', 'products'));
const productIdPattern = /^[A-Za-z0-9_-]{1,160}$/;
let cachedStore;

function mediaMode() {
  const configured = String(process.env.MEDIA_STORAGE || '').trim().toLowerCase();
  if (process.env.NODE_ENV === 'production') {
    if (configured !== 's3') throw new Error('MEDIA_STORAGE=s3 is required in production; local filesystem media is disabled.');
    return 's3';
  }
  if (!configured || configured === 'local') return 'local';
  if (configured === 's3') return 's3';
  throw new Error('MEDIA_STORAGE must be local or s3.');
}

function s3Configuration() {
  const bucket = String(process.env.S3_BUCKET || '').trim();
  const region = String(process.env.S3_REGION || '').trim();
  const publicBaseUrl = String(process.env.S3_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!bucket || !region || !publicBaseUrl) throw new Error('S3_BUCKET, S3_REGION, and S3_PUBLIC_BASE_URL are required for persistent media.');
  let publicUrl;
  try { publicUrl = new URL(publicBaseUrl); } catch { throw new Error('S3_PUBLIC_BASE_URL must be a valid HTTPS URL.'); }
  if (publicUrl.protocol !== 'https:') throw new Error('S3_PUBLIC_BASE_URL must use HTTPS.');
  return {
    bucket,
    region,
    publicBaseUrl,
    endpoint: String(process.env.S3_ENDPOINT || '').trim() || undefined,
    forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || '').toLowerCase() === 'true',
    accessKeyId: String(process.env.S3_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: String(process.env.S3_SECRET_ACCESS_KEY || '').trim()
  };
}

function encodedKey(key) {
  return key.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

function parseLocalReference(reference) {
  if (typeof reference !== 'string' || !reference.startsWith('/uploads/products/')) return null;
  const filename = reference.slice('/uploads/products/'.length);
  if (!filename || path.basename(filename) !== filename || filename.includes('..') || !/^[A-Za-z0-9_-]+\.(?:jpg|png|webp)$/.test(filename)) return null;
  return filename;
}

function localStore() {
  return {
    mode: 'local',
    hasProductImage(reference) { return Boolean(parseLocalReference(reference)); },
    async putProductImage({ productId, extension, contentType, body }) {
      if (!productIdPattern.test(String(productId))) throw new Error('Invalid product ID for media storage.');
      fs.mkdirSync(localDirectory, { recursive: true });
      const filename = `${productId}_${crypto.randomUUID()}.${extension}`;
      fs.writeFileSync(path.join(localDirectory, filename), body, { flag: 'wx', mode: 0o600 });
      return { url: `/uploads/products/${filename}`, key: filename, contentType };
    },
    async getProductImage(reference) {
      const filename = parseLocalReference(reference);
      if (!filename) return null;
      const filePath = path.join(localDirectory, filename);
      if (!fs.existsSync(filePath)) return null;
      const contentType = filename.endsWith('.png') ? 'image/png' : filename.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      return { body: fs.readFileSync(filePath), contentType };
    },
    async deleteProductImage(reference) {
      const filename = parseLocalReference(reference);
      if (!filename) return false;
      fs.rmSync(path.join(localDirectory, filename), { force: true });
      return true;
    },
    async readCatalogImage(product) {
      const refs = [...(Array.isArray(product.images) ? product.images : []), product.image, product.imageUrl].filter(Boolean);
      for (const ref of refs) {
        const image = await this.getProductImage(ref);
        if (image) return image.body;
      }
      return null;
    }
  };
}

function s3Store() {
  const config = s3Configuration();
  const credentials = config.accessKeyId && config.secretAccessKey
    ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
    : undefined;
  if (Boolean(config.accessKeyId) !== Boolean(config.secretAccessKey)) throw new Error('Set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or use the runtime role credentials.');
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    ...(credentials ? { credentials } : {})
  });
  const keyFor = reference => {
    const localReference = parseLocalReference(reference);
    if (localReference) return `products/legacy/${localReference}`;
    if (typeof reference !== 'string' || !reference.startsWith(`${config.publicBaseUrl}/`)) return null;
    const encoded = reference.slice(config.publicBaseUrl.length + 1);
    let key;
    try { key = encoded.split('/').map(segment => decodeURIComponent(segment)).join('/'); } catch { return null; }
    if (!key.startsWith('products/') || key.split('/').some(segment => !segment || segment === '.' || segment === '..')) return null;
    return key;
  };

  return {
    mode: 's3',
    hasProductImage(reference) { return Boolean(keyFor(reference)); },
    async putProductImage({ productId, extension, contentType, body }) {
      if (!productIdPattern.test(String(productId))) throw new Error('Invalid product ID for media storage.');
      const key = `products/${productId}/${crypto.randomUUID()}.${extension}`;
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable' }));
      return { url: `${config.publicBaseUrl}/${encodedKey(key)}`, key, contentType };
    },
    async importLegacyProductImage(reference) {
      const filename = parseLocalReference(reference);
      if (!filename) throw new Error('Legacy product image reference is invalid.');
      const filePath = path.join(localDirectory, filename);
      if (!fs.existsSync(filePath)) throw new Error(`Legacy product image file is missing: ${filename}`);
      const extension = path.extname(filename).slice(1).toLowerCase();
      const contentType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
      const key = `products/legacy/${filename}`;
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: fs.readFileSync(filePath), ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable' }));
      return { url: `${config.publicBaseUrl}/${encodedKey(key)}`, key, contentType };
    },
    async getProductImage(reference) {
      const key = keyFor(reference);
      if (!key) return null;
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
        return { body: Buffer.from(await result.Body.transformToByteArray()), contentType: result.ContentType || 'application/octet-stream' };
      } catch (error) {
        if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async deleteProductImage(reference) {
      const key = keyFor(reference);
      if (!key) return false;
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
      return true;
    },
    async readCatalogImage(product) {
      const refs = [...(Array.isArray(product.images) ? product.images : []), product.image, product.imageUrl].filter(Boolean);
      for (const ref of refs) {
        const image = await this.getProductImage(ref);
        if (image) return image.body;
      }
      return null;
    },
    async close() { client.destroy(); }
  };
}

function getMediaStore() {
  const mode = mediaMode();
  if (!cachedStore || cachedStore.mode !== mode) cachedStore = mode === 's3' ? s3Store() : localStore();
  return cachedStore;
}

async function migrateLegacyProductImages(products) {
  const store = getMediaStore();
  if (store.mode !== 's3') return { migrated: 0, errors: [] };
  const migrated = new Map();
  const errors = [];
  let count = 0;
  for (const product of products || []) {
    const originalImages = Array.isArray(product.images) ? product.images : product.image || product.imageUrl ? [product.image || product.imageUrl] : [];
    const updatedImages = [];
    for (const reference of originalImages) {
      if (typeof reference !== 'string' || !reference.startsWith('/uploads/products/')) {
        updatedImages.push(reference);
        continue;
      }
      if (!migrated.has(reference)) {
        try {
          migrated.set(reference, await store.importLegacyProductImage(reference));
          count += 1;
        } catch (error) {
          errors.push({ productId: product.id, reference, reason: error.message });
          continue;
        }
      }
      const result = migrated.get(reference);
      if (result?.url) updatedImages.push(result.url);
    }
    product.images = updatedImages;
    product.image = updatedImages[0] || '';
    product.imageUrl = updatedImages[0] || '';
  }
  return { migrated: count, errors };
}

function assertProductionMediaConfigured() {
  if (process.env.NODE_ENV === 'production') {
    mediaMode();
    s3Configuration();
  }
  return true;
}

module.exports = { mediaMode, getMediaStore, assertProductionMediaConfigured, migrateLegacyProductImages, parseLocalReference };