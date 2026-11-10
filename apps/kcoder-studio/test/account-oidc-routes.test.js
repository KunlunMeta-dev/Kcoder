// Gateway state/ownership contracts use a synthetic trusted-process adapter.
// Real TLS/JWS/UID acceptance lives in the account-domain host harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createOrganizationOidcRoutes } from '../src/account-oidc-routes.js';
import { createAccountLoginContexts } from '../src/account-login-context.js';

const clientId = '01234567-89ab-4cde-8fab-0123456789ab';
const principal = { principalId: '11234567-89ab-4cde-8fab-0123456789ab', username: 'alice', role: 'user' };
const authority = { handle: '1'.repeat(64), secret: '2'.repeat(64), clientBinding: 'a'.repeat(43) };

function fixture() {
  const contexts = createAccountLoginContexts();
  const target = { id: 'org', security: {}, revision: 1 };
  const brokers = [];
  let active = true, submissions = 0;
  const manager = createOrganizationOidcRoutes({ getTarget: id => id === target.id ? target : null,
    targetSignature: item => `${item.id}:${item.revision}`, loginContexts: contexts,
    loginOwner: request => request.owner, captureOwner: request => ({ owner: request.owner }), ownerActive: () => active,
    isAllowedRedirectOrigin: origin => origin === 'https://gateway.test', listeningPort: () => 4173,
    callbackOwner: async request => request.owner ?? null,
    createBroker: (_target, options) => {
      const child = new EventEmitter();
      const broker = { child, stopped: 0 };
      child.submitOidcCallback = () => {
        submissions++;
        if (options.onAccountAuthenticated(principal, authority) === false) { child.emit('error', new Error('stale')); return; }
        contexts.publish(options.loginOwner, target.id, principal, { authentication: 'oidcResume', resumeAuthority: authority });
      };
      brokers.push(broker);
      queueMicrotask(() => options.onAuthorizationRequired({ requestId: 'root-original-request-identity',
        authorizationUrl: 'https://issuer.test/auth?state=root-original-state', redirectUri: 'https://gateway.test/api/account/oidc/callback', expiresIn: 180 }));
      return broker;
    }, finishBroker: async () => {}, stopBroker: async broker => { broker.stopped++; },
    closeSockets: () => {}, invalidateHealth: () => {}, requireSameOriginMutation: request => request.originValid !== false,
    requestBody: async request => request.body, jsonResponse: (response, code, body) => { response.code = code; response.body = body; },
  });
  const session = { allowedServerIds: new Set(['org']) };
  const response = () => ({ writeHead(code) { this.code = code; }, end(body) { this.text = body; } });
  async function request(method, owner = 'owner-a', body, id = clientId) {
    const result = response();
    await manager.handle({ method, owner, body: JSON.stringify(body) }, result,
      new URL(`https://gateway.test/api/servers/org/account/oidc?clientRequestId=${id}`), session);
    return result;
  }
  async function callbackGet() {
    const result = response();
    await manager.handleCallback({ method: 'GET' }, result, new URL('https://gateway.test/api/account/oidc/callback?code=synthetic-code&state=root-original-state'));
    return result;
  }
  async function callbackPost(receipt, owner) {
    const result = response();
    await manager.handleCallback({ method: 'POST', owner, body: JSON.stringify({ receipt }) }, result,
      new URL('https://gateway.test/api/account/oidc/callback'));
    return result;
  }
  return { manager, contexts, target, brokers, request, callbackGet, callbackPost,
    submissions: () => submissions, expire: () => { active = false; } };
}

test('original owner completes one pending request and private resume data never enters HTTP DTOs', async () => {
  const f = fixture();
  const start = await f.request('POST', 'owner-a', { username: 'alice', clientRequestId: clientId });
  assert.equal(start.code, 200);
  assert.equal(f.contexts.identity('owner-a', 'org'), null);
  const landing = await f.callbackGet();
  const receipt = landing.text.match(/receipt:"([A-Za-z0-9_-]+)"/)[1];
  assert.equal(f.submissions(), 0);
  assert.equal((await f.callbackPost(receipt, 'owner-a')).body.completed, true);
  const status = await f.request('GET');
  assert.equal(status.body.status, 'authenticated');
  assert.equal(status.body.identity.principalId, principal.principalId);
  assert.equal(JSON.stringify(status.body).includes(authority.secret), false);
  assert.equal((await f.callbackPost(receipt, 'owner-a')).body.completed, true);
  assert.equal(f.submissions(), 1);
  f.manager.expireOwner('owner-a');
});

test('wrong web owner and caller origin/nonce cannot complete another pending request', async () => {
  const f = fixture();
  const invalid = await f.request('POST', 'owner-a', { username: 'alice', clientRequestId: clientId, origin: 'https://forged.test', nonce: 'caller-nonce' });
  assert.equal(invalid.code, 400); assert.equal(f.brokers.length, 0);
  await f.request('POST', 'owner-a', { username: 'alice', clientRequestId: clientId });
  assert.equal((await f.request('GET', 'owner-b')).code, 404);
  const receipt = (await f.callbackGet()).text.match(/receipt:"([A-Za-z0-9_-]+)"/)[1];
  assert.equal((await f.callbackPost(receipt, 'owner-b')).code, 403);
  assert.equal(f.submissions(), 0);
  assert.equal(f.contexts.identity('owner-a', 'org'), null);
  await f.request('DELETE');
});

test('retry reconciles original challenge and early cancel cannot create or stop a newer login', async () => {
  const f = fixture();
  await f.request('DELETE');
  assert.equal((await f.request('POST', 'owner-a', { username: 'alice', clientRequestId: clientId })).code, 400);
  assert.equal(f.brokers.length, 0);
  const newer = '21234567-89ab-4cde-8fab-0123456789ab';
  await f.request('POST', 'owner-a', { username: 'alice', clientRequestId: newer }, newer);
  await f.request('POST', 'owner-a', { username: 'alice', clientRequestId: newer }, newer);
  assert.equal(f.brokers.length, 1);
  f.contexts.invalidate('owner-a', 'org');
  f.contexts.publish('owner-a', 'org', { ...principal, username: 'bob' }, { password: 'synthetic-new-login-password' });
  await f.request('DELETE', 'owner-a', undefined, newer);
  assert.equal(f.contexts.identity('owner-a', 'org').username, 'bob');
});

test('expired owner or changed target cannot publish a verified callback', async () => {
  const f = fixture();
  await f.request('POST', 'owner-a', { username: 'alice', clientRequestId: clientId });
  const receipt = (await f.callbackGet()).text.match(/receipt:"([A-Za-z0-9_-]+)"/)[1];
  f.target.revision++;
  assert.equal((await f.callbackPost(receipt, 'owner-a')).code, 403);
  assert.equal(f.submissions(), 0);
  f.manager.expireOwner('owner-a');
});
