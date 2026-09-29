const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const previousMediaMode = process.env.MEDIA_STORAGE;
const previousDirectory = process.env.LEXORA_MEDIA_DIRECTORY;
const previousNodeEnv = process.env.NODE_ENV;
const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lexora-media-'));
process.env.MEDIA_STORAGE = 'local';
process.env.LEXORA_MEDIA_DIRECTORY = testDirectory;
delete process.env.NODE_ENV;
const { getMediaStore, assertProductionMediaConfigured } = require('../server/media');

test('local development media provider stores, reads, and deletes image bytes', async () => {
  const media = getMediaStore();
  const source = Buffer.from('local-image-bytes');
  const saved = await media.putProductImage({ productId: 'prod_media_test', extension: 'jpg', contentType: 'image/jpeg', body: source });
  assert.match(saved.url, /^\/uploads\/products\/prod_media_test_/);
  assert.deepEqual((await media.getProductImage(saved.url)).body, source);
  assert.equal(await media.deleteProductImage(saved.url), true);
  assert.equal(await media.getProductImage(saved.url), null);
});

test('production refuses local filesystem media storage', () => {
  process.env.NODE_ENV = 'production';
  process.env.MEDIA_STORAGE = 'local';
  assert.throws(() => assertProductionMediaConfigured(), /MEDIA_STORAGE=s3 is required in production/);
});

test.after(() => {
  fs.rmSync(testDirectory, { recursive: true, force: true });
  if (previousMediaMode === undefined) delete process.env.MEDIA_STORAGE;
  else process.env.MEDIA_STORAGE = previousMediaMode;
  if (previousDirectory === undefined) delete process.env.LEXORA_MEDIA_DIRECTORY;
  else process.env.LEXORA_MEDIA_DIRECTORY = previousDirectory;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});
