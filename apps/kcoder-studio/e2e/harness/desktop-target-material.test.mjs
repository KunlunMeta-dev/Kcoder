import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyFormalDesktopMaterialTransfer } from './desktop-target-material.mjs';

test('failed material transfer cancels only its original pending upload before owner teardown', async () => {
  const cleanups = [], methods = [];
  const remote = { async request(method, params) {
    methods.push({ method, params });
    if (method === 'attachment/upload/start') return { upload_id: 'original-owned-upload' };
    if (method === 'attachment/upload/chunk') throw new Error('actual transport lost before completion');
    if (method === 'attachment/upload/cancel') return { cancelled: true };
    assert.fail('unexpected remote operation');
  } };
  const local = { request() { assert.fail('failed original upload must not touch the peer target'); } };
  await assert.rejects(verifyFormalDesktopMaterialTransfer({ addCleanup: (_label, callback) => cleanups.push(callback) },
    { local, remote, localThreadId: 'local', remoteThreadId: 'remote' }), /transport lost/);
  assert.equal(cleanups.length, 1); await cleanups[0]();
  assert.deepEqual(methods.at(-1), { method: 'attachment/upload/cancel', params: { upload_id: 'original-owned-upload' } });
  assert.equal(methods.filter(value => value.method === 'attachment/upload/start').length, 1);
  await cleanups[0]();
  assert.equal(methods.filter(value => value.method === 'attachment/upload/cancel').length, 1);
});
