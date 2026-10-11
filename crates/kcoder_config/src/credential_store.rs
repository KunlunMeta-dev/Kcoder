//! Operating-system credential store for Provider secrets.
//!
//! `credentials.json` still owns the bookkeeping document, but a secret may live in the
//! operating-system store instead: the document then carries a marker
//! (`keyring:kcoder/<provider>`) and the secret itself is held by the Windows Credential
//! Manager, the macOS Keychain or the Linux Secret Service. Plaintext values keep working, so
//! the format stays backward compatible and `credential_store` selects the policy.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Keyring service name shared by every KCoder installation.
pub const CREDENTIAL_SERVICE: &str = "kcoder";
/// Marker written into `credentials.json` when the secret lives in the OS store.
pub const CREDENTIAL_MARKER_PREFIX: &str = "keyring:kcoder/";

/// Where Provider secrets are kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CredentialStoreMode {
    /// Prefer the OS store when it is reachable, otherwise keep plaintext entries.
    #[default]
    Auto,
    /// Require the OS store; markers are reported as unavailable instead of falling back.
    Keyring,
    /// Never touch the OS store; markers cannot be resolved.
    File,
}

impl CredentialStoreMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Keyring => "keyring",
            Self::File => "file",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "auto" => Ok(Self::Auto),
            "keyring" => Ok(Self::Keyring),
            "file" => Ok(Self::File),
            other => {
                anyhow::bail!("invalid credential store '{other}'; expected auto, keyring or file")
            }
        }
    }
}

/// Minimal backend so the resolver, the CLI and tests share one seam.
pub trait CredentialBackend: Send + Sync {
    /// Human-readable backend name for diagnostics.
    fn describe(&self) -> String;
    /// Whether the backend can be reached at all in this environment.
    fn available(&self) -> bool;
    /// Why the last availability probe failed, when it did.
    fn unavailable_reason(&self) -> Option<String> {
        None
    }
    /// `Ok(None)` means the store is reachable but holds no such entry.
    fn get(&self, account: &str) -> Result<Option<String>>;
    fn set(&self, account: &str, secret: &str) -> Result<()>;
    fn delete(&self, account: &str) -> Result<()>;
}

/// The real operating-system store.
pub struct OsCredentialBackend {
    service: String,
    probe: std::sync::Mutex<Option<String>>,
}

impl Default for OsCredentialBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl OsCredentialBackend {
    pub fn new() -> Self {
        Self {
            service: CREDENTIAL_SERVICE.to_string(),
            probe: std::sync::Mutex::new(None),
        }
    }

    fn record_probe(&self, reason: Option<String>) {
        if let Ok(mut slot) = self.probe.lock() {
            *slot = reason;
        }
    }

    /// Reachability probe: a missing entry still proves the store answers.
    fn probe(&self) -> std::result::Result<(), String> {
        let entry = match self.entry("__kcoder_probe__") {
            Ok(entry) => entry,
            Err(error) => return Err(format!("{error:#}")),
        };
        match entry.get_password() {
            Ok(_) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("{error:?}")),
        }
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, account).with_context(|| {
            format!("operating-system credential store rejected account '{account}'")
        })
    }

    fn describe_platform(&self) -> &'static str {
        if cfg!(windows) {
            "Windows Credential Manager"
        } else if cfg!(target_os = "macos") {
            "macOS Keychain"
        } else {
            "Secret Service (gnome-keyring / KWallet)"
        }
    }
}

impl CredentialBackend for OsCredentialBackend {
    fn describe(&self) -> String {
        format!("{} [{}]", self.describe_platform(), self.service)
    }

    fn available(&self) -> bool {
        match self.probe() {
            Ok(()) => {
                self.record_probe(None);
                true
            }
            Err(reason) => {
                self.record_probe(Some(reason));
                false
            }
        }
    }

    fn unavailable_reason(&self) -> Option<String> {
        self.probe.lock().ok().and_then(|slot| slot.clone())
    }

    fn get(&self, account: &str) -> Result<Option<String>> {
        match self.entry(account)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(anyhow::Error::from(error))
                .with_context(|| format!("failed to read the stored credential for '{account}'")),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<()> {
        self.entry(account)?
            .set_password(secret)
            .with_context(|| format!("failed to store the credential for '{account}'"))
    }

    fn delete(&self, account: &str) -> Result<()> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(anyhow::Error::from(error))
                .with_context(|| format!("failed to delete the stored credential for '{account}'")),
        }
    }
}

/// Document value for a secret that lives in the OS store.
pub fn marker_for_provider(provider: &str) -> String {
    format!("{CREDENTIAL_MARKER_PREFIX}{provider}")
}

/// Provider id when the stored value is a marker.
pub fn provider_from_marker(value: &str) -> Option<&str> {
    value
        .trim()
        .strip_prefix(CREDENTIAL_MARKER_PREFIX)
        .map(str::trim)
        .filter(|provider| !provider.is_empty())
}

pub fn is_marker(value: &str) -> bool {
    provider_from_marker(value).is_some()
}

/// Resolve markers through the backend, leaving plaintext values untouched.
///
/// A marker that cannot be resolved is removed and reported: it must never reach a Provider as
/// a literal API key.
pub fn resolve_stored_credentials(
    stored: &BTreeMap<String, String>,
    backend: &dyn CredentialBackend,
    mode: CredentialStoreMode,
) -> (BTreeMap<String, String>, Vec<String>) {
    let mut resolved = BTreeMap::new();
    let mut diagnostics = Vec::new();
    let mut plaintext = Vec::new();
    for (provider, value) in stored {
        let Some(account) = provider_from_marker(value) else {
            resolved.insert(provider.clone(), value.clone());
            if !value.trim().is_empty() {
                plaintext.push(provider.clone());
            }
            continue;
        };
        if mode == CredentialStoreMode::File {
            diagnostics.push(format!(
                "{provider}: credentials.json points at the operating-system credential store, \
                 but credential_store=file; run `kcoder auth migrate --to file` or set \
                 credential_store=auto"
            ));
            continue;
        }
        match backend.get(account) {
            Ok(Some(secret)) => {
                resolved.insert(provider.clone(), secret);
            }
            Ok(None) => diagnostics.push(format!(
                "{provider}: no entry in {}; run `kcoder auth login --provider {provider}`",
                backend.describe()
            )),
            Err(error) => diagnostics.push(format!("{provider}: {error:#}")),
        }
    }
    if mode == CredentialStoreMode::Keyring && !plaintext.is_empty() {
        diagnostics.push(format!(
            "plaintext credentials for {} while credential_store=keyring; run \
             `kcoder auth migrate --to keyring`",
            plaintext.join(", ")
        ));
    }
    (resolved, diagnostics)
}

/// Direction of a credential migration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationDirection {
    /// Plaintext values move into the OS store; the document keeps markers.
    ToKeyring,
    /// Markers move back to plaintext values and the store entries are deleted.
    ToFile,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MigrationReport {
    pub moved: Vec<String>,
    pub skipped: Vec<String>,
    pub failures: Vec<String>,
}

impl MigrationReport {
    pub fn is_empty(&self) -> bool {
        self.moved.is_empty() && self.skipped.is_empty() && self.failures.is_empty()
    }
}

/// Rewrite the credential document in the requested direction.
pub fn migrate_stored_credentials(
    stored: &BTreeMap<String, String>,
    backend: &dyn CredentialBackend,
    direction: MigrationDirection,
) -> (BTreeMap<String, String>, MigrationReport) {
    let mut rewritten = stored.clone();
    let mut report = MigrationReport::default();
    for (provider, value) in stored {
        match direction {
            MigrationDirection::ToKeyring => {
                if is_marker(value) {
                    report.skipped.push(provider.clone());
                    continue;
                }
                if value.trim().is_empty() {
                    report.skipped.push(provider.clone());
                    continue;
                }
                match backend.set(provider, value) {
                    Ok(()) => {
                        rewritten.insert(provider.clone(), marker_for_provider(provider));
                        report.moved.push(provider.clone());
                    }
                    Err(error) => report.failures.push(format!("{provider}: {error:#}")),
                }
            }
            MigrationDirection::ToFile => {
                let Some(account) = provider_from_marker(value) else {
                    report.skipped.push(provider.clone());
                    continue;
                };
                match backend.get(account) {
                    Ok(Some(secret)) => {
                        rewritten.insert(provider.clone(), secret);
                        if let Err(error) = backend.delete(account) {
                            report
                                .failures
                                .push(format!("{provider}: stored credential kept: {error:#}"));
                        } else {
                            report.moved.push(provider.clone());
                        }
                    }
                    Ok(None) => report.skipped.push(provider.clone()),
                    Err(error) => report.failures.push(format!("{provider}: {error:#}")),
                }
            }
        }
    }
    (rewritten, report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryBackend {
        entries: Mutex<BTreeMap<String, String>>,
        failure: Option<String>,
    }

    impl MemoryBackend {
        fn with_failure(message: &str) -> Self {
            Self {
                failure: Some(message.to_string()),
                ..Default::default()
            }
        }
    }

    impl CredentialBackend for MemoryBackend {
        fn describe(&self) -> String {
            "memory store".to_string()
        }
        fn available(&self) -> bool {
            self.failure.is_none()
        }
        fn get(&self, account: &str) -> Result<Option<String>> {
            if let Some(message) = &self.failure {
                anyhow::bail!("{message}");
            }
            Ok(self.entries.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, secret: &str) -> Result<()> {
            if let Some(message) = &self.failure {
                anyhow::bail!("{message}");
            }
            self.entries
                .lock()
                .unwrap()
                .insert(account.to_string(), secret.to_string());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<()> {
            self.entries.lock().unwrap().remove(account);
            Ok(())
        }
    }

    fn stored(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(provider, value)| (provider.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn markers_round_trip_and_never_resolve_to_themselves() {
        let marker = marker_for_provider("deepseek");
        assert_eq!(marker, "keyring:kcoder/deepseek");
        assert_eq!(provider_from_marker(&marker), Some("deepseek"));
        assert!(is_marker(&marker));
        assert!(!is_marker("sk-live-plaintext"));

        let backend = MemoryBackend::default();
        backend.set("deepseek", "sk-secret").unwrap();
        let (resolved, diagnostics) = resolve_stored_credentials(
            &stored(&[("deepseek", &marker), ("openai", "sk-plain")]),
            &backend,
            CredentialStoreMode::Auto,
        );
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        assert_eq!(resolved["deepseek"], "sk-secret");
        assert_eq!(resolved["openai"], "sk-plain");
    }

    #[test]
    fn unresolvable_markers_are_dropped_and_reported() {
        let backend = MemoryBackend::default();
        let (resolved, diagnostics) = resolve_stored_credentials(
            &stored(&[("deepseek", &marker_for_provider("deepseek"))]),
            &backend,
            CredentialStoreMode::Keyring,
        );
        assert!(resolved.is_empty());
        assert_eq!(diagnostics.len(), 1);
        assert!(diagnostics[0].contains("no entry"), "{diagnostics:?}");

        let (resolved, diagnostics) = resolve_stored_credentials(
            &stored(&[("deepseek", &marker_for_provider("deepseek"))]),
            &backend,
            CredentialStoreMode::File,
        );
        assert!(resolved.is_empty());
        assert!(
            diagnostics[0].contains("credential_store=file"),
            "{diagnostics:?}"
        );

        let (resolved, diagnostics) = resolve_stored_credentials(
            &stored(&[("deepseek", &marker_for_provider("deepseek"))]),
            &MemoryBackend::with_failure("secret service is unavailable"),
            CredentialStoreMode::Auto,
        );
        assert!(resolved.is_empty());
        assert!(
            diagnostics[0].contains("secret service is unavailable"),
            "{diagnostics:?}"
        );
    }

    #[test]
    fn keyring_mode_reports_plaintext_and_plaintext_survives() {
        let backend = MemoryBackend::default();
        let (resolved, diagnostics) = resolve_stored_credentials(
            &stored(&[("openai", "sk-plain")]),
            &backend,
            CredentialStoreMode::Keyring,
        );
        assert_eq!(resolved["openai"], "sk-plain");
        assert!(
            diagnostics[0].contains("migrate --to keyring"),
            "{diagnostics:?}"
        );
    }

    #[test]
    fn migration_moves_plaintext_into_the_store_and_back() {
        let backend = MemoryBackend::default();
        let (rewritten, report) = migrate_stored_credentials(
            &stored(&[("deepseek", "sk-secret"), ("openai", "sk-other")]),
            &backend,
            MigrationDirection::ToKeyring,
        );
        assert_eq!(report.moved, vec!["deepseek", "openai"]);
        assert!(report.failures.is_empty());
        assert_eq!(rewritten["deepseek"], marker_for_provider("deepseek"));
        assert_eq!(
            backend.get("deepseek").unwrap().as_deref(),
            Some("sk-secret")
        );

        let (back, report) =
            migrate_stored_credentials(&rewritten, &backend, MigrationDirection::ToFile);
        assert_eq!(report.moved, vec!["deepseek", "openai"]);
        assert_eq!(back["deepseek"], "sk-secret");
        assert!(backend.get("deepseek").unwrap().is_none());
    }

    #[test]
    fn migration_failures_keep_the_original_document() {
        let backend = MemoryBackend::with_failure("secret service is unavailable");
        let original = stored(&[("deepseek", "sk-secret")]);
        let (rewritten, report) =
            migrate_stored_credentials(&original, &backend, MigrationDirection::ToKeyring);
        assert_eq!(rewritten, original);
        assert!(report.moved.is_empty());
        assert_eq!(report.failures.len(), 1);
        assert!(report.failures[0].contains("unavailable"), "{report:?}");
    }

    #[test]
    fn os_backend_probe_reports_availability_quickly() {
        let backend = OsCredentialBackend::new();
        let start = std::time::Instant::now();
        let available = backend.available();
        let elapsed = start.elapsed();
        eprintln!(
            "os store available={available} in {elapsed:?} ({})",
            backend.describe()
        );
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "probe took {elapsed:?}"
        );
    }
    #[test]
    fn credential_store_mode_parsing_is_strict() {
        assert_eq!(
            CredentialStoreMode::parse(" Auto ").unwrap(),
            CredentialStoreMode::Auto
        );
        assert_eq!(
            CredentialStoreMode::parse("keyring").unwrap(),
            CredentialStoreMode::Keyring
        );
        assert_eq!(CredentialStoreMode::File.as_str(), "file");
        assert!(CredentialStoreMode::parse("vault").is_err());
    }
}
