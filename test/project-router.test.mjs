import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createProjectRouter } from '../lib/project-router.js';

function response() {
  return { headers: {}, setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; }, end() { return this; } };
}

test('shared project function forwards each action without changing method, authorization, query or body', async () => {
  for (const action of ['index', 'approve', 'reject', 'email-preview', 'status-changed']) {
    let received, loads = 0;
    const router = createProjectRouter({ [action]: async () => {
      loads++; return { default: async (req, res) => { received = req; return res.status(200).json({ action }); } };
    } });
    const req = { method: 'POST', headers: { 'x-admin-secret': 'test-only' },
      query: { __projectAction: action, id: 'submission-1', token: 'approval-token', type: 'all' }, body: { status: 'approved' } };
    const before = structuredClone(req);
    const res = response(); await router(req, res);
    assert.equal(received, req); assert.deepEqual(req, before); assert.equal(loads, 1);
    assert.equal(res.code, 200); assert.equal(res.body.action, action);
  }
});

test('unknown, repeated and prototype-named project actions cannot select a handler', async () => {
  let loads = 0;
  const router = createProjectRouter({ approve: async () => { loads++; } });
  for (const action of [undefined, ['approve', 'reject'], 'constructor', 'toString', '__proto__', '../newsletter/process', 'missing']) {
    const res = response(); await router({ query: { __projectAction: action } }, res);
    assert.equal(res.code, 404);
  }
  assert.equal(loads, 0);
});

test('Vercel routes preserve project URLs and keep upload, newsletter and Shopify auth functions separate', async () => {
  const config = JSON.parse(await fs.readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  function resolve(path) {
    for (const route of config.routes) {
      const match = path.match(new RegExp(`^${route.src}$`));
      if (match) return route.dest.replace(/\$(\d+)/g, (_, index) => match[Number(index)]);
    }
    return path;
  }
  for (const [path, action] of [
    ['/api/projects', 'index'], ['/api/projects/', 'index'], ['/api/projects/index', 'index'],
    ['/api/projects/approve', 'approve'], ['/api/projects/reject/', 'reject'],
    ['/api/projects/email-preview', 'email-preview'], ['/api/projects/status-changed', 'status-changed'],
  ]) assert.equal(resolve(path), `/api/projects/dispatch?__projectAction=${action}`);
  for (const path of ['/api/projects/submit', '/api/newsletter/webhook', '/api/newsletter/process', '/api/auth/shopify', '/api/auth/shopify/callback']) {
    assert.equal(resolve(path), path);
  }
  for (const name of ['projects/submit', 'newsletter/webhook']) {
    const source = await fs.readFile(new URL(`../api/${name}.js`, import.meta.url), 'utf8');
    assert.match(source, /bodyParser:\s*false/);
  }
});

test('API entrypoints stay within the Vercel Hobby function limit', async () => {
  async function entrypoints(url) {
    const output = [];
    for (const entry of await fs.readdir(url, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), url);
      if (entry.isDirectory()) output.push(...await entrypoints(child));
      else if (/\.(js|ts|mjs|cjs)$/.test(entry.name)) output.push(child.pathname);
    }
    return output;
  }
  const files = await entrypoints(new URL('../api/', import.meta.url));
  assert.equal(files.length, 11);
  assert.ok(files.length <= 12);
});

test('real handlers still validate requests and render previews through the shared function', async () => {
  // These cases exit before any database operation or email send.
  process.env.SUPABASE_URL ||= 'https://test-only.supabase.co';
  process.env.SUPABASE_SERVICE_KEY ||= 'test-only-key';
  const router = createProjectRouter();
  for (const [action, method, code] of [['index', 'POST', 405], ['approve', 'GET', 400], ['reject', 'GET', 400]]) {
    const res = response();
    await router({ method, query: { __projectAction: action }, headers: {} }, res);
    assert.equal(res.code, code);
  }
  const unchanged = response();
  await router({ method: 'POST', query: { __projectAction: 'status-changed' }, body: { record: { status: 'pending' }, old_record: { status: 'pending' } } }, unchanged);
  assert.equal(unchanged.code, 200); assert.deepEqual(unchanged.body, { message: 'No status change' });
  const preview = response();
  await router({ method: 'GET', query: { __projectAction: 'email-preview', type: 'all' } }, preview);
  assert.match(preview.headers['Content-Type'], /text\/html/); assert.match(preview.body, /Midnight Garden/);
});
