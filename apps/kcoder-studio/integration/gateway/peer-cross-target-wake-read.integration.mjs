import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import { startPeerSshTargets } from '../../e2e/harness/peer-ssh-targets.mjs';
import { requireExecutable, runIntegration, waitFor } from '../../e2e/harness/run-context.mjs';

process.umask(0o077);
const seedAnswer = 'OWNED_WAKE_ORIGINAL_ANSWER';
const unrelatedAnswer = 'OWNED_WAKE_UNRELATED_ANSWER';
const trigger = 'OWNED_REMOTE_WAKE_READ_TRIGGER';
const done = 'OWNED_REMOTE_WAKE_READ_COMPLETE';
const finish = content => [{ delta: { content }, finishReason: 'stop' }];
const tool = (id, name, args, ready) => [{
  ready, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
    function: { name, arguments: JSON.stringify(args) } }] }, finishReason: 'tool_calls',
}];

await runIntegration(import.meta.url, {
  testId: 'original-recipient-background-read-across-local-and-ssh',
  tier: 'full-integration',
  modelPolicy: 'Actual Native local and loopback SSH targets, HTTP login and real model-selected tool entry points with a deterministic SSE fixture. Independent profiles on one Linux account.',
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'Native peer wake reads');
  const sha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  assert.equal(sha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  const legacySide = process.env.KCODER_E2E_WAKE_READ_LEGACY_SIDE;
  let legacyBinary, legacySha256;
  if (legacySide) {
    assert.ok(['sender', 'receiver'].includes(legacySide));
    legacyBinary = await requireExecutable(process.env.KCODER_E2E_WAKE_READ_LEGACY_BIN, 'an earlier Native without agentMessageWakeReadV1');
    legacySha256 = createHash('sha256').update(await readFile(legacyBinary)).digest('hex');
    assert.equal(legacySha256, process.env.KCODER_E2E_WAKE_READ_LEGACY_BIN_SHA256);
    assert.notEqual(legacySha256, sha256, 'the two versions must be different executables');
  }
  const observed = new Map();
  let access = 'same_project', sender, receiving, sibling, unrelated, receiverClosed = false;
  const describe = output => {
    const parse = value => { try { return JSON.parse(value); } catch { return null; } };
    return { foundOriginal: output.includes(seedAnswer), foundUnrelated: output.includes(unrelatedAnswer),
      code: output.match(/(?:session_read|session_discovery|peer_message)_[a-z_]+/)?.[0],
      parsed: parse(output) };
  };
  function response({ body }) {
    const messages = body.messages;
    const text = JSON.stringify(messages);
    if (!text.includes(trigger)) {
      if (text.includes('OWNED_TRANSPORT_SEED_peer-local')) return finish(seedAnswer);
      if (text.includes('OWNED_UNRELATED_SOURCE')) return finish(unrelatedAnswer);
      return finish('OWNED_LOCAL_SEED');
    }
    assert.ok(receiverClosed && text.includes('OWNED_TRANSPORT_SEED_peer-ssh'), 'only the original receiver may run the trigger');
    for (const row of messages.filter(row => row.role === 'tool' && row.tool_call_id?.startsWith('wread-'))) {
      observed.set(row.tool_call_id.substring(6), describe(String(row.content)));
    }
    const read = (id, address, ready) => tool('wread-' + id, 'ReadSession', { threadId: address.threadId, targetAddress: address }, ready);
    if (!observed.has('default')) return read('default', sender);
    if (!observed.has('allowed')) return read('allowed', sender, () => access === 'same_account');
    if (!observed.has('unrelated')) return read('unrelated', unrelated);
    if (!observed.has('get')) return tool('wread-get', 'GetSessionMessageReceipt', { clientMessageId: 'wake-out-original' });
    if (!observed.has('receipts')) return tool('wread-receipts', 'ListSessionMessageReceipts', { limit: 20 });
    let cursor;
    for (let page = 0; page < 12; page++) {
      const key = 'targets-' + page;
      if (!observed.has(key)) return tool('wread-' + key, 'ListSessions', { limit: 1, ...(cursor && { cursor }) });
      cursor = observed.get(key).parsed?.nextCursor;
      if (!cursor) break;
    }
    if (!observed.has('revoked')) return read('revoked', sender, () => access === 'none');
    return finish(done);
  }
  const fixture = await startPeerSshTargets(context, binary, {
    wakeIdleTargets: ['peer-ssh'], modelOptions: { responseSteps: response },
    ...(legacySide === 'sender' ? { localBinary: legacyBinary } : legacySide === 'receiver' ? { sshBinary: legacyBinary } : {}),
  });
  const a = fixture.clients.get('peer-local'), b = fixture.clients.get('peer-ssh');
  const aThread = await fixture.seed('peer-local'), bThread = await fixture.seed('peer-ssh');
  async function seedAdditional(client, label) {
    const { thread } = await client.request('thread/start', {});
    const clientMessageId = 'own-' + label;
    await client.request('turn/start', { threadId: thread.id, clientMessageId, input: [{ type: 'text', text: label }] });
    await waitFor(async () => (await client.request('turn/receipt/read', { threadId: thread.id, clientMessageId })).receipt?.status === 'completed',
      20000, 'new independent seed turn');
    return thread;
  }
  const other = await seedAdditional(a, 'OWNED_UNRELATED_SOURCE');
  const localSibling = await seedAdditional(b, 'OWNED_RECEIVER_SIBLING');
  const secondLocal = await seedAdditional(b, 'OWNED_RECEIVER_SECOND_SIBLING');
  async function find(client, from, id) {
    let cursor;
    for (let page = 0; page < 16; page++) {
      const result = await client.request('thread/agentMessage/targets', { sourceThreadId: from, ...(cursor && { cursor }) });
      const hit = result.targets.find(row => row.threadId === id);
      if (hit?.address) return hit.address;
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    throw new Error('Expected owned target missing from the original signed-in view');
  }
  sender = await find(b, bThread.id, aThread.id);
  sibling = await find(b, bThread.id, localSibling.id);
  unrelated = await find(b, bThread.id, other.id);
  receiving = await find(a, aThread.id, bThread.id);
  assert.notEqual(sender.targetId, receiving.targetId);
  const send = (client, from, to, clientMessageId, mode, text) => client.request('thread/agentMessage/send',
    { sourceThreadId: from, message: { targetAddress: to, targetThreadId: to.threadId, clientMessageId, mode, text } });
  const receipts = {};
  for (const [id, to] of [['wake-out-original', sender], ['wake-out-local', sibling], ['wake-out-third', unrelated]]) {
    const sent = await send(b, bThread.id, to, id, 'enqueue_only', 'Owned outgoing observation ' + id);
    const readBack = await b.request('thread/agentMessage/get', { sourceThreadId: bThread.id, query: { clientMessageId: id } });
    assert.equal(readBack.receipt?.messageId, sent.messageId, 'the outgoing observation is attributable to its original ID');
    assert.ok(['queued', 'delivering', 'applied'].includes(readBack.receipt.status));
    receipts[id] = sent.messageId;
  }
  const changeAccess = async value => {
    const endpoint = fixture.endpoints.get('peer-local');
    const settings = JSON.parse(await readFile(endpoint.settings, 'utf8'));
    settings.cross_session_messages.read_access = value;
    const change = await context.writeStateJson('peer-local-profile/wake-policy-update.tmp', settings);
    await rename(change, endpoint.settings);
    access = value;
  };
  await b.close();
  receiverClosed = true;
  try {
    await send(a, aThread.id, receiving, 'original-wake-read', 'wake_if_idle', trigger);
    await waitFor(() => observed.has('default'), 40000, 'ownerless wake reads with default target policy');
    await changeAccess('same_account');
    await waitFor(() => [...observed.keys()].some(key => key.startsWith('targets-') && !observed.get(key).parsed?.nextCursor), 60000, 'original read and local plus scoped remote pages');
    await changeAccess('none');
    await waitFor(() => observed.has('revoked'), 30000, 'fresh recheck after target revocation');
    const remoteReadSupported = legacySide !== 'receiver';
    for (const id of ['default', 'allowed', 'unrelated', 'revoked']) {
      assert.equal(observed.get(id).foundUnrelated, false);
      assert.equal(observed.get(id).foundOriginal, remoteReadSupported && id === 'allowed');
      if (!remoteReadSupported) assert.match(observed.get(id).code, /session_read_(unavailable|unsupported_target)/);
    }
    if (remoteReadSupported) {
      assert.equal(observed.get('default').code, 'session_read_other_project');
      for (const id of ['unrelated', 'revoked']) assert.equal(observed.get(id).code, 'session_read_not_permitted');
    }
    const get = observed.get('get').parsed;
    if (remoteReadSupported) assert.equal((get?.receipt ?? get)?.messageId, receipts['wake-out-original']);
    else assert.match(observed.get('get').code, /peer_message_original_receipt_unconfirmed/);
    const page = observed.get('receipts').parsed;
    const row = id => page?.items?.find(item => item.clientMessageId === id);
    for (const id of remoteReadSupported ? ['wake-out-original', 'wake-out-local'] : ['wake-out-local']) {
      assert.equal(row(id)?.confirmation, 'confirmed', id);
      assert.equal(row(id)?.receipt?.messageId, receipts[id]);
    }
    if (!remoteReadSupported) assert.equal(row('wake-out-original')?.confirmation, 'unconfirmed');
    assert.equal(row('wake-out-third')?.confirmation, 'unconfirmed');
    assert.ok(page.unconfirmedCount >= 1);
    const pages = [...observed].filter(([key]) => key.startsWith('targets-')).map(([, value]) => value.parsed);
    assert.ok(pages.every(value => value?.targets.length <= 1 && value.completeness === 'partial'));
    const ids = pages.flatMap(value => value.targets.map(target => target.threadId));
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes(sibling.threadId) && ids.includes(secondLocal.id));
    assert.equal(ids.includes(sender.threadId), !legacySide);
    assert.ok(!ids.includes(unrelated.threadId) && !ids.includes(receiving.threadId));
    assert.ok(!pages.at(-1).nextCursor && fixture.model.requests.length <= 22);
    return { actualSsh: true, legacySide: legacySide ?? null, viewerClosed: true, localPagesPreserved: true,
      originalDiscovered: ids.includes(sender.threadId), pageCount: pages.length, originalReceiptConfirmed: remoteReadSupported,
      unrelatedReceiptUnconfirmed: true, defaultDidNotExposeHistory: true, revokedDidNotExposeHistory: true };
  } finally {
    await context.writeArtifactJson('wake-read-facts.json', {
      binarySha256: sha256, legacySide: legacySide ?? null, legacySha256: legacySha256 ?? null,
      receiverClosed, providerRequests: fixture.model.requests.length,
      observations: Object.fromEntries([...observed].map(([key, { foundOriginal, foundUnrelated, code, parsed }]) =>
        [key, { foundOriginal, foundUnrelated, code, rows: parsed?.targets?.length ?? parsed?.items?.length, cursor: Boolean(parsed?.nextCursor) }])),
    });
  }
});
