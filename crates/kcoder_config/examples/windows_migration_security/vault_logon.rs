//! Test-only two-process vault proof. Plaintext never leaves the writing process.
use super::*;
use std::fmt::Write as _;

pub(super) fn execute(
    directory: &PrivateDirectory,
    root: &std::path::Path,
    owner: &str,
    mode: &str,
    expected: Option<&str>,
) -> Result<Value> {
    let identity = directory.directory_identity()?;
    if mode == "--vault-root" {
        ensure!(expected.is_none(), "invalid_vault_root_arguments");
        let parent =
            PrivateDirectory::open_existing(root.parent().context("owned_parent_missing")?)?
                .directory_identity()?;
        return Ok(
            json!({"status":"passed","stage":"root_observed_without_vault_access", "rootIdentity":identity,"parentIdentity":parent,"vaultCalls":0}),
        );
    }
    ensure!(
        expected == Some(identity.as_str()),
        "owned_vault_root_changed"
    );
    if mode == "--vault-cleanup" {
        if load_intent(directory, owner)?.is_none() {
            let current = OsCredentialBackend::new()
                .get(&account(owner))?
                .map(Zeroizing::new);
            return Ok(json!({"safeToRemoveRoot":current.is_none(),
                "disposition":if current.is_none(){"not_written_absence_verified"}else{"untracked_uuid_entry_retained"},
                "systemEntryAbsenceVerified":current.is_none()}));
        }
        return clean_credential(directory, owner);
    }
    let backend = OsCredentialBackend::new();
    let name = account(owner);
    if mode == "--vault-reopen" {
        let intent = load_intent(directory, owner)?.context("owned_vault_intent_missing")?;
        ensure!(intent.write_attempted, "owned_vault_write_not_attempted");
        let value = backend
            .get(&name)?
            .map(Zeroizing::new)
            .context("owned_vault_entry_missing_on_reopen")?;
        ensure!(
            digest(&value) == intent.secret_sha256,
            "owned_vault_entry_changed"
        );
        drop(value);
        let cleanup = clean_credential(directory, owner)?;
        ensure!(
            cleanup["safeToRemoveRoot"] == true && cleanup["systemEntryAbsenceVerified"] == true,
            "owned_vault_cleanup_unconfirmed"
        );
        return Ok(
            json!({"status":"passed","stage":"reopened_and_deleted","backend":backend.describe(),
            "fileBackendUsed":false,"exactRandomAccountOnly":true,"readbackMatched":true,
            "enumeratedAccounts":false,"cleanup":cleanup}),
        );
    }
    ensure!(mode == "--vault-write", "invalid_vault_mode");
    ensure!(
        load_intent(directory, owner)?.is_none(),
        "existing_intent_reconcile_only"
    );
    // Do not call available(): it reads a fixed legacy account, outside this UUID.
    ensure!(
        backend.get(&name)?.is_none(),
        "owned_vault_random_account_collision"
    );
    let mut entropy = Zeroizing::new([0u8; 32]);
    getrandom::fill(&mut *entropy)
        .map_err(|_| anyhow::anyhow!("owned_vault_entropy_unavailable"))?;
    let mut secret = Zeroizing::new(String::with_capacity(64));
    for byte in entropy.iter() {
        write!(&mut *secret, "{byte:02x}").context("owned_vault_value_encoding_failed")?;
    }
    let mut intent = Intent {
        owner: owner.into(),
        account: name.clone(),
        secret_sha256: digest(&secret),
        write_attempted: false,
    };
    directory.atomic_replace(OsStr::new(INTENT), &serde_json::to_vec(&intent)?)?;
    intent.write_attempted = true;
    directory.atomic_replace(OsStr::new(INTENT), &serde_json::to_vec(&intent)?)?;
    backend.set(&name, &secret)?;
    let actual = backend
        .get(&name)?
        .map(Zeroizing::new)
        .context("owned_vault_write_unconfirmed")?;
    ensure!(
        digest(&actual) == intent.secret_sha256,
        "owned_vault_write_changed"
    );
    Ok(
        json!({"status":"passed","stage":"written_pending_independent_reopen","backend":backend.describe(),
        "fileBackendUsed":false,"exactRandomAccountOnly":true,"readbackMatched":true,
        "enumeratedAccounts":false,"plainValueExported":false}),
    )
}
