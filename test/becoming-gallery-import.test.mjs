import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validatePhotos, requireFileAccess, uploadPhoto, importGallery } from '../lib/becoming-gallery-import.js';

const bytes = Buffer.from('mock-jpeg-bytes');
const photo = { filename: 'becoming-night-' + 'a'.repeat(20) + '.jpg', width: 1200, height: 1600,
  bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), alt: 'Becoming photograph' };
const ready = { id: 'gid://shopify/MediaImage/1', fileStatus: 'READY', image: { url: 'https://cdn.shopify.com/s/files/1/files/' + photo.filename, width: 1200, height: 1600 } };
const access = { currentAppInstallation: { accessScopes: ['read_files', 'write_files'].map((handle) => ({ handle })) } };

test('prepared batch rejects path traversal, missing checksums, oversized originals, duplicate names and skipped files', () => {
  assert.deepEqual(validatePhotos({ version: 1, photos: [photo] }), [photo]);
  for (const update of [{ filename: '../photo.jpg' }, { width: 4000 }, { bytes: 30_000_000 }, { sha256: '' }]) assert.throws(() => validatePhotos({ version: 1, photos: [{ ...photo, ...update }] }));
  assert.throws(() => validatePhotos({ version: 1, photos: [photo, photo] }));
  assert.throws(() => validatePhotos({ version: 1, photos: [photo], skipped: [{ filename: 'bad' }] }));
});

test('missing file permissions stop before any import', async () => {
  await requireFileAccess(async () => access);
  await assert.rejects(() => requireFileAccess(async () => ({ currentAppInstallation: { accessScopes: [{ handle: 'write_customers' }] } })), /read_files/);
});

test('a ready existing image is reused without another upload; altered local bytes are rejected', async () => {
  let sends = 0;
  const result = await uploadPhoto(photo, bytes, { graphql: async () => ({ files: { nodes: [ready] } }), fetch: async () => { sends++; } });
  assert.equal(result.id, ready.id); assert.equal(sends, 0);
  await assert.rejects(() => uploadPhoto(photo, Buffer.from('changed'), { graphql: async () => { throw Error('must not query'); } }), /Prepared image changed/);
});

test('staged upload is created as image, then polled before publishing its URL', async () => {
  const calls = [];
  const graphql = async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes('FindGalleryFile')) return { files: { nodes: [] } };
    if (query.includes('StageGalleryPhoto')) return { stagedUploadsCreate: { userErrors: [], stagedTargets: [{ url: 'https://uploads.example.test', resourceUrl: 'https://uploads.example.test/photo', parameters: [{ name: 'key', value: 'photo' }] }] } };
    if (query.includes('CreateGalleryPhoto')) return { fileCreate: { userErrors: [], files: [{ id: ready.id, fileStatus: 'PROCESSING' }] } };
    return { node: ready };
  };
  const result = await uploadPhoto(photo, bytes, { graphql, sleep: async () => {}, fetch: async (_, request) => {
    assert.equal(request.method, 'POST'); assert.equal(request.body.get('file').type, 'image/jpeg'); return { ok: true };
  } });
  assert.equal(result.url, ready.image.url);
  assert.equal(calls.find((call) => call.query.includes('CreateGalleryPhoto')).variables.files[0].duplicateResolutionMode, 'RAISE_ERROR');
  assert.ok(calls.some((call) => call.query.includes('GalleryPhotoStatus')));
});

test('an interrupted processing image is polled without creating a duplicate; failed processing rejects', async () => {
  let queried = 0;
  const graphql = async (query) => { queried++; return query.includes('FindGalleryFile') ? { files: { nodes: [{ id: ready.id, fileStatus: 'PROCESSING', image: null }] } } : { node: ready }; };
  assert.equal((await uploadPhoto(photo, bytes, { graphql, sleep: async () => {} })).id, ready.id); assert.equal(queried, 2);
  await assert.rejects(() => uploadPhoto(photo, bytes, { graphql: async () => ({ files: { nodes: [{ ...ready, fileStatus: 'FAILED' }] } }) }), /processing failed/);
});

test('failed import keeps the public manifest; rerun resumes and writes only Shopify URLs and the initial page photos', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'becoming-import-'));
  const theme = path.join(directory, 'theme');
  try {
    await mkdir(path.join(theme, 'assets'), { recursive: true }); await mkdir(path.join(theme, 'templates'));
    const second = { ...photo, filename: 'becoming-night-' + 'b'.repeat(20) + '.jpg' };
    await writeFile(path.join(directory, 'photos.json'), JSON.stringify({ version: 1, photos: [photo, second] }));
    for (const item of [photo, second]) await writeFile(path.join(directory, item.filename), bytes);
    const manifest = path.join(theme, 'assets/becoming-gallery-data.json'); await writeFile(manifest, 'original manifest');
    await writeFile(path.join(theme, 'templates/page.becoming-gallery.json'), JSON.stringify({ sections: { main: { settings: { photographer_credit: '' } } } }));
    const graphql = async (query) => query.includes('GalleryFileAccess') ? access : { node: ready };
    let count = 0;
    const upload = async (item) => { count++; if (count === 2) throw Error('Offline'); return { ...item, id: ready.id, url: ready.image.url }; };
    await assert.rejects(() => importGallery({ directory, themeDirectory: theme, graphql, upload, log() {} }), /Offline/);
    assert.equal(await readFile(manifest, 'utf8'), 'original manifest');
    const imported = await importGallery({ directory, themeDirectory: theme, graphql, upload: async (item) => { count++; return { ...item, id: 'gid://shopify/MediaImage/2', url: ready.image.url.replace(photo.filename, item.filename) }; }, log() {} });
    assert.equal(imported, 2); assert.equal(count, 3);
    const data = JSON.parse(await readFile(manifest, 'utf8')); assert.equal(data.photos.length, 2); assert.deepEqual(Object.keys(data.photos[0]).sort(), ['alt', 'height', 'url', 'width']);
    const template = JSON.parse(await readFile(path.join(theme, 'templates/page.becoming-gallery.json'), 'utf8')); assert.equal(template.sections.main.block_order.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
