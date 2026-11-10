use super::proof::{self, Intent, Proof, digest, recipient_accounts};
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    CredentialBackend, CredentialStore, OsCredentialBackend, PrivateDirectory,
    imported_credentials::{CredentialGroupOutcome, ImportState, mcp::McpSecretValues},
};
use serde_json::{Value, json};
use std::{collections::BTreeSet, ffi::OsStr, io::Read, path::Path};
use zeroize::Zeroizing;

fn read(directory: &PrivateDirectory, name: &str, limit: u64) -> Result<Zeroizing<Vec<u8>>> {
    let file = directory.open_single_link_regular_file(OsStr::new(name))?;
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(limit + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= limit, "private_audit_budget");
    Ok(bytes)
}
fn json_read<T: serde::de::DeserializeOwned>(
    directory: &PrivateDirectory,
    name: &str,
) -> Result<T> {
    serde_json::from_slice(&read(directory, name, 1024 * 1024)?)
        .map_err(|_| anyhow::anyhow!("private_audit_record"))
}
fn save(root: &PrivateDirectory, value: &Proof) -> Result<()> {
    root.atomic_replace(OsStr::new(proof::PROOF), &serde_json::to_vec(value)?)
}
fn open_root(path: &Path, owner: &str, expected: Option<&str>) -> Result<PrivateDirectory> {
    ensure!(
        proof::uuid(owner)
            && path.is_absolute()
            && path.file_name() == Some(OsStr::new(&format!("kcoder-package-{owner}"))),
        "private_audit_root"
    );
    let root = PrivateDirectory::open_existing(path)?;
    root.verify_trusted_config_directory()?;
    if let Some(expected) = expected {
        ensure!(
            root.directory_identity()? == expected,
            "private_audit_identity"
        );
    }
    let marker: Value = json_read(&root, ".owner.json")?;
    ensure!(marker["owner"] == owner, "private_audit_owner");
    Ok(root)
}

/// This helper never calls backend set/delete or enumerates a vault.
pub(super) fn execute(args: Vec<String>) -> Result<Value> {
    ensure!((4..=5).contains(&args.len()), "private_audit_arguments");
    let (mode, path, owner) = (&args[1], Path::new(&args[2]), &args[3]);
    ensure!(
        (mode == "--vault-root" && args.len() == 4) || (mode != "--vault-root" && args.len() == 5),
        "private_audit_arguments"
    );
    let root = open_root(path, owner, args.get(4).map(String::as_str))?;
    if mode == "--vault-root" {
        let parent =
            PrivateDirectory::open_existing(path.parent().context("private_audit_parent")?)?;
        return Ok(
            json!({"status":"passed","rootIdentity":root.directory_identity()?,
            "parentIdentity":parent.directory_identity()?,"vaultCalls":0}),
        );
    }
    ensure!(
        [
            "--private-admit",
            "--private-bind",
            "--private-capture",
            "--private-final",
            "--private-unused-final"
        ]
        .contains(&mode.as_str()),
        "private_audit_mode"
    );
    let profile = root.open_child(OsStr::new(proof::PROFILE), false)?;
    profile.verify_trusted_config_directory()?;
    let settings_bytes = read(&profile, "settings.json", 1024 * 1024)?;
    let settings: Value = serde_json::from_slice(&settings_bytes)?;
    ensure!(
        settings["credential_store"] == "keyring",
        "private_audit_forced_keyring"
    );
    if mode == "--private-admit" {
        match root.entry_metadata(OsStr::new(proof::ADMISSION)) {
            Err(error) if missing(&error) => {}
            _ => anyhow::bail!("private_audit_prior_admission"),
        }
        let admission = proof::Admission {
            owner: owner.clone(),
            root_identity: root.directory_identity()?,
            profile_identity: profile.directory_identity()?,
            baseline: settings,
            write_dispatched: false,
        };
        root.atomic_replace(
            OsStr::new(proof::ADMISSION),
            &serde_json::to_vec(&admission)?,
        )?;
        return Ok(json!({"admitted":true,"vaultCalls":0}));
    }
    let mut admission: proof::Admission = json_read(&root, proof::ADMISSION)?;
    ensure!(
        admission.owner == *owner
            && admission.root_identity == root.directory_identity()?
            && admission.profile_identity == profile.directory_identity()?,
        "private_audit_admission_changed"
    );
    if mode == "--private-unused-final" {
        ensure!(
            !admission.write_dispatched && settings == admission.baseline,
            "private_audit_write_unknown"
        );
        match root.entry_metadata(OsStr::new(proof::PROOF)) {
            Err(error) if missing(&error) => {}
            _ => anyhow::bail!("private_audit_write_unknown"),
        }
        ensure_empty_credentials(&profile)?;
        return Ok(
            json!({"safeToRemoveRoot":true,"systemEntryAbsenceVerified":false,
            "noPrivateWriteDispatched":true,"referenceCount":0,"privateCaseNotCompleted":true}),
        );
    }
    let intent: Intent = json_read(&root, proof::INTENT)?;
    proof::validate_intent(&intent, owner)?;
    if mode == "--private-bind" {
        ensure!(
            !intent.write_dispatched && !admission.write_dispatched,
            "private_audit_prior_write"
        );
        match root.entry_metadata(OsStr::new(proof::PROOF)) {
            Err(error) if missing(&error) => {}
            _ => anyhow::bail!("private_audit_prior_proof"),
        }
        ensure_empty_credentials(&profile)?;
        let value = Proof {
            version: 1,
            owner: owner.clone(),
            root_identity: root.directory_identity()?,
            profile_identity: profile.directory_identity()?,
            request_id: intent.request_id,
            offers: intent.offers,
            source_sha256: intent.source_sha256,
            provider_names: intent.provider_names,
            mcp_names: intent.mcp_names,
            baseline: settings,
            references: None,
            group: None,
            recipient_sha256: None,
        };
        save(&root, &value)?;
        admission.write_dispatched = true;
        root.atomic_replace(
            OsStr::new(proof::ADMISSION),
            &serde_json::to_vec(&admission)?,
        )?;
        return Ok(json!({"bound":true,"vaultCalls":0,"recipientCount":2,"referenceCount":0}));
    }
    ensure!(
        admission.write_dispatched && intent.write_dispatched,
        "private_audit_missing_write_proof"
    );
    let mut proof: Proof = json_read(&root, proof::PROOF)?;
    ensure!(
        proof.version == 1
            && proof.owner == *owner
            && proof.root_identity == root.directory_identity()?
            && proof.profile_identity == profile.directory_identity()?
            && proof.request_id == intent.request_id
            && proof.offers == intent.offers
            && proof.source_sha256 == intent.source_sha256
            && proof.provider_names == intent.provider_names
            && proof.mcp_names == intent.mcp_names,
        "private_audit_proof_changed"
    );
    let credential_bytes = read(&profile, "credentials.json", 4 * 1024 * 1024)?;
    let document: CredentialStore = serde_json::from_slice(&credential_bytes)?;
    let refs: Vec<_> = document
        .imported_credentials
        .receipts
        .values()
        .map(|r| r.reference.clone())
        .collect();
    proof::validate_references(&proof, &refs)?;
    ensure!(
        document.imported_credentials.groups.len() == 1,
        "private_audit_groups"
    );
    let group = document
        .imported_credentials
        .groups
        .values()
        .next()
        .unwrap();
    ensure!(
        group.references.len() == 4 && refs.iter().all(|r| group.references.contains(r)),
        "private_audit_group_set"
    );
    if let Some(original) = &proof.references {
        ensure!(
            original == &refs && proof.group.as_deref() == Some(&group.group_id),
            "private_audit_refs_changed"
        );
    } else {
        ensure!(
            mode == "--private-capture" && group.outcome == CredentialGroupOutcome::Committed,
            "private_audit_missing_original_refs"
        );
        // Fix the original Native refs before the first audit backend read.
        proof.references = Some(refs.clone());
        proof.group = Some(group.group_id.clone());
        save(&root, &proof)?;
    }
    let accounts: BTreeSet<_> = refs
        .iter()
        .map(|r| r.account.clone())
        .chain(recipient_accounts(&proof.offers))
        .collect();
    ensure!(accounts.len() == 6, "private_audit_accounts");
    let backend = OsCredentialBackend::new();
    if mode == "--private-final" {
        ensure!(
            group.outcome == CredentialGroupOutcome::Undone
                && document.credentials.is_empty()
                && document
                    .imported_credentials
                    .receipts
                    .values()
                    .all(|r| r.state == ImportState::Undone)
                && settings == proof.baseline
                && proof.recipient_sha256.is_some(),
            "private_audit_not_undone"
        );
        for account in accounts {
            ensure!(
                backend.get(&account)?.is_none(),
                "private_audit_entry_remains"
            );
        }
        return Ok(
            json!({"safeToRemoveRoot":true,"systemEntryAbsenceVerified":true,"referenceCount":4,
            "recipientCount":2,"originalGroupUndone":true,"targetSettingsRestored":true,"fileBackendUsed":false}),
        );
    }
    ensure!(
        mode == "--private-capture"
            && group.outcome == CredentialGroupOutcome::Committed
            && document
                .imported_credentials
                .receipts
                .values()
                .all(|r| r.state == ImportState::Published),
        "private_audit_not_published"
    );
    ensure!(
        document.credentials.len() == 2,
        "private_audit_provider_bindings"
    );
    for r in &refs {
        ensure!(
            accounts.contains(&r.account),
            "private_audit_foreign_account"
        );
        let raw = Zeroizing::new(
            backend
                .get(&r.account)?
                .context("private_audit_entry_missing")?,
        );
        ensure!(raw.len() <= 8192, "private_audit_value_budget");
        ensure!(
            digest(raw.as_bytes())
                == document.imported_credentials.receipts[&r.operation_id].fingerprint,
            "private_audit_original_fingerprint_changed"
        );
        if r.subject.is_provider() {
            ensure!(
                document.credentials.get(&r.provider)
                    == Some(&kcoder_config::marker_for_provider(&r.account)),
                "private_audit_provider_binding_changed"
            );
        } else {
            let configs = settings["mcp_servers"]
                .as_array()
                .context("private_audit_mcp_configs")?;
            let config: kcoder_types::McpServerConfig = serde_json::from_value(
                configs
                    .iter()
                    .find(|v| v["name"] == r.provider)
                    .context("private_audit_mcp_config_missing")?
                    .clone(),
            )?;
            ensure!(
                config
                    .policy
                    .credential_ref
                    .as_ref()
                    .is_some_and(|v| v.id == r.operation_id)
                    && settings["mcp_disabled_servers"]
                        .as_array()
                        .is_some_and(|v| v.contains(&json!(r.provider))),
                "private_audit_mcp_binding_changed"
            );
        }
        let (value, index) = if r.subject.is_provider() {
            (
                Zeroizing::new(raw.to_string()),
                proof
                    .provider_names
                    .iter()
                    .position(|n| n == &r.provider)
                    .unwrap(),
            )
        } else {
            let values: McpSecretValues = serde_json::from_str(&raw)?;
            ensure!(
                values.env.len() == 1 && values.headers.is_empty(),
                "private_audit_mcp_fields"
            );
            (
                Zeroizing::new(
                    values
                        .env
                        .get("TOKEN")
                        .context("private_audit_mcp_missing")?
                        .clone(),
                ),
                2 + proof
                    .mcp_names
                    .iter()
                    .position(|n| n == &r.provider)
                    .unwrap(),
            )
        };
        ensure!(
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()),
            "private_audit_value_shape"
        );
        ensure!(
            digest(value.as_bytes()) == proof.source_sha256[index],
            "private_audit_value_changed"
        );
        for bytes in [&*settings_bytes, &*credential_bytes] {
            ensure!(
                !bytes
                    .windows(value.len())
                    .any(|part| part == value.as_bytes()),
                "private_audit_plaintext"
            );
        }
    }
    let mut fingerprints = Vec::new();
    for account in recipient_accounts(&proof.offers) {
        ensure!(accounts.contains(&account), "private_audit_foreign_account");
        let value = Zeroizing::new(
            backend
                .get(&account)?
                .context("private_audit_recipient_missing")?,
        );
        ensure!(
            value.len() == 44
                && value.ends_with('=')
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b)),
            "private_audit_recipient_shape"
        );
        fingerprints.push(digest(value.as_bytes()));
    }
    if let Some(original) = &proof.recipient_sha256 {
        ensure!(original == &fingerprints, "private_audit_recipient_changed");
    } else {
        proof.recipient_sha256 = Some(fingerprints);
        save(&root, &proof)?;
    }
    ensure!(
        profile.directory_identity()? == proof.profile_identity,
        "private_audit_identity"
    );
    Ok(
        json!({"publishedBindingsVerified":true,"referenceCount":4,"recipientCount":2,
        "vaultValuesMatched":true,"fileBackendUsed":false,"publicValuesAbsent":true}),
    )
}
fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|e| {
        e.downcast_ref::<std::io::Error>()
            .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
    })
}
fn ensure_empty_credentials(profile: &PrivateDirectory) -> Result<()> {
    match profile.entry_metadata(OsStr::new("credentials.json")) {
        Err(error) if missing(&error) => Ok(()),
        Ok(_) => {
            let previous: CredentialStore = json_read(profile, "credentials.json")?;
            ensure!(
                previous.credentials.is_empty()
                    && previous.imported_credentials.receipts.is_empty()
                    && previous.imported_credentials.groups.is_empty(),
                "private_audit_prior_credentials"
            );
            Ok(())
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn malformed_request_fails_before_any_root_or_vault_access() {
        assert!(super::execute(vec![]).is_err());
        assert!(
            super::execute(vec![
                "audit".into(),
                "--private-final".into(),
                "x".into(),
                "unowned".into(),
                "identity".into()
            ])
            .is_err()
        );
    }
    #[test]
    fn only_original_held_directory_admission_can_prove_no_private_write() {
        use super::*;
        let temp = tempfile::tempdir().unwrap();
        let owner = "10000000-0000-4000-8000-000000000000";
        let path = temp.path().join(format!("kcoder-package-{owner}"));
        let root = PrivateDirectory::open_or_create(&path).unwrap();
        root.atomic_replace(
            OsStr::new(".owner.json"),
            &serde_json::to_vec(&json!({"owner":owner})).unwrap(),
        )
        .unwrap();
        let profile = root
            .create_private_child(OsStr::new(proof::PROFILE))
            .unwrap();
        profile
            .atomic_replace(
                OsStr::new("settings.json"),
                br#"{"credential_store":"keyring","providers":{}}"#,
            )
            .unwrap();
        let call = |mode: &str| {
            execute(vec![
                "audit".into(),
                mode.into(),
                path.to_string_lossy().into(),
                owner.into(),
                root.directory_identity().unwrap(),
            ])
        };
        assert!(call("--private-unused-final").is_err());
        assert_eq!(call("--private-admit").unwrap()["vaultCalls"], 0);
        assert!(call("--private-admit").is_err());
        assert_eq!(
            call("--private-unused-final").unwrap()["noPrivateWriteDispatched"],
            true
        );
        let mut admission: proof::Admission = json_read(&root, proof::ADMISSION).unwrap();
        admission.write_dispatched = true;
        root.atomic_replace(
            OsStr::new(proof::ADMISSION),
            &serde_json::to_vec(&admission).unwrap(),
        )
        .unwrap();
        assert!(call("--private-unused-final").is_err());
    }
}
