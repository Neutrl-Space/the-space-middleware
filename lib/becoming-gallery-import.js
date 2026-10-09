import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export function validatePhotos(data) {
  if (data.version !== 1 || !Array.isArray(data.photos) || !data.photos.length || data.skipped?.length) throw new Error('Prepare a nonempty photo batch and resolve skipped files before importing.');
  const names = new Set();
  for (const photo of data.photos) {
    if (!/^becoming-night-[a-f0-9]{20}\.jpg$/.test(photo.filename) || names.has(photo.filename) ||
      !Number.isInteger(photo.width) || photo.width < 1 || photo.width > 1600 ||
      !Number.isInteger(photo.height) || photo.height < 1 || photo.height > 1600 ||
      !Number.isInteger(photo.bytes) || photo.bytes < 1 || photo.bytes > 2_000_000 || !/^[a-f0-9]{64}$/.test(photo.sha256)) throw new Error('Invalid prepared photograph.');
    names.add(photo.filename);
  }
  return data.photos;
}

const mutation = (data, name) => {
  if (!data[name] || data[name].userErrors?.length) throw new Error(`Shopify ${name} failed.`);
  return data[name];
};

export async function requireFileAccess(graphql) {
  const data = await graphql('query GalleryFileAccess { currentAppInstallation { accessScopes { handle } } }');
  const scopes = data.currentAppInstallation.accessScopes.map((scope) => scope.handle);
  if (!scopes.includes('read_files') || !scopes.includes('write_files')) throw new Error('Grant read_files and write_files to the Shopify app, then reauthorize /api/auth/shopify before importing.');
}

export async function uploadPhoto(photo, bytes, { graphql, fetch: send = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (bytes.length !== photo.bytes || createHash('sha256').update(bytes).digest('hex') !== photo.sha256) throw new Error('Prepared image changed; rerun photo preparation.');
  // Find an already-created file after a retry, including interrupted imports.
  const existing = await graphql(`query FindGalleryFile($query: String!) {
    files(first: 10, query: $query) { nodes { id fileStatus ... on MediaImage { image { url width height } } } }
  }`, { query: `media_type:IMAGE AND filename:${JSON.stringify(photo.filename)}` });
  const matches = existing.files.nodes.filter((file) => !file.image || new URL(file.image.url).pathname.split('/').pop() === photo.filename);
  if (matches.length > 1) throw new Error('Multiple matching gallery files; resolve the duplicate before importing.');
  let file = matches[0];
  if (!file) {
    const staged = mutation(await graphql(`mutation StageGalleryPhoto($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } }
    }`, { input: [{ filename: photo.filename, mimeType: 'image/jpeg', resource: 'FILE', httpMethod: 'POST', fileSize: String(bytes.length) }] }), 'stagedUploadsCreate');
    const target = staged.stagedTargets[0];
    if (!target?.url || !target.resourceUrl) throw new Error('No staged upload target returned.');
    const form = new FormData();
    for (const parameter of target.parameters) form.append(parameter.name, parameter.value);
    form.append('file', new Blob([bytes], { type: 'image/jpeg' }), photo.filename);
    const response = await send(target.url, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('Staged photo upload failed.');
    const created = mutation(await graphql(`mutation CreateGalleryPhoto($files: [FileCreateInput!]!) {
      fileCreate(files: $files) { files { id fileStatus } userErrors { field message } }
    }`, { files: [{ filename: photo.filename, alt: photo.alt, contentType: 'IMAGE', originalSource: target.resourceUrl, duplicateResolutionMode: 'RAISE_ERROR' }] }), 'fileCreate');
    file = created.files[0];
    if (!file?.id) throw new Error('Gallery file was not returned.');
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    if (file.fileStatus === 'FAILED') throw new Error('Shopify photo processing failed.');
    if (file.fileStatus === 'READY' && file.image?.url) return { id: file.id, url: file.image.url, width: file.image.width, height: file.image.height, alt: photo.alt, filename: photo.filename, sha256: photo.sha256 };
    await sleep(2000);
    const checked = await graphql(`query GalleryPhotoStatus($id: ID!) { node(id: $id) { ... on MediaImage { id fileStatus image { url width height } } } }`, { id: file.id });
    if (!checked.node) throw new Error('Uploaded photo could not be verified.');
    file = checked.node;
  }
  throw new Error('Photo processing timed out. Rerun the import to resume.');
}

export async function atomicJson(filename, data) {
  await writeFile(filename + '.tmp', JSON.stringify(data, null, 2) + '\n');
  await rename(filename + '.tmp', filename);
}

export async function importGallery({ directory, themeDirectory, graphql, upload = uploadPhoto, log = console.log }) {
  const photos = validatePhotos(JSON.parse(await readFile(path.join(directory, 'photos.json'), 'utf8')));
  await requireFileAccess(graphql);
  const statePath = path.join(directory, 'shopify-upload-state.json');
  let state = { version: 1, photos: {} };
  try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const imported = [];
  for (const [index, photo] of photos.entries()) {
    let result = state.photos[photo.filename];
    // Always read back cached files: never publish deleted or unready files.
    if (result?.sha256 === photo.sha256) {
      const verified = await graphql(`query VerifyImportedGalleryFile($id: ID!) { node(id: $id) { ... on MediaImage { fileStatus image { url width height } } } }`, { id: result.id });
      if (verified.node?.fileStatus !== 'READY' || !verified.node.image?.url) result = null;
      else result = { ...result, ...verified.node.image, alt: photo.alt };
    } else result = null;
    if (!result) result = await upload(photo, await readFile(path.join(directory, photo.filename)), { graphql });
    if (!result.url.startsWith('https://cdn.shopify.com/')) throw new Error('Shopify did not return a supported CDN URL.');
    state.photos[photo.filename] = result;
    await atomicJson(statePath, state);
    imported.push(result);
    log(`${index + 1}/${photos.length} photographs ready`);
  }
  // Only replace the public manifest after every image succeeds. Drive references stay private.
  await atomicJson(path.join(themeDirectory, 'assets/becoming-gallery-data.json'), { version: 1, photos: imported.map(({ url, width, height, alt }) => ({ url, width, height, alt })) });
  const templatePath = path.join(themeDirectory, 'templates/page.becoming-gallery.json');
  const template = JSON.parse(await readFile(templatePath, 'utf8'));
  const first = imported.slice(0, 24);
  template.sections.main.blocks = Object.fromEntries(first.map((photo, index) => [`photo${index + 1}`, { type: 'photo', settings: { image: `shopify://shop_images/${photo.filename}` } }]));
  template.sections.main.block_order = first.map((_, index) => `photo${index + 1}`);
  await atomicJson(templatePath, template);
  return imported.length;
}
