import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { runIntegration, requireExecutable } from '../../e2e/harness/run-context.mjs';
import { unregisteredColdTaskFixture } from '../../e2e/harness/task-workspace-lookup.mjs';

process.umask(0o077);
await runIntegration(import.meta.url, { testId: 'native-unregistered-workspace-after-all-original-processes-exit',
  tier: 'full-integration', modelPolicy: 'Actual isolated Native lifetimes and durable thread metadata. No scenario, model request, personal profile or browser cache.' }, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'fixed cold-workspace Native');
  assert.match(process.env.KCODER_E2E_KCODER_BIN_SHA256 ?? '', /^[a-f0-9]{64}$/);
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(binary)) hash.update(bytes);
  const binarySha256 = hash.digest('hex');
  assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  const fixture = await unregisteredColdTaskFixture(context, binary);
  const response = await fixture.cold.wire.request('thread/workspace/lookup', { threadId: fixture.threadId, limit: 64 });
  await context.writeArtifactJson('cold-workspace-lookup-observation.json', {
    supported: !response.error, errorCode: response.error?.code ?? null, originalNativeExited: true,
    matchingOriginal: response.result?.candidates?.some(row => row.workspacePath === fixture.original) === true,
    lookup: response.result ?? null,
  });
  assert.ok(!response.error, 'the current account must locate the old unregistered Native workspace after its original process exits');
  assert.equal(fixture.cold.initialized.capabilities.experimental.threadWorkspaceLookupV1, true);
  assert.deepEqual(response.result.candidates, [{ workspacePath: fixture.original }]);
  assert.equal(response.result.completeness, 'complete');
  assert.equal(response.result.issueCount, 0);
  const bound = await fixture.open(response.result.candidates[0].workspacePath);
  const listed = await bound.request('thread/list', { limit: 100, allowPartial: true });
  assert.equal(listed.completeness, 'complete');
  assert.equal(listed.issueCount, 0);
  assert.deepEqual(listed.threads.filter(row => row.id === fixture.threadId).map(row => row.cwd), [fixture.original]);
  const resumed = await bound.request('thread/resume', { threadId: fixture.threadId });
  assert.equal(resumed.thread.id, fixture.threadId);
  const history = await bound.request('thread/read', { threadId: fixture.threadId });
  assert.equal(history.thread.id, fixture.threadId);
  assert.equal(history.messages.filter(row => row.role === 'user').length, 0);
  const originalHistoryBefore = await fixture.originalHistoryWitness();
  assert.equal(bound.child.exitCode, null);
  assert.equal(bound.child.signalCode, null);
  const contender = await fixture.open(fixture.original);
  assert.equal(contender.initialized.capabilities.experimental.threadOwnershipErrorsV1, true);
  const owned = await contender.wire.request('thread/resume', { threadId: fixture.threadId });
  assert.equal(owned.error?.code, -32022);
  assert.deepEqual(owned.error.data, { version: 1, reason: 'ownedElsewhere', threadId: fixture.threadId });
  const missing = await contender.wire.request('thread/resume', { threadId: 'missing_owned_history' });
  assert.equal(missing.error?.code, -32022);
  assert.equal(missing.error.data, undefined, 'a missing history error cannot become an ownership observation');
  const invalid = await contender.wire.request('thread/resume', { threadId: '../outside' });
  assert.ok(invalid.error);
  assert.equal(invalid.error.data, undefined, 'an invalid selector is never an ownership observation');
  assert.equal(bound.child.exitCode, null);
  assert.equal(bound.child.signalCode, null);
  assert.deepEqual(await fixture.originalHistoryWitness(), originalHistoryBefore);
  await context.writeArtifactJson('actual-session-owned-elsewhere.json', {
    originalOwnerPid: bound.child.pid, contenderPid: contender.child.pid,
    originalThreadId: fixture.threadId, negotiated: true, code: owned.error.code, data: owned.error.data,
    invalidSelectorHasNoOwnershipData: true, missingHistoryCode: missing.error.code, missingHistoryHasNoOwnershipData: true, originalHistoryUnchanged: originalHistoryBefore, originalOwnerStillLive: true, noNewUser: true, providerRequests: fixture.providerRequests,
  });
  await contender.stop();
  await bound.stop();
  await fixture.cold.stop();
  await fixture.disableHistory();
  const disabled = await fixture.open(fixture.fallback);
  assert.equal(disabled.initialized.capabilities.experimental.threadWorkspaceLookupV1, false);
  const denied = await disabled.wire.request('thread/workspace/lookup', { threadId: fixture.threadId });
  assert.equal(denied.error?.code, -32057);
  assert.equal(denied.result, undefined);
  await disabled.stop();
  await context.writeArtifactJson('management-provider-http.json', { requests: fixture.providerRequests, methods: fixture.providerHttp });
  assert.equal(fixture.providerRequests, fixture.providerHttp.length, 'every HTTP request must be recorded');
  assert.ok(fixture.providerRequests <= 3, 'no additional warmup requests are admitted');
  for (const request of fixture.providerHttp) {
    assert.equal(request.method, 'HEAD');
    assert.equal(request.path, '/v1/chat/completions');
    assert.match(request.phase, /^cold-workspace-native-\d+:(initialize|thread\/start|thread\/resume)$/);
  }
  const modelRequests = fixture.providerHttp.filter(row => row.method === 'POST').length;
  assert.equal(modelRequests, 0);
  return { binarySha256, nativeLifetimes: fixture.nativeLifetimes, originalProcessExited: true, persistentWorkspaceRecovered: true,
    actualUniqueThreadList: true, originalThreadResumeAndRead: true, actualTwoProcessOwnershipData: true, historyDisabledCannotLocate: true, modelRequests, providerHttpRequests: fixture.providerRequests, providerWarmups: fixture.providerHttp };

});
