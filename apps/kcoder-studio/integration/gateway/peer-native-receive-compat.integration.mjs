import assert from 'node:assert/strict';
import { requireExecutable, runIntegration, waitFor } from '../../e2e/harness/run-context.mjs';
import { peerNativeFixture } from '../../e2e/harness/peer-native-runtime.mjs';

process.umask(0o077);
await runIntegration(import.meta.url, {
  testId: 'native-peer-history-receive-agreement', tier: 'full-integration',
  modelPolicy: 'Actual Native history produced by two Native targets and the production Gateway router, then direct legacy/modern Native stdio readers. Controlled authenticated socket subjects and deterministic provider; no HTTP-login, GUI, SSH or real-model claim.',
}, async context => {
  if (process.platform !== 'linux') throw new Error('This owned Native image acceptance requires Linux');
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'peer candidate');
  const fixture = await peerNativeFixture(context, binary);
  return fixture.withRouteDiagnostics(async () => {
    const source = await fixture.clientFor('a'), targetClient = await fixture.clientFor('b');
    const a = await fixture.seed(source, 'a'), b = await fixture.seed(targetClient, 'b');
    const targets = [];
    let cursor;
    for (let index = 0; index < 16; index++) {
      const page = await source.request('thread/agentMessage/targets', { sourceThreadId: a.id,
        ...(cursor ? { cursor } : {}) });
      targets.push(...page.targets); cursor = page.nextCursor;
      if (!cursor) break;
    }
    assert.equal(cursor, undefined);
    const target = targets.find(row => row.address?.threadId === b.id);
    assert.ok(target?.allowedModes.includes('enqueue_only'));
    const receipt = await source.request('thread/agentMessage/send', { sourceThreadId: a.id,
      message: { targetThreadId: b.id, targetAddress: target.address,
        clientMessageId: 'native-receive-compat', mode: 'enqueue_only', text: 'OWNED_NATIVE_PEER_COMPAT' } });
    await waitFor(async () => {
      const result = await source.request('thread/agentMessage/get', { sourceThreadId: a.id,
        query: { clientMessageId: 'native-receive-compat' } });
      return result.receipt?.status === 'applied' && result.receipt.messageId === receipt.messageId;
    }, 30_000, 'actual peer history commit before changing presentation clients');
    const original = await targetClient.request('thread/read', { threadId: b.id, limit: 100 });
    assert.equal(original.messages.filter(row => row.role === 'peer_agent').length, 1);
    await fixture.stopEndpoint('b');
    const reports = [];
    for (const support of [false, true]) {
      const raw = await fixture.rawReaderFor('b', support);
      const resume = await raw.reader.request('thread/resume', { threadId: b.id,
        history: { limit: 100, indexed: false } });
      assert.equal(resume.error, undefined);
      assert.equal(resume.result.history.status, 'ready');
      const pages = [resume.result.history.page];
      for (const method of ['thread/read', 'thread/read/indexed']) {
        const result = await raw.reader.request(method, { threadId: b.id, limit: 100 });
        assert.equal(result.error, undefined);
        pages.push(result.result);
      }
      for (const page of pages) {
        assert.equal(page.messages.filter(row => row.role === 'peer_agent').length, support ? 1 : 0);
        assert.equal(page.messages.filter(row => row.role === 'user').length, 1);
        assert.ok(page.messages.some(row => row.role === 'assistant'));
        if (!support) {
          assert.equal(page.transcriptSnapshotV1, undefined);
          assert.equal(page.transcriptObservationV1, undefined);
        }
      }
      assert.equal(raw.reader.notificationHistory.some(frame => frame.method === 'turn/started'), false);
      reports.push({ peerSupport: support, peerRows: pages.map(page => page.messages.filter(row => row.role === 'peer_agent').length),
        noNewTurn: true, directNativeWire: true });
      await raw.stop();
    }
    await context.writeArtifactJson('native-peer-receive-assertions.json', { originalMessageId: receipt.messageId,
      nativeHistoryPeerRows: 1, source: receipt.sourceAddress, destination: receipt.targetAddress, readers: reports });
    return { nativeReceiveAgreement: true, providerBehaviorProven: false };
  });
});
