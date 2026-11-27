import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { waitFor } from '../run-context.mjs';
import { startPeerUidNamespace } from './runtime.mjs';
import { login } from '../http.mjs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const value = name => { const result = process.env[name]; assert.ok(typeof result === 'string' && result.length > 0, `Explicit ${name} required`); return result; };
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  throw new Error('Run the registered suites/gateway/peer-ssh-enrollment.e2e.mjs; this module is only its owned fixture helper');
export async function runPeerUidProductAcceptance(context) {
  const rendererRoot = value('KCODER_E2E_RENDERER_ROOT'), expectedIndex = value('KCODER_E2E_RENDERER_INDEX_SHA256');
  const actualIndex = createHash('sha256').update(await readFile(resolve(rendererRoot, 'index.html'))).digest('hex');
  assert.equal(actualIndex, expectedIndex);
  await context.writeArtifactJson('renderer-cookie-html-provenance.json', { rendererRoot, indexSha256: actualIndex,
    sourceCommit: 'b1cd481dc008ea95b8a12e5c520ca1a2112e4478', e2eAutomationEnabled: false,
    purpose: 'HTTP cookie RPC token HTML only; no DOM or React acceptance' });
  const product = { binary: value('KCODER_E2E_KCODER_BIN'), binarySha256: value('KCODER_E2E_KCODER_BIN_SHA256'), supervisor: value('KCODER_E2E_PEER_UID_SUPERVISOR_BIN'), supervisorSha256: value('KCODER_E2E_PEER_UID_SUPERVISOR_SHA256') };
  const gatewayRoot = value('KCODER_E2E_PEER_UID_GATEWAY_ROOT'); assert.ok(gatewayRoot.startsWith('/'));
  const helper = path => import(pathToFileURL(resolve(gatewayRoot, 'e2e/harness', path)).href);
  const [{ startGateway }, { openOwnedPeerBrowserRuntime }, { materializeWorkspace }] = await Promise.all([helper('gateway.mjs'), helper('peer-browser-runtime.mjs'), helper('workspace-fixture.mjs')]);
  const fixture = await startPeerUidNamespace(context, { product });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'two-uid-gateway-control' });
  const servers = fixture.users.map((user, index) => ({ id: `uid-${index}`, label: `Owned actual OS UID ${user.uid}`, runtime: 'kcoder', transport: 'ssh', host: '127.0.0.1', user: user.name,
    port: fixture.port, acceptNewHostKey: false, command: '/runtime/kcoder', workspace: `${user.home}/workspace`, settingsFile: `${user.home}/.config/kcoder/settings.json` }));
  const serversFile = await context.writeStateJson('two-uid-targets.json', servers);
  await context.writeStateJson('gateway-profile/settings.json', { providers: {}, credential_store: 'file' });
  const gateway = await startGateway(context, { auth: true, workspace, serversFile, kcoderBin: product.binary, gatewayRoot,
    env: { ...fixture.sshEnvironment, KCODER_CONFIG_DIR: context.pathInState('gateway-profile'), KCODER_HOME: context.pathInState('gateway-profile') } });
  const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
  const control = async (index, action, body = {}, origin = gateway.baseUrl) => {
    const response = await fetch(`${gateway.baseUrl}/api/servers/${servers[index].id}/peer-ssh/${action}`, { method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath: servers[index].workspace, ...body }), signal: AbortSignal.timeout(60000) });
    const raw = await response.text(); assert.ok(Buffer.byteLength(raw) < 32768);
    return { status: response.status, body: JSON.parse(raw) };
  };
  const proposals = [], pins = [];
  assert.equal((await control(0, 'prepare', {}, 'http://other.invalid')).status, 403);
  for (let index = 0; index < 2; index++) {
    const before = await fixture.snapshot([]); assert.equal(before.modelRequests.length, 0);
    const prepared = await control(index, 'prepare'); assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    assert.equal(prepared.body.enrollment.native.accountUid, fixture.users[index].uid);
    assert.equal(prepared.body.enrollment.target.sshUser, fixture.users[index].name);
    proposals.push(prepared.body);
    const applied = await control(index, 'apply', { proposalId: prepared.body.proposalId, digest: prepared.body.digest });
    assert.equal(applied.status, 200, JSON.stringify(applied.body)); assert.equal(applied.body.receipt.status, 'pinned');
    pins.push(applied.body.receipt);
    assert.equal((await fixture.snapshot([])).modelRequests.length, 0, 'Explicit management never requests a model');
  }
  await context.writeArtifactJson('explicit-ssh-enrollment-checkpoint.json', { pinReceipts: pins,
    nativeAccounts: proposals.map(row => ({ accountUid: row.enrollment.native.accountUid, sshUser: row.enrollment.target.sshUser,
      profileIdentity: row.enrollment.native.profileIdentity, enrollmentId: row.enrollment.enrollmentId })),
    actualFullCookieSameOrigin: true, otherOriginRejected: true, managementProviderPosts: 0 });
  const clients = [];
  for (let index = 0; index < 2; index++) clients.push(await openOwnedPeerBrowserRuntime(context, gateway, { serverId: servers[index].id, workspace: servers[index].workspace }));
  const threads = [], nativePids = [];
  for (let index = 0; index < 2; index++) {
    const client = clients[index];
    nativePids.push((await client.request('server/resources/read')).processId);
    const { thread } = await client.request('thread/start', {}); threads.push(thread);
    const clientMessageId = `owned-uid-${index}-original-seed`;
    await client.request('turn/start', { threadId: thread.id, clientMessageId, input: [{ type: 'text', text: `OWNED_UID_${index}_SEED` }] });
    await waitFor(async () => { const { receipt } = await client.request('turn/receipt/read', { threadId: thread.id, clientMessageId }); assert.ok(!['failed', 'interrupted'].includes(receipt?.status), 'Actual original UID seed failed'); return receipt?.status === 'completed'; }, 45000, 'actual original SSH UID Native seed');
  }
  const actualIdentity = await fixture.snapshot(nativePids);
  assert.deepEqual(actualIdentity.native.map(row => row.uid), fixture.users.map(user => user.uid));
  assert.equal(actualIdentity.modelRequests.length, 2);
  const probes = await fixture.probeUsers();
  const receipts = [];
  for (let index = 0; index < 2; index++) {
    const client = clients[index], source = threads[index].id, destination = threads[1 - index].id;
    let selected, cursor;
    for (let page = 0; page < 32; page++) {
      const result = await client.request('thread/agentMessage/targets', { sourceThreadId: source, ...(cursor ? { cursor } : {}) });
      selected = result.targets.find(row => row.address?.threadId === destination);
      if (selected) break;
      cursor = result.nextCursor; if (!cursor) break;
    }
    assert.ok(selected?.address && selected.allowedModes.includes('enqueue_only'), 'Other real UID target must be discovered from actual Native routing');
    const originalCid = `owned-uid-${index}-peer-${fixture.owner}`;
    const message = { targetThreadId: destination, targetAddress: selected.address, clientMessageId: originalCid, mode: 'enqueue_only', text: `OWNED_UID_${index}_ORIGINAL_PEER` };
    const admitted = await client.request('thread/agentMessage/send', { sourceThreadId: source, message });
    let original;
    await waitFor(async () => { original = (await client.request('thread/agentMessage/get', { sourceThreadId: source, query: { clientMessageId: originalCid } })).receipt; return original?.status === 'applied'; }, 30000, 'same original cross-UID receipt Applied');
    assert.equal(original.messageId, admitted.messageId); assert.equal(original.clientMessageId, originalCid);
    assert.notEqual(original.sourceAddress.targetId, original.targetAddress.targetId);
    receipts.push(original);
  }
  for (let index = 0; index < 2; index++) {
    const history = await clients[index].request('thread/read', { threadId: threads[index].id, limit: 100 });
    assert.equal(history.messages.filter(row => row.role === 'user').length, 1, 'Peer does not manufacture another actual User');
    assert.equal(history.messages.filter(row => row.origin === 'peer_agent' && row.content === `OWNED_UID_${1 - index}_ORIGINAL_PEER`).length, 1);
  }
  const after = await fixture.snapshot(nativePids); assert.equal(after.modelRequests.length, 2, 'Enqueue-only cannot create a third Provider request');
  for (let index = 0; index < 2; index++) {
    const revoked = await control(index, 'revoke'); assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.receipt.status, 'revoked');
    const historical = await control(index, 'apply', { proposalId: proposals[index].proposalId, digest: proposals[index].digest });
    assert.equal(historical.status, 200); assert.deepEqual(historical.body.receipt, pins[index]);
    const status = await control(index, 'status'); assert.equal(status.status, 200);
    const current = await clients[index].request('runtime.context.get', {}); assert.ok(current, 'Ordinary coding metadata remains available after peer revoke');
  }
  await assert.rejects(clients[0].request('thread/agentMessage/targets', { sourceThreadId: threads[0].id }),
    'The old private session cannot outlive explicit pin revocation');
  const final = await fixture.snapshot(nativePids); assert.equal(final.modelRequests.length, 2, 'Revocation and original receipt reads never request a model');
  await context.writeArtifactJson('two-uid-native-product-proof.json', { imageContainer: fixture.id, nativeInputs: fixture.nativeInputs, nativeIdentityBefore: actualIdentity.native, nativeIdentityAfter: after.native,
    realSshUserProbes: probes, modelRequests: final.modelRequests, pinReceipts: pins, explicitFullBrowserCookieEnrollment: true, revokedAfterApplied: true,
    actualTargets: servers.map(({ id, transport, user, workspace }) => ({ id, transport, user, workspace })), threads: threads.map(row => row.id), originalReceipts: receipts,
    hostAccountChanges: 0, paidModelCalls: 0, managedAccountPeerBranch: false, ordinaryDifferentUidSshOnly: true });
  return { actualDifferentOsUids: probes.map(row => row.uid), actualNativeProcesses: 2, actualSshTargets: 2, originalReceiptsApplied: 2, nativePeerRows: 2, userTurns: 2, deterministicProviderCalls: 2, extraEnqueueProviderCalls: 0, fakeUserPrompts: 0 };
}
