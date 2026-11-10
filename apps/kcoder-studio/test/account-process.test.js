import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { authenticatedAccountProcess } from '../src/account-process.js';

function processFixture() {
  const child = new EventEmitter();
  const writes = [];
  child.stdin = new Writable({ write(chunk, _encoding, done) { writes.push(Buffer.from(chunk)); done(); } });
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = 123;
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', 1, null)); };
  return { child, writes };
}

test('authentication uses stdin and only subsequent runtime frames reach the broker', async t => {
  const { child, writes } = processFixture();
  let identity;
  const proxy = authenticatedAccountProcess(child, { username: 'alice', password: 'private-fixture-password', workspace: '/private/work' }, {
    onAuthenticated: value => { identity = value; },
  });
  t.after(() => child.kill());
  let output = '';
  proxy.stdout.on('data', value => { output += value; });
  const authentication = JSON.parse(Buffer.concat(writes).toString());
  assert.equal(authentication.password, 'private-fixture-password');
  assert.equal(authentication.workspace, '/private/work');
  const hello = { protocol: 'kcoder-account-v1', authenticated: true, username: 'alice',
    principalId: 'ab87c7c1-34bd-4fb0-a309-11f086d08d09', uid: 2001, role: 'user' };
  const wire = JSON.stringify(hello) + '\n' + '{"jsonrpc":"2.0","id":1,"result":{}}\n';
  child.stdout.write(wire.slice(0, 12)); child.stdout.write(wire.slice(12));
  assert.equal(identity.principalId, hello.principalId);
  assert.equal(output, '{"jsonrpc":"2.0","id":1,"result":{}}\n');
  assert.equal(output.includes('private-fixture-password'), false);
});

test('a root identity, wrong user or malformed preamble cannot enter the broker', async () => {
  for (const bad of [null, { authenticated: false }, { protocol: 'kcoder-account-v1', authenticated: true,
    username: 'alice', principalId: 'ab87c7c1-34bd-4fb0-a309-11f086d08d09', uid: 0, role: 'admin' }]) {
    const { child } = processFixture();
    const proxy = authenticatedAccountProcess(child, { username: 'alice', password: 'private-fixture-password' });
    let failed = false;
    proxy.on('error', () => { failed = true; });
    let output = '';
    proxy.stdout.on('data', value => { output += value; });
    child.stdout.write(JSON.stringify(bad) + '\n');
    assert.equal(failed, true);
    assert.equal(child.killed, true);
    assert.equal(output, '');
  }
});

test('workspace startup failures do not revoke valid account credentials', () => {
  for (const [errorCode, expected] of [['runtime_start_failed', false], ['authentication_failed', true]]) {
    const { child } = processFixture();
    let rejected;
    const proxy = authenticatedAccountProcess(child, { username: 'alice', password: 'private-fixture-password' }, {
      onFailure: value => { rejected = value.authenticationRejected; },
    });
    proxy.on('error', () => {});
    child.stdout.write(JSON.stringify({ protocol: 'kcoder-account-v1', authenticated: false, errorCode }) + '\n');
    assert.equal(rejected, expected);
  }
});

test('a synchronous identity veto rejects the same-chunk runtime frames before anything reaches the broker', () => {
  const { child } = processFixture();
  let failures = 0;
  const proxy = authenticatedAccountProcess(child, { username: 'alice', password: 'private-fixture-password' }, {
    onAuthenticated: () => false,
    onFailure: value => { assert.equal(value.authenticationRejected, false); failures++; },
  });
  let output = '', errors = 0;
  proxy.on('error', () => { errors++; }); proxy.stdout.on('data', bytes => { output += bytes; });
  const hello = { protocol: 'kcoder-account-v1', authenticated: true, username: 'alice',
    principalId: 'ab87c7c1-34bd-4fb0-a309-11f086d08d09', uid: 2001, role: 'user' };
  child.stdout.write(JSON.stringify(hello) + '\n' + '{"jsonrpc":"2.0","id":1,"result":{"mustNotLeak":true}}\n');
  child.stdout.write('{"jsonrpc":"2.0","id":2,"result":{"alsoHidden":true}}\n');
  assert.equal(output, ''); assert.equal(child.killed, true);
  assert.equal(failures, 1); assert.equal(errors, 1);
});

test('legacy undefined and explicit true identity callbacks still forward an accepted same-chunk response', () => {
  for (const accepted of [undefined, true]) {
    const { child } = processFixture();
    const proxy = authenticatedAccountProcess(child, { username: 'alice', password: 'private-fixture-password' }, {
      onAuthenticated: () => accepted,
    });
    let output = ''; proxy.stdout.on('data', bytes => { output += bytes; });
    const hello = { protocol: 'kcoder-account-v1', authenticated: true, username: 'alice',
      principalId: 'ab87c7c1-34bd-4fb0-a309-11f086d08d09', uid: 2001, role: 'user' };
    const runtime = '{"jsonrpc":"2.0","id":3,"result":{}}\n';
    child.stdout.write(JSON.stringify(hello) + '\n' + runtime);
    assert.equal(output, runtime); assert.notEqual(child.killed, true); child.kill();
  }
});

test('an identity callback exception fails closed without escaping or forwarding its private error', () => {
  const { child } = processFixture();
  const proxy = authenticatedAccountProcess(child, { username: 'alice', password: 'private-fixture-password' }, {
    onAuthenticated: () => { throw new Error('PRIVATE_CALLBACK_CONTEXT'); },
  });
  let output = '', error;
  proxy.on('error', value => { error = value; }); proxy.stdout.on('data', bytes => { output += bytes; });
  const hello = { protocol: 'kcoder-account-v1', authenticated: true, username: 'alice',
    principalId: 'ab87c7c1-34bd-4fb0-a309-11f086d08d09', uid: 2001, role: 'user' };
  assert.doesNotThrow(() => child.stdout.write(JSON.stringify(hello) + '\n' + '{"jsonrpc":"2.0","id":4,"result":{}}\n'));
  assert.equal(output, ''); assert.equal(child.killed, true);
  assert.ok(error instanceof Error && !error.message.includes('PRIVATE_CALLBACK_CONTEXT'));
});
