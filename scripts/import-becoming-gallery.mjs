import 'dotenv/config';
import path from 'node:path';
import { importGallery, validatePhotos } from '../lib/becoming-gallery-import.js';
import { readFile } from 'node:fs/promises';

const [directory, themeDirectory, mode = '--check'] = process.argv.slice(2);
if (!directory || !themeDirectory || !['--check', '--upload'].includes(mode)) throw new Error('Usage: node scripts/import-becoming-gallery.mjs <prepared-photos> <theme-directory> [--check|--upload]');
const photos = validatePhotos(JSON.parse(await readFile(path.join(directory, 'photos.json'), 'utf8')));
if (mode === '--check') {
  console.log(`${photos.length} photographs, ${(photos.reduce((total, photo) => total + photo.bytes, 0) / 1e6).toFixed(1)} MB. No uploads or theme changes made.`);
} else {
  const { shopifyGraphql } = await import('../lib/shopify.js');
  console.log(`Imported ${await importGallery({ directory: path.resolve(directory), themeDirectory: path.resolve(themeDirectory), graphql: shopifyGraphql, concurrency: 3 })} photographs. Theme files are ready for review; no page or theme was published.`);
}
