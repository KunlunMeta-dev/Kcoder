// Explicit normal-release Native cases; neither an OS-vault nor a Host transport assertion.
const tests = [
  'source_transfer::private_credentials::crypto::tests::explicit_hpke_implementation_opens_the_published_rfc_suite_vector',
  'source_transfer::private_credentials::crypto::tests::private_payload_framing_rejects_extra_slots_truncation_length_overflow_and_trailing_bytes',
  'source_transfer::private_credentials::crypto::tests::low_order_recipient_and_noncanonical_keys_fail_without_a_plaintext_fallback',
  'source_transfer::private_credentials::crypto::tests::standard_hpke_one_shot_roundtrip_restores_the_same_key_without_a_global_provider',
  'source_transfer::private_credentials::crypto::tests::hpke_rejects_a_different_recipient_aad_tampering_or_malformed_ciphertext',
  'source_transfer::tests::private_credential_candidates::received_private_candidates_are_paginated_original_metadata_without_secret_or_key_birth',
  'source_transfer::tests::private_credential_recovery::a_verified_receive_intent_without_its_receipt_is_pending_only_while_the_original_writer_runs',
  'source_transfer::tests::private_credential_recovery::a_missing_verified_receive_receipt_is_unknown_and_is_never_republished',
  'source_transfer::tests::private_credential_recovery::custody_observes_the_actual_writer_and_a_cancel_request_does_not_mean_it_stopped',
  'source_transfer::tests::private_credential_recovery::an_oversized_offer_is_rejected_before_a_recipient_key_or_private_namespace_is_born',
  'source_transfer::tests::private_credential_recovery::private_recovery_reopens_original_offer_cipher_and_received_binding_without_replay',
  'source_transfer::tests::private_credential_recovery::rejected_ciphertext_is_not_a_verified_receive_and_observation_never_recreates_a_key',
  'source_transfer::tests::private_credential_recovery::unknown_private_material_does_not_block_original_grant_cancellation_or_clear_snapshot_cancel',
  'source_transfer::tests::private_credentials::changed_source_does_not_reseal_and_an_unused_offer_can_be_cancelled_then_released',
  'source_transfer::tests::private_credentials::existing_key_or_ciphertext_loss_never_creates_another_key_or_envelope',
  'source_transfer::tests::private_credentials::forced_keyring_keeps_the_original_key_and_never_falls_back_or_touches_a_foreign_profile',
  'source_transfer::tests::private_credentials::independent_explicit_consents_and_actual_target_peer_are_required',
  'source_transfer::tests::private_credentials::local_credential_plan_source_keeps_the_exact_existing_json_shape',
  'source_transfer::tests::private_credentials::private_cancel_is_available_during_the_owned_writer_and_cannot_clear_another_domain',
  'source_transfer::tests::private_credentials::private_values_use_an_independent_ciphertext_channel_and_reopen_with_source_offline',
  'source_transfer::tests::private_credentials::native_catalog_or_same_bytes_key_replacement_is_unknown_and_is_never_repaired',
  'source_transfer::tests::private_credentials::unpublished_key_deletion_reconciles_only_the_original_account_after_a_lost_reply',
  'source_transfer::tests::private_credentials::cancelling_a_prepared_private_batch_releases_never_staged_material_after_formal_rollback',
  'source_transfer::tests::private_credentials::encrypted_inputs_enter_the_original_batch_group_and_undo_after_source_removal',
];

export function windowsPrivateCredentialSelections() {
  return ['source_transfer::private_credentials::crypto::tests::', 'source_transfer::tests::private_credentials::',
    'source_transfer::tests::private_credential_recovery::', 'source_transfer::tests::private_credential_candidates::'].map((testFilter, index) =>
    ({ slug: `private-credentials-${index}`, testFilter, expectedTests: tests.filter(name => name.startsWith(testFilter)) }));
}
