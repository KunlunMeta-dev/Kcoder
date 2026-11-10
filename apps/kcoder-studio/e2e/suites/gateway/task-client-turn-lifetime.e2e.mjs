import assert from 'node:assert/strict';
import { readFile, readlink, writeFile } from 'node:fs/promises';
import { nativeCodeFixture, startNativeCodeGateway, pollNative } from '../../harness/native-code-service.mjs';
import { startTaskClientLifetimeProvider } from '../../harness/task-client-lifetime-provider.mjs';
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { login } from '../../harness/http.mjs';
import { requireExecutable, runE2E } from '../../harness/run-context.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'original-task-session-attachment-policy', tier: 'full-integration',
  modelPolicy: 'Actual app-server, Gateway, shared browser transports and original task history; bounded controlled model stream tests cancellation only. No platform account or real model.',
  processSignalTimeoutMs: 45_000,
}, async context => {
  assert.equal(process.platform, 'linux');
  assert.ok(process.getuid() > 0);
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'normal app-server image');
  const provider = await startTaskClientLifetimeProvider(context);
  const fixture = await nativeCodeFixture(context, binary);
  // Make an accidental fallback to the previous user service fail in this fixture.
  fixture.env.XDG_RUNTIME_DIR = fixture.root;
  fixture.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${fixture.root}/no-user-service-bus`;
  const settings = JSON.parse(await readFile(fixture.settings, 'utf8'));
  settings.providers['owned-code'].endpoint = provider.endpoint;
  settings.providers['owned-code'].chat_protocol = 'minimax';
  await writeFile(fixture.settings, JSON.stringify(settings), { mode: 0o600 });
  const experimental = { sessionLifetimeV1: true, gatewaySharedThreadsV1: true, taskSourcesV1: true,
    threadRuntimeHandoffV1: true, interactionBindingV1: true, threadCreationReceiptsV1: true };
  const first = await startNativeCodeGateway(context, fixture, 'client-turn-gateway', { experimental });
  const created = await first.rpc('thread/start', { clientRequestId: `lifetime-${context.seed}` });
  const threadId = created.thread.id;
  async function appServerChild() {
    const gatewayPid = first.gateway.child.pid;
    const children = (await readFile(`/proc/${gatewayPid}/task/${gatewayPid}/children`, 'utf8')).trim().split(/\s+/);
    const owned = [];
    for (const pid of children.filter(Boolean)) {
      try {
        const [program, raw] = await Promise.all([
          readlink(`/proc/${pid}/exe`),
          readFile(`/proc/${pid}/cmdline`, 'utf8'),
        ]);
        if (program === fixture.binary && raw.split('\0').includes('app-server')) owned.push(Number(pid));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    assert.equal(owned.length, 1, 'Gateway owns exactly one app-server for this workspace');
    return owned[0];
  }
  const appServerPid = await appServerChild();

  const cookie = await login(first.gateway.baseUrl, first.gateway.authToken);
  context.registerSecret(cookie);
  async function viewer(label) {
    const client = await openRpc(gatewayRpcUrl(first.gateway, 'local', 'cookie-auth'),
      { headers: { Cookie: cookie, Origin: first.gateway.baseUrl } });
    context.addCleanup(`close task lifetime viewer ${label}`, () => closeRpcAndWait(client));
    await initializeRpc(client, label, experimental);
    await client.request('thread/resume', { threadId }, 60_000);
    await client.request('gateway/thread/attach', { threadId, viewId: label });
    return client;
  }
  const departedViewer = await viewer('lifetime-idle-viewer');
  const survivor = await viewer('lifetime-surviving-viewer');
  const heldInput = { threadId, clientMessageId: `lifetime-hold-${context.seed}`,
    input: [{ type: 'text', text: 'LIFETIME_HOLD' }] };
  const start = await first.rpc('turn/start', heldInput);
  const userEvent = (turnId, clientMessageId) => ({ method, params }) =>
    method === 'item/started' && params?.threadId === threadId && params.turnId === turnId
    && params.item?.type === 'userMessage' && params.item.content?.clientMessageId === clientMessageId;
  const heldEvent = userEvent(start.turn.id, heldInput.clientMessageId);
  const heldMessages = await Promise.all([departedViewer, survivor].map(client =>
    client.waitFor(heldEvent, 30_000, 'the original committed input on an idle peer')));
  assert.equal(heldMessages[0].params.item.id, heldMessages[1].params.item.id);
  await pollNative(() => provider.attempts.length === 1, 'the original controlled stream');
  await closeRpcAndWait(departedViewer);
  const stillRunning = await survivor.request('thread/read', { threadId }, 60_000);
  assert.equal(stillRunning.thread.id, threadId);
  assert.equal(provider.attempts[0].closed, false,
    'An idle peer disconnect must not cancel the actual input owner');
  await closeRpcAndWait(first.client);
  await new Promise(resolve => setTimeout(resolve, 4000));
  assert.equal(provider.attempts[0].closed, false,
    'The submitting client may leave while a legitimate viewer remains attached');
  const observer = await openRpc(gatewayRpcUrl(first.gateway, 'local', 'cookie-auth'),
    { headers: { Cookie: cookie, Origin: first.gateway.baseUrl } });
  context.addCleanup('close detached history observer', () => closeRpcAndWait(observer));
  await initializeRpc(observer, 'lifetime-read-only-observer', experimental);
  await observer.request('thread/read', { threadId }, 60_000);
  await closeRpcAndWait(survivor);
  const terminal = await pollNative(async () => {
    const { receipt } = await observer.request('turn/receipt/read', {
      threadId, clientMessageId: heldInput.clientMessageId,
    });
    return receipt && receipt.status !== 'running' ? receipt : null;
  }, 'last-attachment interruption in the original receipt');
  assert.equal(terminal.turnId, start.turn.id);
  assert.equal(terminal.status, 'interrupted');
  await pollNative(() => provider.attempts[0].closed, 'the original cancelled model transport');
  assert.equal(provider.attempts.length, 1);
  assert.equal(await appServerChild(), appServerPid,
    'Last-attachment cancellation preserves the original app-server and lease');
  const reopened = await viewer('lifetime-reopened-viewer');
  const duplicate = await reopened.request('turn/start', heldInput, 60_000)
    .then(value => ({ value }), error => ({ error }));
  if (duplicate.error) assert.match(duplicate.error.message, /was already committed/);
  else assert.equal(duplicate.value.turn.id, start.turn.id);
  assert.equal(provider.attempts.length, 1, 'A different client cannot replay the original input');
  const nextClientMessageId = `lifetime-next-${context.seed}`;
  const next = await reopened.request('turn/start', { threadId,
    clientMessageId: nextClientMessageId, input: [{ type: 'text', text: 'LIFETIME_NEXT' }] }, 60_000);
  const nextEvent = userEvent(next.turn.id, nextClientMessageId);
  const nextMessage = await reopened.waitFor(nextEvent, 30_000, 'the next original committed input');
  const finished = await reopened.waitFor(message => message.method === 'turn/completed'
    && message.params?.turnId === next.turn.id, 60_000, 'the surviving client turn');
  assert.equal(finished.params.turn.status, 'completed');
  const history = await reopened.request('thread/read', { threadId }, 60_000);
  assert.equal(history.thread.id, threadId);
  assert.deepEqual(history.messages.filter(message => message.role === 'user').map(message => message.id),
    [heldMessages[0].params.item.id, nextMessage.params.item.id]);
  assert.equal(survivor.messages().filter(heldEvent).length, 1);
  assert.equal(reopened.messages().filter(nextEvent).length, 1);
  assert.equal(reopened.messages().filter(heldEvent).length, 0);
  assert.equal(history.messages.filter(message => message.role === 'assistant'
    && message.content === 'LIFETIME_PEER_COMPLETED').length, 1);
  assert.equal(provider.attempts.length, 2);
  await context.writeArtifactJson('original-client-turn-lifetime-result.json', {
    originalTask: threadId, normalImage: fixture.imageSha256,
    idlePeerDisconnectPreservedTurn: true, submitterDisconnectWithPeerContinued: true,
    lastAttachmentInterruptedAfterGrace: true, readOnlyObserverWasNotAnAttachment: true,
    reattachDidNotReplayCancelledInput: true,
    idlePeersSawSameCommittedInput: true, duplicateInputWasNotReplayed: true, historyKeptInputOrder: true,
    sameGatewayAppServerAndOriginalTask: true, gatewayPid: first.gateway.child.pid, appServerPid, survivingClientCompletedNextTurn: true,
    originalHistoryPreserved: true, modelRequests: provider.attempts.length,
    realModel: false, realPlatform: false, channelExecutionTested: false,
  });
  await closeRpcAndWait(reopened);
  await closeRpcAndWait(observer);
});
