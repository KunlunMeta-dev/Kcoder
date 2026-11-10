//! Explicit owned-user Core acceptance. No ordinary profile or credential is read.
#[cfg(windows)]
#[path = "windows_imported_credential_security/backend.rs"]
mod backend;
#[cfg(windows)]
#[path = "windows_imported_credential_security/core.rs"]
mod core;
#[cfg(windows)]
#[path = "windows_imported_credential_security/fixture.rs"]
mod fixture;
#[cfg(windows)]
#[path = "windows_imported_credential_security/host_audit.rs"]
mod host_audit;

#[cfg(windows)]
fn execute() -> anyhow::Result<serde_json::Value> {
    use anyhow::ensure;
    let args: Vec<String> = std::env::args().collect();
    ensure!((4..=5).contains(&args.len()), "core_invalid_arguments");
    let mode = &args[1];
    let path = std::path::Path::new(&args[2]);
    let owner = &args[3];
    ensure!(
        (mode == "--vault-root" && args.len() == 4) || (mode != "--vault-root" && args.len() == 5),
        "core_invalid_arguments"
    );
    let root = fixture::open_root(path, owner, args.get(4).map(String::as_str))?;
    if mode == "--vault-root" {
        let parent = kcoder_config::PrivateDirectory::open_existing(
            path.parent()
                .ok_or_else(|| anyhow::anyhow!("core_parent_missing"))?,
        )?;
        return Ok(
            serde_json::json!({"status":"passed","rootIdentity":root.directory_identity()?,"parentIdentity":parent.directory_identity()?,"vaultCalls":0}),
        );
    }
    match mode.as_str() {
        "--host-bind" | "--host-capture" | "--host-final" | "--host-unused-final" => {
            host_audit::execute(&root, path, owner, mode)
        }
        "--core-publish" => core::publish(&root, path, owner),
        "--core-reopen-undo" => core::reopen_and_undo(&root, path, owner),
        "--core-cleanup" => core::cleanup(&root, path, owner),
        _ => anyhow::bail!("core_invalid_mode"),
    }
}

#[cfg(any(windows, test))]
fn public_error_code(error: &anyhow::Error) -> &'static str {
    const CODES: &[&str] = &[
        "core_host_backing_missing",
        "core_host_entry_remains",
        "core_host_foreign_account",
        "core_host_group_missing",
        "core_host_group_undo_unconfirmed",
        "core_host_invalid_mode",
        "core_host_invalid_native_reference",
        "core_host_invalid_proof",
        "core_host_mcp_missing",
        "core_host_mcp_not_disabled",
        "core_host_mcp_value_changed",
        "core_host_mcp_value_missing",
        "core_host_native_state_not_published",
        "core_host_native_undo_unconfirmed",
        "core_host_original_references_missing",
        "core_host_prior_proof_requires_read",
        "core_host_profile_was_not_empty",
        "core_host_proof_changed",
        "core_host_provider_not_resolved",
        "core_host_provider_value_changed",
        "core_host_readonly_auditor",
        "core_host_reference_collision",
        "core_host_source_digest_invalid",
        "core_host_source_digest_missing",
        "core_host_source_owner_changed",
        "core_host_target_changed",
        "core_host_target_not_restored",
        "core_host_uncommitted_group",
        "core_host_unexpected_private_mutation",
        "core_host_unexpected_reference_count",
        "core_host_windows_node_capacity_unexpected",
        "core_host_write_may_have_run",
        "core_host_wrong_group_count",
        "core_host_wrong_native_subject",
        "core_active_bindings_remain",
        "core_backing_changed",
        "core_cleanup_entry_remains",
        "core_cleanup_not_undone",
        "core_delete_did_not_reach_os",
        "core_delete_reply_was_not_lost",
        "core_entropy_unavailable",
        "core_file_fallback_forbidden",
        "core_fixture_account_invalid",
        "core_fixture_group_changed",
        "core_fixture_inspection_budget",
        "core_fixture_intent_changed",
        "core_fixture_intent_invalid",
        "core_fixture_profile_changed",
        "core_fixture_record_budget",
        "core_fixture_record_invalid",
        "core_fixture_reference_collision",
        "core_fixture_reference_profile_changed",
        "core_fixture_unexpected_file_kind",
        "core_foreign_profile_touched_backend",
        "core_group_not_committed",
        "core_group_published_pending_independent_reopen",
        "core_group_receipt_missing",
        "core_group_receipt_replay_changed_state",
        "core_group_undo_failed",
        "core_grouped_key_removed_independently",
        "core_invalid_arguments",
        "core_invalid_mode",
        "core_invalid_owner",
        "core_invalid_root",
        "core_lost_delete_checkpoint_missing",
        "core_lost_delete_was_replayed",
        "core_lost_real_delete_reply",
        "core_lost_real_set_reply",
        "core_lost_set_checkpoint_missing",
        "core_lost_set_did_not_reach_os",
        "core_lost_set_was_replayed",
        "core_mcp_backing_missing",
        "core_mcp_binding_remains_active",
        "core_mcp_config_missing",
        "core_mcp_header_missing",
        "core_mcp_not_disabled",
        "core_mcp_reference_missing",
        "core_mcp_resolution_failed",
        "core_parent_missing",
        "core_plaintext_leak",
        "core_preparation_state_conflict",
        "core_prior_intent_requires_reconciliation",
        "core_profile_identity_missing",
        "core_provider_backing_missing",
        "core_provider_reference_missing",
        "core_provider_resolution_failed",
        "core_publication_callback_replayed",
        "core_published_state_missing",
        "core_reopened_and_group_undone_pending_delete_reconciliation",
        "core_root_identity_changed",
        "core_root_owner_changed",
        "core_set_reply_was_not_lost",
        "core_staged_key_became_active",
        "core_target_settings_not_restored",
        "core_undo_backend_boundary_changed",
        "core_undoing_key_reinstalled",
        "core_unexpected_backend_writes",
        "core_unowned_backend_account",
        "core_wrong_profile_reference_accepted",
    ];
    let message = error.to_string();
    CODES
        .iter()
        .copied()
        .find(|code| *code == message)
        .unwrap_or("core_credential_helper_failed")
}

#[cfg(windows)]
fn main() {
    match execute() {
        Ok(value) => println!("{value}"),
        // Only static errors are retained; raw backend chains or secret values are never printed.
        Err(error) => {
            eprintln!("{}", public_error_code(&error));
            std::process::exit(2);
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("core_credential_helper_requires_windows");
    std::process::exit(2);
}

#[cfg(test)]
mod tests {
    use super::public_error_code;

    #[test]
    fn arbitrary_backend_io_and_json_errors_never_publish_their_values() {
        let secret = "SYNTHETIC_CORE_BACKEND_VALUE_NEVER_PUBLIC";
        let json_error =
            serde_json::from_str::<bool>(&serde_json::to_string(secret).unwrap()).unwrap_err();
        for error in [
            anyhow::anyhow!("backend rejected value {secret}"),
            anyhow::Error::from(std::io::Error::other(secret)),
            anyhow::Error::from(json_error),
            anyhow::anyhow!("core_{secret}"),
        ] {
            assert_eq!(public_error_code(&error), "core_credential_helper_failed");
            assert!(!public_error_code(&error).contains(secret));
        }
    }

    #[test]
    fn only_fixed_example_codes_are_public_and_context_never_prints_a_chain() {
        let secret = "SYNTHETIC_CORE_CONTEXT_VALUE_NEVER_PUBLIC";
        let error = anyhow::anyhow!("backend {secret}").context("core_backing_changed");
        assert_eq!(public_error_code(&error), "core_backing_changed");
        let code = public_error_code(&error);
        assert!(code.len() <= 96 && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'));
        assert_eq!(
            public_error_code(&anyhow::anyhow!("credential_import_backend_unavailable")),
            "core_credential_helper_failed"
        );
    }
}
