import assert from 'node:assert/strict';
import { requireExecutable, runIntegration, waitFor } from '../../e2e/harness/run-context.mjs';
import { peerNativeFixture } from '../../e2e/harness/peer-native-runtime.mjs';

process.umask(0o077);
const partialDiscoveryOnly = process.env.KCODER_E2E_PEER_DISCOVERY_PARTIAL_ONLY === '1';
await runIntegration(import.meta.url, { testId: partialDiscoveryOnly ? 'peer-session-native-partial-discovery' : 'peer-session-native-two-targets', tier: 'full-integration',
  modelPolicy: partialDiscoveryOnly ? 'Actual three Native profiles and production Gateway directory routing. One destination explicitly disables communications; authorized healthy rows remain visible as partial. No model turn, HTTP-login, SSH or GUI claim.' : 'Actual two Native app-servers and Gateway routing with controlled authenticated socket subjects and deterministic provider. No HTTP-login, SSH, GUI or real-model claim.' }, async context => {
  if (process.platform !== 'linux') throw new Error('This owned Native image acceptance requires Linux');
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'peer candidate');
  const fixture = await peerNativeFixture(context, binary);
  return fixture.withRouteDiagnostics(async () => {
  if (partialDiscoveryOnly) {
    const source = await fixture.clientFor('a'), disabled = await fixture.clientFor('b');
    const healthy = await fixture.clientFor('c');
    fixture.session.allowedServerIds.add('c');
    const start = async client => {
      const { thread } = await client.request('thread/start', {});
      await client.request('gateway/thread/attach', { threadId: thread.id, viewId: `partial-${thread.id}` });
      return thread;
    };
    const a = await start(source), b = await start(disabled), c = await start(healthy);
    const policy = await disabled.request('thread/agentMessage/policy/read', { sourceThreadId: b.id });
    await disabled.request('thread/agentMessage/policy/save', { sourceThreadId: b.id,
      expectedRevision: policy.revision, enabled: false, wakeIdle: false });
    const rows = [], pages = [];
    let cursor;
    for (let index = 0; index < 16; index++) {
      const page = await source.request('thread/agentMessage/targets', { sourceThreadId: a.id, ...(cursor ? { cursor } : {}) });
      pages.push({ completeness: page.completeness, issues: page.issueCount ?? 0 });
      rows.push(...page.targets); cursor = page.nextCursor;
      if (!cursor) break;
    }
    assert.equal(cursor, undefined);
    assert.ok(rows.some(row => row.threadId === c.id), 'healthy destination remains discoverable');
    assert.ok(!rows.some(row => row.threadId === b.id), 'disabled destination publishes no session rows');
    assert.equal(pages.at(-1).completeness, 'partial');
    assert.equal(pages.at(-1).issues, 1);
    for (const [client, thread] of [[source, a], [disabled, b], [healthy, c]]) {
      const history = await client.request('thread/read', { threadId: thread.id, limit: 10 });
      assert.equal(history.messages.length, 0, 'directory reads never start a turn or append history');
    }
    fixture.revokeSession();
    await assert.rejects(source.request('thread/agentMessage/targets', { sourceThreadId: a.id }));
    await context.writeArtifactJson('peer-native-partial-discovery.json', {
      actualNativeProcesses: 3, productionGatewayRouter: true, syntheticAuthenticatedSocketSubjects: true,
      disabledPeerExcluded: true, healthyPeerVisible: true, originalSourceRevokedRejected: true,
      pages, modelTurns: 0, historyRows: 0, actualSsh: false, actualUi: false,
    });
    return { partialDiscoveryPreservesHealthyTargets: true, providerBehaviorProven: false };
  }
  const source = await fixture.clientFor('a'), destination = await fixture.clientFor('b');
  const a = await fixture.seed(source, 'a'), b = await fixture.seed(destination, 'b');
  const targets = [];
  let cursor;
  for (let page = 0; page < 16; page++) {
    const result = await source.request('thread/agentMessage/targets', { sourceThreadId: a.id,
      ...(cursor ? { cursor } : {}) });
    targets.push(...result.targets);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  assert.equal(cursor, undefined, 'the owned target set was completely paged');
  const target = targets.find(target => target.threadId === b.id && target.address?.threadId === b.id);
  assert.ok(target?.address, 'actual Native destination is discovered without caller-supplied IDs');
  assert.ok(target.allowedModes.includes('enqueue_only'));
  await destination.request('thread/metadata/update', { threadId: b.id, title: 'Windows 安装包联验' });
  const requested = { sourceThreadId: a.id, title: '安装包', query: 'WINDOWS', targetId: target.address.targetId, allowedMode: 'enqueue_only', limit: 32 };
  const matching = await source.request('thread/agentMessage/targets', requested);
  assert.deepEqual(matching.targets.map(row => row.threadId), [b.id]);
  assert.equal(matching.targets[0].title, 'Windows 安装包联验');
  assert.equal(matching.nextCursor ?? null, null, 'the target-scoped search is complete');
  const none = await source.request('thread/agentMessage/targets', { ...requested, title: '不同的验收标题' });
  assert.deepEqual(none.targets, []);
  assert.equal(none.nextCursor ?? null, null);
  await context.writeArtifactJson('peer-title-search.json', {
    visibleTargetMatched: true, missingTitleReturnedNoRows: true, mode: requested.allowedMode, requestedLimit: requested.limit,
  });
  const text = 'OWNED_NATIVE_CROSS_TARGET_PEER';
  fixture.holdSourceChecks();
  const receipt = await source.request('thread/agentMessage/send', { sourceThreadId: a.id,
    message: { targetThreadId: target.threadId, targetAddress: target.address,
      clientMessageId: 'owned-native-message', mode: 'enqueue_only', text } });
  assert.equal(receipt.status, 'queued');
  await waitFor(() => fixture.checksSeen() > 0, 15_000, 'actual destination requests original Source authorization');
  const sourceAddress = receipt.sourceAddress;
  assert.notEqual(sourceAddress.targetId, receipt.targetAddress.targetId, 'distinct actual Native profiles');
  source.close();
  fixture.releaseSourceChecks();
  const reader = await fixture.clientFor('a');
  await reader.request('thread/resume', { threadId: a.id });
  let final;
  await waitFor(async () => {
    final = await reader.request('thread/agentMessage/get', { sourceThreadId: a.id,
      query: { clientMessageId: 'owned-native-message' } });
    return final.receipt?.status === 'applied';
  }, 30_000, 'native history witness after original viewer closes');
  assert.equal(final.receipt.messageId, receipt.messageId);
  const history = await destination.request('thread/read', { threadId: b.id, limit: 100 });
  const peers = history.messages.filter(message => message.role === 'peer_agent' && message.content === text);
  assert.equal(peers.length, 1);
  assert.equal(peers[0].origin, 'peer_agent');
  assert.equal(history.messages.filter(message => message.role === 'user').length, 1,
    'enqueue-only never fabricates another user prompt');
  const duplicate = await reader.request('thread/agentMessage/send', { sourceThreadId: a.id,
    message: { targetThreadId: b.id, targetAddress: target.address,
      clientMessageId: 'owned-native-message', mode: 'enqueue_only', text } });
  assert.equal(duplicate.messageId, receipt.messageId);
  await assert.rejects(reader.request('thread/agentMessage/send', { sourceThreadId: a.id,
    message: { targetThreadId: b.id, targetAddress: target.address,
      clientMessageId: 'owned-native-message', mode: 'enqueue_only', text: `${text}_CHANGED` } }));
  fixture.session.allowedServerIds.delete('b');
  await assert.rejects(reader.request('thread/agentMessage/send', { sourceThreadId: a.id,
    message: { targetThreadId: b.id, targetAddress: target.address,
      clientMessageId: 'owned-revoked-message', mode: 'enqueue_only', text } }));
  await context.writeArtifactJson('peer-native-assertions.json', { actualNativeProcesses: 2,
    actualGatewayRouter: true, syntheticAuthenticatedSocketSubjects: true, deterministicProvider: true,
    originalViewerClosed: true, peerRows: peers.length, fakeUserPrompts: 0,
    stableMessageId: receipt.messageId, sourceAddress, destination: target.address,
    checks: fixture.checksSeen(), finalStatus: final.receipt.status });
  return { crossTargetNativeHistoryApplied: true, providerBehaviorProven: false };
  });
});
