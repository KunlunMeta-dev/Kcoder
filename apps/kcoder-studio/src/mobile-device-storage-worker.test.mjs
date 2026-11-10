import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createWindowsStorageGuardClient } from './mobile-device-storage-worker.js';

function fixture(t) {
  const child = new EventEmitter(), writes = [];
  let killed = 0, referenced = false;
  child.stdin = new Writable({ write(chunk, _encoding, callback) { writes.push(JSON.parse(chunk.toString())); callback(); } });
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { killed++; queueMicrotask(() => child.emit('exit', 1)); };
  child.ref = () => { referenced = true; }; child.unref = () => { referenced = false; };
  const client = createWindowsStorageGuardClient(child);
  t.after(() => client.close());
  return { child, client, writes, killed: () => killed, referenced: () => referenced,
    reply: value => child.stdout.write(Buffer.from(JSON.stringify(value) + '\n')) };
}
const identity = 'A'.repeat(8) + ':' + 'B'.repeat(16);
const reason = expected => error => error.code === 'MOBILE_DEVICE_STORAGE_UNAVAILABLE' && error.reason === expected;

test('one guard reruns every request, preserves private errors, and unrefs only while idle', async t => {
  const f = fixture(t); assert.equal(f.referenced(), false);
  const first = f.client.check('owned-path', true); assert.equal(f.referenced(), true);
  f.reply({id:f.writes[0].id, identity}); assert.equal(await first, `windows-volume-file:${identity}`);
  assert.equal(f.referenced(), false);
  const second = f.client.check('owned-path', false);
  f.reply({id:f.writes[1].id, error:'acl_not_private'});
  await assert.rejects(second, reason('acl_not_private'));
  assert.equal(f.writes.length, 2); assert.equal(f.killed(), 0);
});
test('unknown or lost guard receipts retire the owner without replaying initialize', async t => {
  const f = fixture(t), first = f.client.check('owned-path', true);
  const rejected = assert.rejects(first, reason('invalid_identity'));
  f.reply({id:f.writes[0].id + 1, identity}); await rejected;
  await assert.rejects(f.client.check('owned-path', true), reason('execution_failed'));
  assert.equal(f.writes.length, 1); assert.equal(f.killed(), 1);
});
test('a busy store has a definite rejection and does not replay the request', async t => {
  const f = fixture(t);
  const request = f.client.check('owned-path', false);
  f.reply({ id: f.writes[0].id, error: 'store_busy' });
  await assert.rejects(request, reason('store_busy'));
  assert.equal(f.writes.length, 1);
  assert.equal(f.killed(), 0);
  const next = f.client.check('owned-path', false);
  f.reply({ id: f.writes[1].id, identity });
  assert.equal(await next, `windows-volume-file:${identity}`);
});
test('guard request timeout is bounded and never retries a possibly executed initialization', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f = fixture(t), request = f.client.check('owned-path', true);
  const rejected = assert.rejects(request, reason('timeout'));
  t.mock.timers.tick(10_000); await rejected;
  assert.equal(f.writes.length, 1); assert.equal(f.killed(), 1);
});
test('strict JSONL guards reject extra fields, malformed JSON, and output overflow', async t => {
  for (const invalid of [JSON.stringify({id:1,identity,trusted:true})+'\n', '{broken}\n', '{"id":1,"id":1,"identity":"'+identity+'"}\n', 'x'.repeat(8193)]) {
    const f = fixture(t), request = f.client.check('owned-path', false);
    const rejected = assert.rejects(request, error => ['invalid_identity','output_limit'].includes(error.reason));
    f.child.stdout.write(Buffer.from(invalid)); await rejected; assert.equal(f.killed(), 1);
  }
});
test('guard EOF or explicit owner close rejects pending work and cannot leave a restartable client', async t => {
  for (const close of [f=>f.child.stdout.end(), f=>f.client.close()]) {
    const f = fixture(t), request = f.client.check('owned-path', true);
    const rejected = assert.rejects(request, reason('execution_failed')); close(f); await rejected;
    await assert.rejects(f.client.check('owned-path', false), reason('execution_failed'));
    assert.equal(f.killed(), 1); assert.equal(f.writes.length, 1);
  }
});
