import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { requireExecutable, runIntegration, waitFor } from '../../e2e/harness/run-context.mjs';
import { startPeerSshTargets } from '../../e2e/harness/peer-ssh-targets.mjs';

process.umask(0o077);
await runIntegration(import.meta.url, { testId: 'actual-http-local-ssh-cross-target-peers', tier: 'full-integration',
  modelPolicy: 'Actual HTTP browser-cookie login, local and loopback SSH Native targets, separate profiles/workspaces and deterministic Provider. No synthetic subjects, distinct-UID, external-TLS, GUI, autonomous-model or Windows claim.' }, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'fixed peer Native');
  const sha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  assert.equal(sha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  const fixture = await startPeerSshTargets(context, binary);
  const a = await fixture.seed('peer-local'), b = await fixture.seed('peer-ssh');
  const source = fixture.clients.get('peer-local'), receiver = fixture.clients.get('peer-ssh');
  async function discover(client, sourceId, destinationId) {
    const targets = [];
    let cursor;
    for (let page = 0; page < 32; page++) {
      const result = await client.request('thread/agentMessage/targets', { sourceThreadId: sourceId,
        ...(cursor ? { cursor } : {}) });
      targets.push(...result.targets); cursor = result.nextCursor;
      if (!cursor) break;
    }
    assert.equal(cursor, undefined);
    const target = targets.find(row => row.address?.threadId === destinationId);
    assert.ok(target?.allowedModes.includes('enqueue_only'), 'Actual peer on other transport must be discoverable');
    return target;
  }
  async function send(client, from, target, clientMessageId, text) {
    const message = { targetThreadId: target.threadId, targetAddress: target.address,
      clientMessageId, mode: 'enqueue_only', text };
    const receipt = await client.request('thread/agentMessage/send', { sourceThreadId: from, message });
    let final;
    await waitFor(async () => {
      final = await client.request('thread/agentMessage/get', { sourceThreadId: from, query: { clientMessageId } });
      return final.receipt?.status === 'applied';
    }, 30_000, 'original cross-transport Native history receipt');
    assert.equal(final.receipt.messageId, receipt.messageId);
    const duplicate = await client.request('thread/agentMessage/send', { sourceThreadId: from, message });
    assert.equal(duplicate.messageId, receipt.messageId);
    await assert.rejects(client.request('thread/agentMessage/send', { sourceThreadId: from,
      message: { ...message, text: text + '_CHANGED' } }));
    return final.receipt;
  }
  const targetB = await discover(source, a.id, b.id);
  const first = await send(source, a.id, targetB, 'owned-local-to-ssh', 'OWNED_LOCAL_TO_SSH_PEER');
  assert.notEqual(first.sourceAddress.targetId, first.targetAddress.targetId);
  assert.notEqual(first.sourceAddress.workspaceId, first.targetAddress.workspaceId);
  const targetA = await discover(receiver, b.id, a.id);
  assert.deepEqual(targetA.address, first.sourceAddress);
  const back = await send(receiver, b.id, targetA, 'owned-ssh-to-local', 'OWNED_SSH_TO_LOCAL_PEER');
  for (const [client, id, text] of [[receiver, b.id, 'OWNED_LOCAL_TO_SSH_PEER'], [source, a.id, 'OWNED_SSH_TO_LOCAL_PEER']]) {
    const history = await client.request('thread/read', { threadId: id, limit: 100 });
    assert.equal(history.messages.filter(row => row.role === 'peer_agent' && row.content === text).length, 1);
    assert.equal(history.messages.filter(row => row.role === 'user').length, 1);
  }
  assert.equal(fixture.model.requests.length, 2, 'Enqueue-only messages do not add Provider/user turns');
  await context.writeArtifactJson('peer-local-ssh-assertions.json', { binarySha256: sha256,
    actualHttpLogin: true, actualSshTransport: true, independentNativeProfiles: true,
    distinctCanonicalTargets: true, distinctWorkspaces: true, source: first.sourceAddress,
    destination: first.targetAddress, messageIds: [first.messageId, back.messageId], originalReceiptsApplied: 2,
    nativePeerRows: 2, fakeUserPrompts: 0, providerRequests: fixture.model.requests.length,
    syntheticClientSubjects: false, distinctOsAccountsProven: false, externalTlsProven: false });
  return { actualLocalSshCrossTargetBidirectional: true, providerBehaviorProven: false };
});
