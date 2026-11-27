import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startPeerUidNamespace } from './runtime.mjs';
import { login } from '../http.mjs';
import { waitForStdioChildClose } from '../app-server-stdio.mjs';

const required = name => { const value = process.env[name]; assert.ok(value?.startsWith('/') || /SHA256$/.test(name) && /^[a-f0-9]{64}$/.test(value ?? ''), `Explicit ${name} required`); return value; };
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const mutateOwnedProfile = `import json,os,pwd,shutil,subprocess,sys
from pathlib import Path
home=Path(pwd.getpwuid(os.geteuid()).pw_dir)
assert home==Path('/home/a') and os.getuid()==os.geteuid()==20001
profile=home/'.config/kcoder'
phase=sys.argv[1]
if phase=='replace-key':
    (profile/'peer-router-v1').rename(profile/'peer-router-v1-original-owned')
    result=subprocess.run(['/runtime/kcoder','--cwd',str(home/'workspace'),'peer-ssh','prepare','--confirm'],capture_output=True,check=True,text=True)
    observation=json.loads(result.stdout)
    print(json.dumps({'phase':phase,'uid':os.geteuid(),'native':observation['native']}))
elif phase=='restore-key':
    (profile/'peer-router-v1').rename(profile/'peer-router-v1-replacement-owned')
    (profile/'peer-router-v1-original-owned').rename(profile/'peer-router-v1')
    print(json.dumps({'phase':phase,'uid':os.geteuid()}))
elif phase=='fresh-profile':
    retired=home/'.config/kcoder-original-revoked'
    profile.rename(retired)
    profile.mkdir(mode=0o700)
    shutil.copyfile(retired/'settings.json',profile/'settings.json')
    os.chmod(profile/'settings.json',0o600)
    print(json.dumps({'phase':phase,'uid':os.geteuid(),'nativeKeyAbsent':not(profile/'peer-router-v1').exists(),'oldRevokedProfilePreserved':retired.is_dir()}))
else:
    raise RuntimeError('unregistered owned mutation')
`;

/** Only this run's real SSH account changes its generated fixture profile.
 * No local UID impersonation, personal configuration or model is involved.
 */
export async function runPeerUidEnrollmentIdentity(context) {
  const product = { binary: required('KCODER_E2E_KCODER_BIN'), binarySha256: required('KCODER_E2E_KCODER_BIN_SHA256'),
    supervisor: required('KCODER_E2E_PEER_UID_SUPERVISOR_BIN'), supervisorSha256: required('KCODER_E2E_PEER_UID_SUPERVISOR_SHA256') };
  const gatewayRoot = required('KCODER_E2E_PEER_UID_GATEWAY_ROOT');
  const helper = name => import(pathToFileURL(resolve(gatewayRoot, 'e2e/harness', name)).href);
  const [{ startGateway }, { materializeWorkspace }, { openOwnedPeerBrowserRuntime }] = await Promise.all([helper('gateway.mjs'), helper('workspace-fixture.mjs'), helper('peer-browser-runtime.mjs')]);
  const fixture = await startPeerUidNamespace(context, { product });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'identity-control' });
  const user = fixture.users[0];
  const target = { id: 'identity-target', label: 'Owned UID identity replacement', runtime: 'kcoder', transport: 'ssh', host: '127.0.0.1', user: user.name,
    port: fixture.port, acceptNewHostKey: false, command: '/runtime/kcoder', workspace: user.home + '/workspace', settingsFile: user.home + '/.config/kcoder/settings.json' };
  const serversFile = await context.writeStateJson('identity-target.json', [target]);
  await context.writeStateJson('gateway-profile/settings.json', { providers: {}, credential_store: 'file' });
  const gateway = await startGateway(context, { auth: true, workspace, serversFile, kcoderBin: product.binary, gatewayRoot,
    env: { ...fixture.sshEnvironment, KCODER_CONFIG_DIR: context.pathInState('gateway-profile'), KCODER_HOME: context.pathInState('gateway-profile') } });
  const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
  let controlSequence = 0;
  const control = async (action, body = {}) => {
    const response = await fetch(`${gateway.baseUrl}/api/servers/${target.id}/peer-ssh/${action}`, { method: 'POST',
      headers: { Cookie: cookie, Origin: gateway.baseUrl, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath: target.workspace, ...body }), signal: AbortSignal.timeout(60000) });
    const text = await response.text(); assert.ok(Buffer.byteLength(text) < 32768);
    const result = { status: response.status, body: JSON.parse(text) };
    await context.writeArtifactJson(`identity-control-${++controlSequence}-${action}.json`, result);
    return result;
  };
  const mutate = async phase => {
    const child = context.spawnOwned(`identity-real-ssh-${phase}`, 'ssh', ['-T', '-p', String(fixture.port), `${user.name}@127.0.0.1`,
      `/usr/bin/python3 -I -S -B - ${quote(phase)}`], { env: fixture.sshEnvironment, stdin: 'pipe' });
    let text = ''; child.stdout.on('data', value => { text += value; assert.ok(Buffer.byteLength(text) < 16384); });
    const ended = waitForStdioChildClose(child, 30000, 'original real SSH identity fixture mutation');
    child.stdin.end(mutateOwnedProfile);
    assert.equal((await ended).code, 0);
    const value = JSON.parse(text); assert.equal(value.uid, user.uid); return value;
  };
  const first = await control('prepare'); assert.equal(first.status, 200);
  const original = first.body;
  assert.equal((await control('apply', { proposalId: original.proposalId, digest: original.digest })).status, 200);
  const before = await control('status'); assert.equal(before.body.pinStatus, 'pinned');
  const replaced = await mutate('replace-key'); assert.notDeepEqual(replaced.native, original.enrollment.native);
  const denied = await control('prepare'); assert.equal(denied.status, 409); assert.equal(denied.body.error, 'PEER_SSH_PIN_IDENTITY_CHANGED');
  assert.equal((await control('status')).body.proposals.length, before.body.proposals.length, 'Incompatible identity must not create an uncertain proposal');
  await mutate('restore-key');
  const revoked = await control('revoke'); assert.equal(revoked.status, 200); assert.equal(revoked.body.receipt.status, 'revoked');
  assert.equal(revoked.body.receipt.enrollmentId, original.enrollment.enrollmentId);
  const fresh = await mutate('fresh-profile'); assert.equal(fresh.nativeKeyAbsent, true); assert.equal(fresh.oldRevokedProfilePreserved, true);
  const next = await control('prepare'); assert.equal(next.status, 200);
  assert.notEqual(next.body.enrollment.native.profileIdentity, original.enrollment.native.profileIdentity);
  assert.notEqual(next.body.enrollment.enrollmentId, original.enrollment.enrollmentId); assert.equal(next.body.enrollment.generation, 1);
  const applied = await control('apply', { proposalId: next.body.proposalId, digest: next.body.digest }); assert.equal(applied.status, 200);
  assert.equal(applied.body.receipt.generation, 1);
  const old = await control('apply', { proposalId: original.proposalId, digest: original.digest }); assert.equal(old.status, 200);
  assert.equal(old.body.receipt.enrollmentId, original.enrollment.enrollmentId);
  const status = await control('status'); assert.equal(status.body.pinStatus, 'pinned');
  assert.ok(status.body.proposals.some(row => row.receipt?.enrollmentId === original.enrollment.enrollmentId && row.receipt.status === 'revoked'));
  const runtime = await openOwnedPeerBrowserRuntime(context, gateway, { serverId: target.id, workspace: target.workspace });
  const nativePid = (await runtime.request('server/resources/read')).processId;
  const after = await fixture.snapshot([nativePid]); assert.equal(after.native[0].uid, user.uid);
  assert.equal(after.native[0].capEff, '0000000000000000'); assert.equal(after.modelRequests.length, 0);
  await context.writeArtifactJson('identity-replacement-proof.json', { fixedTargetId: target.id, fixedWorkspace: target.workspace, uid: user.uid,
    original: { proposalId: original.proposalId, enrollmentId: original.enrollment.enrollmentId, native: original.enrollment.native },
    replacementKeyRejected: denied.body.error, oldRevokedReceipt: revoked.body.receipt,
    newEnrollment: next.body.enrollment, newReceipt: applied.body.receipt, oldReceiptAfterReplacement: old.body.receipt,
    noKeyBeforeExplicitPreparation: fresh.nativeKeyAbsent, native: after.native, providerPosts: after.modelRequests,
    hostAccountChanges: 0, paidModelCalls: 0, reactAcceptance: false });
  return { sameTargetAndWorkspace: true, realUid: user.uid, oldKeyRejected: true, oldPinRevoked: true, newProfileGeneration: 1,
    newPrivateRuntime: true, modelRequests: 0, oldReceiptNeverRevivedCurrentPin: true };
}
