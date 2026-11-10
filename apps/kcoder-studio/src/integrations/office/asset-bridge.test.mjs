import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
import { createOfficeAssetBridge } from './asset-bridge.mjs';

const scope = { accountId: 'a', targetId: 't', workspaceId: 'w', identityGeneration: 'g', targetRevision: 'r' };
async function* bytes(value) { yield Buffer.from(value); }

function setup() {
  const records = new Map();
  const calls = [];
  const context = { scope, nativeConnectionId: 'native-1', nativeClient: {
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'attachment/upload/start') return { upload_id: 'upload-owned' };
      if (method === 'attachment/upload/finish') return { path: '/native-owned/staged/material.txt' };
      return {};
    }
  } };
  const receipts = {
    async beginInput(record) {
      if (records.has(record.inputId)) return { existing: true, record: records.get(record.inputId) };
      records.set(record.inputId, { ...record, status: 'pending' });
      return { existing: false };
    },
    async readInput({ inputId }) { return records.get(inputId); },
    async completeInput(record) { records.set(record.inputId, { ...record, owner: { ...record.owner, organizationId: null } }); },
    async failInput(record) {
      if (records.get(record.inputId)?.status !== 'accepted') records.set(record.inputId, record);
    }
  };
  let decision = 'allow';
  const bridge = createOfficeAssetBridge({
    getHostContext: async () => context,
    evaluateAction: async () => ({ status: 'completed', result: { decision, policyRevision: '1' } }),
    receipts
  });
  return { bridge, context, calls, records, deny() { decision = 'deny'; } };
}

test('protocol-only: private stream uses captured native RPC shapes and returns an opaque receipt', async () => {
  const env = setup();
  const request = { scope, operationId: 'input-1', filename: '材料.txt', mediaType: 'text/plain', expectedBytes: 3, expectedSha256: hash('abc'), byteStream: bytes('abc') };
  const result = await env.bridge.channel.prepareChannelInput(request);
  assert.equal(result.status, 'accepted');
  assert.equal(result.bytes, 3);
  assert.equal('path' in result, false);
  assert.deepEqual(env.calls.map(call => call.method), ['attachment/upload/start', 'attachment/upload/chunk', 'attachment/upload/finish']);
  const resolved = await env.bridge.runtime.resolveInput(scope, { kind: 'office_input', inputId: result.inputId, revision: 1 });
  assert.equal(resolved.path, '/native-owned/staged/material.txt');
  const duplicate = await env.bridge.channel.prepareChannelInput({ ...request, byteStream: bytes('abc') });
  assert.deepEqual(duplicate, result);
  assert.equal(env.calls.length, 3);
});

test('metadata cannot inject a native path and unknown policy is not authorization', async () => {
  const env = setup();
  await assert.rejects(env.bridge.channel.prepareChannelInput({
    scope, operationId: 'input-1', filename: '../other', mediaType: 'text/plain', expectedBytes: 3, expectedSha256: hash('abc'), byteStream: bytes('abc')
  }), { code: 'OFFICE_INVALID_INPUT' });
  env.deny();
  await assert.rejects(env.bridge.channel.prepareChannelInput({
    scope, operationId: 'input-1', filename: 'a.txt', mediaType: 'text/plain', expectedBytes: 3, expectedSha256: hash('abc'), byteStream: bytes('abc')
  }), { code: 'OFFICE_ACCESS_DENIED' });
  assert.equal(env.calls.length, 0);
});

test('native connection replacement blocks consumption of a stale staged path', async () => {
  const env = setup();
  const result = await env.bridge.channel.prepareChannelInput({
    scope, operationId: 'input-1', filename: 'a.txt', mediaType: 'text/plain', expectedBytes: 3, expectedSha256: hash('abc'), byteStream: bytes('abc')
  });
  env.context.nativeConnectionId = 'native-2';
  await assert.rejects(env.bridge.runtime.resolveInput(scope, result), { code: 'OFFICE_INPUT_REQUIRES_RECOVERY' });
});

test('size mismatch cancels only the captured native upload and keeps a reconciliation record', async () => {
  const env = setup();
  await assert.rejects(env.bridge.channel.prepareChannelInput({
    scope, operationId: 'input-1', filename: 'a.txt', mediaType: 'text/plain', expectedBytes: 2, expectedSha256: hash('abc'), byteStream: bytes('abc')
  }), { code: 'OFFICE_INPUT_SIZE_MISMATCH' });
  assert.equal(env.calls.at(-1).method, 'attachment/upload/cancel');
  assert.equal(env.calls.at(-1).params.upload_id, 'upload-owned');
  assert.equal([...env.records.values()][0].status, 'unknown');
});


test('same operation and byte length cannot silently accept changed content', async () => {
  const env=setup();
  const request={scope,operationId:'input-1',filename:'a.txt',mediaType:'text/plain',expectedBytes:3,expectedSha256:hash('abc'),byteStream:bytes('abc')};
  await env.bridge.channel.prepareChannelInput(request);
  await assert.rejects(env.bridge.channel.prepareChannelInput({...request,expectedSha256:hash('xyz'),byteStream:bytes('xyz')}),{code:'OFFICE_OPERATION_CONFLICT'});
  assert.equal(env.calls.filter(call=>call.method==='attachment/upload/start').length,1);
});
test('hash mismatch is cancelled before native finish', async () => {
  const env=setup();
  await assert.rejects(env.bridge.channel.prepareChannelInput({scope,operationId:'input-1',filename:'a.txt',mediaType:'text/plain',expectedBytes:3,expectedSha256:hash('xyz'),byteStream:bytes('abc')}),{code:'OFFICE_INPUT_HASH_MISMATCH'});
  assert.equal(env.calls.some(call=>call.method==='attachment/upload/finish'),false);
  assert.equal(env.calls.at(-1).method,'attachment/upload/cancel');
});
