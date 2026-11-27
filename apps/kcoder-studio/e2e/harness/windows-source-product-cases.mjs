// Fixed Native product tests; the binary may never define its own acceptance roster.
const tests = [
  'a_ready_upload_is_not_a_product_or_an_import_and_materialization_has_its_own_lease',
  'cancellation_keeps_the_original_upload_ready_and_resume_reconciles_the_original_product',
  'a_lost_file_publication_reply_reuses_its_inode_without_another_copy',
  'metadata_reservation_uses_actual_nodes_and_cannot_be_zero_for_empty_payloads',
  'a_missing_born_namespace_operation_or_intent_is_unknown_and_prepare_never_repairs_it',
  'equal_byte_replacements_unknown_files_and_a_foreign_profile_do_not_gain_product_authority',
  'publication::uploaded_configuration_skill_and_history_use_normal_explicit_batch_publish_reopen_and_undo',
  'publication::same_inode_mutations_cannot_be_recaptured_as_uploaded_configuration_assets_or_history',
  'publication::transferred_uploaded_provenance_survives_source_removal_and_three_receiving_bindings_reopen',
  'memory::uploaded_memory_never_invents_an_original_mtime_and_received_provenance_retains_unknown_time',
  'memory::a_fresh_memory_inventory_cannot_recapture_same_inode_changed_uploaded_bytes',
];

export function windowsSourceProductSelection() {
  const testFilter = 'source_transfer::uploads::materialization::tests::';
  return { slug: 'uploaded-product', testFilter, expectedTests: tests.map(name => testFilter + name) };
}
