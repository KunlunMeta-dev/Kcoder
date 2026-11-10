import assert from 'node:assert/strict';
import { runE2E } from '../../harness/run-context.mjs';
import { runWindowsNativeLibtest, validateNativeLibtestOptions } from '../../harness/windows-native-libtest.mjs';
import { windowsNativeCaseContext } from '../../harness/windows-native-case.mjs';
import { windowsBrowserUploadSelections } from '../../harness/windows-browser-upload-cases.mjs';
import { windowsSourceProductSelection } from '../../harness/windows-source-product-cases.mjs';
import { windowsMemorySnapshotSelection } from '../../harness/windows-memory-snapshot-cases.mjs';
import { windowsPrivateCredentialSelections } from '../../harness/windows-private-credential-cases.mjs';
import { windowsReadConsumerRunSelection } from '../../harness/windows-read-consumers.mjs';

const options = { consent: process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST,
  target: process.env.KCODER_E2E_WINDOWS_SSH_TARGET, parent: process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,
  node: process.env.KCODER_E2E_WINDOWS_NODE, testBinary: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_BIN,
  testSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_TEST_SHA256, sourceTreeSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SOURCE_SHA256,
  supervisor: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN, supervisorSha256: process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_SHA256,
  expectedCommit: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_COMMIT,
  expectedDirty: process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY === 'true' };
assert.match(options.expectedCommit ?? '', /^[a-f0-9]{40}$/);
assert.ok(['true', 'false'].includes(process.env.KCODER_E2E_WINDOWS_NATIVE_EXPECTED_DIRTY));
const scope = process.env.KCODER_E2E_WINDOWS_RETENTION_SCOPE;
assert.ok(['config', 'immutable-stream', 'cache-recovery', 'raw', 'payload', 'upload', 'attempt', 'adoption', 'history-adoption', 'cache', 'browser-upload', 'uploaded-product', 'memory-snapshot', 'private-credentials', 'read-tools', 'read-engine'].includes(scope), 'Choose the exact normal-release native test binary scope');
const readSelection = ['read-tools', 'read-engine'].includes(scope)
  ? windowsReadConsumerRunSelection(scope, process.env.KCODER_E2E_WINDOWS_READ_PATH_MODE) : null;
const browserUploadSelections = windowsBrowserUploadSelections();
const historyAdoptionCase = ['fresh-history-service', 'source_transfer::tests::capsules::fresh_history_adoption_initializes_only_the_target_service_before_normal_plan_run_and_undo'];
const adoptionCases = [
  ['three-classes', 'source_transfer::tests::adoption::three_received_classes_publish_one_fixed_native_preview_and_never_install_on_ready'],
  ['cancel-resume', 'source_transfer::tests::adoption::cancellation_during_received_hash_keeps_running_fact_then_resumes_the_same_fixed_preview'],
  ['missing-birth', 'source_transfer::tests::adoption::a_missing_born_adoption_or_lock_is_unknown_and_is_not_recreated_by_prepare_or_resume'],
  ['lost-publication', 'source_transfer::tests::adoption::a_lost_preview_publication_acknowledgement_reconciles_the_original_inode_without_another_scan'],
  ['equal-byte-replacement', 'source_transfer::tests::adoption::an_unconfirmed_preview_replaced_with_equal_bytes_is_unknown_and_never_regenerated'],
  ['short-worker', 'source_transfer::tests::adoption::a_short_worker_finishing_between_checkpoint_and_lease_observation_returns_the_final_preview'],
  ['effective-project', 'source_transfer::tests::adoption::received_effective_project_configuration_requires_an_actual_destination_mapping_and_blocks_project_templates'],
  ['static-capsule', 'source_transfer::tests::capsules::received_static_assets_use_normal_disabled_plans_without_a_live_source_or_native_reference'],
  ['history-capsule', 'source_transfer::tests::capsules::received_history_retains_the_authenticated_origin_through_normal_archive_and_batch'],
  historyAdoptionCase,
  ['stable-asset-origin', 'source_transfer::tests::asset_identity::work_asset_logical_origin_survives_content_changes_and_separates_other_source_roots'],
  ['legacy-asset-origin', 'source_transfer::tests::asset_identity::old_work_asset_receipts_keep_their_exact_manifest_without_fabricating_a_source_identity'],
  ['actual-asset-bytes', 'source_transfer::tests::asset_identity::returned_work_asset_bytes_are_verified_after_a_same_inode_change_between_hash_and_delivery'],
  ['actual-config-bytes', 'source_transfer::tests::asset_identity::returned_configuration_inventory_cannot_substitute_equal_length_bytes_after_the_original_hash'],
];
const cases = readSelection ? readSelection.selections.map(row => [row.slug, row.exactTest]) : scope === 'private-credentials' ? windowsPrivateCredentialSelections().flatMap(selection => selection.expectedTests.map(name => [name.split('::').at(-1), name])) : scope === 'memory-snapshot' ? windowsMemorySnapshotSelection().expectedTests.map(name => [name.split('::').at(-1), name]) : scope === 'uploaded-product' ? windowsSourceProductSelection().expectedTests.map(name => [name.split('::').at(-1), name]) : scope === 'browser-upload' ? browserUploadSelections.flatMap(selection => selection.expectedTests.map(name => [name.split('::').at(-1), name])) : scope === 'cache' ? [
  ['birth-and-seal', 'external_history::lifecycle::derived::tests::a_real_projection_has_a_fixed_birth_before_publication_and_a_streamed_seal_without_global_lock'],
  ['lost-birth-ack', 'external_history::lifecycle::derived::tests::a_lost_directory_publication_ack_reuses_only_its_exact_native_birth_without_readonly_repair'],
  ['replacement', 'external_history::lifecycle::derived::tests::matching_cache_names_cannot_adopt_an_unowned_or_replaced_directory'],
  ['live-readers', 'external_history::lifecycle::derived::tests::sealed_projection_tree_is_collected_after_all_native_reader_descendants_leave'],
  ['changed-seal', 'external_history::lifecycle::derived::tests::changed_sealed_cache_and_unknown_attachment_subtree_are_retained_before_logical_retirement'],
  ['lost-delete-ack', 'external_history::lifecycle::retire::tests::lost_cache_leaf_and_empty_directory_delete_receipts_reconcile_only_the_original_pending_path'],
] : scope === 'immutable-stream' ? [
  ['crash-cleanup-and-no-replace', 'private_files::windows_stream_publication::tests::process_exit_removes_partial_stream_and_complete_publication_is_no_replace'],
] : scope === 'cache-recovery' ? [
  ['original-sealed-rollback', 'external_history::lifecycle::derived_recovery::crash_tests::sealed_cache_process_crash_restores_original_bytes_without_read_side_effects'],
] : scope === 'history-adoption' ? [historyAdoptionCase] : scope === 'adoption' ? adoptionCases : scope === 'config' ? [
  ['original-handles', 'private_files::portable_retention::tests::portable_retention_removes_only_original_quarantined_leaves_and_verified_empty_directories'],
  ['replacement', 'private_files::portable_retention::tests::portable_retention_preserves_replacements_and_occupied_destinations'],
  ['readonly', 'private_files::portable_retention::tests::portable_windows_readonly_is_not_overridden_by_retention'],
] : scope === 'attempt' ? [
  ['durable-admission', 'source_transfer::tests::attempts::durable_acceptance_never_grants_the_same_attempt_execution_after_all_owners_die'],
  ['immutable-intent', 'source_transfer::tests::attempts::accepted_attempt_kind_call_and_operation_selection_are_immutable'],
  ['missing-birth', 'source_transfer::tests::attempts::attempt_birth_or_lock_loss_remains_unknown_without_repair_and_another_target_cannot_adopt_it'],
  ['bounded-ledger', 'source_transfer::tests::attempts::the_attempt_ledger_has_a_fixed_count_budget_and_does_not_store_selection_content'],
] : scope === 'raw' ? [
  ['legacy-baseline', 'an_active_old_archive_without_a_birth_baseline_stays_readable_and_is_never_adopted_for_collection'],
  ['collect', 'an_unreferenced_managed_archive_is_collected_and_its_original_operation_cannot_resurrect_it'],
  ['alias-and-readers', 'aliases_durable_dependents_and_live_reader_descendants_keep_the_original_archive'],
  ['cancel-resume', 'cancel_after_quarantine_retains_known_effects_and_explicit_resume_finishes_the_same_operation'],
  ['cancel-preflight', 'cancelling_raw_preflight_preserves_the_unmodified_live_import'],
  ['user-changes', 'changed_owned_raw_bytes_and_added_user_content_prevent_logical_retirement_and_collection'],
  ['alias-admission', 'retired_alias_admission_and_its_completed_receipt_do_not_follow_later_shared_generation_users'],
  ['original-operation', 'retired_request_identity_cancel_and_legacy_gates_do_not_create_another_operation'],
  ['independent-references', 'independent_live_references_keep_aliases_live_and_released_receipts_cannot_revive_access'],
] : scope === 'payload' ? [
  ['collect-payloads', 'original_payload_births_are_collected_with_the_archive_and_preserve_control_audit'],
  ['user-changes', 'changed_payload_bytes_same_byte_replacements_and_unknown_family_entries_are_never_adopted'],
  ['cancel-and-lost-progress', 'payload_collection_cancel_and_lost_parent_checkpoint_reopen_the_original_plan'],
  ['local-copy', 'a_mutable_local_copy_tree_is_owned_separately_from_its_selected_source_and_collected_after_ready'],
  ['lost-leaf-ack', 'a_payload_leaf_delete_lost_ack_is_reconciled_from_its_original_node_pending_receipt'],
] : [
  ['upload-01', 'readonly_prepare_paged_discovery_and_owned_upload_survive_reopen_without_original_source'],
  ['upload-02', 'immutable_parts_lost_receipts_and_stale_sequences_never_append_or_truncate'],
  ['upload-03', 'upload_cancellation_revisions_and_whole_digest_failures_remain_explicit'],
  ['upload-04', 'lost_authorize_checkpoint_reconciles_original_grant_without_reselecting_or_copying'],
  ['upload-05', 'budgets_invalid_names_changed_ownership_and_links_do_not_grant_paths'],
  ['upload-06', 'independent_cancel_stops_an_active_assembly_and_a_different_native_grant_is_never_adopted'],
  ['upload-07', 'both_sources_messages_and_typed_tool_items_use_the_same_frozen_upload_authority'],
  ['upload-08', 'restart_after_the_authorization_intent_before_native_dispatch_restores_the_original_grant'],
  ['upload-09', 'browser_prepare_pins_the_source_before_bytes_and_cancel_does_not_silently_release_it'],
  ['upload-10', 'same_owned_upload_recovers_its_pin_receipt_and_the_local_copy_has_an_independent_lifetime'],
  ['upload-11', 'collection::original_upload_parts_are_explicitly_collected_and_only_the_final_receipt_releases_reservations'],
  ['upload-12', 'collection::a_ready_local_copy_remains_readable_after_staging_collection_and_an_active_native_writer_blocks_it'],
  ['upload-13', 'collection::active_assembly_prevents_collection_preparation_without_cancelling_or_deleting_peer_bytes'],
  ['upload-14', 'collection::lost_leaf_and_completion_checkpoints_reconcile_only_the_original_collection_and_keep_audit'],
  ['upload-15', 'collection::reservation_capacity_is_returned_only_after_all_registered_data_has_confirmed_delete_receipts'],
  ['upload-16', 'collection::old_unsealed_markers_and_missing_collection_controls_cannot_gain_new_deletion_rights'],
  ['upload-17', 'collection::only_the_registered_single_link_prepublication_temporary_can_be_collected_after_a_lost_publish_ack'],
  ['upload-18', 'collection::collection_history_is_scoped_paged_ten_and_cancel_before_retirement_preserves_upload_bytes'],
  ['upload-19', 'collection::explicit_resume_before_a_tombstone_can_rebase_a_changed_upload_and_retains_its_original_plan'],
  ['upload-20', 'collection::collection_cancellation_after_a_real_delete_preserves_progress_and_reopens_the_same_control'],
  ['upload-21', 'collection::changed_or_replaced_original_upload_data_and_unknown_entries_never_become_collection_authority'],
];
await runE2E(import.meta.url, { testId: `windows-archive-retention-${scope}`, tier: 'manual-live',
  modelPolicy: readSelection
    ? 'actual Windows default-dev Tools/Engine libtest PE, independently source/SHA pinned with default stack; owned paths only, no release-performance, installer, GUI, personal files, model or source program claim'
    : 'actual Windows normal-release Native filesystem and recovery libtests; exact selected scope from owned synthetic profiles only. No installer, GUI, personal history, model, source tool or power-loss durability claim.' },
async context => {
  const results = [];
  // Crate libtests contain unrelated services; select the exact primitives. Each
  // integration binary is wholly synthetic, so require its complete fixed roster
  // and zero filtered/ignored tests in one owned run instead of repeated SSH setup.
  const selections = readSelection ? readSelection.selections : scope === 'private-credentials' ? windowsPrivateCredentialSelections() : scope === 'memory-snapshot' ? [windowsMemorySnapshotSelection()] : scope === 'uploaded-product' ? [windowsSourceProductSelection()] : scope === 'browser-upload' ? browserUploadSelections : scope === 'cache'
    ? ['derived', 'retire'].map(module => {
      const testFilter = `external_history::lifecycle::${module}::tests::`;
      return { slug: `cache-${module}`, testFilter, expectedTests: cases.map(([, name]) => name).filter(name => name.startsWith(testFilter)) };
    }) : scope === 'adoption'
    ? ['adoption', 'capsules', 'asset_identity'].map(module => {
      const testFilter = `source_transfer::tests::${module}::`;
      return { slug: module, testFilter, expectedTests: cases.map(([, name]) => name).filter(name => name.startsWith(testFilter)) };
    }) : ['config', 'immutable-stream', 'cache-recovery', 'attempt', 'history-adoption'].includes(scope)
      ? cases.map(([slug, exactTest]) => ({ slug, exactTest, expectedTests: [exactTest] }))
      : [{ slug: `${scope}-suite`, expectedTests: cases.map(([, name]) => name) }];
  for (const { slug, ...selection } of selections) {
    const selected = { ...options, ...selection, ...(readSelection ? { pathFixture: readSelection.pathFixture } : {}) };
    validateNativeLibtestOptions(selected);
    const result = await runWindowsNativeLibtest(windowsNativeCaseContext(context, slug), selected);
    if (readSelection) {
      assert.equal(result.pathFixture.ready, true); assert.equal(result.pathFixture.mode, readSelection.pathFixture.mode);
      for (const flag of ['sameNativeDirectory', 'sameNativeLeaf', 'originalOwnerVerified']) assert.equal(result.pathFixture[flag], true);
      assert.equal(result.pathFixture.shareCreated, false); assert.equal(result.pathFixture.policyChanged, false);
      assert.equal(result.pathCleanup.nativeOwnerStopped, true); assert.equal(result.pathCleanup.originalOwnerVerified, true);
      assert.equal(result.pathCleanup.longSubtreeRemoved, readSelection.pathFixture.mode === 'long-case');
    }
    results.push(result);
  }
  const executed = results.flatMap(value => value.names);
  assert.equal(new Set(executed).size, cases.length, 'Every distinct selected case must execute exactly once');
  assert.deepEqual([...executed].sort(), cases.map(([, name]) => name).sort());
  return { scope, ...(readSelection ? { readPathMode: readSelection.pathFixture.mode, testProfile: 'default-dev' } : {}), distinctExecuted: executed.length,
    cases: results.map(value => ({ names: value.names, summary: value.summary, passed: value.passed })) };
});
