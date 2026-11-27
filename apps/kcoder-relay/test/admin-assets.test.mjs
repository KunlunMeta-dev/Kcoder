import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { adminJs } from '../src/admin-assets.mjs';

function dashboard({ initialResponse, loggedOut = false } = {}) {
  const nodes = new Map(['copy', 'error', 'dashboard', 'create', 'logout'].map(id => [id, { hidden: true }]));
  if (loggedOut) nodes.set('login', {});
  nodes.get('dashboard').insertAdjacentHTML = (position, html) => {
    assert.equal(position, 'beforebegin');
    assert.match(html, /<form id="login"/);
    nodes.set('login', {});
  };
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id) },
    fetch: initialResponse ? async () => initialResponse : () => new Promise(() => {}),
  });
  vm.runInContext(`${adminJs}\nglobalThis.testApi = api;`, context);
  return { context, nodes };
}

test('admin API reports HTTP failures even when a proxy returns HTML and only sends JSON headers with a body', async () => {
  const { context } = dashboard();
  const requests = [];
  context.fetch = async (url, options) => {
    requests.push(options);
    return new Response('<html>Bad Gateway</html>', { status: 502 });
  };
  await assert.rejects(context.testApi('state'), error => error.status === 502 && /HTTP 502/.test(error.message));
  assert.equal(requests[0].headers, undefined);
  context.fetch = async (url, options) => {
    assert.equal(options.headers['content-type'], 'application/json');
    return new Response(null, { status: 204 });
  };
  assert.equal(await context.testApi('logout', {}), null);
  context.fetch = async () => new Response('{"error":"权限已撤销"}', { status: 403 });
  await assert.rejects(context.testApi('state'), error => error.status === 403 && error.message === '权限已撤销');
  context.fetch = async () => new Response('<html>unexpected success</html>', { status: 200 });
  await assert.rejects(context.testApi('state'), /无效数据/);
});

test('initial admin state failures are visible and an expired session restores the login form', async () => {
  const failed = dashboard({ initialResponse: new Response('failed', { status: 500 }), loggedOut: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failed.nodes.get('error').hidden, false);
  assert.match(failed.nodes.get('error').textContent, /HTTP 500/);

  const expired = dashboard({ initialResponse: new Response('expired', { status: 401 }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(expired.nodes.get('dashboard').hidden, true);
  assert.equal(expired.nodes.has('login'), true);
});
