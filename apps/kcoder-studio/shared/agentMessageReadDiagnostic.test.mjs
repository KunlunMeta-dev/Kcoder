import test from 'node:test';
import assert from 'node:assert/strict';
import { agentMessageDiagnosticData, agentMessageReadDiagnostic, isAgentMessageReadDiagnostic } from './agentMessageReadDiagnostic.mjs';

test('read diagnostics preserve only exact closed codes and never inspect raw errors or getters', () => {
  const secret = 'PRIVATE_TOKEN_C:/Users/private/session';
  const safe = Object.assign(new Error(secret), { data: { reason: 'peer_source_tool_disabled', path: secret, token: secret } });
  assert.deepEqual(agentMessageDiagnosticData(safe), { reason: 'peer_source_tool_disabled' });
  for (const value of [secret, 'peer_source_tool_disabled: '+secret, '', null, { secret }]) {
    const result = agentMessageReadDiagnostic('targets', { message: secret, data: { reason: value, secret } });
    assert.deepEqual(result, { stage: 'targets', reason: 'unknown' });
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  const hostile = Object.defineProperty({}, 'data', { get() { throw new Error(secret); } });
  assert.deepEqual(agentMessageDiagnosticData(hostile), { reason: 'unknown' });
  assert.equal(isAgentMessageReadDiagnostic({ stage: 'targets', reason: 'peer_source_tool_disabled' }), true);
  assert.equal(isAgentMessageReadDiagnostic({ stage: 'targets', reason: secret }), false);
  assert.equal(isAgentMessageReadDiagnostic({ stage: secret, reason: 'unknown' }), false);
  assert.equal(isAgentMessageReadDiagnostic({ stage: 'targets', reason: 'unknown', path: secret }), false);
});

test('policy diagnostics distinguish eligibility, lease privacy and source reads without publishing causes', () => {
  const secret = 'PRIVATE_POLICY_CREDENTIAL_AND_IDENTITY';
  for (const reason of ['peer_policy_source_ephemeral', 'peer_policy_source_not_independent', 'peer_policy_workspace_mismatch',
    'peer_policy_lease_unavailable', 'peer_policy_lease_target_mismatch', 'peer_policy_lease_privacy_unverified',
    'peer_policy_lease_busy', 'peer_policy_settings_access_denied', 'peer_policy_settings_invalid']) {
    assert.deepEqual(agentMessageReadDiagnostic('policy', { message: secret, data: { reason, identity: secret } }), { stage: 'policy', reason });
    assert.equal(isAgentMessageReadDiagnostic({ stage: 'policy', reason }), true);
  }
  const unknown = agentMessageReadDiagnostic('policy', { message: secret, data: { reason: 'peer_policy_new_unreviewed', secret } });
  assert.deepEqual(unknown, { stage: 'policy', reason: 'unknown' });
  assert.ok(!JSON.stringify(unknown).includes(secret));
});


test('read diagnostics runtime module is included in both npm and desktop staged resource closures', async t => {
  const { readFile, mkdtemp, mkdir, copyFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const file = 'shared/agentMessageReadDiagnostic.mjs';
  assert.ok(pkg.files.includes(file));
  const resource = pkg.build.extraResources.find(row => row.from === file);
  assert.equal(resource?.to, 'gateway/'+file);
  const root = await mkdtemp(join(tmpdir(), 'kcoder-peer-diagnostic-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staged = join(root, resource.to); await mkdir(join(root, 'gateway/shared'), { recursive: true });
  await copyFile(new URL('./agentMessageReadDiagnostic.mjs', import.meta.url), staged);
  const actual = await import(pathToFileURL(staged).href);
  assert.deepEqual(actual.agentMessageDiagnosticData({ data: { reason: 'peer_source_tool_disabled', secret: 'PRIVATE_TOKEN' } }),
    { reason: 'peer_source_tool_disabled' });
});
