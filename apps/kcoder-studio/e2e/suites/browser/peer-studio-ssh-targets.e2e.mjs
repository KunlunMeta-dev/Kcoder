import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { requireExecutable, runE2E } from '../../harness/run-context.mjs';
import { startPeerSshTargets } from '../../harness/peer-ssh-targets.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { openOwnedPeerStudioPage } from '../../harness/peer-studio-browser.mjs';
import { observePeerStudioPage, sendPeerStudioUi, assertPeerStudioSourceNavigation } from '../../harness/peer-studio-ui.mjs';

process.umask(0o077);
await runE2E(import.meta.url, { testId: 'actual-react-http-local-ssh-cross-target-peers', tier: 'full-integration',
  modelPolicy: 'Two actual React Chromium pages with separate HTTP logins, local/loopback SSH Native targets and separate profiles/workspaces. Deterministic seed Provider only; no autonomous model, distinct-UID, external HTTP runtime/TLS, Windows or Electron claim.' }, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'fixed SSH peer Native');
  const sha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  assert.equal(sha256, process.env.KCODER_E2E_KCODER_BIN_SHA256); await assertRendererBuildFresh();
  const fixture = await startPeerSshTargets(context, binary);
  const source = await fixture.seed('peer-local'), target = await fixture.seed('peer-ssh');
  for (const client of fixture.clients.values()) await client.close();
  const { page: a } = await openOwnedPeerStudioPage(context, fixture.gateway, { label: 'peer-local-react' });
  const { page: b } = await openOwnedPeerStudioPage(context, fixture.gateway, { label: 'peer-ssh-react' });
  const aWire = observePeerStudioPage(a), bWire = observePeerStudioPage(b);
  const taskUrl = (alias, threadId) => `${fixture.gateway.baseUrl}/runtime-tasks?${new URLSearchParams({ deviceId: alias,
    taskId: `kcoder:${alias}:${threadId}` })}`;
  const sourceUrl = taskUrl('peer-local', source.id), targetUrl = taskUrl('peer-ssh', target.id);
  const toRemote = 'OWNED_REACT_LOCAL_TO_SSH <b>literal peer</b>';
  const toLocal = 'OWNED_REACT_SSH_TO_LOCAL <img src=x>';
  try {
    await a.goto(sourceUrl, { waitUntil: 'domcontentloaded' });
    await b.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await a.getByTestId('message-user').filter({ hasText: 'OWNED_TRANSPORT_SEED_peer-local' }).waitFor({ timeout: 30_000 });
    await b.getByTestId('message-user').filter({ hasText: 'OWNED_TRANSPORT_SEED_peer-ssh' }).waitFor({ timeout: 30_000 });
    const first = await sendPeerStudioUi(a, aWire, { targetTitle: new RegExp(`OWNED_TRANSPORT_SEED_peer-ssh|${target.id}`), text: toRemote });
    assert.equal(first.settled.receipt.sourceAddress.threadId, source.id);
    assert.equal(first.settled.receipt.targetAddress.threadId, target.id);
    assert.notEqual(first.settled.receipt.sourceAddress.targetId, first.settled.receipt.targetAddress.targetId);
    const received = b.getByTestId('peer-agent-message').filter({ hasText: toRemote });
    await received.waitFor({ timeout: 30_000 }); assert.equal(await received.locator('b').count(), 0);
    assert.equal(await b.getByTestId('message-user').filter({ hasText: toRemote }).count(), 0);
    await b.screenshot({ path: context.pathInArtifacts('ssh-target-peer-plain-text.png'), fullPage: true });
    await assertPeerStudioSourceNavigation(b, bWire, received, { sourceAddress: first.settled.receipt.sourceAddress,
      sourceMarker: 'OWNED_TRANSPORT_SEED_peer-local', serverId: 'peer-local' });
    await b.screenshot({ path: context.pathInArtifacts('ssh-to-local-original-source-navigation.png'), fullPage: true });
    await b.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await b.getByTestId('message-user').filter({ hasText: 'OWNED_TRANSPORT_SEED_peer-ssh' }).waitFor({ timeout: 30_000 });
    const back = await sendPeerStudioUi(b, bWire, { targetTitle: new RegExp(`OWNED_TRANSPORT_SEED_peer-local|${source.id}`), text: toLocal,
      expectedAddress: first.settled.receipt.sourceAddress });
    const returned = a.getByTestId('peer-agent-message').filter({ hasText: toLocal });
    await returned.waitFor({ timeout: 30_000 }); assert.equal(await returned.locator('img').count(), 0);
    await assertPeerStudioSourceNavigation(a, aWire, returned, { sourceAddress: back.settled.receipt.sourceAddress,
      sourceMarker: 'OWNED_TRANSPORT_SEED_peer-ssh', serverId: 'peer-ssh' });
    assert.equal(fixture.model.requests.length, 2, 'UI messages and cross-target navigation cannot add Provider turns');
    await context.writeArtifactJson('peer-studio-ssh-assertions.json', { binarySha256: sha256,
      actualReactChromium: true, actualHttpLogin: true, actualSshRuntimeTarget: true,
      source: first.settled.receipt.sourceAddress, destination: first.settled.receipt.targetAddress,
      messageIds: [first.settled.receipt.messageId, back.settled.receipt.messageId], originalReceiptsApplied: 2,
      bidirectionalSourceNavigation: true, navigationCreatesTurn: false, peerMarkupMounted: false,
      fakeUserPrompts: 0, providerRequests: fixture.model.requests.length, syntheticClientSubjects: false,
      distinctOsAccountsProven: false, externalHttpRuntimeProven: false });
    return { actualReactCrossSshTargetBidirectional: true, originalReceiptsApplied: 2 };
  } finally {
    await context.writeArtifactJson('peer-local-react-wire.json', aWire);
    await context.writeArtifactJson('peer-ssh-react-wire.json', bWire);
    await a.screenshot({ path: context.pathInArtifacts('peer-local-final.png'), fullPage: true }).catch(() => {});
    await b.screenshot({ path: context.pathInArtifacts('peer-ssh-final.png'), fullPage: true }).catch(() => {});
  }
});
