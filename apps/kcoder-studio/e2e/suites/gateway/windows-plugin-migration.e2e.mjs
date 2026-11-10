import assert from 'node:assert/strict';
import { runE2E } from '../../harness/run-context.mjs';
import { runWindowsNativeLibtest, validateNativeLibtestOptions } from '../../harness/windows-native-libtest.mjs';
import { windowsNativeCaseContext } from '../../harness/windows-native-case.mjs';

const options = { consent: process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST,
  target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
  node: process.env.KCODER_E2E_WINDOWS_NODE, testBinary: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_BIN,
  testSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256, sourceTreeSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256,
  supervisor: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN, supervisorSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_SHA256,
  expectedCommit: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT,
  expectedDirty: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY === 'true' };
assert.match(options.expectedCommit ?? '', /^[a-f0-9]{40}$/);
assert.ok(['true', 'false'].includes(process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY));
const scope = process.env.KCODER_E2E_WINDOWS_PLUGIN_LEASE_SCOPE;
assert.ok(['config', 'plugin', 'baseline'].includes(scope), 'Choose the exact frozen native binary scope');
const cases = scope === 'config' ? [
  ['exclusive', 'private_files::portable_lease::tests::portable_existing_lease_contends_and_never_creates_a_missing_leaf'],
  ['shared', 'private_files::portable_lease::tests::portable_shared_leases_reject_exclusive_then_release'],
  ['identity', 'private_files::portable_lease::tests::portable_lease_rejects_replacement_hardlinks_and_future_identity'],
  ['path-race', 'private_files::portable_lease::tests::portable_lease_rechecks_the_original_name_after_locking'],
  ['busy-path-race', 'private_files::portable_lease::tests::portable_busy_lease_rejects_a_renamed_holder_and_replacement_name'],
] : scope === 'plugin' ? [
  ['path-identity', 'declared_installation_paths_bind_the_granted_native_directories_not_path_spelling'],
  ['lifecycle', 'portable_plugin_lifecycle_keeps_sources_unchanged_and_reopens_after_explicit_cancel'],
  ['cancel-running', 'a_running_capture_observes_cross_instance_cancel_without_replacing_its_lease'],
] : [['old-platform-gate', 'both_sources_migrate_actual_packages_disabled_and_reopen_undo_without_source']];
await runE2E(import.meta.url, { testId: `windows-plugin-portable-lease-${scope}`, tier: 'manual-live',
    modelPolicy: 'actual Windows normal-release native libtest; owned synthetic plugin/profile only; no keyring, personal settings, installation, models, source Hook execution or GUI. Baseline is an intentional retained product-failure probe.' },
  async context => {
    const results = [];
    for (const [slug, exactTest] of cases) {
      const selected = { ...options, exactTest, expectedTests: [exactTest] };
      validateNativeLibtestOptions(selected);
      results.push(await runWindowsNativeLibtest(windowsNativeCaseContext(context, slug), selected));
    }
    return { scope, cases: results.map(value => ({ names: value.names, summary: value.summary, passed: value.passed })) };
  });
