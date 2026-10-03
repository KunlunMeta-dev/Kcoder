use anyhow::{Context, Result, bail};
use kcoder_config::{
    ConfigPaths, ConfigScope, CredentialStore, merge_settings_documents, read_scope, update_scope,
    validate_and_resolve_settings_document, write_user_dotenv_if_missing,
};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use tracing::warn;

const BUNDLE_MAGIC: &[u8] = b"KCODER_INTERNAL_V1";
const DIGEST_LEN: usize = 32;
const LENGTH_LEN: usize = 8;
const MAX_BUNDLE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct InternalBundle {
    version: u32,
    settings: Value,
    credentials: CredentialStore,
    #[serde(default)]
    dotenv: Option<String>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct BootstrapOutcome {
    pub(crate) settings_written: bool,
    pub(crate) credentials_written: bool,
    pub(crate) dotenv_written: bool,
}

impl BootstrapOutcome {
    fn changed(&self) -> bool {
        self.settings_written || self.credentials_written || self.dotenv_written
    }
}

pub(crate) fn bootstrap_from_current_exe(cwd: &Path) -> Result<Option<BootstrapOutcome>> {
    let executable = std::env::current_exe().context("failed to locate the running executable")?;
    let paths = ConfigPaths::discover(cwd)?;
    bootstrap_from_executable(&executable, &paths)
}

fn bootstrap_from_executable(
    executable: &Path,
    paths: &ConfigPaths,
) -> Result<Option<BootstrapOutcome>> {
    let Some(bundle) = read_bundle(executable)? else {
        return Ok(None);
    };
    if bundle.version != 1 {
        bail!(
            "unsupported internal bootstrap bundle version {}",
            bundle.version
        );
    }
    if !bundle.settings.is_object() {
        bail!("internal bootstrap settings must be a JSON object");
    }
    if bundle.credentials.credentials.is_empty() {
        bail!("internal bootstrap bundle does not contain provider credentials");
    }

    let bundled_dotenv = bundle.dotenv;
    let bundled_settings = bundle.settings;
    let existing_settings = read_scope(paths, ConfigScope::User)
        .context("failed to read existing user settings before bundled initialization")?;
    let mut merged_settings = bundled_settings.clone();
    merge_settings_documents(&mut merged_settings, existing_settings.clone());
    let resolved_settings = validate_and_resolve_settings_document(&merged_settings)
        .context("bundled company settings are not valid")?;

    let mut credentials = CredentialStore::load_from(&paths.credentials)
        .context("failed to read existing provider credentials before bundled initialization")?;
    let existing_credentials = credentials.clone();
    for (provider, api_key) in bundle.credentials.credentials {
        if !credentials.has_api_key(&provider) {
            credentials.set_api_key(&provider, api_key)?;
        }
    }
    require_active_provider_credential(&resolved_settings, &credentials)?;

    let mut outcome = BootstrapOutcome::default();
    if let Some(dotenv) = bundled_dotenv {
        // Debug switches must never reach a user profile through a bundled dotenv;
        // they would leave request logs (prompts and responses) recording forever.
        let (dotenv, dropped_debug_switches) = sanitize_bundled_dotenv(&dotenv);
        if !dropped_debug_switches.is_empty() {
            warn!(
                ?dropped_debug_switches,
                "dropped debug switches and credentials from the bundled company dotenv; provider keys are provisioned through credentials.json"
            );
        }
        if dotenv_has_effective_entries(&dotenv) {
            outcome.dotenv_written = write_user_dotenv_if_missing(&paths.config_dir, &dotenv)
                .context("failed to write bundled company dotenv")?;
        } else {
            warn!("bundled company dotenv had no usable entries; nothing was written");
        }
    }
    if credentials != existing_credentials {
        credentials
            .save_to(&paths.credentials)
            .context("failed to write bundled provider credentials")?;
        outcome.credentials_written = true;
    }
    if merged_settings != existing_settings {
        update_scope(paths, ConfigScope::User, |current| {
            let mut latest = bundled_settings.clone();
            merge_settings_documents(&mut latest, current.clone());
            *current = latest;
            Ok(())
        })
        .context("failed to write bundled user settings")?;
        outcome.settings_written = true;
    }

    Ok(outcome.changed().then_some(outcome))
}

/// True for debug switches (`DEV_DEBUG`, `*_DEBUG`) that a bundle must not deliver.
fn is_debug_switch(key: &str) -> bool {
    let key = key.trim();
    key.eq_ignore_ascii_case("DEV_DEBUG") || key.to_ascii_uppercase().ends_with("_DEBUG")
}

/// True for credential-shaped entries; a bundled dotenv must never deliver secrets.
///
/// Provider keys belong in `credentials.json` (written separately with user-only
/// permissions), not in a plaintext `.env` that every child process inherits.
fn is_credential_entry(key: &str) -> bool {
    kcoder_config::looks_like_credential_env_key(key)
}

/// Returns the dotenv with debug switches removed plus the keys that were dropped.
fn sanitize_bundled_dotenv(contents: &str) -> (String, Vec<String>) {
    let mut sanitized = String::with_capacity(contents.len());
    let mut dropped = Vec::new();
    for line in contents.split_inclusive('\n') {
        let body = line.trim_end_matches(['\n', '\r']);
        let key = body.split('=').next().unwrap_or("").trim();
        if !key.is_empty()
            && !key.starts_with('#')
            && (is_debug_switch(key) || is_credential_entry(key))
        {
            dropped.push(key.to_string());
            continue;
        }
        sanitized.push_str(line);
    }
    (sanitized, dropped)
}

/// True when the dotenv still carries at least one assignment worth writing.
fn dotenv_has_effective_entries(contents: &str) -> bool {
    contents.lines().any(|line| {
        let body = line.trim();
        !body.is_empty() && !body.starts_with('#') && body.contains('=')
    })
}

fn require_active_provider_credential(
    settings: &kcoder_config::Settings,
    credentials: &CredentialStore,
) -> Result<()> {
    let provider = settings.provider.as_deref().unwrap_or("kunlunmeta").trim();
    if provider != "local" && !credentials.has_api_key(provider) {
        bail!("internal bootstrap bundle has no credential for active provider '{provider}'");
    }
    Ok(())
}

fn read_bundle(executable: &Path) -> Result<Option<InternalBundle>> {
    let mut file = File::open(executable)
        .with_context(|| format!("failed to open executable {}", executable.display()))?;
    let file_len = file
        .metadata()
        .with_context(|| format!("failed to inspect executable {}", executable.display()))?
        .len();
    let footer_len = (DIGEST_LEN + LENGTH_LEN + BUNDLE_MAGIC.len()) as u64;
    if file_len < footer_len {
        return Ok(None);
    }

    file.seek(SeekFrom::End(-(BUNDLE_MAGIC.len() as i64)))
        .context("failed to seek to internal bundle marker")?;
    let mut magic = vec![0_u8; BUNDLE_MAGIC.len()];
    file.read_exact(&mut magic)
        .context("failed to read internal bundle marker")?;
    if magic != BUNDLE_MAGIC {
        return Ok(None);
    }

    file.seek(SeekFrom::End(-((BUNDLE_MAGIC.len() + LENGTH_LEN) as i64)))
        .context("failed to seek to internal bundle length")?;
    let mut length_bytes = [0_u8; LENGTH_LEN];
    file.read_exact(&mut length_bytes)
        .context("failed to read internal bundle length")?;
    let payload_len = u64::from_le_bytes(length_bytes);
    if payload_len == 0 || payload_len > MAX_BUNDLE_BYTES {
        bail!("invalid internal bootstrap bundle length {payload_len}");
    }
    if payload_len + footer_len > file_len {
        bail!("internal bootstrap bundle extends beyond the executable");
    }

    let payload_start = file_len - footer_len - payload_len;
    file.seek(SeekFrom::Start(payload_start))
        .context("failed to seek to internal bundle payload")?;
    let mut payload = vec![0_u8; payload_len as usize];
    file.read_exact(&mut payload)
        .context("failed to read internal bundle payload")?;
    let mut expected_digest = [0_u8; DIGEST_LEN];
    file.read_exact(&mut expected_digest)
        .context("failed to read internal bundle digest")?;
    let actual_digest = Sha256::digest(&payload);
    if actual_digest.as_slice() != expected_digest {
        bail!("internal bootstrap bundle checksum mismatch");
    }

    serde_json::from_slice(&payload)
        .context("failed to parse internal bootstrap bundle")
        .map(Some)
}

#[test]
fn bundled_dotenv_drops_debug_switches_but_keeps_the_rest() {
    let (sanitized, dropped) = sanitize_bundled_dotenv(
        "HTTPS_PROXY=http://proxy.internal:8080\nDEV_DEBUG=1\nNO_PROXY=localhost\nCODER_debug=on\n",
    );
    assert_eq!(
        sanitized,
        "HTTPS_PROXY=http://proxy.internal:8080\nNO_PROXY=localhost\n"
    );
    assert_eq!(
        dropped,
        vec!["DEV_DEBUG".to_string(), "CODER_debug".to_string()]
    );
}

#[test]
fn bundled_dotenv_never_carries_api_keys_or_tokens() {
    let (sanitized, dropped) = sanitize_bundled_dotenv(
        "KUNLUNMETA_BASE_API_KEY=company-internal-secret\nGATEWAY_TOKEN=abc\nHTTP_PROXY=http://proxy.internal:8080\nMY_SECRET=xyz\nDB_PASSWORD=hunter2\n",
    );
    assert_eq!(sanitized, "HTTP_PROXY=http://proxy.internal:8080\n");
    assert_eq!(
        dropped,
        vec![
            "KUNLUNMETA_BASE_API_KEY".to_string(),
            "GATEWAY_TOKEN".to_string(),
            "MY_SECRET".to_string(),
            "DB_PASSWORD".to_string(),
        ]
    );
}

#[test]
fn bundled_dotenv_with_only_debug_switches_has_no_effective_entries() {
    let (sanitized, dropped) =
        sanitize_bundled_dotenv("# comment\nDEV_DEBUG=1\n\nOTHER_DEBUG=on\n");
    assert!(dropped.len() == 2);
    assert!(!dotenv_has_effective_entries(&sanitized));
    assert!(dotenv_has_effective_entries("A=1\n"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use tempfile::TempDir;

    fn append_bundle(path: &Path, bundle: &Value) {
        let payload = serde_json::to_vec(bundle).unwrap();
        let digest = Sha256::digest(&payload);
        let mut file = OpenOptions::new().append(true).open(path).unwrap();
        file.write_all(&payload).unwrap();
        file.write_all(&digest).unwrap();
        file.write_all(&(payload.len() as u64).to_le_bytes())
            .unwrap();
        file.write_all(BUNDLE_MAGIC).unwrap();
    }

    fn fixture() -> (TempDir, std::path::PathBuf, ConfigPaths) {
        let temp = TempDir::new().unwrap();
        let executable = temp.path().join("kcoder.exe");
        fs::write(&executable, b"fake-pe-image").unwrap();
        let project = temp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let paths = ConfigPaths::with_config_dir(&project, temp.path().join("config"));
        (temp, executable, paths)
    }

    #[test]
    fn executable_without_bundle_is_ignored() {
        let (_temp, executable, paths) = fixture();

        assert_eq!(
            bootstrap_from_executable(&executable, &paths).unwrap(),
            None
        );
        assert!(!paths.user_settings.exists());
        assert!(!paths.credentials.exists());
    }

    #[test]
    fn bundled_settings_and_credentials_are_created_once() {
        let (_temp, executable, paths) = fixture();
        append_bundle(
            &executable,
            &json!({
                "version": 1,
                "settings": {
                    "active_provider": "kunlunmeta",
                    "permission_mode": "yolo"
                },
                "credentials": {
                    "kunlunmeta": {"type": "api", "key": "company-internal-secret"}
                },
                "dotenv": "KUNLUNMETA_BASE_API_KEY=company-internal-secret\nHTTPS_PROXY=http://proxy.internal:8080\n"
            }),
        );

        let outcome = bootstrap_from_executable(&executable, &paths)
            .unwrap()
            .unwrap();
        assert_eq!(
            outcome,
            BootstrapOutcome {
                settings_written: true,
                credentials_written: true,
                dotenv_written: true,
            }
        );
        let dotenv = fs::read_to_string(paths.config_dir.join(".env")).unwrap();
        assert_eq!(
            dotenv, "HTTPS_PROXY=http://proxy.internal:8080\n",
            "bundled api keys must never reach .env; they belong in credentials.json"
        );
        assert!(
            !dotenv.contains("company-internal-secret"),
            "the bundled secret must not be copied into the dotenv"
        );
        assert_eq!(
            read_scope_for_test(&paths.user_settings)["active_provider"],
            "kunlunmeta"
        );
        assert!(
            CredentialStore::load_from(&paths.credentials)
                .unwrap()
                .has_api_key("kunlunmeta")
        );
        assert_eq!(
            bootstrap_from_executable(&executable, &paths).unwrap(),
            None
        );
    }

    #[test]
    fn bundled_dotenv_never_replaces_an_existing_file() {
        let (_temp, executable, paths) = fixture();
        fs::create_dir_all(&paths.config_dir).unwrap();
        fs::write(
            paths.config_dir.join(".env"),
            "KUNLUNMETA_BASE_API_KEY=user-owned\n",
        )
        .unwrap();
        append_bundle(
            &executable,
            &json!({
                "version": 1,
                "settings": {"active_provider": "kunlunmeta"},
                "credentials": {"kunlunmeta": {"type": "api", "key": "bundled-secret"}},
                "dotenv": "KUNLUNMETA_BASE_API_KEY=bundled-secret\n"
            }),
        );

        let outcome = bootstrap_from_executable(&executable, &paths)
            .unwrap()
            .unwrap();

        assert!(!outcome.dotenv_written);
        assert_eq!(
            fs::read_to_string(paths.config_dir.join(".env")).unwrap(),
            "KUNLUNMETA_BASE_API_KEY=user-owned\n"
        );
    }

    #[test]
    fn existing_values_are_preserved_while_missing_values_are_added() {
        let (_temp, executable, paths) = fixture();
        append_bundle(
            &executable,
            &json!({
                "version": 1,
                "settings": {
                    "active_provider": "kunlunmeta",
                    "permission_mode": "yolo",
                    "tui": {"alternate_screen": "auto"}
                },
                "credentials": {
                    "kunlunmeta": {"type": "api", "key": "bundled-secret"},
                    "openai": {"type": "api", "key": "bundled-openai-secret"}
                }
            }),
        );
        kcoder_config::write_scope(
            &paths,
            ConfigScope::User,
            &json!({"permission_mode": "ask"}),
        )
        .unwrap();
        let mut credentials = CredentialStore::default();
        credentials
            .set_api_key("openai", "existing-openai-secret".to_string())
            .unwrap();
        credentials.save_to(&paths.credentials).unwrap();

        let outcome = bootstrap_from_executable(&executable, &paths)
            .unwrap()
            .unwrap();
        assert!(outcome.settings_written);
        assert!(outcome.credentials_written);
        assert_eq!(
            read_scope_for_test(&paths.user_settings)["permission_mode"],
            "ask"
        );
        assert_eq!(
            read_scope_for_test(&paths.user_settings)["active_provider"],
            "kunlunmeta"
        );
        let stored = CredentialStore::load_from(&paths.credentials).unwrap();
        assert_eq!(stored.credentials["kunlunmeta"], "bundled-secret");
        assert_eq!(stored.credentials["openai"], "existing-openai-secret");
    }

    #[test]
    fn invalid_profile_reference_is_rejected_before_writing_files() {
        let (_temp, executable, paths) = fixture();
        append_bundle(
            &executable,
            &json!({
                "version": 1,
                "settings": {"summary_profile": "missing-summary-profile"},
                "credentials": {"openai": {"type": "api", "key": "secret"}}
            }),
        );

        let error = bootstrap_from_executable(&executable, &paths).unwrap_err();
        assert!(error.to_string().contains("company settings are not valid"));
        assert!(!paths.user_settings.exists());
        assert!(!paths.credentials.exists());
    }

    #[test]
    fn active_provider_without_matching_credential_is_rejected() {
        let (_temp, executable, paths) = fixture();
        append_bundle(
            &executable,
            &json!({
                "version": 1,
                "settings": {"active_provider": "kunlunmeta"},
                "credentials": {"openai": {"type": "api", "key": "secret"}}
            }),
        );

        let error = bootstrap_from_executable(&executable, &paths).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("no credential for active provider 'kunlunmeta'")
        );
        assert!(!paths.user_settings.exists());
        assert!(!paths.credentials.exists());
    }

    #[test]
    fn corrupted_bundle_is_rejected() {
        let (_temp, executable, paths) = fixture();
        append_bundle(
            &executable,
            &json!({
                "version": 1,
                "settings": {},
                "credentials": {"openai": {"type": "api", "key": "secret"}}
            }),
        );
        let mut bytes = fs::read(&executable).unwrap();
        bytes[b"fake-pe-image".len()] ^= 0x01;
        fs::write(&executable, bytes).unwrap();

        let error = bootstrap_from_executable(&executable, &paths).unwrap_err();
        assert!(error.to_string().contains("checksum mismatch"));
        assert!(!paths.user_settings.exists());
        assert!(!paths.credentials.exists());
    }

    fn read_scope_for_test(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }
}
