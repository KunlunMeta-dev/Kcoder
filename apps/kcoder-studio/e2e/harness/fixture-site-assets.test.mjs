import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startFixtureSite } from './fixture-site.mjs';
function owner() { const cleanups = []; return { context: { addCleanup: (_label, callback) => cleanups.push(callback), registerPort() {} }, async close() { for (const fn of cleanups.reverse()) await fn(); } }; }
test('fixture script assets use exact paths and read-only methods without filesystem inputs', async () => {
  const owned = owner();
  const site = await startFixtureSite(owned.context, { assets: { '/gate.mjs': { body: 'export const fixture = true;', contentType: 'text/javascript; charset=utf-8' } } });
  try {
    const valid = await fetch(new URL('/gate.mjs', site.url)); assert.match(valid.headers.get('content-type'), /text\/javascript/); assert.equal(await valid.text(), 'export const fixture = true;');
    const blocked = await fetch(new URL('/gate.mjs', site.url), { method: 'POST' }); assert.equal(blocked.status, 405);
    const alias = await new Promise((resolve, reject) => { const req = request(site.url, { path: '/a/../gate.mjs' }, response => { let body = ''; response.on('data', value => { body += value; }); response.on('end', () => resolve({ type: response.headers['content-type'], body })); }); req.on('error', reject); req.end(); });
    assert.doesNotMatch(alias.type, /javascript/); assert.notEqual(alias.body, 'export const fixture = true;');
  } finally { await owned.close(); }
});
test('invalid fixture assets are rejected before opening any listener', async () => {
  for (const [path, asset] of [['/../gate.mjs', { body: '', contentType: 'text/javascript; charset=utf-8' }], ['/gate.mjs', { body: 'x'.repeat(1024 * 1024 + 1), contentType: 'text/javascript; charset=utf-8' }], ['/gate.mjs', { body: '', contentType: 'text/html' }]]) {
    const owned = owner(); await assert.rejects(startFixtureSite(owned.context, { assets: { [path]: asset } }), /Invalid fixture exact asset/); await owned.close();
  }
});

test('fixture refuses wildcard and non-local listener addresses before creating resources', async () => {
  for (const host of ['0.0.0.0', 'example.invalid', '203.0.113.111']) {
    const owned = owner(); await assert.rejects(startFixtureSite(owned.context, { host }), /exact local IPv4/); await owned.close();
  }
});
