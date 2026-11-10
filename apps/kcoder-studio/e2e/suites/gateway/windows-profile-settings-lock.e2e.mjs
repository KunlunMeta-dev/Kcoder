import assert from 'node:assert/strict';
import { runE2E } from '../../harness/run-context.mjs';
import { runWindowsNativeLibtest, validateNativeLibtestOptions } from '../../harness/windows-native-libtest.mjs';

const options = { consent: process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST,
  target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
  node: process.env.KCODER_E2E_WINDOWS_NODE, testBinary: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_BIN,
  testSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256, sourceTreeSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256,
  supervisor: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN, supervisorSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_SHA256,
  expectedCommit: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT,
  expectedDirty: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY === 'true' };
assert.match(options.expectedCommit ?? '', /^[a-f0-9]{40}$/);
assert.ok(['true', 'false'].includes(process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY),
  'Source identity must explicitly distinguish a frozen clean commit from a hashed overlay');
const scope = process.env.KCODER_E2E_WINDOWS_CONFIG_LOCK_SCOPE ?? 'profile';
assert.ok(['profile', 'credentials'].includes(scope), 'Unknown Config lock scope');
const cases = scope === 'profile' ? [
  ['short-reader-lease', 'profile_settings_file::tests::a_short_reader_lease_delays_publication_without_replaying_the_update_callback'],
  ['persistent-contention', 'profile_settings_file::tests::persistent_contention_never_enters_the_update_callback_or_changes_settings'],
] : [
  ['credential-short-readers', 'imported_credentials::group::coordination_tests::coordination_short_readers_do_not_turn_group_publication_into_an_unknown_outcome'],
  ['credential-persistent-readers', 'imported_credentials::group::coordination_tests::coordination_persistent_readers_do_not_enter_callbacks_or_change_private_state'],
  ['credential-no-callback-replay', 'imported_credentials::group::coordination_tests::coordination_wait_never_retries_a_cancelled_callback_or_a_lost_publication_receipt'],
];
for (const [slug, exactTest] of cases) {
  const selected = { ...options, exactTest, expectedTests: [exactTest] };
  validateNativeLibtestOptions(selected);
  await runE2E(import.meta.url, { testId: `windows-profile-settings-lock-${slug}`, tier: 'manual-live',
    modelPolicy: 'actual Windows Config release libtest, one exact named regression; frozen clean commit or separately hashed overlay; isolated owned temporary file-mode fixture only, no OS keyring, models, personal credentials, installation or GUI' },
  context => runWindowsNativeLibtest(context, selected));
}
