//! Plugin secrets in the existing execution-profile credential document.
//! The reserved entry deliberately has a non-API type: old writers must reject it.
use crate::{CredentialBackend, CredentialStore, CredentialStoreMode};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fmt, path::Path};

pub const NAMESPACE: &str = "$pluginCredentials";
const KIND: &str = "plugin_credentials_v1";
const MAX_SCOPES: usize = 256;
const MAX_NAMES: usize = 32;
const MAX_VALUE_BYTES: usize = 16 * 1024;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginCredentialDocument {
    #[serde(rename = "type")]
    kind: String,
    pub scopes: BTreeMap<String, PluginCredentialScope>,
}
impl Default for PluginCredentialDocument {
    fn default() -> Self {
        Self {
            kind: KIND.into(),
            scopes: BTreeMap::new(),
        }
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PluginCredentialScope {
    pub operation_id: Option<String>,
    pub values: BTreeMap<String, PluginSecret>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "storage", rename_all = "snake_case", deny_unknown_fields)]
pub enum PluginSecret {
    File { value: String },
    Keyring { account: String },
}
impl fmt::Debug for PluginCredentialDocument {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PluginCredentialDocument")
            .field("scope_count", &self.scopes.len())
            .finish()
    }
}
impl fmt::Debug for CredentialStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CredentialStore")
            .field("provider_ids", &self.credentials.keys())
            .field("revoked", &self.revoked)
            .field("plugin_credentials", &self.plugin_credentials)
            .finish()
    }
}
pub fn validate_scope(scope: &str) -> Result<()> {
    ensure!(
        scope.len() == 64
            && scope
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "invalid plugin credential scope"
    );
    Ok(())
}
pub fn validate_name(name: &str) -> Result<()> {
    ensure!(
        !name.is_empty()
            && name.len() <= 128
            && name.bytes().enumerate().all(|(i, b)| b == b'_'
                || b.is_ascii_alphabetic()
                || (i > 0 && b.is_ascii_digit())),
        "invalid plugin credential variable name"
    );
    Ok(())
}
impl PluginCredentialDocument {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.kind == KIND,
            "unsupported plugin credential document version"
        );
        ensure!(
            self.scopes.len() <= MAX_SCOPES,
            "plugin credential scope limit exceeded"
        );
        for (scope, entry) in &self.scopes {
            validate_scope(scope)?;
            ensure!(
                entry.values.len() <= MAX_NAMES,
                "plugin credential variable limit exceeded"
            );
            if let Some(id) = &entry.operation_id {
                ensure!(
                    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()),
                    "invalid plugin operation identity"
                );
            }
            for (name, secret) in &entry.values {
                validate_name(name)?;
                match secret {
                    PluginSecret::File { value } => validate_value(value)?,
                    PluginSecret::Keyring { account } => {
                        ensure!(
                            account.starts_with(&format!("plugin/{scope}/"))
                                && account.len() == 104
                                && account[72..].bytes().all(|b| b.is_ascii_hexdigit()),
                            "invalid plugin credential account"
                        );
                    }
                }
            }
        }
        ensure!(
            serde_json::to_vec(self)?.len() <= 2 * 1024 * 1024,
            "plugin credential document limit exceeded"
        );
        Ok(())
    }
    /// Existing unavailable markers are not missing secrets and cannot authorize replacement.
    pub fn resolve_strict(
        &self,
        scope: &str,
        backend: &dyn CredentialBackend,
        mode: CredentialStoreMode,
    ) -> Result<BTreeMap<String, String>> {
        self.validate()?;
        validate_scope(scope)?;
        let mut values = BTreeMap::new();
        if let Some(entry) = self.scopes.get(scope) {
            for (name, value) in &entry.values {
                let value = match value {
                    PluginSecret::File { value } => value.clone(),
                    PluginSecret::Keyring { account } => {
                        ensure!(
                            mode != CredentialStoreMode::File,
                            "plugin_credential_store_unavailable"
                        );
                        backend
                            .get(account)
                            .map_err(|_| anyhow::anyhow!("plugin_credential_store_unavailable"))?
                            .ok_or_else(|| anyhow::anyhow!("plugin_credential_store_unavailable"))?
                    }
                };
                validate_value(&value)?;
                values.insert(name.clone(), value);
            }
        }
        Ok(values)
    }

    /// Unavailable OS entries are missing values, never marker strings or diagnostics with secrets.
    pub fn resolve(
        &self,
        scope: &str,
        backend: &dyn CredentialBackend,
        mode: CredentialStoreMode,
    ) -> Result<BTreeMap<String, String>> {
        self.validate()?;
        validate_scope(scope)?;
        let mut result = BTreeMap::new();
        if let Some(entry) = self.scopes.get(scope) {
            for (name, value) in &entry.values {
                let resolved = match value {
                    PluginSecret::File { value } => Some(value.clone()),
                    PluginSecret::Keyring { account } if mode != CredentialStoreMode::File => {
                        backend.get(account).ok().flatten()
                    }
                    PluginSecret::Keyring { .. } => None,
                };
                if let Some(value) = resolved {
                    validate_value(&value)?;
                    result.insert(name.clone(), value);
                }
            }
        }
        Ok(result)
    }
}
pub fn environment_is_configured(name: &str) -> bool {
    let configured = |name: &str| {
        std::env::var(name)
            .ok()
            .is_some_and(|value| !value.trim().is_empty())
    };
    configured(name)
        || name
            .strip_prefix("KCODER_CONNECTOR_")
            .is_some_and(configured)
}

fn validate_value(value: &str) -> Result<()> {
    ensure!(
        !value.trim().is_empty() && value.len() <= MAX_VALUE_BYTES && !value.contains('\0'),
        "plugin credential value must be nonempty and at most 16384 bytes"
    );
    Ok(())
}
impl CredentialStore {
    /// Uses the credential transaction lock and private atomic writer; only supplied declared names change.
    pub fn update_plugin_credentials(
        path: &Path,
        scope: &str,
        operation_id: Option<&str>,
        values: &BTreeMap<String, String>,
        allowed_names: &[String],
        mode: CredentialStoreMode,
        backend: &dyn CredentialBackend,
    ) -> Result<()> {
        Self::update_plugin_credentials_inner(
            path,
            scope,
            operation_id,
            values,
            allowed_names,
            mode,
            backend,
            false,
        )
    }

    /// Private setup is compare-and-set on still-missing declared keys under the credential file lock.
    pub fn update_missing_plugin_credentials(
        path: &Path,
        scope: &str,
        operation_id: Option<&str>,
        values: &BTreeMap<String, String>,
        allowed_names: &[String],
        mode: CredentialStoreMode,
        backend: &dyn CredentialBackend,
    ) -> Result<()> {
        Self::update_plugin_credentials_inner(
            path,
            scope,
            operation_id,
            values,
            allowed_names,
            mode,
            backend,
            true,
        )
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Private setup and intentional replacement share the existing locked transaction"
    )]
    fn update_plugin_credentials_inner(
        path: &Path,
        scope: &str,
        operation_id: Option<&str>,
        values: &BTreeMap<String, String>,
        allowed_names: &[String],
        mode: CredentialStoreMode,
        backend: &dyn CredentialBackend,
        missing_only: bool,
    ) -> Result<()> {
        validate_scope(scope)?;
        ensure!(
            !values.is_empty() && values.len() <= MAX_NAMES,
            "invalid plugin credential variable count"
        );
        for (name, value) in values {
            validate_name(name)?;
            validate_value(value)?;
            ensure!(
                allowed_names.contains(name),
                "plugin credential variable is not declared"
            );
        }
        let use_keyring = mode != CredentialStoreMode::File && backend.available();
        ensure!(
            mode != CredentialStoreMode::Keyring || use_keyring,
            "plugin credential store is unavailable"
        );
        let mut created = Vec::new();
        let mut retired = Vec::new();
        let result = Self::update_file(path, |store| {
            if missing_only {
                let current = store
                    .plugin_credentials
                    .resolve_strict(scope, backend, mode)?;
                for name in values.keys() {
                    ensure!(
                        !current.contains_key(name) && !environment_is_configured(name),
                        "plugin_scope_changed: credentials already configured; reload missing fields"
                    );
                }
            }

            let entry = store
                .plugin_credentials
                .scopes
                .entry(scope.into())
                .or_insert_with(|| PluginCredentialScope {
                    operation_id: operation_id.map(str::to_owned),
                    values: BTreeMap::new(),
                });
            // Installing the exact catalog source may explicitly bind its pre-install credentials.
            ensure!(
                entry.operation_id.as_deref().is_none()
                    || entry.operation_id.as_deref() == operation_id,
                "plugin_scope_changed"
            );
            entry.operation_id = operation_id.map(str::to_owned);
            for (name, value) in values {
                let next = if use_keyring {
                    let mut random = [0u8; 16];
                    getrandom::fill(&mut random).map_err(|_| {
                        anyhow::anyhow!("plugin credential account allocation failed")
                    })?;
                    let nonce = random
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect::<String>();
                    let account = format!("plugin/{scope}/{nonce}");
                    backend
                        .set(&account, value)
                        .map_err(|_| anyhow::anyhow!("plugin credential store write failed"))?;
                    created.push(account.clone());
                    PluginSecret::Keyring { account }
                } else {
                    PluginSecret::File {
                        value: value.clone(),
                    }
                };
                if let Some(PluginSecret::Keyring { account }) =
                    entry.values.insert(name.clone(), next)
                {
                    retired.push(account);
                }
            }
            store.plugin_credentials.validate()
        });
        if result.is_err() {
            for account in created {
                let _ = backend.delete(&account);
            }
        } else {
            for account in retired {
                let _ = backend.delete(&account);
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    #[derive(Default)]
    struct Backend {
        values: Mutex<BTreeMap<String, String>>,
    }
    impl CredentialBackend for Backend {
        fn describe(&self) -> String {
            "test".into()
        }
        fn available(&self) -> bool {
            true
        }
        fn get(&self, key: &str) -> Result<Option<String>> {
            Ok(self.values.lock().unwrap().get(key).cloned())
        }
        fn set(&self, key: &str, value: &str) -> Result<()> {
            self.values.lock().unwrap().insert(key.into(), value.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<()> {
            self.values.lock().unwrap().remove(key);
            Ok(())
        }
    }
    #[test]
    fn plugin_namespace_preserves_providers_revocations_and_rejects_old_writer() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("credentials.json");
        CredentialStore::update_file(&path, |store| {
            store.set_api_key("fixture", "provider-test".into())?;
            store.remove_api_key("retired")?;
            Ok(())
        })
        .unwrap();
        let scope = "a".repeat(64);
        let backend = Backend::default();
        CredentialStore::update_plugin_credentials(
            &path,
            &scope,
            None,
            &BTreeMap::from([("TOKEN".into(), "private-fixture".into())]),
            &["TOKEN".into()],
            CredentialStoreMode::File,
            &backend,
        )
        .unwrap();
        CredentialStore::update_file(&path, |store| {
            store.set_api_key("another", "another-test".into())
        })
        .unwrap();
        let store = CredentialStore::load_from(&path).unwrap();
        assert_eq!(store.credentials["fixture"], "provider-test");
        assert!(store.revoked.contains("retired"));
        assert_eq!(
            store
                .plugin_credentials
                .resolve(&scope, &backend, CredentialStoreMode::File)
                .unwrap()["TOKEN"],
            "private-fixture"
        );
        assert!(!format!("{store:?}").contains("private-fixture"));
        assert!(!format!("{store:?}").contains("provider-test"));
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        #[derive(Debug, Deserialize)]
        struct OldEntry {
            #[serde(rename = "type")]
            credential_type: String,
        }
        let old = serde_json::from_value::<BTreeMap<String, OldEntry>>(value).unwrap();
        assert!(
            old.values()
                .any(|entry| entry.credential_type != "api" && entry.credential_type != "revoked")
        );
        assert_eq!(store.plugin_credentials.scopes.len(), 1);
    }
    #[test]
    fn private_keyring_accounts_are_distinct_and_unavailable_is_missing() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("credentials.json");
        let scope = "b".repeat(64);
        let backend = Backend::default();
        let values = BTreeMap::from([("TOKEN".into(), "private-fixture".into())]);
        let allowed = vec!["TOKEN".into()];
        for _ in 0..2 {
            CredentialStore::update_plugin_credentials(
                &path,
                &scope,
                Some(&"c".repeat(32)),
                &values,
                &allowed,
                CredentialStoreMode::Keyring,
                &backend,
            )
            .unwrap();
        }
        let store = CredentialStore::load_from(&path).unwrap();
        assert_eq!(backend.values.lock().unwrap().len(), 1);
        assert!(
            !std::fs::read_to_string(&path)
                .unwrap()
                .contains("private-fixture")
        );
        assert_eq!(
            store
                .plugin_credentials
                .resolve(&scope, &backend, CredentialStoreMode::Auto)
                .unwrap(),
            values
        );
        assert!(
            store
                .plugin_credentials
                .resolve(&scope, &backend, CredentialStoreMode::File)
                .unwrap()
                .is_empty()
        );
        backend.values.lock().unwrap().clear();
        assert!(
            store
                .plugin_credentials
                .resolve(&scope, &backend, CredentialStoreMode::Auto)
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn concurrent_missing_only_setup_has_one_winner_and_unavailable_markers_cannot_be_replaced() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("credentials.json");
        let scope = "a".repeat(64);
        let backend = std::sync::Arc::new(Backend::default());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers = ["synthetic-first", "synthetic-second"]
            .into_iter()
            .map(|value| {
                let path = path.clone();
                let scope = scope.clone();
                let backend = backend.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    CredentialStore::update_missing_plugin_credentials(
                        &path,
                        &scope,
                        None,
                        &BTreeMap::from([("P09_CAS_VALUE".into(), value.into())]),
                        &["P09_CAS_VALUE".into()],
                        CredentialStoreMode::File,
                        backend.as_ref(),
                    )
                })
            })
            .collect::<Vec<_>>();
        let results = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let conflict = results.into_iter().find_map(Result::err).unwrap();
        assert!(conflict.to_string().contains("plugin_scope_changed"));
        assert!(!conflict.to_string().contains("synthetic-first"));
        assert!(!conflict.to_string().contains("synthetic-second"));
        let keyring_scope = "b".repeat(64);
        CredentialStore::update_plugin_credentials(
            &path,
            &keyring_scope,
            None,
            &BTreeMap::from([("P09_OS_VALUE".into(), "synthetic-old".into())]),
            &["P09_OS_VALUE".into()],
            CredentialStoreMode::Keyring,
            backend.as_ref(),
        )
        .unwrap();
        backend.values.lock().unwrap().clear();
        let before = std::fs::read(&path).unwrap();
        let result = CredentialStore::update_missing_plugin_credentials(
            &path,
            &keyring_scope,
            None,
            &BTreeMap::from([("P09_OS_VALUE".into(), "synthetic-new".into())]),
            &["P09_OS_VALUE".into()],
            CredentialStoreMode::Auto,
            backend.as_ref(),
        );
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("plugin_credential_store_unavailable")
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn wrong_scope_operation_and_undeclared_keys_never_write() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("credentials.json");
        let backend = Backend::default();
        let scope = "a".repeat(64);
        let values = BTreeMap::from([("TOKEN".into(), "fixture".into())]);
        assert!(
            CredentialStore::update_plugin_credentials(
                &path,
                &scope,
                None,
                &values,
                &[],
                CredentialStoreMode::File,
                &backend
            )
            .is_err()
        );
        assert!(!path.exists());
        CredentialStore::update_plugin_credentials(
            &path,
            &scope,
            Some(&"a".repeat(32)),
            &values,
            &["TOKEN".into()],
            CredentialStoreMode::File,
            &backend,
        )
        .unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(
            CredentialStore::update_plugin_credentials(
                &path,
                &scope,
                Some(&"b".repeat(32)),
                &values,
                &["TOKEN".into()],
                CredentialStoreMode::File,
                &backend
            )
            .is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}
