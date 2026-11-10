// This roster is an explicit assertion, never inferred from a binary's reported tests.
const uploads = [
  'tests::selected_files_are_private_bounded_and_ready_only_after_actual_hashes',
  'tests::lost_partial_or_complete_append_receipts_require_the_original_part_bytes',
  'tests::independent_cancel_stops_verification_and_stale_parts_cannot_cross_a_resume',
  'tests::untracked_or_changed_birth_and_published_receipts_are_not_repaired',
  'tests::same_bytes_at_a_replaced_file_never_inherit_ready_authority',
  'tests::actual_copy_rejects_a_same_inode_content_change_despite_a_saved_ready_receipt',
  'tests::missing_execution_lock_is_unknown_and_never_recreated_by_controls',
  'control_tests::completed_upload_controls_preserve_the_committed_receipt_and_sequence',
  'control_tests::a_lost_cancel_receipt_cannot_cancel_again_after_explicit_resume',
  'control_tests::controls_require_the_original_commit_lease_even_after_completion',
  'control_tests::accepted_worker_holds_its_lease_before_execution_and_releases_on_drop',
  'control_tests::upload_receipt_pages_are_bounded_and_report_only_accepted_offsets',
  'control_tests::completing_between_progress_and_receipt_reads_returns_a_consistent_snapshot',
  'parts::review_tests::a_zero_byte_append_with_a_lost_reply_keeps_its_original_part_intent',
];
const container = [
  'manifest::tests::configuration_names_unicode_and_canonical_file_order_are_preserved',
  'manifest::tests::sensitive_authentication_environment_and_generated_entries_are_excluded_at_any_depth',
  'manifest::tests::portable_paths_reject_escapes_windows_aliases_and_unsafe_components',
  'manifest::tests::collisions_include_directory_spelling_unicode_case_and_parent_file_conflicts',
  'manifest::tests::payload_count_digest_and_manifest_encoding_have_independent_budgets',
  'manifest::tests::unknown_link_authority_duplicate_fields_and_versions_are_rejected_without_echo',
  'package::tests::streaming_roundtrip_preserves_offsets_order_empty_files_and_bounded_io',
  'package::tests::forged_header_overflow_noncanonical_manifest_truncation_and_trailing_bytes_fail',
  'package::tests::construction_never_claims_payload_verification_and_copy_checks_actual_returned_bytes',
  'package::tests::stale_index_rejects_changed_manifest_before_returning_any_payload',
  'package::tests::a_manifest_changed_during_an_otherwise_valid_copy_is_not_reported_as_verified',
  'package::tests::streaming_cancellation_stops_before_next_chunk_without_success_or_implicit_replay',
  'package::tests::writer_refuses_truncated_extended_or_wrong_digest_files_and_failed_output',
  'package::tests::full_two_gib_payload_fits_container_metadata_budget_without_allocating_the_payload',
];

export function windowsBrowserUploadSelections() {
  return [
    { slug: 'native-upload', testFilter: 'source_transfer::uploads::',
      expectedTests: uploads.map(name => `source_transfer::uploads::${name}`) },
    { slug: 'backup-container', testFilter: 'source_upload::',
      expectedTests: container.map(name => `source_upload::${name}`) },
  ];
}
