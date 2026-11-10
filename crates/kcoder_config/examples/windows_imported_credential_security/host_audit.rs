//! Read-only proof of the actual Host-created references. This never publishes or deletes a key.
use super::fixture::{self, PROFILE};
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    CredentialBackend, CredentialStore, CredentialStoreMode, OsCredentialBackend, PrivateDirectory,
    imported_credentials::{
        CredentialGroupOutcome, CredentialImportRef, ImportState, ImportedCredentialStore,
        mcp::CredentialSubject,
    },
};
use kcoder_types::McpServerConfig;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeSet, ffi::OsStr, path::Path};
use zeroize::Zeroizing;

const STATE: &str = "host-native-credential-proof.json";
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Proof {
    version: u32,
    owner: String,
    root_identity: String,
    profile_identity: String,
    baseline: Value,
    provider_sha256: String,
    mcp_sha256: String,
    references: Option<Vec<CredentialImportRef>>,
    group: Option<String>,
}

struct Reader {
    backend: OsCredentialBackend,
    accounts: BTreeSet<String>,
}
impl CredentialBackend for Reader {
    fn describe(&self) -> String {
        self.backend.describe()
    }
    fn available(&self) -> bool {
        self.backend.available()
    }
    fn get(&self, account: &str) -> Result<Option<String>> {
        ensure!(self.accounts.contains(account), "core_host_foreign_account");
        self.backend.get(account)
    }
    fn set(&self, _: &str, _: &str) -> Result<()> {
        anyhow::bail!("core_host_readonly_auditor")
    }
    fn delete(&self, _: &str) -> Result<()> {
        anyhow::bail!("core_host_readonly_auditor")
    }
}

fn profile(root: &PrivateDirectory) -> Result<PrivateDirectory> {
    let profile = root.open_child(OsStr::new(PROFILE), false)?;
    profile.verify_trusted_config_directory()?;
    Ok(profile)
}
fn save(root: &PrivateDirectory, proof: &Proof) -> Result<()> {
    root.atomic_replace(OsStr::new(STATE), &serde_json::to_vec(proof)?)
}
fn load(root: &PrivateDirectory, owner: &str) -> Result<Proof> {
    let proof: Proof = serde_json::from_value(fixture::read_value(root, STATE, 128 * 1024)?)
        .map_err(|_| anyhow::anyhow!("core_host_invalid_proof"))?;
    ensure!(
        proof.version == 1
            && proof.owner == owner
            && proof.root_identity == root.directory_identity()?
            && proof.profile_identity == profile(root)?.directory_identity()?,
        "core_host_proof_changed"
    );
    Ok(proof)
}

pub(super) fn execute(
    root: &PrivateDirectory,
    path: &Path,
    owner: &str,
    mode: &str,
) -> Result<Value> {
    let target_path = path.join(PROFILE);
    if mode == "--host-bind" {
        match root.entry_metadata(OsStr::new(STATE)) {
            Ok(_) => anyhow::bail!("core_host_prior_proof_requires_read"),
            Err(e)
                if e.chain().any(|e| {
                    e.downcast_ref::<std::io::Error>()
                        .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
                }) => {}
            Err(e) => return Err(e),
        }
        let source = fixture::read_value(root, "host-source-digests.json", 8192)?;
        ensure!(source["owner"] == owner, "core_host_source_owner_changed");
        let p = source["providerSha256"]
            .as_str()
            .context("core_host_source_digest_missing")?;
        let m = source["mcpSha256"]
            .as_str()
            .context("core_host_source_digest_missing")?;
        ensure!(
            [p, m]
                .iter()
                .all(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit())),
            "core_host_source_digest_invalid"
        );
        ensure!(
            !target_path.join("credentials.json").exists(),
            "core_host_profile_was_not_empty"
        );
        let proof = Proof {
            version: 1,
            owner: owner.into(),
            root_identity: root.directory_identity()?,
            profile_identity: profile(root)?.directory_identity()?,
            baseline: kcoder_config::read_settings_file(&target_path.join("settings.json"))?,
            provider_sha256: p.into(),
            mcp_sha256: m.into(),
            references: None,
            group: None,
        };
        // Preserve the no-key intent before the independent platform-capacity observation.
        save(root, &proof)?;
        let capacity = root.available_storage()?;
        ensure!(
            capacity.file_nodes.is_none(),
            "core_host_windows_node_capacity_unexpected"
        );
        return Ok(
            json!({"status":"passed","bound":true,"vaultCalls":0,"storageQuerySucceeded":true,"storageFileNodesKnown":false}),
        );
    }
    let mut proof = load(root, owner)?;
    let document = CredentialStore::load_from(&target_path.join("credentials.json"))?;
    let target = ImportedCredentialStore::open(&target_path)?;
    if mode == "--host-unused-final" {
        ensure!(
            proof.references.is_none()
                && proof.group.is_none()
                && document.imported_credentials.receipts.is_empty()
                && document.imported_credentials.groups.is_empty()
                && document.credentials.is_empty(),
            "core_host_unexpected_private_mutation"
        );
        let locator = fixture::read_value(root, "host-request-intent.json", 128 * 1024)?;
        ensure!(
            locator["owner"] == owner && locator["applyMayHaveRun"] == false,
            "core_host_write_may_have_run"
        );
        ensure!(
            kcoder_config::read_settings_file(&target_path.join("settings.json"))?
                == proof.baseline,
            "core_host_target_changed"
        );
        return Ok(
            json!({"safeToRemoveRoot":true,"systemEntryAbsenceVerified":false,"noHostWriteDispatched":true,"referenceCount":0,"hostCaseNotCompleted":true}),
        );
    }
    let provider_name = format!("HostProvider{}", owner.replace('-', ""));
    let mcp_name = format!("host-mcp-{}", owner.replace('-', ""));
    if mode == "--host-capture" && proof.references.is_none() {
        let refs: Vec<_> = document
            .imported_credentials
            .receipts
            .values()
            .map(|r| r.reference.clone())
            .collect();
        ensure!(refs.len() == 2, "core_host_unexpected_reference_count");
        for r in &refs {
            ensure!(
                r.storage == kcoder_config::imported_credentials::ImportStorage::Keyring
                    && r.profile_identity == proof.profile_identity
                    && r.account.len() == 39
                    && r.account.starts_with("import-")
                    && r.account[7..].bytes().all(|b| b.is_ascii_hexdigit()),
                "core_host_invalid_native_reference"
            );
            ensure!(
                match &r.subject {
                    CredentialSubject::Provider => r.provider == provider_name,
                    CredentialSubject::Mcp { env, headers, .. } =>
                        r.provider == mcp_name
                            && env == &vec!["TOKEN".to_owned()]
                            && headers.is_empty(),
                },
                "core_host_wrong_native_subject"
            );
        }
        ensure!(
            refs.iter().filter(|r| r.subject.is_provider()).count() == 1,
            "core_host_wrong_native_subject"
        );
        ensure!(
            refs[0].account != refs[1].account,
            "core_host_reference_collision"
        );
        ensure!(
            document.imported_credentials.groups.len() == 1,
            "core_host_wrong_group_count"
        );
        let group = document
            .imported_credentials
            .groups
            .values()
            .next()
            .unwrap();
        ensure!(
            group.outcome == CredentialGroupOutcome::Committed
                && group.references.len() == 2
                && refs.iter().all(|r| group.references.contains(r)),
            "core_host_uncommitted_group"
        );
        proof.references = Some(refs);
        proof.group = Some(group.group_id.clone());
        save(root, &proof)?;
    }
    let refs = proof
        .references
        .as_ref()
        .context("core_host_original_references_missing")?;
    let backend = Reader {
        backend: OsCredentialBackend::new(),
        accounts: refs.iter().map(|r| r.account.clone()).collect(),
    };
    if mode == "--host-capture" {
        let mut resolved_provider = false;
        for r in refs {
            ensure!(
                target.state(r, &backend)? == Some(ImportState::Published),
                "core_host_native_state_not_published"
            );
            if r.subject.is_provider() {
                let value = Zeroizing::new(
                    backend
                        .get(&r.account)?
                        .context("core_host_backing_missing")?,
                );
                ensure!(
                    fixture::digest(&value) == proof.provider_sha256,
                    "core_host_provider_value_changed"
                );
                resolved_provider = true;
            }
        }
        let settings = kcoder_config::read_settings_file(&target_path.join("settings.json"))?;
        let config: McpServerConfig = serde_json::from_value(
            settings["mcp_servers"]
                .as_array()
                .context("core_host_mcp_missing")?
                .iter()
                .find(|v| v["name"] == mcp_name)
                .context("core_host_mcp_missing")?
                .clone(),
        )?;
        let values =
            target.resolve_mcp_with_mode(&config, CredentialStoreMode::Keyring, &backend)?;
        ensure!(
            values.env.len() == 1
                && values.headers.is_empty()
                && fixture::digest(
                    values
                        .env
                        .get("TOKEN")
                        .context("core_host_mcp_value_missing")?
                ) == proof.mcp_sha256,
            "core_host_mcp_value_changed"
        );
        ensure!(
            settings["mcp_disabled_servers"]
                .as_array()
                .is_some_and(|v| v.contains(&json!(mcp_name))),
            "core_host_mcp_not_disabled"
        );
        ensure!(resolved_provider, "core_host_provider_not_resolved");
        return Ok(
            json!({"status":"passed","nativeHostPublishedBindingsVerified":true,"referenceCount":2,"providerResolved":true,"mcpResolved":true,"mcpDisabled":true,"fileBackendUsed":false}),
        );
    }
    ensure!(mode == "--host-final", "core_host_invalid_mode");
    for r in refs {
        ensure!(
            target.state(r, &backend)? == Some(ImportState::Undone),
            "core_host_native_undo_unconfirmed"
        );
        ensure!(
            backend.get(&r.account)?.is_none(),
            "core_host_entry_remains"
        );
    }
    ensure!(
        target
            .group_receipt(proof.group.as_ref().context("core_host_group_missing")?)?
            .is_some_and(|g| g.outcome == CredentialGroupOutcome::Undone),
        "core_host_group_undo_unconfirmed"
    );
    ensure!(
        kcoder_config::read_settings_file(&target_path.join("settings.json"))? == proof.baseline
            && document.credentials.is_empty(),
        "core_host_target_not_restored"
    );
    Ok(
        json!({"status":"passed","safeToRemoveRoot":true,"systemEntryAbsenceVerified":true,"originalReferencesUndone":true,"originalGroupUndone":true,"targetSettingsRestored":true,"activeBindingsAbsent":true,"referenceCount":2,"fileBackendUsed":false}),
    )
}
