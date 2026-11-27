use super::{backend::AuditedBackend, fixture::*};
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    CredentialBackend, CredentialStore, CredentialStoreMode, PrivateDirectory,
    imported_credentials::{
        CredentialGroupOutcome, ImportState, ImportedCredentialStore, mcp::McpSecretValues,
    },
};
use kcoder_types::McpServerConfig;
use serde_json::{Value, json};
use std::{collections::BTreeMap, ffi::OsStr, path::Path};
use zeroize::{Zeroize, Zeroizing};

struct PrivateResolved(BTreeMap<String, String>);
impl Drop for PrivateResolved {
    fn drop(&mut self) {
        for value in self.0.values_mut() {
            value.zeroize();
        }
    }
}

fn accounts(intent: &Intent) -> Result<Vec<String>> {
    Ok(refs(intent)?.iter().map(|r| r.account.clone()).collect())
}

fn bound_mcp(intent: &Intent) -> Result<McpServerConfig> {
    let mut config = intent
        .mcp_config
        .clone()
        .context("core_mcp_config_missing")?;
    config.policy.credential_ref = Some(
        intent
            .mcp
            .as_ref()
            .context("core_mcp_reference_missing")?
            .mcp_reference()?,
    );
    Ok(config)
}

fn store_path(root: &Path) -> std::path::PathBuf {
    root.join(PROFILE)
}

pub(super) fn publish(root: &PrivateDirectory, path: &Path, owner: &str) -> Result<Value> {
    match root.entry_metadata(OsStr::new(INTENT)) {
        Ok(_) => anyhow::bail!("core_prior_intent_requires_reconciliation"),
        Err(error)
            if error.chain().any(|e| {
                e.downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            }) => {}
        Err(error) => return Err(error),
    }
    let mut intent = initial_intent(root, owner)?;
    save(root, &intent)?;
    let profile = root.create_private_child(OsStr::new(PROFILE))?;
    intent.profile_identity = Some(profile.directory_identity()?);
    save(root, &intent)?;
    profile.atomic_replace(
        OsStr::new("settings.json"),
        &serde_json::to_vec(&intent.baseline)?,
    )?;
    let target = ImportedCredentialStore::open(&store_path(path))?;
    let prepare_backend = AuditedBackend::new(Vec::new());
    let name = format!("ImportedE2E{}", owner.replace('-', ""));
    intent.provider =
        Some(target.prepare(&name, CredentialStoreMode::Keyring, &prepare_backend)?);
    let mcp: McpServerConfig = serde_json::from_value(json!({
        "name":format!("mcp-e2e-{}",owner.replace('-',"")),"transport":"http","url":"http://127.0.0.1:9/mcp",
        "policy":{"required_headers":["Authorization","X-Client"]}
    }))?;
    intent.mcp = Some(target.prepare_mcp(
        &mcp,
        &[],
        &["Authorization".into(), "X-Client".into()],
        CredentialStoreMode::Keyring,
        &prepare_backend,
    )?);
    intent.mcp_config = Some(mcp);
    let key = random_secret()?;
    let private_mcp = random_secret()?;
    let payload = McpSecretValues {
        env: BTreeMap::new(),
        headers: BTreeMap::from([
            ("Authorization".into(), format!("Bearer {}", &*private_mcp)),
            ("X-Client".into(), private_mcp.to_string()),
        ]),
    }
    .encode()?;
    intent.provider_fingerprint = Some(digest(&key));
    intent.mcp_fingerprint = Some(digest(&payload));
    intent.phase = "keys_may_be_written".into();
    save(root, &intent)?;
    let backend = AuditedBackend::new(accounts(&intent)?);
    let references = refs(&intent)?;
    backend.lose_next_set_reply();
    ensure!(
        target.stage(references[0], &key, &backend).is_err(),
        "core_set_reply_was_not_lost"
    );
    ensure!(
        target.state(references[0], &backend)? == Some(ImportState::Staged),
        "core_lost_set_checkpoint_missing"
    );
    ensure!(backend.calls().set == 1, "core_lost_set_did_not_reach_os");
    drop(target);
    let target = ImportedCredentialStore::open(&store_path(path))?;
    target.stage(references[0], &key, &backend)?;
    ensure!(backend.calls().set == 1, "core_lost_set_was_replayed");
    target.stage(references[1], &payload, &backend)?;
    no_plaintext(&profile, &[&key, &private_mcp])?;
    no_plaintext(root, &[&key, &private_mcp])?;
    let before = CredentialStore::load_from(&store_path(path).join("credentials.json"))?;
    ensure!(
        !before.credentials.contains_key(&references[0].provider),
        "core_staged_key_became_active"
    );
    let mcp = bound_mcp(&intent)?;
    let receipt = target.publish_group(&intent.group, &[references[0].clone(),references[1].clone()], &backend, |document| {
        document["providers"] = json!({(name.clone()):{"api_format":"openai_chat_completions","endpoint":"http://127.0.0.1:9/v1",
            "default_model":"fixture","context_window_tokens":64000,"max_output_tokens":8192,"output_headroom_tokens":8192}});
        document["active_provider"] = json!(name);document["credential_store"] = json!("keyring");
        document["mcp_disabled_servers"] = json!([mcp.name.clone()]);
        document["mcp_servers"] = json!([mcp]);Ok(())
    })?;
    ensure!(
        receipt.outcome == CredentialGroupOutcome::Committed,
        "core_group_not_committed"
    );
    let published_settings =
        kcoder_config::read_settings_file(&store_path(path).join("settings.json"))?;
    ensure!(
        published_settings["mcp_disabled_servers"]
            .as_array()
            .is_some_and(|names| names.contains(&json!(mcp.name))),
        "core_mcp_not_disabled"
    );
    no_plaintext(&profile, &[&key, &private_mcp])?;
    no_plaintext(root, &[&key, &private_mcp])?;
    ensure!(backend.calls().set == 2, "core_unexpected_backend_writes");
    intent.phase = "committed_receipt_withheld".into();
    save(root, &intent)?;
    Ok(
        json!({"status":"passed","stage":"core_group_published_pending_independent_reopen",
        "fileBackendUsed":false,"providerAndMcp":true,"referenceCount":2,"lostSetReconciledWithoutReplay":true,
        "groupReceiptDeliberatelyWithheld":true,"targetFilesContainNoOriginalValues":true,
        "backend":backend.describe(),"calls":backend.calls(),"availabilityProbeReadOnly":true,
        "availabilityProbeReads":prepare_backend.calls().available+backend.calls().available,"mcpImportedDisabled":true}),
    )
}

pub(super) fn reopen_and_undo(root: &PrivateDirectory, path: &Path, owner: &str) -> Result<Value> {
    let mut intent = load(root, owner)?;
    let profile = profile(root, &intent)?;
    let references = refs(&intent)?;
    let backend = AuditedBackend::new(accounts(&intent)?);
    let target = ImportedCredentialStore::open(&store_path(path))?;
    for reference in references {
        ensure!(
            target.state(reference, &backend)? == Some(ImportState::Published),
            "core_published_state_missing"
        );
    }
    let key = Zeroizing::new(
        backend
            .get(&references[0].account)?
            .context("core_provider_backing_missing")?,
    );
    let payload = Zeroizing::new(
        backend
            .get(&references[1].account)?
            .context("core_mcp_backing_missing")?,
    );
    ensure!(
        Some(digest(&key)) == intent.provider_fingerprint
            && Some(digest(&payload)) == intent.mcp_fingerprint,
        "core_backing_changed"
    );
    let document = CredentialStore::load_from(&store_path(path).join("credentials.json"))?;
    let (resolved, diagnostics) = kcoder_config::resolve_stored_credentials(
        &document.credentials,
        &backend,
        CredentialStoreMode::Keyring,
    );
    let resolved = PrivateResolved(resolved);
    ensure!(
        diagnostics.is_empty()
            && resolved.0.len() == 1
            && resolved.0.get(&references[0].provider) == Some(&*key),
        "core_provider_resolution_failed"
    );
    let private_mcp = target.resolve_mcp_with_mode(
        &bound_mcp(&intent)?,
        CredentialStoreMode::Keyring,
        &backend,
    )?;
    let header = private_mcp
        .headers
        .get("X-Client")
        .context("core_mcp_header_missing")?;
    ensure!(
        private_mcp.headers.get("Authorization") == Some(&format!("Bearer {header}")),
        "core_mcp_resolution_failed"
    );
    no_plaintext(&profile, &[&key, header])?;
    no_plaintext(root, &[&key, header])?;
    let receipt = target
        .group_receipt(&intent.group)?
        .context("core_group_receipt_missing")?;
    let reread = target.publish_group(
        &intent.group,
        &[references[0].clone(), references[1].clone()],
        &backend,
        |_| anyhow::bail!("core_publication_callback_replayed"),
    )?;
    ensure!(
        reread == receipt && backend.calls().set == 0,
        "core_group_receipt_replay_changed_state"
    );
    let other = root.create_private_child(OsStr::new("foreign-profile"))?;
    other.atomic_replace(
        OsStr::new("settings.json"),
        b"{\"credential_store\":\"keyring\"}",
    )?;
    let foreign = ImportedCredentialStore::open(&path.join("foreign-profile"))?;
    let before = backend.calls();
    ensure!(
        foreign.state(references[0], &backend).is_err()
            && foreign.undo(references[0], &backend).is_err(),
        "core_wrong_profile_reference_accepted"
    );
    ensure!(
        serde_json::to_value(&before)? == serde_json::to_value(backend.calls())?,
        "core_foreign_profile_touched_backend"
    );
    ensure!(
        target.undo(references[0], &backend).is_err(),
        "core_grouped_key_removed_independently"
    );
    let undone = target.undo_group(&intent.group, &backend, |document| {
        *document = intent.baseline.clone();
        Ok(())
    })?;
    ensure!(
        undone.outcome == CredentialGroupOutcome::Undone,
        "core_group_undo_failed"
    );
    backend.lose_next_delete_reply();
    ensure!(
        target.undo(references[0], &backend).is_err(),
        "core_delete_reply_was_not_lost"
    );
    ensure!(
        target.state(references[0], &backend)? == Some(ImportState::Undoing),
        "core_lost_delete_checkpoint_missing"
    );
    ensure!(
        backend.get(&references[0].account)?.is_none(),
        "core_delete_did_not_reach_os"
    );
    ensure!(
        target.stage(references[0], &key, &backend).is_err(),
        "core_undoing_key_reinstalled"
    );
    ensure!(
        backend.calls().set == 0 && backend.calls().delete == 1,
        "core_undo_backend_boundary_changed"
    );
    no_plaintext(&profile, &[&key, header])?;
    no_plaintext(root, &[&key, header])?;
    intent.phase = "undoing_delete_receipt_withheld".into();
    save(root, &intent)?;
    Ok(
        json!({"status":"passed","stage":"core_reopened_and_group_undone_pending_delete_reconciliation",
        "fileBackendUsed":false,"providerResolved":true,"mcpResolved":true,"targetFilesContainNoOriginalValues":true,
        "originalGroupReceiptReconciledWithoutCallback":true,"wrongProfileRejectedBeforeBackend":true,
        "groupedRemovalBlocked":true,"lostDeleteReachedOs":true,"undoingBlocksReinstall":true,"calls":backend.calls()}),
    )
}

pub(super) fn cleanup(root: &PrivateDirectory, path: &Path, owner: &str) -> Result<Value> {
    let intent = load(root, owner)?;
    if intent.phase == "preparing" {
        ensure!(
            intent.provider.is_none() && intent.mcp.is_none(),
            "core_preparation_state_conflict"
        );
        return Ok(
            json!({"safeToRemoveRoot":true,"systemEntryAbsenceVerified":false,
            "noBackendWriteDispatched":true,"referenceCount":0,"coreCaseNotCompleted":true}),
        );
    }
    let _profile = profile(root, &intent)?;
    let references = refs(&intent)?;
    let backend = AuditedBackend::new(accounts(&intent)?);
    let target = ImportedCredentialStore::open(&store_path(path))?;
    if let Some(group) = target.group_receipt(&intent.group)?
        && group.outcome == CredentialGroupOutcome::Committed
    {
        target.undo_group(&intent.group, &backend, |document| {
            *document = intent.baseline.clone();
            Ok(())
        })?;
    }
    let mut all_undone = true;
    for reference in references {
        if target.state(reference, &backend)?.is_some() {
            ensure!(
                target.undo(reference, &backend)? == ImportState::Undone,
                "core_cleanup_not_undone"
            );
        } else {
            all_undone = false;
        }
        ensure!(
            backend.get(&reference.account)?.is_none(),
            "core_cleanup_entry_remains"
        );
    }
    let current = kcoder_config::read_settings_file(&store_path(path).join("settings.json"))?;
    ensure!(
        current == intent.baseline,
        "core_target_settings_not_restored"
    );
    let credentials = CredentialStore::load_from(&store_path(path).join("credentials.json"))?;
    ensure!(
        credentials.credentials.is_empty(),
        "core_active_bindings_remain"
    );
    ensure!(
        target
            .resolve_mcp_with_mode(&bound_mcp(&intent)?, CredentialStoreMode::Keyring, &backend)
            .is_err(),
        "core_mcp_binding_remains_active"
    );
    if intent.phase == "undoing_delete_receipt_withheld" {
        ensure!(backend.calls().delete == 1, "core_lost_delete_was_replayed");
    }
    let group_undone = target
        .group_receipt(&intent.group)?
        .is_some_and(|group| group.outcome == CredentialGroupOutcome::Undone);
    Ok(
        json!({"safeToRemoveRoot":true,"systemEntryAbsenceVerified":true,"fileBackendUsed":false,
        "coreStateUndone":all_undone && group_undone,"referenceCount":2,"targetSettingsRestored":true,"activeBindingsAbsent":true,
        "lostDeleteReconciledWithoutReplay":intent.phase=="undoing_delete_receipt_withheld","calls":backend.calls()}),
    )
}
