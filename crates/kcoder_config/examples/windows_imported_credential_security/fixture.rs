use anyhow::{Context, Result, ensure};
use kcoder_config::{PrivateDirectory, imported_credentials::CredentialImportRef};
use kcoder_types::McpServerConfig;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, io::Read, path::Path};
use zeroize::Zeroizing;

pub(super) const INTENT: &str = "core-credential-intent.json";
pub(super) const PROFILE: &str = "credential-profile";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Intent {
    pub version: u32,
    pub owner: String,
    pub root_identity: String,
    pub profile_identity: Option<String>,
    pub baseline: Value,
    pub provider: Option<CredentialImportRef>,
    pub mcp: Option<CredentialImportRef>,
    pub mcp_config: Option<McpServerConfig>,
    pub provider_fingerprint: Option<String>,
    pub mcp_fingerprint: Option<String>,
    pub group: String,
    pub phase: String,
}

pub(super) fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub(super) fn random_secret() -> Result<Zeroizing<String>> {
    use std::fmt::Write;
    let mut bytes = Zeroizing::new([0u8; 32]);
    getrandom::fill(&mut *bytes).map_err(|_| anyhow::anyhow!("core_entropy_unavailable"))?;
    let mut value = Zeroizing::new(String::with_capacity(64));
    for byte in bytes.iter() {
        write!(&mut *value, "{byte:02x}")?;
    }
    Ok(value)
}

pub(super) fn open_root(
    path: &Path,
    owner: &str,
    expected: Option<&str>,
) -> Result<PrivateDirectory> {
    ensure!(
        owner.len() == 36
            && owner.bytes().enumerate().all(|(at, byte)| {
                if [8, 13, 18, 23].contains(&at) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
                }
            }),
        "core_invalid_owner"
    );
    ensure!(
        path.is_absolute()
            && path.file_name() == Some(OsStr::new(&format!("kcoder-package-{owner}"))),
        "core_invalid_root"
    );
    let root = PrivateDirectory::open_existing(path)?;
    root.verify_trusted_config_directory()?;
    if let Some(expected) = expected {
        ensure!(
            root.directory_identity()? == expected,
            "core_root_identity_changed"
        );
    }
    let marker = read_value(&root, ".owner.json", 4096)?;
    ensure!(marker["owner"] == owner, "core_root_owner_changed");
    Ok(root)
}

pub(super) fn read_value(directory: &PrivateDirectory, name: &str, limit: u64) -> Result<Value> {
    let file = directory.open_single_link_regular_file(OsStr::new(name))?;
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(limit + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= limit, "core_fixture_record_budget");
    serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("core_fixture_record_invalid"))
}

pub(super) fn save(directory: &PrivateDirectory, intent: &Intent) -> Result<()> {
    let bytes = serde_json::to_vec(intent)?;
    ensure!(bytes.len() <= 128 * 1024, "core_fixture_record_budget");
    directory.atomic_replace(OsStr::new(INTENT), &bytes)
}

pub(super) fn load(directory: &PrivateDirectory, owner: &str) -> Result<Intent> {
    let value = read_value(directory, INTENT, 128 * 1024)?;
    let intent: Intent = serde_json::from_value(value)
        .map_err(|_| anyhow::anyhow!("core_fixture_intent_invalid"))?;
    ensure!(
        intent.version == 1
            && intent.owner == owner
            && intent.root_identity == directory.directory_identity()?,
        "core_fixture_intent_changed"
    );
    ensure!(
        intent.group == format!("group-{}", owner.replace('-', "")),
        "core_fixture_group_changed"
    );
    Ok(intent)
}

pub(super) fn profile(root: &PrivateDirectory, intent: &Intent) -> Result<PrivateDirectory> {
    let profile = root.open_child(OsStr::new(PROFILE), false)?;
    ensure!(
        Some(profile.directory_identity()?) == intent.profile_identity,
        "core_fixture_profile_changed"
    );
    Ok(profile)
}

pub(super) fn refs(intent: &Intent) -> Result<[&CredentialImportRef; 2]> {
    let provider = intent
        .provider
        .as_ref()
        .context("core_provider_reference_missing")?;
    let mcp = intent.mcp.as_ref().context("core_mcp_reference_missing")?;
    ensure!(
        provider.account != mcp.account && provider.operation_id != mcp.operation_id,
        "core_fixture_reference_collision"
    );
    for reference in [provider, mcp] {
        ensure!(
            reference.account.len() == 39
                && reference.account.starts_with("import-")
                && reference.account[7..]
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit()),
            "core_fixture_account_invalid"
        );
        ensure!(
            reference.profile_identity
                == *intent
                    .profile_identity
                    .as_ref()
                    .context("core_profile_identity_missing")?,
            "core_fixture_reference_profile_changed"
        );
        ensure!(
            reference.storage == kcoder_config::imported_credentials::ImportStorage::Keyring,
            "core_file_fallback_forbidden"
        );
    }
    Ok([provider, mcp])
}

pub(super) fn no_plaintext(directory: &PrivateDirectory, secrets: &[&str]) -> Result<()> {
    directory.visit_entry_names_bounded(64, |name| {
        let metadata = directory.entry_metadata(name)?;
        if metadata.is_dir() {
            return Ok(());
        }
        ensure!(metadata.is_file(), "core_fixture_unexpected_file_kind");
        // Empty coordination locks carry no source bytes and may remain locked on Windows.
        if metadata.len() == 0 {
            return Ok(());
        }
        let file = directory.open_single_link_regular_file(name)?;
        let mut bytes = Zeroizing::new(Vec::new());
        file.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= 16 * 1024 * 1024,
            "core_fixture_inspection_budget"
        );
        for secret in secrets {
            ensure!(
                !bytes.windows(secret.len()).any(|b| b == secret.as_bytes()),
                "core_plaintext_leak"
            );
        }
        Ok(())
    })
}

pub(super) fn initial_intent(root: &PrivateDirectory, owner: &str) -> Result<Intent> {
    Ok(Intent {
        version: 1,
        owner: owner.into(),
        root_identity: root.directory_identity()?,
        profile_identity: None,
        baseline: json!({"credential_store":"keyring","mcp_servers":[]}),
        provider: None,
        mcp: None,
        mcp_config: None,
        provider_fingerprint: None,
        mcp_fingerprint: None,
        group: format!("group-{}", owner.replace('-', "")),
        phase: "preparing".into(),
    })
}
