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
const cases = [
  ['configuration', 'both_configuration_formats_transfer_existing_inventory_without_authentication_originals'],
  ['history', 'transferred_history_reuses_original_raw_archive_and_never_an_attachment_supplement'],
  ['lost-receipt', 'lost_part_receipt_recovers_only_an_identical_owned_prefix_without_rewriting'],
  ['cancel-watermark', 'cancellation_watermarks_survive_restart_and_old_resume_cannot_clear_new_cancellation'],
  ['binding', 'source_changes_and_another_native_account_or_target_grant_do_not_retarget_a_request'],
  ['cancel-running', 'source_cancellation_releases_its_writer_and_requires_explicit_same_job_resume'],
  ['path-policy', 'transfer_boundaries_reject_escaping_reserved_and_authentication_asset_names'],
  ['static-assets', 'static_work_assets_keep_source_scope_and_bytes_without_installation_or_native_reference'],
  ['compressed-history', 'boundaries::compressed_physical_bytes_and_logical_snapshot_survive_transport_and_original_removal'],
  ['unknown-prefix', 'boundaries::unknown_conflicting_prefix_is_preserved_instead_of_overwritten'],
  ['missing-control', 'boundaries::missing_operation_control_is_never_recreated_by_prepare_read_or_cancel'],
  ['tamper', 'boundaries::changed_payload_or_forged_final_receipt_blocks_configuration_use_without_repair'],
  ['quota', 'boundaries::fixed_request_grant_and_aggregate_reservations_fail_before_large_file_creation'],
];
await runE2E(import.meta.url, { testId: 'windows-native-source-transfer', tier: 'manual-live',
    modelPolicy: 'Actual Windows normal-release Native service libtests in owned synthetic D: profiles; no personal data, keyring, installation, tools, models or source Hook execution. This is not a Gateway, cross-host or GUI acceptance claim.' },
  async context => {
    const results = [];
    for (const [slug, name] of cases) {
      const exactTest = `source_transfer::tests::${name}`;
      const selected = { ...options, exactTest, expectedTests: [exactTest] };
      validateNativeLibtestOptions(selected);
      results.push(await runWindowsNativeLibtest(windowsNativeCaseContext(context, slug), selected));
    }
    return { scope: 'Windows Native source transfer, not cross-host or installer',
      cases: results.map(value => ({ names: value.names, summary: value.summary, passed: value.passed })) };
  });
