import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { authenticatedAccountProcess } from '../src/account-process.js';

const requestId = 'synthetic-original-request-id';
const pending = { protocol: 'kcoder-account-v1', authenticated: false, authenticationPending: true,
  authentication: 'oidc', requestId, authorizationUrl: 'https://issuer.test/authorize?state=original',
  redirectUri: 'https://gateway.test/oidc/callback', expiresIn: 180 };
const identity = { protocol: 'kcoder-account-v1', authenticated: true, username: 'alice',
  principalId: '01234567-89ab-4cde-8fab-0123456789ab', role: 'user', uid: 22001 };
const callback = { requestId, authorizationResponse: 'https://gateway.test/oidc/callback?code=synthetic&state=original' };

function fixture() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.frames = [];
  child.stdin = new Writable({ write(chunk, _encoding, done) { child.frames.push(chunk.toString()); done(); } });
  child.kill = () => { child.killed = true; };
  child.respond = response => child.stdout.write(JSON.stringify(response) + '\n');
  child.confirmed = () => ({ ...identity, privateOidcResume: { handle: '1'.repeat(64), secret: '2'.repeat(64),
    clientBinding: JSON.parse(child.frames[0]).clientBinding } });
  return child;
}

test('OIDC proxy keeps original callback and queues runtime bytes until verified identity', async () => {
  const child = fixture(), challenges = [], principals = [];
  const proxy = authenticatedAccountProcess(child, { username: 'alice', authentication: 'oidc' }, {
    onAuthorizationRequired: value => challenges.push(value), onAuthenticated: value => principals.push(value),
  });
  proxy.on('error', error => assert.fail(error.message));
  let output = '';
  proxy.stdout.on('data', chunk => { output += chunk; });
  proxy.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  assert.equal(child.frames.length, 1);
  assert.equal(JSON.parse(child.frames[0]).authentication, 'oidc');
  assert.equal(Object.hasOwn(JSON.parse(child.frames[0]), 'password'), false);
  child.respond(pending);
  assert.equal(challenges.length, 1);
  assert.equal(principals.length, 0);
  assert.equal(child.frames.length, 1);
  proxy.submitOidcCallback(callback);
  assert.equal(JSON.parse(child.frames[1]).protocol, 'kcoder-account-oidc-code-v1');
  child.stdout.write(JSON.stringify(child.confirmed()) + '\n{"jsonrpc":"2.0","id":1,"result":{}}\n');
  assert.equal(principals[0].principalId, identity.principalId);
  assert.equal(child.frames.length, 3);
  assert.equal(JSON.parse(child.frames[2]).method, 'initialize');
  assert.equal(output, '{"jsonrpc":"2.0","id":1,"result":{}}\n');
  child.emit('close', 0);
});

test('OIDC callback cannot substitute a request or submit twice', () => {
  const child = fixture();
  const proxy = authenticatedAccountProcess(child, { username: 'alice', authentication: 'oidc' });
  proxy.on('error', () => {});
  child.respond(pending);
  assert.throws(() => proxy.submitOidcCallback({ ...callback, requestId: 'another-request' }));
  assert.equal(child.frames.length, 1);
  proxy.submitOidcCallback(callback);
  assert.throws(() => proxy.submitOidcCallback(callback));
  assert.equal(child.frames.length, 2);
  child.emit('close', 0);
});

test('stale OIDC identity veto cannot flush queued runtime requests', async () => {
  const child = fixture();
  const proxy = authenticatedAccountProcess(child, { username: 'alice', authentication: 'oidc' }, { onAuthenticated: () => false });
  const rejected = once(proxy, 'error');
  proxy.stdin.write('{"jsonrpc":"2.0","id":2,"method":"turn/start"}\n');
  child.respond(pending); proxy.submitOidcCallback(callback); child.respond(child.confirmed());
  await rejected;
  assert.equal(child.killed, true);
  assert.equal(child.frames.length, 2);
  child.emit('close', 1);
});

test('pending OIDC runtime buffering is bounded and requires a fixed HTTPS challenge', async () => {
  const child = fixture();
  const proxy = authenticatedAccountProcess(child, { username: 'alice', authentication: 'oidc' });
  const rejected = once(proxy, 'error');
  proxy.stdin.write(Buffer.alloc(65537));
  await rejected;
  assert.equal(child.killed, true);
  assert.equal(child.frames.length, 1);
  child.emit('close', 1);
  const nextChild = fixture();
  const next = authenticatedAccountProcess(nextChild, { username: 'alice', authentication: 'oidc' });
  const badUrl = once(next, 'error');
  nextChild.respond({ ...pending, authorizationUrl: 'http://untrusted.test/auth' });
  await badUrl;
  assert.equal(nextChild.killed, true);
  nextChild.emit('close', 1);
});
