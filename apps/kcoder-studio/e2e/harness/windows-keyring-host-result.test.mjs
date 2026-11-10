import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateOwnedHostCleanup, validateOwnedHostResult } from './windows-keyring-host-result.mjs';
import { prepareOwnedHostHandoff } from './windows-keyring-host-handoff.mjs';
import { keyringAccountSourceReview, validateOwnedKeyringCleanup } from './windows-keyring-account.mjs';
import { prepareSuiteArtifacts } from '../run-all.mjs';
import { suiteEnvironmentNames } from './runner-options.mjs';

const cleanup = () => ({ safeToRemoveRoot: true, systemEntryAbsenceVerified: true, originalReferencesUndone: true,
  originalGroupUndone: true, targetSettingsRestored: true, activeBindingsAbsent: true, referenceCount: 2, fileBackendUsed: false });
const result = () => ({ passed: true, scope: 'native_migration_host_keyring', owner: 'owned', username: 'name',
  ownedSid: 'S-1-5-21-1-2-3-1000', hostMigrationVerified: true, gatewayMigrationVerified: false,
  written: { status: 'passed', stage: 'native_host_group_published_pending_independent_reopen', hostMigrationVerified: true,
    targetFilesAndRpcContainNoOriginalValues: true, oldSourceToolsExecuted: 0, modelTurnsStarted: 0, appServerProcessesClosed: 1, rpcRequests: 12,
    storageQuerySucceeded: true, storageFileNodesKnown: false, forcedKeyring: true, providerAndMcpSameGroup: true, explicitConsentEnforced: true, applyReceiptDiscardedAndReadReconciled: true,
    publishedCredentials: 2, nativeAudit: { nativeHostPublishedBindingsVerified: true, referenceCount: 2, fileBackendUsed: false,
      providerResolved: true, mcpResolved: true, mcpDisabled: true } },
  reopened: { status: 'passed', stage: 'native_host_reopened_source_offline_and_rolled_back',
    targetFilesAndRpcContainNoOriginalValues: true, oldSourceToolsExecuted: 0, modelTurnsStarted: 0, appServerProcessesClosed: 1, rpcRequests: 6,
    independentHostReopen: true, originalRequestReceiptReconciled: true, sourceOfflineUndo: true, sourceBytesUnchanged: true, nativeAudit: cleanup() } });

test('Native Host acceptance requires real grouped publication and independent original-receipt Undo', () => {
  validateOwnedHostResult(result(), 'owned', 'name'); validateOwnedHostCleanup(cleanup());
  for (const mutate of [v => { v.scope = 'config_core_keyring'; }, v => { v.written.forcedKeyring = false; },
    v => { v.written.nativeAudit.mcpDisabled = false; }, v => { v.reopened.sourceOfflineUndo = false; },
    v => { v.reopened.nativeAudit.originalReferencesUndone = false; }, v => { v.gatewayMigrationVerified = true; },
    v => { v.written.oldSourceToolsExecuted = 1; }]) {
    const bad = result(); mutate(bad); assert.throws(() => validateOwnedHostResult(bad, 'owned', 'name'));
  }
});

test('Host pre-apply no-write cleanup remains distinct from an OS absence proof', () => {
  const value = { cleaned: true, owner: 'owned', ownedSid: 'S-1-5-21-1-2-3-1000', accountAbsent: true, profileAbsent: true,
    allJobsStopped: true, vault: { safeToRemoveRoot: true, systemEntryAbsenceVerified: false, noHostWriteDispatched: true,
      referenceCount: 0, hostCaseNotCompleted: true } };
  validateOwnedKeyringCleanup(value, 'owned', 'host-rpc');
  for (const scenario of ['raw', 'config-core']) assert.throws(() => validateOwnedKeyringCleanup(value, 'owned', scenario));
  assert.throws(() => validateOwnedHostCleanup(value.vault));
});

test('Host suite pins runtime sources and cannot rebuild application outputs', async () => {
  const source = 'suites/gateway/windows-keyring-host.e2e.mjs', calls = [];
  await prepareSuiteArtifacts([source], { run: async (...args) => calls.push(args) }); assert.deepEqual(calls, []);
  const names = suiteEnvironmentNames(source);
  for (const name of ['KCODER_E2E_WINDOWS_KEYRING_HOST_CLI_SHA256', 'KCODER_E2E_WINDOWS_KEYRING_HOST_NODE_SHA256']) assert.ok(names.includes(name));
  const review = await keyringAccountSourceReview('host-rpc');
  assert.equal(review.files.length, new Set(review.files.map(f => f.path)).size);
  for (const suffix of ['host_audit.rs', 'windows-keyring-host-probe.mjs', 'windows-keyring-host-handoff.mjs', 'app-server-stdio.mjs']) assert.ok(review.files.some(f => f.path.endsWith(suffix)));
});

test('Host handoff registers synthetic source values before protected stdin and excludes them from metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-host-handoff-'));
  try {
    const cli = join(root, 'cli.exe'), bytes = Buffer.from('SYNTHETIC_BINARY'); await writeFile(cli, bytes);
    const digest = createHash('sha256').update(bytes).digest('hex'), secrets = [], artifacts = [], copied = [];
    const context = { registerSecret: value => secrets.push(value), writeArtifactJson: async (...args) => artifacts.push(args) };
    let protectedInput = false;
    await prepareOwnedHostHandoff(context, { hostCli: cli, hostCliSha256: digest, hostNode: 'D:\\owned\\node.exe',
      hostNodeSha256: digest, helperSha256: digest }, { owner: 'owned', root: 'D:\\owned', copy: async (...args) => copied.push(args),
      ps: async (script, input) => {
        if (!input) return JSON.stringify({ sha256: digest });
        const parsed = JSON.parse(input); protectedInput = true; assert.equal(secrets.length, 3);
        for (const secret of Object.values(parsed.fixture).filter(v => v !== 'owned')) {
          assert.ok(secrets.includes(secret)); assert.equal(script.includes(secret), false);
        }
        return JSON.stringify({ privateFixtureSaved: true, runtimeSaved: true });
      } });
    assert.equal(protectedInput, true); assert.equal(copied.length, 3);
    for (const secret of secrets) assert.equal(JSON.stringify(artifacts).includes(secret), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
