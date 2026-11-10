import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectOwnedRemoteFrame } from './remote-native-disconnect-fault.mjs';

test('disconnect selector uses actual private bind and prompt response identities, never text matches', () => {
  const state = {};
  assert.equal(inspectOwnedRemoteFrame({ jsonrpc: '2.0', id: 1, result: { text: 'session/prompt completed' } }, state), false);
  inspectOwnedRemoteFrame({ jsonrpc: '2.0', id: 'bind', method: 'kcoder/nativeRemote/controlV1', params: {
    operationId: 'original-op', endpointInstanceId: 'held-instance', message: { method: 'bind_original', params: {} },
  } }, state);
  inspectOwnedRemoteFrame({ jsonrpc: '2.0', id: 'prompt-once', method: 'session/prompt', params: {} }, state);
  const accepted = { identity: { threadId: 'actual-thread', turnId: 'actual-turn', attemptId: 'actual-attempt' } };
  inspectOwnedRemoteFrame({ jsonrpc: '2.0', id: 'control', method: 'kcoder/nativeRemote/controlV1', params: {
    message: { method: 'receiver_accepted', params: accepted },
  } }, state);
  assert.deepEqual(state, { operationId: 'original-op', endpointInstanceId: 'held-instance', promptId: 'prompt-once', accepted });
  assert.equal(inspectOwnedRemoteFrame({ jsonrpc: '2.0', id: 'other', result: { stopReason: 'end_turn' } }, state), false);
  assert.equal(inspectOwnedRemoteFrame({ jsonrpc: '2.0', id: 'prompt-once', error: { message: 'failed' } }, state), false);
  assert.equal(inspectOwnedRemoteFrame({ jsonrpc: '2.0', id: 'prompt-once', result: { stopReason: 'end_turn' } }, state), true);
});

test('partial result selector holds only the actual original artifact chunk response and forwards exact byte prefix', async () => {
  const { partialArtifactChunkPrefix } = await import('./remote-native-disconnect-fault.mjs');
  const state = { kind: 'artifact_chunk' };
  inspectOwnedRemoteFrame({ jsonrpc: '2.0', id: 1, method: 'kcoder/nativeRemote/controlV1', params: {
    operationId: 'original-op', endpointInstanceId: 'original-endpoint', message: { method: 'bind_original', params: {} },
  } }, state);
  inspectOwnedRemoteFrame({ jsonrpc: '2.0', id: 7, method: 'session/prompt', params: {} }, state);
  assert.equal(inspectOwnedRemoteFrame({ jsonrpc: '2.0', id: 7, result: { stopReason: 'end_turn' } }, state), false);
  const intent = { manifestSha256: 'a'.repeat(64), offset: 0, artifact: { id: 'original-artifact', revision: 1 } };
  inspectOwnedRemoteFrame({ jsonrpc: '2.0', id: 11, method: 'kcoder/nativeRemote/controlV1', params: {
    message: { method: 'read_artifact_chunk', params: intent },
  } }, state);
  const frame = { jsonrpc: '2.0', id: 11, result: { operationId: 'original-op', endpointInstanceId: 'original-endpoint',
    data: { kind: 'artifact_chunk', manifestSha256: intent.manifestSha256,
      bytesBase64: Buffer.from('PK complete original artifact bytes remain unmodified').toString('base64') } } };
  assert.equal(inspectOwnedRemoteFrame(frame, state), true);
  assert.equal(inspectOwnedRemoteFrame({ ...frame, id: 12 }, state), false);
  const line = Buffer.from(JSON.stringify(frame) + '\n');
  const prefix = partialArtifactChunkPrefix(line);
  assert.ok(prefix.length > 0 && prefix.length < line.length);
  assert.deepEqual(prefix, line.subarray(0, prefix.length));
  assert.throws(() => JSON.parse(prefix.toString('utf8')), 'No complete JSON receipt was forwarded');
});
