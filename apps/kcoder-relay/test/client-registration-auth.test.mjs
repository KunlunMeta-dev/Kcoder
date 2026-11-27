import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { ensureRegisteredClientIdentity } from '../src/client.mjs';
import { prepareClientIdentity, readRegisteredClientIdentity, saveRegisteredClientIdentity } from '../src/client-identity.mjs';
import { assignment, gatewaySecret, registrationKey, ownedRoot } from './fixtures/client-safety-resources.mjs';

const url = 'https://owned-registration.example.test';
const accountSessionToken = 'owned-session-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const accountLoginToken = 'owned-login-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const activationCode = 'owned-activation-code-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const accountCredentials = { username: 'owned-user', password: 'owned-password-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ' };
const basic = Buffer.from(`${accountCredentials.username}:${accountCredentials.password}`).toString('base64');
const response = (secret = assignment.secret) => new Response(JSON.stringify({ ...assignment, secret, gatewaySecret,
  maxConnections: 128, maxBytesPerWindow: 67108864, trafficWindowMs: 60000 }), { status: 201 });

test('conflicting account proofs fail before any registration request and preserve their pending identity', async t => {
  const f = await ownedRoot(t);
  const conflicts = [
    { accountCredentials, accountSessionToken },
    { accountCredentials, accountLoginToken },
    { accountSessionToken, accountLoginToken },
  ];
  for (const [index, credentials] of conflicts.entries()) {
    const identityFile = join(f.root, `conflict-${index}.json`);
    const pending = await prepareClientIdentity({ identityFile, relayUrl: url, gatewaySecret });
    let requests = 0;
    await assert.rejects(ensureRegisteredClientIdentity({ url, identityFile, gatewaySecret, registrationKey, ...credentials,
      fetchImpl: async () => { requests++; return response(); } }), /Exactly one Relay account credential/);
    assert.equal(requests, 0);
    assert.deepEqual(await prepareClientIdentity({ identityFile, relayUrl: url, gatewaySecret }), pending);
  }
});

test('each enrollment mode binds its endpoint and authorization to the same credential', async t => {
  const f = await ownedRoot(t);
  const modes = [
    [{ accountCredentials }, '/_relay/account/register', `Basic ${basic}`],
    [{ accountSessionToken }, '/_relay/account/enroll', `Bearer ${accountSessionToken}`],
    [{ accountLoginToken }, '/_relay/account/register', `Bearer ${accountLoginToken}`],
    [{ activationCode }, '/_relay/activate-device', `Bearer ${activationCode}`],
    [{ registrationKey }, '/_relay/register', `Bearer ${registrationKey}`],
  ];
  for (const [index, [credentials, pathname, authorization]] of modes.entries()) {
    const identityFile = join(f.root, `mode-${index}.json`);
    let requests = 0;
    const registered = await ensureRegisteredClientIdentity({ url, identityFile, gatewaySecret, ...credentials,
      fetchImpl: async (endpoint, init) => {
        requests++;
        assert.equal(endpoint.origin, url);
        assert.equal(endpoint.pathname, pathname);
        assert.equal(init.headers.authorization, authorization);
        assert.equal(init.redirect, 'error');
        return response();
      } });
    assert.equal(requests, 1);
    assert.deepEqual(registered, assignment);
    assert.deepEqual(await readRegisteredClientIdentity({ identityFile, relayUrl: url, gatewaySecret }), assignment);
  }
});

test('unused legacy credentials keep their existing fallback priority without being sent', async t => {
  const f = await ownedRoot(t);
  const modes = [
    [{ accountLoginToken, activationCode, registrationKey }, ['/_relay/account/register', `Bearer ${accountLoginToken}`]],
    [{ activationCode, registrationKey }, ['/_relay/activate-device', `Bearer ${activationCode}`]],
    [{ accountCredentials, activationCode, registrationKey }, ['/_relay/account/register', `Basic ${basic}`]],
  ];
  for (const [index, [credentials, expected]] of modes.entries()) {
    await ensureRegisteredClientIdentity({ url, gatewaySecret, identityFile: join(f.root, `fallback-${index}.json`), ...credentials,
      fetchImpl: async (endpoint, init) => {
        assert.deepEqual([endpoint.pathname, init.headers.authorization], expected);
        assert.equal(JSON.stringify(init).includes(registrationKey), false);
        return response();
      } });
  }
});

test('a registration response cannot reuse the presented account password or Basic proof as its control secret', async t => {
  const f = await ownedRoot(t);
  for (const [index, secret] of [accountCredentials.password, basic].entries()) {
    assert.match(secret, /^[A-Za-z0-9._~-]{32,512}$/, 'the response must pass the independent secret format check');
    const identityFile = join(f.root, `echo-${index}.json`);
    const pending = await prepareClientIdentity({ identityFile, relayUrl: url, gatewaySecret });
    await assert.rejects(ensureRegisteredClientIdentity({ url, gatewaySecret, identityFile, accountCredentials,
      fetchImpl: async () => response(secret) }), /invalid registered Gateway credentials/);
    assert.deepEqual(await prepareClientIdentity({ identityFile, relayUrl: url, gatewaySecret }), pending);
  }
});

test('an explicitly invalid selected proof never falls through to a legacy registration key', async t => {
  const f = await ownedRoot(t);
  let requests = 0, index = 0;
  for (const field of ['accountSessionToken', 'accountLoginToken', 'activationCode', 'accountCredentials']) {
    for (const invalid of ['', false, 0, [], {}]) {
      await assert.rejects(ensureRegisteredClientIdentity({ url, gatewaySecret, registrationKey,
        identityFile: join(f.root, `invalid-${index++}.json`), [field]: invalid,
        fetchImpl: async () => { requests++; return response(); } }));
    }
  }
  assert.equal(requests, 0);
});

test('every Bearer mode rejects a response that reuses its selected authentication proof', async t => {
  const f = await ownedRoot(t);
  for (const [index, [credentials, secret]] of [
    [{ accountSessionToken, registrationKey }, accountSessionToken],
    [{ accountLoginToken, activationCode, registrationKey }, accountLoginToken],
    [{ activationCode, registrationKey }, activationCode],
    [{ registrationKey }, registrationKey],
  ].entries()) {
    await assert.rejects(ensureRegisteredClientIdentity({ url, gatewaySecret,
      identityFile: join(f.root, `bearer-echo-${index}.json`), ...credentials,
      fetchImpl: async () => response(secret) }), /invalid registered Gateway credentials/);
  }
});

test('an authentication refusal never falls back to another credential or changes the enrollment proof', async t => {
  const f = await ownedRoot(t), identityFile = join(f.root, 'refused.json');
  const pending = await prepareClientIdentity({ identityFile, relayUrl: url, gatewaySecret });
  let requests = 0;
  await assert.rejects(ensureRegisteredClientIdentity({ url, gatewaySecret, identityFile, accountSessionToken, registrationKey,
    fetchImpl: async (endpoint, init) => {
      requests++;
      assert.equal(endpoint.pathname, '/_relay/account/enroll');
      assert.equal(init.headers.authorization, `Bearer ${accountSessionToken}`);
      return new Response(null, { status: 401 });
    } }), { status: 401 });
  assert.equal(requests, 1);
  assert.deepEqual(await prepareClientIdentity({ identityFile, relayUrl: url, gatewaySecret }), pending);
});

test('an already registered identity is reused without selecting or sending spare account proofs', async t => {
  const f = await ownedRoot(t), identityFile = join(f.root, 'registered.json');
  const pending = await prepareClientIdentity({ identityFile, relayUrl: url, gatewaySecret });
  await saveRegisteredClientIdentity({ identityFile, relayUrl: url, gatewaySecret, ...pending, ...assignment });
  let requests = 0;
  const registered = await ensureRegisteredClientIdentity({ url, gatewaySecret, identityFile,
    accountCredentials, accountSessionToken, accountLoginToken, activationCode, registrationKey,
    fetchImpl: async () => { requests++; throw new Error('registered identities must not enroll again'); } });
  assert.equal(requests, 0);
  assert.deepEqual(registered, assignment);
  assert.deepEqual(await readRegisteredClientIdentity({ identityFile, relayUrl: url, gatewaySecret }), assignment);
});
