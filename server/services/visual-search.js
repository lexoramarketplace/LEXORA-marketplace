const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_INPUT_PIXELS = 20_000_000;
const MAX_IMAGE_DIMENSION = 768;
const MAX_RESULTS = 24;
const MAX_CATALOG_IMAGES_SCANNED = 100;
const MIN_COLOR_OVERLAP = 30;
const MIME_FORMATS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const EXTENSION_FORMATS = { '.jpg': 'jpg', '.jpeg': 'jpg', '.png': 'png', '.webp': 'webp' };
const EXISTING_PRODUCT_IMAGE_URLS = {
  prod_vela: 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=900&q=85',
  prod_kanso: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=900&q=85',
  prod_forma: 'https://images.unsplash.com/photo-1592078615290-033ee584e267?auto=format&fit=crop&w=900&q=85'
};
const remoteCatalogHistogramCache = new Map();

function providerSettings(environment = process.env) {
  const provider = String(environment.VISUAL_SEARCH_PROVIDER || '').trim().toLowerCase();
  const apiKey = String(environment.VISUAL_SEARCH_API_KEY || '').trim();
  if (provider !== 'openai-compatible' || !apiKey) return { mode: 'catalog-fallback' };

  const endpoint = String(environment.VISUAL_SEARCH_API_URL || 'https://api.openai.com/v1/chat/completions').trim();
  let parsed;
  try { parsed = new URL(endpoint); } catch { return { mode: 'catalog-fallback' }; }
  const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !localHttp) return { mode: 'catalog-fallback' };
  return {
    mode: 'openai-compatible',
    apiKey,
    endpoint: parsed.href,
    model: String(environment.VISUAL_SEARCH_MODEL || 'gpt-4o-mini').trim()
  };
}

function identifyImageFormat(filename, mimeType) {
  const extensionFormat = EXTENSION_FORMATS[path.extname(String(filename || '')).toLowerCase()];
  const mimeFormat = MIME_FORMATS[String(mimeType || '').toLowerCase()];
  return extensionFormat && extensionFormat === mimeFormat ? extensionFormat : null;
}

function colorName(red, green, blue) {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  if (max < 50) return 'black';
  if (min > 210 && max - min < 35) return 'white';
  if (max - min < 28) return max < 130 ? 'gray' : 'light neutral';
  if (red > green * 1.25 && red > blue * 1.2) return 'red';
  if (green > red * 1.2 && green > blue * 1.15) return 'green';
  if (blue > red * 1.2 && blue > green * 1.12) return 'blue';
  if (red > 155 && green > 90 && blue < 105) return 'orange';
  if (red > 145 && green > 125 && blue < 100) return 'yellow';
  if (red > 100 && blue > 90 && red > green * 1.12) return 'purple';
  return 'mixed color';
}

function binCenter(bin) {
  return Math.min(255, bin * 64 + 32);
}

async function inspectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('The image is empty.');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error('The image exceeds the 5 MB limit.');

  let pipeline;
  let metadata;
  try {
    pipeline = sharp(buffer, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS, animated: false });
    metadata = await pipeline.metadata();
  } catch {
    throw new Error('The image could not be decoded. Try a valid JPG, PNG, or WEBP image.');
  }
  if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw new Error('Only JPG, PNG, and WEBP images are supported.');
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_INPUT_PIXELS) {
    throw new Error('The image dimensions are too large.');
  }

  let decoded;
  let providerImage;
  try {
    const resized = sharp(buffer, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS, animated: false })
      .rotate()
      .resize({ width: MAX_IMAGE_DIMENSION, height: MAX_IMAGE_DIMENSION, fit: 'inside', withoutEnlargement: true });
    const raw = await resized.clone().flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    decoded = raw;
    providerImage = await resized.jpeg({ quality: 75, mozjpeg: true }).toBuffer();
  } catch {
    throw new Error('The image could not be decoded. Try a valid JPG, PNG, or WEBP image.');
  }

  const histogram = new Array(64).fill(0);
  const pixels = decoded.info.width * decoded.info.height;
  for (let index = 0; index < decoded.data.length; index += decoded.info.channels) {
    const red = decoded.data[index];
    const green = decoded.data[index + 1];
    const blue = decoded.data[index + 2];
    const bin = (Math.min(3, red >> 6) * 16) + (Math.min(3, green >> 6) * 4) + Math.min(3, blue >> 6);
    histogram[bin] += 1;
  }
  for (let index = 0; index < histogram.length; index += 1) histogram[index] /= pixels;

  const colorGroups = new Map();
  histogram.forEach((share, index) => {
    if (!share) return;
    const red = binCenter(Math.floor(index / 16));
    const green = binCenter(Math.floor((index % 16) / 4));
    const blue = binCenter(index % 4);
    const name = colorName(red, green, blue);
    const group = colorGroups.get(name) || { name, weight: 0, red: 0, green: 0, blue: 0 };
    group.weight += share;
    group.red += red * share;
    group.green += green * share;
    group.blue += blue * share;
    colorGroups.set(name, group);
  });
  const dominantColors = [...colorGroups.values()]
    .map(group => {
      const rgb = [group.red, group.green, group.blue].map(value => Math.round(value / group.weight));
      return {
        name: group.name,
        hex: `#${rgb.map(value => value.toString(16).padStart(2, '0')).join('')}`,
        share: Math.round(group.weight * 1000) / 10
      };
    })
    .sort((left, right) => right.share - left.share)
    .slice(0, 3);

  return { histogram, dominantColors, providerImage, width: metadata.width, height: metadata.height, format: metadata.format };
}

function parseVisionContent(content) {
  if (typeof content !== 'string') throw new Error('Vision provider returned an invalid analysis.');
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let result;
  try { result = JSON.parse(trimmed); } catch { throw new Error('Vision provider returned an invalid analysis.'); }
  const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean).slice(0, 8) : [];
  return {
    category: typeof result.category === 'string' ? result.category.slice(0, 100) : null,
    colors: strings(result.colors),
    style: typeof result.style === 'string' ? result.style.slice(0, 120) : null,
    material: typeof result.material === 'string' ? result.material.slice(0, 120) : null,
    attributes: strings(result.attributes)
  };
}

async function analyzeWithVision(image, settings = providerSettings()) {
  if (settings.mode !== 'openai-compatible') return null;
  const prompt = 'Analyze only visible product attributes in this image. Return JSON with category (string or null), colors (array), style (string or null), material (string or null), and attributes (array). Use null or [] when uncertain. Do not infer a brand, price, gender, or hidden material.';
  let response;
  try {
    response = await fetch(settings.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.providerImage.toString('base64')}`, detail: 'low' } }
        ] }],
        max_tokens: 300
      }),
      signal: AbortSignal.timeout(20_000)
    });
  } catch {
    throw new Error('The configured visual-search provider is unavailable.');
  }
  if (!response.ok) throw new Error('The configured visual-search provider could not analyze this image.');
  const payload = await response.json().catch(() => ({}));
  return parseVisionContent(payload.choices?.[0]?.message?.content);
}

function safeCatalogImagePath(product, imageDirectory) {
  const images = Array.isArray(product.images) ? product.images : [];
  const references = [...images, product.image, product.imageUrl].filter(value => typeof value === 'string' && value.startsWith('/uploads/products/'));
  for (const reference of references) {
    const filename = reference.slice('/uploads/products/'.length);
    if (!filename || path.basename(filename) !== filename || filename.includes('..') || !filename.startsWith(`${product.id}_`)) continue;
    const resolved = path.resolve(imageDirectory, filename);
    if (resolved.startsWith(`${path.resolve(imageDirectory)}${path.sep}`)) return resolved;
  }
  return null;
}

function histogramOverlap(left, right) {
  let intersection = 0;
  for (let index = 0; index < 64; index += 1) intersection += Math.min(left[index], right[index]);
  return Math.round(intersection * 1000) / 10;
}

async function matchCatalogByColor(image, products, imageDirectory, loadCatalogImage, hasCatalogImage) {
  const matches = [];
  const candidates = products.filter(product =>
    (product.status || 'active') === 'active' &&
    (safeCatalogImagePath(product, imageDirectory) || EXISTING_PRODUCT_IMAGE_URLS[product.id] || hasCatalogImage?.(product))
  ).slice(0, MAX_CATALOG_IMAGES_SCANNED);
  for (const product of candidates) {
    const imagePath = safeCatalogImagePath(product, imageDirectory);
    try {
      const catalogImage = imagePath
        ? await inspectImage(await fs.readFile(imagePath))
        : loadCatalogImage
          ? await inspectImage(await loadCatalogImage(product))
          : await existingCatalogHistogram(product);
      if (!catalogImage) continue;
      const similarity = histogramOverlap(image.histogram, catalogImage.histogram);
      if (similarity < MIN_COLOR_OVERLAP) continue;
      const colors = image.dominantColors.slice(0, 2).map(color => color.name);
      matches.push({
        product,
        score: similarity,
        colors: (catalogImage.dominantColors || []).slice(0, 3).map(color => color.name),
        matchType: 'Similar color',
        matchReasons: [`RGB color-histogram overlap: ${similarity}%`, ...(colors.length ? [`Detected dominant colors: ${colors.join(', ')}`] : [])]
      });
    } catch {
      continue;
    }
  }
  return matches.sort((left, right) => right.score - left.score).slice(0, MAX_RESULTS);
}

async function readRemoteCatalogImage(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'image/jpeg,image/png,image/webp' },
      signal: AbortSignal.timeout(6000)
    });
  } catch {
    return null;
  }
  if (!response.ok || !/^image\/(jpeg|png|webp)(;|$)/i.test(response.headers.get('content-type') || '')) return null;
  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (declaredSize > MAX_UPLOAD_BYTES) return null;
  const chunks = [];
  let totalSize = 0;
  try {
    for await (const chunk of response.body) {
      totalSize += chunk.length;
      if (totalSize > MAX_UPLOAD_BYTES) return null;
      chunks.push(chunk);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks, totalSize);
}

async function existingCatalogHistogram(product) {
  const url = EXISTING_PRODUCT_IMAGE_URLS[product.id];
  if (!url) return null;
  if (!remoteCatalogHistogramCache.has(product.id)) {
    remoteCatalogHistogramCache.set(product.id, (async () => {
      const buffer = await readRemoteCatalogImage(url);
      if (!buffer) return null;
      try {
        const features = await inspectImage(buffer);
        return { histogram: features.histogram, dominantColors: features.dominantColors };
      } catch { return null; }
    })());
  }
  return remoteCatalogHistogramCache.get(product.id);
}

async function loadExistingProductImage(product, imageDirectory, loadCatalogImage) {
  const localPath = safeCatalogImagePath(product, imageDirectory);
  if (localPath) {
    try { return await fs.readFile(localPath); } catch { return null; }
  }
  if (loadCatalogImage) {
    try { return await loadCatalogImage(product); } catch { return null; }
  }
  const url = EXISTING_PRODUCT_IMAGE_URLS[product.id];
  return url ? readRemoteCatalogImage(url) : null;
}

function matchCatalogByAttributes(analysis, products) {
  const matches = [];
  const category = String(analysis.category || '').trim().toLowerCase();
  const colors = analysis.colors.map(color => color.toLowerCase());
  const visibleTerms = [analysis.style, analysis.material, ...analysis.attributes].filter(Boolean).join(' ').toLowerCase();

  for (const product of products) {
    if ((product.status || 'active') !== 'active') continue;
    const searchable = [product.name, product.category, product.description, product.color, product.colors, product.material, product.style, product.tags, product.specifications]
      .flatMap(value => Array.isArray(value) ? value : [value])
      .filter(value => typeof value === 'string')
      .join(' ')
      .toLowerCase();
    const reasons = [];
    let score = 0;
    if (category && String(product.category || '').toLowerCase().includes(category)) { score += 45; reasons.push(`Category match: ${product.category}`); }
    const productColors = Array.isArray(product.colors) ? product.colors : typeof product.color === 'string' ? [product.color] : [];
    if (colors.some(color => productColors.some(productColor => productColor.toLowerCase() === color))) { score += 20; reasons.push('Detected color matches stored product color'); }
    if (visibleTerms && visibleTerms.split(/\W+/).filter(Boolean).some(term => term.length > 3 && searchable.includes(term))) {
      score += 15;
      reasons.push('Visible style/material words match product data');
    }
    if (score > 0) matches.push({ product, score, colors: productColors, matchType: reasons[0] || 'Visual attribute match', matchReasons: reasons });
  }
  return matches.sort((left, right) => right.score - left.score).slice(0, MAX_RESULTS);
}

function publicProductMatch(match) {
  const product = match.product;
  return {
    productId: product.id,
    id: product.id,
    name: product.name,
    category: product.category,
    description: product.description || '',
    supplier: product.supplier || '',
    location: product.location || '',
    price: Number(product.price || 0),
    wholesalePrice: Number(product.wholesalePrice || 0),
    moq: Number(product.moq || 1),
    stock: Number(product.stock || 0),
    availableStock: Number(product.availableStock ?? product.stock ?? 0),
    available: Number(product.availableStock ?? product.stock ?? 0) > 0 && (product.status || 'active') === 'active',
    status: product.status || 'active',
    rating: product.rating ?? null,
    reviews: product.reviews || 0,
    colors: match.colors || (Array.isArray(product.colors) ? product.colors : typeof product.color === 'string' ? [product.color] : []),
    material: typeof product.material === 'string' ? product.material : '',
    productType: typeof product.productType === 'string' ? product.productType : '',
    verified: product.verified === true,
    image: product.image || product.imageUrl || product.images?.[0] || EXISTING_PRODUCT_IMAGE_URLS[product.id] || '',
    images: Array.isArray(product.images) ? product.images : [],
    matchType: match.matchType,
    matchReasons: match.matchReasons,
    similarityScore: match.score
  };
}

async function searchVisualCatalog({ buffer, format, sourceProduct, products, imageDirectory, loadCatalogImage, hasCatalogImage, environment = process.env }) {
  if (sourceProduct) {
    buffer = await loadExistingProductImage(sourceProduct, imageDirectory, loadCatalogImage);
    if (!buffer) throw new Error('This catalog product has no supported image for visual search.');
    try {
      const metadata = await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS }).metadata();
      format = metadata.format === 'jpeg' ? 'jpg' : metadata.format;
    } catch {
      throw new Error('This catalog product image could not be decoded.');
    }
  }
  const image = await inspectImage(buffer);
  if (image.format === 'jpeg' && format !== 'jpg') throw new Error('Image extension does not match the image contents.');
  if (image.format !== 'jpeg' && image.format !== format) throw new Error('Image extension does not match the image contents.');
  const settings = providerSettings(environment);
  const detected = await analyzeWithVision(image, settings);
  if (detected) {
    const matches = matchCatalogByAttributes(detected, products);
    return {
      provider: 'openai-compatible',
      fallback: false,
      sourceType: sourceProduct ? 'catalog-product' : 'customer-upload',
      analysis: { ...detected, dominantColors: image.dominantColors },
      matching: { method: 'catalog-attribute-evidence', definition: 'Category match adds 45 points, stored color evidence 20 points, and visible style/material term evidence 15 points. Results require at least one matching signal.' },
      results: matches.map(publicProductMatch),
      total: matches.length
    };
  }

  const matches = await matchCatalogByColor(image, products, imageDirectory, loadCatalogImage, hasCatalogImage);
  return {
    provider: 'catalog-fallback',
    fallback: true,
    sourceType: sourceProduct ? 'catalog-product' : 'customer-upload',
    analysis: {
      category: null,
      colors: [],
      dominantColors: image.dominantColors,
      style: null,
      material: null,
      attributes: [],
      note: 'No vision provider is configured. These results use local RGB color-histogram comparison only; category, style, and material were not analyzed.'
    },
    matching: {
      method: 'rgb-histogram-intersection',
      definition: 'Similarity is the intersection of normalized 64-bin RGB histograms, expressed from 0 to 100; 100 means identical color-bin distributions.',
      minimumSimilarity: MIN_COLOR_OVERLAP,
      catalogImageScope: 'Only active catalog products with an existing LEXORA catalog image reference can be matched in fallback mode. Customer-uploaded images are processed locally and are not sent to external image hosts.'
    },
    results: matches.map(publicProductMatch),
    total: matches.length
  };
}

function providerMode(environment = process.env) {
  return providerSettings(environment).mode;
}

module.exports = {
  MAX_UPLOAD_BYTES,
  MAX_IMAGE_DIMENSION,
  MIME_FORMATS,
  EXTENSION_FORMATS,
  identifyImageFormat,
  inspectImage,
  providerMode,
  searchVisualCatalog,
  safeCatalogImagePath
};
