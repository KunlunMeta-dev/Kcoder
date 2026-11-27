import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadProductAccountCookieScopeRoot, prepareProductAccountCookieScopeSource,
  PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE, productAccountCookieScope, verifyProductAccountCookieScopeRelocation } from './gateway-product-account.js';

const issuer = 'https://relay.example.test';

async function fixture(t) {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'product-account-scope-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const roots = ['Source', 'Target', 'Next'].map(name => join(parent, name));
  for (const root of roots) await mkdir(root);
  return { parent, source: roots[0], target: roots[1], next: roots[2] };
}

test('legacy hash survives repeated moves by copying one immutable scope seed', async t => {
  const { source, target, next } = await fixture(t);
  assert.equal(await loadProductAccountCookieScopeRoot(source), source);
  assert.equal(productAccountCookieScope(await loadProductAccountCookieScopeRoot(source), '/', issuer),
    productAccountCookieScope(source, '/', issuer));
  const validateOffline = () => true;
  const first = { source, finalTarget: target, operationId: 'cookie-scope-move-1', validateOffline };
  assert.deepEqual(await prepareProductAccountCookieScopeSource(first), { version: 1, state: 'frozen' });
  const frozen = await readFile(join(source, PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE));
  assert.deepEqual(JSON.parse(frozen), { version: 1, scopeRoot: source });
  await copyFile(join(source, PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE), join(target, PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE));
  assert.deepEqual(await verifyProductAccountCookieScopeRelocation(first), { version: 1, state: 'verified' });
  assert.deepEqual(await readFile(join(source, PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE)), frozen);
  assert.deepEqual(await readFile(join(target, PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE)), frozen);
  assert.equal(await loadProductAccountCookieScopeRoot(target), source);

  const second = { source: target, finalTarget: next, operationId: 'cookie-scope-move-2', validateOffline };
  assert.deepEqual(await prepareProductAccountCookieScopeSource(second), { version: 1, state: 'frozen' });
  await copyFile(join(target, PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE), join(next, PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE));
  assert.deepEqual(await verifyProductAccountCookieScopeRelocation(second), { version: 1, state: 'verified' });
  assert.deepEqual(await readFile(join(next, PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE)), frozen);
  assert.equal(await loadProductAccountCookieScopeRoot(next), source);
  assert.equal(productAccountCookieScope(await loadProductAccountCookieScopeRoot(next), '/g/test/', issuer),
    productAccountCookieScope(source, '/g/test/', issuer));
  assert.notEqual(productAccountCookieScope(await loadProductAccountCookieScopeRoot(next), '/', issuer),
    productAccountCookieScope(source, '/', 'https://another-relay.example.test'));
  assert.notEqual(productAccountCookieScope(await loadProductAccountCookieScopeRoot(next), '/', issuer),
    productAccountCookieScope(source, '/g/another/', issuer));
});

test('missing owner authority writes nothing and a malformed seed never falls back', async t => {
  const { source, target } = await fixture(t);
  await assert.rejects(prepareProductAccountCookieScopeSource({ source, finalTarget: target,
    operationId: 'cookie-scope-denied', validateOffline: () => false }),
  { code: 'PRODUCT_ACCOUNT_COOKIE_SCOPE_AUTHORITY_REQUIRED' });
  await assert.rejects(readFile(join(source, PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE)), { code: 'ENOENT' });

  await writeFile(join(source, PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE), '{"version":1,"scopeRoot":"relative"}\n');
  await assert.rejects(loadProductAccountCookieScopeRoot(source), { code: 'PRODUCT_ACCOUNT_COOKIE_SCOPE_INVALID' });
});
