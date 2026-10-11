//! Credentials io stage of configuration loading.

use super::*;

impl Serialize for CredentialStore {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        if self
            .revoked
            .iter()
            .any(|id| self.credentials.contains_key(id))
        {
            return Err(serde::ser::Error::custom(
                "Credential cannot be both present and revoked",
            ));
        }
        let mut entries = self
            .credentials
            .iter()
            .map(|(provider, key)| {
                (
                    provider,
                    StoredApiCredential {
                        credential_type: "api".into(),
                        key: Some(key.clone()),
                    },
                )
            })
            .collect::<BTreeMap<_, _>>();
        for provider in &self.revoked {
            entries.insert(
                provider,
                StoredApiCredential {
                    credential_type: "revoked".into(),
                    key: None,
                },
            );
        }
        let mut document = serde_json::to_value(entries).map_err(serde::ser::Error::custom)?;
        if !self.plugin_credentials.scopes.is_empty() {
            document[crate::plugin_credentials::NAMESPACE] =
                serde_json::to_value(&self.plugin_credentials)
                    .map_err(serde::ser::Error::custom)?;
        }
        document.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for CredentialStore {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let mut document = Value::deserialize(deserializer)?;
        let plugin_credentials = match document
            .as_object_mut()
            .and_then(|object| object.remove(crate::plugin_credentials::NAMESPACE))
        {
            Some(value) => serde_json::from_value(value)
                .map_err(|_| serde::de::Error::custom("invalid plugin credential document"))?,
            None => crate::plugin_credentials::PluginCredentialDocument::default(),
        };
        plugin_credentials
            .validate()
            .map_err(serde::de::Error::custom)?;
        let stored: StoredCredentialDocument =
            serde_json::from_value(document).map_err(serde::de::Error::custom)?;
        let mut revoked = std::collections::BTreeSet::new();
        let credentials = match stored {
            StoredCredentialDocument::Legacy(legacy) => {
                let mut credentials = legacy.api_keys;
                if let Some(retired) = credentials.remove("minimax") {
                    credentials.entry("kunlunmeta".into()).or_insert(retired);
                }
                credentials
            }
            StoredCredentialDocument::Current(stored) => {
                let mut credentials = BTreeMap::new();
                for (provider, credential) in stored {
                    if credential.credential_type == "revoked" {
                        if credential.key.is_some() {
                            return Err(serde::de::Error::custom(
                                "Revoked credential must not contain a key",
                            ));
                        }
                        revoked.insert(provider);
                        continue;
                    }
                    if credential.credential_type != "api" {
                        return Err(serde::de::Error::custom(format!(
                            "credential for provider '{provider}' must have type 'api'"
                        )));
                    }
                    let key = credential
                        .key
                        .ok_or_else(|| serde::de::Error::custom("API credential requires a key"))?;
                    credentials.insert(provider, key);
                }
                credentials
            }
        };
        Ok(Self {
            credentials,
            revoked,
            plugin_credentials,
        })
    }
}

impl CredentialStore {
    /// Read-modify-write credentials under the same per-file lock used by settings writers.
    pub fn update_file<F>(path: &Path, update: F) -> Result<()>
    where
        F: FnOnce(&mut Self) -> Result<()>,
    {
        let _transaction_guard = provider_transaction::write_guard(path)?;
        let lock = lock_settings_path(path)?;
        let result = (|| {
            let mut store = Self::load_from(path)?;
            let original = store.clone();
            update(&mut store)?;
            if store == original {
                return Ok(());
            }
            store.save_to(path)
        })();
        FileExt::unlock(&lock).context("failed to unlock credential file")?;
        result
    }

    pub fn load() -> Result<Self> {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let path = ConfigPaths::discover(&cwd)?.credentials;
        Self::load_from(&path)
    }

    pub fn load_from(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let content = fs::read_to_string(path)
            .with_context(|| format!("failed to read credentials from {}", path.display()))?;
        serde_json::from_str(&content)
            .with_context(|| format!("failed to parse credentials from {}", path.display()))
    }

    pub fn save(&self) -> Result<()> {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let path = ConfigPaths::discover(&cwd)?.credentials;
        self.save_to(&path)
    }

    pub fn save_to(&self, path: &Path) -> Result<()> {
        let value = serde_json::to_value(self).context("failed to serialize credentials")?;
        write_json_atomic(path, &value, true)
    }

    pub fn set_api_key(&mut self, provider: &str, api_key: String) -> Result<()> {
        anyhow::ensure!(
            provider != crate::plugin_credentials::NAMESPACE,
            "reserved credential namespace"
        );
        let provider = normalize_provider(provider)?;
        anyhow::ensure!(!api_key.trim().is_empty(), "API key must not be empty");
        self.revoked.remove(&provider);
        self.credentials.insert(provider, api_key);
        Ok(())
    }

    pub fn remove_api_key(&mut self, provider: &str) -> Result<bool> {
        anyhow::ensure!(
            provider != crate::plugin_credentials::NAMESPACE,
            "reserved credential namespace"
        );
        let provider = normalize_provider(provider)?;
        let removed = self.credentials.remove(&provider).is_some();
        self.revoked.insert(provider);
        Ok(removed)
    }

    pub fn has_api_key(&self, provider: &str) -> bool {
        normalize_provider(provider)
            .ok()
            .is_some_and(|provider| self.credentials.contains_key(&provider))
    }
}

pub(super) fn normalize_provider(provider: &str) -> Result<String> {
    crate::validate_provider_id(provider)
}

pub(super) fn apply_credentials(settings: &mut Settings, credentials: &CredentialStore) {
    // Markers in credentials.json resolve through the operating-system credential store; a
    // marker that cannot be resolved is dropped so it never reaches a Provider as an API key.
    let (resolved, diagnostics) = crate::resolve_stored_credentials(
        &credentials.credentials,
        &crate::OsCredentialBackend::new(),
        settings.credential_store,
    );
    for diagnostic in &diagnostics {
        tracing::warn!(target: "kcoder_config::credentials", "{diagnostic}");
    }
    settings.stored_provider_credentials = resolved.clone();
    settings.revoked_provider_credentials = credentials.revoked.clone();
    for (provider, api_key) in &resolved {
        let target = match provider.as_str() {
            "anthropic" => &mut settings.anthropic_api_key,
            "kunlunmeta" => &mut settings.kunlunmeta_api_key,
            "openai" => &mut settings.openai_api_key,
            "local" => &mut settings.local_api_key,
            "gemini" => &mut settings.gemini_api_key,
            "grok" => &mut settings.grok_api_key,
            _ => continue,
        };
        *target = Some(api_key.clone());
    }
}
