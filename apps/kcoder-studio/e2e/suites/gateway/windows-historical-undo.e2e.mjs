import { runE2E } from '../../harness/run-context.mjs';
import { runWindowsNativeLibtest, validateNativeLibtestOptions } from '../../harness/windows-native-libtest.mjs';

const options = { consent: process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST,
  target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
  node: process.env.KCODER_E2E_WINDOWS_NODE, testBinary: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_BIN,
  testSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256, sourceTreeSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256,
  supervisor: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN, supervisorSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_SHA256,
  expectedTests: ['a_full_supported_attachment_batch_fits_the_metadata_budget',
    'a_lost_undo_receipt_and_pre_rename_crash_reconcile_only_this_owned_intent',
    'a_real_later_user_message_and_even_equal_byte_history_replacement_block_undo',
    'an_old_unsealed_session_is_never_adopted_and_cancelled_checks_leave_it_active',
    'metadata_goals_added_artifacts_and_identical_replaced_files_are_user_owned',
    'publication_lease_and_metadata_lock_cannot_be_bypassed_or_replaced',
    'unchanged_owned_session_is_retired_once_and_all_attachments_audit_and_sources_stay'] };
validateNativeLibtestOptions(options);
await runE2E(import.meta.url, { testId: 'windows-historical-undo-native-seven', tier: 'manual-live',
  modelPolicy: 'actual Windows Rust test binary; isolated temporary profile/history only; no models, personal settings, sessions, credentials or installation' },
context => runWindowsNativeLibtest(context, options));
