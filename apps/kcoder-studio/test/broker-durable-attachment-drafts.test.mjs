import test from 'node:test';
import assert from 'node:assert/strict';
import { durableDraftReady, handleDurableDraftRequest, retainDurableDraft, unclaimedDurableDraft } from '../src/broker-durable-attachment-drafts.js';

function fixture() {
  const client = { initialized: true, authorizationOwner: 'device-a' };
  const calls = [];
  const broker = {
    clients: new Set([client]), closed: false,
    initializeResponse: { result: { capabilities: { experimental: { durableAttachmentDraftsV1: true } } } },
    draftAttachmentAuthority: () => ['gateway-a', 'target-a', 'principal-a', 'user'],
    resourceOwners: new Map(), retainedAttachmentBindings: new Map(), materializedAttachments: new Set(),
    persistentResources: new Set(), durableDraftPaths: new Set(),
    sendInternalRequest(method, params, { onResponse }) {
      calls.push({ method, params });
      onResponse({ result: { drafts: params.paths.map(sourcePath => ({ sourcePath, path: '/private/draft.txt' })) } });
    },
  };
  const request = { id: 1, method: 'gateway/attachments/retain', params: { durable: true, threadId: 'thread-a', paths: ['/upload/a.txt'] } };
  return { broker, client, request, calls };
}

test('unconfirmed draft paths remain private with Unix or Windows separators', () => {
  const { broker, client } = fixture();
  for (const path of [`/session/draft-attachments/d-${'a'.repeat(64)}/content/file.txt`,
    `C:\\session\\draft-attachments\\d-${'a'.repeat(64)}\\content\\file.txt`,
    `/session/draft-attachments/d-${'a'.repeat(64)}/content/back\\slash.txt`]) {
    assert.equal(unclaimedDurableDraft(broker, path), true);
    broker.resourceOwners.set(`attachment\0${path}`, client);
    assert.equal(unclaimedDurableDraft(broker, path), false);
  }
  assert.equal(unclaimedDurableDraft(broker, '/session/attachments/turn/file.txt'), false);
});

test('empty Gateway state recovers only from Native proof under the same stable authority', async () => {
  const f = fixture();
  const first = await retainDurableDraft(f.broker, f.client, f.request);
  assert.equal(f.calls[0].params.recoverOnly, true);
  assert.equal(f.broker.resourceOwners.get('attachment\0/private/draft.txt'), f.client);
  const restarted = fixture();
  assert.deepEqual(await retainDurableDraft(restarted.broker, restarted.client, restarted.request), first);
  assert.equal(restarted.calls[0].params.ownerScope, f.calls[0].params.ownerScope);
  restarted.client.authorizationOwner = 'another-device';
  restarted.request.params.paths = ['/another/path'];
  restarted.broker.sendInternalRequest = (method, params, { onResponse }) => {
    restarted.calls.push({ method, params });
    onResponse({ error: { code: -32048, message: 'another authority' } });
  };
  await assert.rejects(retainDurableDraft(restarted.broker, restarted.client, restarted.request));
  assert.notEqual(restarted.calls[1].params.ownerScope, f.calls[0].params.ownerScope);
});

test('concurrent cold reclaims cannot replace an active peer after the Native reply', async () => {
  const f = fixture();
  const peer = { ...f.client };
  f.broker.clients.add(peer);
  const replies = [];
  f.broker.sendInternalRequest = (_method, _params, { onResponse }) => replies.push(onResponse);
  const one = retainDurableDraft(f.broker, f.client, f.request);
  const two = retainDurableDraft(f.broker, peer, f.request);
  const result = { result: { drafts: [{ sourcePath: '/upload/a.txt', path: '/private/draft.txt' }] } };
  replies[0](result); await one;
  replies[1](result); await assert.rejects(two, /ownership changed/);
  assert.equal(f.broker.resourceOwners.get('attachment\0/private/draft.txt'), f.client);
});

test('only a genuinely owned upload may be sealed initially; active peers and consumed paths fail', async () => {
  const f = fixture();
  const key = 'attachment\0/upload/a.txt';
  f.broker.resourceOwners.set(key, f.client);
  await retainDurableDraft(f.broker, f.client, f.request);
  assert.equal(f.calls[0].params.recoverOnly, false);
  f.broker.resourceOwners.set(key, {});
  await assert.rejects(retainDurableDraft(f.broker, f.client, f.request), /another owner/);
  f.broker.resourceOwners.set(key, f.client);
  f.broker.materializedAttachments.add(key);
  await assert.rejects(retainDurableDraft(f.broker, f.client, f.request), /materialized/);
  assert.equal(f.calls.length, 1);
});

test('auth or target replacement while retaining never grants the new caller ownership', async () => {
  for (const change of [f => { f.client.authorizationOwner = 'device-b'; },
    f => { f.broker.draftAttachmentAuthority = () => ['different-target']; }]) {
    const f = fixture();
    let complete;
    f.broker.sendInternalRequest = (_method, _params, { onResponse }) => { complete = onResponse; };
    const promise = retainDurableDraft(f.broker, f.client, f.request);
    change(f);
    complete({ result: { drafts: [{ sourcePath: '/upload/a.txt', path: '/private/draft.txt' }] } });
    await assert.rejects(promise, /owner changed/);
    assert.equal(f.broker.resourceOwners.size, 0);
    assert.equal(f.broker.persistentResources.has('attachment\0/private/draft.txt'), true);
  }
});

test('unsupported backend, forged parent scope and invalid Native receipts fail closed', async () => {
  const f = fixture();
  f.broker.initializeResponse.result.capabilities.experimental.durableAttachmentDraftsV1 = false;
  assert.equal(durableDraftReady(f.broker), false);
  await assert.rejects(retainDurableDraft(f.broker, f.client, f.request), /updated/);
  f.broker.initializeResponse.result.capabilities.experimental.durableAttachmentDraftsV1 = true;
  f.request.params.ownerScope = 'forged';
  await assert.rejects(retainDurableDraft(f.broker, f.client, f.request), /Invalid/);
  delete f.request.params.ownerScope;
  f.broker.sendInternalRequest = (_method, _params, { onResponse }) => onResponse({ result: { drafts: [] } });
  await assert.rejects(retainDurableDraft(f.broker, f.client, f.request), /receipt/);
  assert.equal(f.broker.resourceOwners.size, 0);
});

test('public RPC cannot access trusted parent draft methods, including notifications', () => {
  const f = fixture();
  const sent = [];
  f.client.send = value => sent.push(value);
  assert.equal(handleDurableDraftRequest(f.broker, f.client, { method: 'attachment/draft/retain', id: 9 }), true);
  assert.equal(sent[0].error.code, -32601);
  assert.equal(handleDurableDraftRequest(f.broker, f.client, { method: 'attachment/draft/retain' }), true);
  assert.equal(sent.length, 1);
  assert.equal(f.calls.length, 0);
});
