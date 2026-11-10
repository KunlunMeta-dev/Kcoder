import assert from 'node:assert/strict';
import { runE2E } from '../../harness/run-context.mjs';
import { runWindowsNativeLibtest } from '../../harness/windows-native-libtest.mjs';
import { inspectWindowsPrivateNode, validateWindowsPrivateCredentialEvidence } from '../../harness/windows-private-credential-review.mjs';

for (const option of process.argv.slice(2)) assert.equal(option, '--preflight');
if (!process.argv.includes('--preflight')) assert.equal(process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY, 'false', 'A clean committed Windows producer is required');

if (process.argv.includes('--preflight')) {
  await runE2E(import.meta.url, { testId: 'windows-private-node-readonly', tier: 'manual-live',
    modelPolicy: 'Read-only Get-Command and existing non-profile Node executable metadata/hash. No account, logon, vault, remote writes, installation, model or GUI operation.' },
  context => inspectWindowsPrivateNode(context, { consent: process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST, target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET }));
} else await runE2E(import.meta.url, { testId: 'windows-native-private-credential-file-bundle', tier: 'manual-live', cleanupTimeoutMs: 120000,
  modelPolicy: 'Normal release Windows Native actual RPC, two synthetic original configuration entries/offers and four file-backed import refs. Source removal, durable prepare-status, ordinary publication/reopen/Undo and key release. No OS vault/account, GUI, installer, personal data, source tools or inference.' }, async context => {
  const result = await runWindowsNativeLibtest(context, { consent: process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST,
    target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
    node: process.env.KCODER_E2E_WINDOWS_NODE, nodeSha256: process.env.KCODER_E2E_WINDOWS_PRIVATE_NODE_SHA256,
    testBinary: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_BIN, testSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256,
    sourceTreeSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256,
    supervisor: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN, supervisorSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_SHA256,
    expectedCommit: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT,
    expectedDirty: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY === 'true',
    reviewedSourceSha256: process.env.KCODER_E2E_WINDOWS_PRIVATE_REVIEW_SHA256, probeKind: 'private-credentials' });
  validateWindowsPrivateCredentialEvidence(result.details);
});
