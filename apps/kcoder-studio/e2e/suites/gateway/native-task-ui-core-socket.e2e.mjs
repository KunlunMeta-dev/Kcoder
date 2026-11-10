import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { applicationFixture } from '../../harness/application-service.mjs';
import { startNativeCodeGateway, changeNativeCodeExecutionSettings, pollNative, sha256File } from '../../harness/native-code-service.mjs';
import { originalSystemdCarrier, originalUserUnit, registerOriginalCarrierCleanup, registerOriginalTaskTreeCleanup } from '../../harness/native-systemd-carrier.mjs';
import { observeOriginalForegroundChannels } from '../../harness/native-channel-foreground-tree.mjs';
import { collectTaskUiDiagnostics } from '../../harness/native-task-ui-diagnostics.mjs';
import { requireExecutable, runE2E } from '../../harness/run-context.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'ordinary-native-task-only-existing-core-socket', tier: 'full-integration',
  modelPolicy: 'Actual normal Native image, user unit, Core socket and first-party Gateway. No channel SDK is attached. No platform account, input or model calls.',
  processSignalTimeoutMs: 45_000,
}, async context => {
  assert.equal(process.platform, 'linux');
  assert.ok(process.getuid() > 0, 'Requires the actual nonprivileged UID and its existing user manager');
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'matching normal Native image');
  assert.equal(await sha256File(binary), process.env.KCODER_E2E_KCODER_BIN_SHA256);
  const fixture = await applicationFixture(context, binary);
  const runtime = `/run/user/${fixture.uid}`;
  const runtimeInfo = await lstat(runtime);
  assert.ok(runtimeInfo.isDirectory() && !runtimeInfo.isSymbolicLink() && runtimeInfo.uid === fixture.uid);
  fixture.env.XDG_RUNTIME_DIR = runtime;
  fixture.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtime}/bus`;
  const experimental = { connectivityV1: true,
    integrationOperationReceiptsV1: true, taskSourcesV1: true,
    threadRuntimeHandoffV1: true, interactionBindingV1: true, threadCreationReceiptsV1: true };
  const admin = await startNativeCodeGateway(context, fixture, 'task-socket-original-admin', {
    experimental: { ...experimental, taskSourcesV1: false, threadRuntimeHandoffV1: false },
  });
  const marker = 'task-socket-owned-manager';
  registerOriginalCarrierCleanup(context, fixture, marker);
  const creator = await startNativeCodeGateway(context, fixture, 'task-socket-task-creator', { experimental });
  const clientRequestId = `task-socket-original-${context.seed}`;
  const created = await creator.rpc('thread/start', { clientRequestId });
  const threadId = created.thread.id;
  const before = await creator.rpc('thread/read', { threadId });
  assert.equal(before.thread.id, threadId);
  const carrier = await originalSystemdCarrier(fixture);
  const unit = await originalUserUnit(context, fixture, carrier, 'show', 'task-socket-original-unit');
  const initialCore = await observeOriginalForegroundChannels(context, fixture, admin,
    { owner: { pid: Number(unit.MainPID) }, requireScopeFence: true, expectedSdks: 0,
      label: 'task-socket-core-before-channel-pidfds', attachTimeoutMs: 60000 });
  await creator.close();
  assert.deepEqual(await initialCore.read(), initialCore.original,
    'Closing the creating Gateway must preserve the independently hosted original Core');
  const tree = await observeOriginalForegroundChannels(context, fixture, admin,
    // The observer hashes each actual Native image while retaining its pidfd.
    // This setup reads several GiB; bound its cold-I/O budget independently.
    { owner: { pid: Number(unit.MainPID) }, requireScopeFence: true, expectedSdks: 0, attachTimeoutMs: 60000 });
  const originalCore = initialCore.original.keepers.find(process => process.role === 'core');
  assert.ok(originalCore?.alive && originalCore.kernelPidfd);
  assert.equal(tree.original.keepers.find(process => process.role === 'core')?.pid, originalCore.pid,
    'Independent attachment must preserve the same original app-server');
  assert.deepEqual(await initialCore.read(), initialCore.original,
    'The held original Core pidfd must still be live after channel authentication');
  registerOriginalTaskTreeCleanup(context, fixture, carrier, tree, 'task-socket');
  const viewer = await startNativeCodeGateway(context, fixture, 'task-socket-independent-viewer', { experimental });
  assert.equal(viewer.initialized.capabilities.experimental?.toolProfilesV1, true,
    'The authenticated task client must retain the actual host tool-profile capability');
  assert.equal(viewer.initialized.capabilities.experimental?.lunaToolSelectionsV1, true,
    'Switching to original JSONL must preserve the separately verified Luna baseline capability');
  const toolSelections = await viewer.rpc('settings/tools/selection/read', { includeLunaBaseline: true });
  assert.ok(Array.isArray(toolSelections.lunaAllowedTools),
    'The original host must return the opted-in typed Luna baseline');
  const originalReceipt = await viewer.rpc('thread/creation/read', { clientRequestId });
  assert.equal(originalReceipt.receipt.status, 'ready');
  assert.equal(originalReceipt.receipt.threadId, threadId);
  const originalIndex = await viewer.rpc('thread/list', {});
  assert.equal(originalIndex.threads.length, 1, 'Only the explicitly created task belongs in the cold directory');
  assert.equal(originalIndex.threads[0].id, threadId, 'The durable empty task must be listed before it is resumed');
  await context.writeArtifactJson('before-original-task-resume.json', {
    threadId, originalMessages: before.messages.length, originalTree: tree.original,
    channelBound: false, modelCalls: fixture.modelRequests(),
  });
  let resumed;
  try { resumed = await viewer.rpc('thread/resume', { threadId }); }
  catch (error) {
    try { await collectTaskUiDiagnostics(context, fixture, carrier); }
    catch { await context.writeArtifactJson('task-ui-diagnostics-unavailable.json', { unavailable: true, originalFailurePreserved: true }); }
    throw error;
  }
  assert.equal(resumed.thread.id, threadId);
  const again = await viewer.rpc('thread/resume', { threadId });
  assert.equal(again.thread.id, threadId);
  const after = await viewer.rpc('thread/read', { threadId });
  assert.deepEqual(after.messages, before.messages);
  assert.deepEqual(await tree.read(), tree.original, 'Task-only attachment must preserve the actual original Core/Main/SDK');
  const tasks = await viewer.rpc('thread/list', {});
  // A resident snapshot can add live model/run fields; loading the original task
  // must preserve the complete directory membership and its durable metadata.
  assert.deepEqual(tasks.threads.map(task => task.id), originalIndex.threads.map(task => task.id));
  for (const field of ['cwd', 'title', 'metadataRevision', 'archivedAt', 'parent']) {
    assert.deepEqual(tasks.threads[0][field], originalIndex.threads[0][field], field);
  }
  assert.deepEqual(await viewer.rpc('thread/creation/read', { clientRequestId }), originalReceipt);
  const restoreExecutionSettings = await changeNativeCodeExecutionSettings(fixture);
  try {
    const changed = await viewer.rpc('thread/read', { threadId });
    assert.deepEqual(changed.messages, before.messages);
    assert.deepEqual(await initialCore.read(), initialCore.original);
    assert.deepEqual(await tree.read(), tree.original,
      'Knowledge and model settings must preserve the original task Core and attached SDK');
  } finally { await restoreExecutionSettings(); }
  assert.equal(fixture.modelRequests(), 0);
  await context.writeArtifactJson('original-task-core-socket-result.json', {
    normalNativeImage: fixture.imageSha256, originalTask: threadId, realCoreSocket: true,
    noActiveChatBinding: true, sameOriginalProcessTree: true, originalHistoryPreserved: true,
    originalCreationReceiptPreserved: true, originalConversationIndexPreserved: true,
    emptyTaskIsListedAsConversation: tasks.threads.some(task => task.id === threadId),
    tasksCreated: 1, gatewayRestartPreservedOriginalCore: true,
    channelAttachedToOriginalCore: false, taskOnly: true,
    taskCreatedExplicitlyByFixture: true, inputSubmitted: false, modelCalls: 0,
    executionSettingsPreservedOriginalTree: true,
    originalToolProfileCapabilityPreserved: true, lunaBaselineReadFromOriginalHost: true,
    realPlatform: false, boundary: 'Actual ordinary task creation, restore and host recovery; no SDK attachment tested',
  });
  const disconnected = viewer.client.waitFor(message => message.method === 'server/disconnected',
    60_000, 'the original frontend to report actual task-host loss');
  void disconnected.catch(() => {});
  await tree.crashCore();
  await disconnected;
  await context.writeArtifactJson('task-host-disconnect-observation.json', {
    notifications: viewer.client.messages().filter(message => ['server/transportError', 'server/disconnected'].includes(message.method)),
    originalFailureAssertionsPreserved: true, modelCalls: fixture.modelRequests(),
  });
  assert.ok(viewer.client.messages().some(message => message.method === 'server/transportError'
    && message.params?.message === 'APP_SERVER_HOST_CONNECTION_LOST'
    && message.params.outcome === 'unknown' && message.params.replayAllowed === false),
  'Host loss must be visible without inventing a task completion');
  await pollNative(async () => {
    const value = await tree.read();
    return [...value.processes, ...(value.keepers ?? [])].every(process => !process.alive) ? value : null;
  }, 'the original crashed Core and its exact Main/SDK to finish cleanup', 60_000);
  await viewer.close();
  const recovered = await startNativeCodeGateway(context, fixture, 'task-socket-after-core-restart', { experimental });
  const recoveredHistory = await recovered.rpc('thread/read', { threadId });
  assert.equal(recoveredHistory.thread.id, threadId);
  assert.deepEqual(recoveredHistory.messages, before.messages);
  assert.deepEqual(await recovered.rpc('thread/creation/read', { clientRequestId }), originalReceipt);
  const recoveredUnit = await originalUserUnit(context, fixture, carrier, 'show', 'task-socket-recovered-unit');
  assert.equal(recoveredUnit.MainPID, unit.MainPID, 'The original manager owns Core recovery');
  const recoveredTree = await observeOriginalForegroundChannels(context, fixture, recovered,
    { owner: { pid: Number(recoveredUnit.MainPID) }, requireScopeFence: true, expectedSdks: 0,
      label: 'task-socket-recovered-core-pidfds', attachTimeoutMs: 60_000 });
  const recoveredCore = recoveredTree.original.keepers.find(process => process.role === 'core');
  assert.ok(recoveredCore?.alive && recoveredCore.kernelPidfd && recoveredCore.pid !== originalCore.pid);
  registerOriginalTaskTreeCleanup(context, fixture, carrier, recoveredTree, 'task-socket-recovered');
  assert.equal(fixture.modelRequests(), 0);
  await context.writeArtifactJson('original-task-core-crash-recovery-result.json', {
    normalNativeImage: fixture.imageSha256, originalTask: threadId, realKernelCrash: true,
    frontendDisconnected: true, originalTreeCleanupConfirmed: true, originalManagerPreserved: true,
    originalHistoryPreserved: true, originalCreationReceiptPreserved: true,
    inputSubmitted: false, modelCalls: 0, realPlatform: false, unknownInputReplayTested: false,
    boundary: 'Owned normal-image Core recovery with no submitted input; not an unsettled side-effect or Feishu test',
  });
  await recovered.close();
  await admin.close();
});
