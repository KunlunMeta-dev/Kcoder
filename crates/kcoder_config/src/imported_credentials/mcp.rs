//! MCP bindings share native credential receipts without entering the Provider API-key namespace.
use super::*;
pub(super) mod extensions;
use kcoder_types::{McpCredentialRef, McpServerConfig};
#[cfg(test)]
mod tests;

fn verify_observation_file(file: &std::fs::File) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata = file.metadata()?;
        // SAFETY: geteuid only observes the actual caller identity.
        ensure!(
            metadata.uid() == unsafe { libc::geteuid() }
                && metadata.permissions().mode() & 0o077 == 0,
            "credential_import_unsafe_file"
        );
    }
    #[cfg(windows)]
    crate::file_permissions::verify_windows_user_only_file_handle(file)?;
    Ok(())
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CredentialSubject {
    #[default]
    Provider,
    Mcp {
        binding: String,
        env: Vec<String>,
        headers: Vec<String>,
    },
}
impl CredentialSubject {
    pub fn is_provider(&self) -> bool {
        matches!(self, Self::Provider)
    }
    pub(super) fn same_owner(&self, other: &Self) -> bool {
        self.is_provider() == other.is_provider()
    }
}
pub(super) fn validate_owner(subject: &CredentialSubject, name: &str) -> Result<()> {
    let valid = if subject.is_provider() {
        crate::validate_provider_id(name).ok().as_deref() == Some(name)
    } else {
        !name.is_empty()
            && !name.starts_with("plugin.")
            && name.trim() == name
            && !name.chars().any(char::is_control)
    };
    ensure!(
        valid && name.len() <= 128,
        if subject.is_provider() {
            "credential_import_invalid_provider"
        } else {
            "mcp_credential_invalid_owner"
        }
    );
    Ok(())
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpSecretValues {
    pub env: BTreeMap<String, String>,
    pub headers: BTreeMap<String, String>,
}
impl std::fmt::Debug for McpSecretValues {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("McpSecretValues")
            .field("env_count", &self.env.len())
            .field("header_count", &self.headers.len())
            .finish()
    }
}
impl Drop for McpSecretValues {
    fn drop(&mut self) {
        for value in self.env.values_mut().chain(self.headers.values_mut()) {
            value.zeroize();
        }
    }
}
impl McpSecretValues {
    pub fn encode(&self) -> Result<Zeroizing<String>> {
        self.validate()?;
        let encoded = Zeroizing::new(serde_json::to_string(self)?);
        ensure!(
            encoded.len() <= 2 * 1024 * 1024,
            "mcp_credential_budget_exceeded"
        );
        Ok(encoded)
    }
    pub(super) fn decode(value: &str) -> Result<Self> {
        ensure!(
            value.len() <= 2 * 1024 * 1024,
            "mcp_credential_budget_exceeded"
        );
        let values: Self = serde_json::from_str(value)
            .map_err(|_| anyhow::anyhow!("mcp_credential_invalid_payload"))?;
        values.validate()?;
        Ok(values)
    }
    fn validate(&self) -> Result<()> {
        ensure!(
            !self.env.is_empty() || !self.headers.is_empty(),
            "mcp_credential_empty_payload"
        );
        ensure!(
            self.env.len() + self.headers.len() <= 32,
            "mcp_credential_budget_exceeded"
        );
        for (name, value) in &self.env {
            crate::plugin_credentials::validate_name(name)?;
            validate_value(value)?;
        }
        #[cfg(windows)]
        ensure!(
            self.env
                .keys()
                .map(|name| name.to_ascii_lowercase())
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == self.env.len(),
            "mcp_credential_environment_conflict"
        );
        let mut names = std::collections::BTreeSet::new();
        for (name, value) in &self.headers {
            header_name(name)?;
            validate_value(value)?;
            ensure!(
                names.insert(name.to_ascii_lowercase()),
                "mcp_credential_header_conflict"
            );
            http::HeaderValue::from_str(value)
                .map_err(|_| anyhow::anyhow!("mcp_credential_invalid_header_value"))?;
        }
        Ok(())
    }
    pub(super) fn validate_subject(&self, subject: &CredentialSubject) -> Result<()> {
        let CredentialSubject::Mcp { env, headers, .. } = subject else {
            anyhow::bail!("mcp_credential_wrong_subject")
        };
        ensure!(
            self.env.keys().eq(env.iter())
                && self
                    .headers
                    .keys()
                    .map(|name| name.to_ascii_lowercase())
                    .collect::<std::collections::BTreeSet<_>>()
                    == headers.iter().cloned().collect(),
            "mcp_credential_field_mismatch"
        );
        Ok(())
    }
}
fn validate_value(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && value.len() <= 16384 && !value.contains('\0'),
        "mcp_credential_invalid_value"
    );
    Ok(())
}
fn header_name(name: &str) -> Result<()> {
    ensure!(name.len() <= 128, "mcp_credential_invalid_header_name");
    http::header::HeaderName::from_bytes(name.as_bytes())
        .map_err(|_| anyhow::anyhow!("mcp_credential_invalid_header_name"))?;
    Ok(())
}
pub(super) fn validate_subject(subject: &CredentialSubject) -> Result<()> {
    if let CredentialSubject::Mcp {
        binding,
        env,
        headers,
    } = subject
    {
        ensure!(
            binding.len() == 64
                && binding.bytes().all(|byte| byte.is_ascii_hexdigit())
                && env.len() + headers.len() <= 32
                && env.len() + headers.len() > 0,
            "mcp_credential_invalid_reference"
        );
        for name in env {
            crate::plugin_credentials::validate_name(name)?;
        }
        for name in headers {
            header_name(name)?;
        }
        ensure!(
            env.windows(2).all(|names| names[0] < names[1])
                && headers.windows(2).all(|names| names[0] < names[1])
                && headers
                    .iter()
                    .all(|name| name == &name.to_ascii_lowercase()),
            "mcp_credential_invalid_reference"
        );
    }
    Ok(())
}
pub(super) fn binding_revision(config: &McpServerConfig) -> Result<String> {
    let mut config = config.clone();
    config.policy.credential_ref = None;
    super::group::revision(&serde_json::to_value(config)?)
}
impl CredentialImportRef {
    pub(super) fn same_owner(&self, other: &Self) -> bool {
        self.provider == other.provider && self.subject.same_owner(&other.subject)
    }
}
impl ImportedCredentialDocument {
    pub(super) fn validate_mcp_bindings(&self) -> Result<()> {
        ensure!(
            self.mcp_bindings.len() <= 4096,
            "mcp_credential_budget_exceeded"
        );
        for (id, value) in &self.mcp_bindings {
            let receipt = self
                .receipts
                .get(id)
                .ok_or_else(|| anyhow::anyhow!("mcp_credential_receipt_required"))?;
            ensure!(
                !receipt.reference.subject.is_provider() && receipt.state == ImportState::Published,
                "mcp_credential_invalid_binding"
            );
            if receipt.reference.storage == ImportStorage::File {
                McpSecretValues::decode(&value.0)?.validate_subject(&receipt.reference.subject)?;
                ensure!(
                    hash(&value.0) == receipt.fingerprint,
                    "mcp_credential_invalid_binding"
                );
            } else {
                ensure!(
                    value.0 == marker_for_provider(&receipt.reference.account),
                    "mcp_credential_invalid_binding"
                );
            }
        }
        Ok(())
    }
}
pub(super) fn binding<'a>(
    store: &'a CredentialStore,
    reference: &CredentialImportRef,
) -> Option<&'a str> {
    if reference.subject.is_provider() {
        store
            .credentials
            .get(&reference.provider)
            .map(String::as_str)
    } else {
        store
            .imported_credentials
            .mcp_bindings
            .get(&reference.operation_id)
            .map(|value| value.0.as_str())
    }
}
pub(super) fn revoked(store: &CredentialStore, reference: &CredentialImportRef) -> bool {
    reference.subject.is_provider() && store.revoked.contains(&reference.provider)
        || !reference.subject.is_provider()
            && store
                .imported_credentials
                .receipts
                .get(&reference.operation_id)
                .is_some_and(|receipt| receipt.state == ImportState::Undoing)
}
pub(super) fn occupied(store: &CredentialStore, reference: &CredentialImportRef) -> bool {
    binding(store, reference).is_some() || revoked(store, reference)
}
pub(super) fn binding_used_elsewhere(
    store: &CredentialStore,
    reference: &CredentialImportRef,
    marker: &str,
) -> bool {
    store.credentials.iter().any(|(name, value)| {
        (!reference.subject.is_provider() || name != &reference.provider) && value == marker
    }) || store
        .imported_credentials
        .mcp_bindings
        .iter()
        .any(|(id, value)| {
            (reference.subject.is_provider() || id != &reference.operation_id) && value.0 == marker
        })
}
pub(super) fn set_binding(
    store: &mut CredentialStore,
    reference: &CredentialImportRef,
    value: String,
) -> Result<()> {
    if reference.subject.is_provider() {
        store.set_api_key(&reference.provider, value)
    } else {
        store
            .imported_credentials
            .mcp_bindings
            .insert(reference.operation_id.clone(), StagedKey(value));
        Ok(())
    }
}
pub(super) fn remove_binding(
    store: &mut CredentialStore,
    reference: &CredentialImportRef,
    tombstone: bool,
) -> Option<Zeroizing<String>> {
    if reference.subject.is_provider() {
        let value = store
            .credentials
            .remove(&reference.provider)
            .map(Zeroizing::new);
        if tombstone {
            store.revoked.insert(reference.provider.clone());
        } else {
            store.revoked.remove(&reference.provider);
        }
        value
    } else {
        store
            .imported_credentials
            .mcp_bindings
            .remove(&reference.operation_id)
            .map(|value| Zeroizing::new(value.0.clone()))
    }
}
pub(super) fn verify_settings(reference: &CredentialImportRef, settings: &Value) -> Result<()> {
    match &reference.subject {
        CredentialSubject::Provider => {
            let provider: crate::ProviderConfig = serde_json::from_value(
                settings
                    .get("providers")
                    .and_then(|providers| providers.get(&reference.provider))
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("credential_group_provider_missing"))?,
            )
            .map_err(|_| anyhow::anyhow!("credential_group_provider_invalid"))?;
            ensure!(
                provider.authentication.is_api_key(),
                "credential_group_provider_invalid"
            );
        }
        CredentialSubject::Mcp { binding, .. } => {
            let servers = settings
                .get("mcp_servers")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow::anyhow!("mcp_credential_target_missing"))?;
            let config: McpServerConfig = serde_json::from_value(
                servers
                    .iter()
                    .find(|server| {
                        server.get("name").and_then(Value::as_str) == Some(&reference.provider)
                    })
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("mcp_credential_target_missing"))?,
            )
            .map_err(|_| anyhow::anyhow!("mcp_credential_target_changed"))?;
            ensure!(
                config
                    .policy
                    .credential_ref
                    .as_ref()
                    .map(|value| value.id.as_str())
                    == Some(&reference.operation_id)
                    && binding_revision(&config)? == *binding,
                "mcp_credential_target_changed"
            );
        }
    }
    Ok(())
}

impl ImportedCredentialStore {
    /// Prepare names and a binding only; source secret values are not read by this operation.
    pub fn prepare_mcp(
        &self,
        config: &McpServerConfig,
        env: &[String],
        headers: &[String],
        mode: CredentialStoreMode,
        backend: &dyn CredentialBackend,
    ) -> Result<CredentialImportRef> {
        ensure!(
            config.policy.credential_ref.is_none(),
            "mcp_credential_target_exists"
        );
        self.prepare_mcp_inner(config, env, headers, mode, backend, None)
    }

    /// Extend one existing binding with additional fields; the prior binding remains owned.
    pub fn prepare_mcp_extension(
        &self,
        config: &McpServerConfig,
        env: &[String],
        headers: &[String],
        mode: CredentialStoreMode,
        backend: &dyn CredentialBackend,
    ) -> Result<CredentialImportRef> {
        let previous = config
            .policy
            .credential_ref
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("mcp_credential_reference_required"))?;
        // Check the actual native binding before accepting its identity as a predecessor.
        drop(self.resolve_mcp_with_mode(config, mode, backend)?);
        self.prepare_mcp_inner(
            config,
            env,
            headers,
            mode,
            backend,
            Some(previous.id.clone()),
        )
    }

    fn prepare_mcp_inner(
        &self,
        config: &McpServerConfig,
        env: &[String],
        headers: &[String],
        mode: CredentialStoreMode,
        backend: &dyn CredentialBackend,
        predecessor: Option<String>,
    ) -> Result<CredentialImportRef> {
        ensure!(
            !config.name.starts_with("plugin."),
            "mcp_credential_target_exists"
        );
        let mut env = env.to_vec();
        env.sort();
        let mut headers = headers
            .iter()
            .map(|name| name.to_ascii_lowercase())
            .collect::<Vec<_>>();
        headers.sort();
        let subject = CredentialSubject::Mcp {
            binding: binding_revision(config)?,
            env,
            headers,
        };
        validate_subject(&subject)?;
        if let CredentialSubject::Mcp { env, headers, .. } = &subject {
            ensure!(
                env.len()
                    + headers.len()
                    + config.policy.env_vars.len()
                    + config.policy.env_aliases.len()
                    + config.policy.env_http_headers.len()
                    + usize::from(config.policy.bearer_token_env_var.is_some())
                    <= 32,
                "mcp_credential_budget_exceeded"
            );
            ensure!(
                env.is_empty() || config.transport == "stdio",
                "mcp_credential_invalid_transport"
            );
            ensure!(
                headers.is_empty() || matches!(config.transport.as_str(), "http" | "sse"),
                "mcp_credential_invalid_transport"
            );
            for name in env {
                ensure!(
                    config.policy.required_env.contains(name)
                        && !config
                            .env
                            .keys()
                            .chain(config.policy.env_aliases.keys())
                            .chain(config.policy.env_vars.iter())
                            .any(|configured| {
                                if cfg!(windows) {
                                    configured.eq_ignore_ascii_case(name)
                                } else {
                                    configured == name
                                }
                            }),
                    "mcp_credential_undeclared_field"
                );
            }
            for name in headers {
                ensure!(
                    config
                        .policy
                        .required_headers
                        .iter()
                        .any(|required| required.eq_ignore_ascii_case(name))
                        && !config
                            .headers
                            .keys()
                            .chain(config.policy.env_http_headers.keys())
                            .any(|configured| configured.eq_ignore_ascii_case(name))
                        && !(name == "authorization"
                            && config.policy.bearer_token_env_var.is_some()),
                    "mcp_credential_undeclared_field"
                );
            }
        }
        let reference =
            self.prepare_subject_extension(&config.name, subject, mode, backend, predecessor)?;
        self.check(&reference)?;
        Ok(reference)
    }

    /// Resolve only the exact published reference, owning profile and approved server definition.
    pub fn resolve_mcp(
        &self,
        config: &McpServerConfig,
        backend: &dyn CredentialBackend,
    ) -> Result<McpSecretValues> {
        self.resolve_mcp_inner(config, None, backend)
            .map(|value| value.0)
    }
    pub fn resolve_mcp_with_mode(
        &self,
        config: &McpServerConfig,
        mode: CredentialStoreMode,
        backend: &dyn CredentialBackend,
    ) -> Result<McpSecretValues> {
        self.resolve_mcp_inner(config, Some(mode), backend)
            .map(|value| value.0)
    }
    /// Internal cache authority contains file identity, never a public secret digest.
    pub fn mcp_connection_revision(
        &self,
        config: &McpServerConfig,
        mode: CredentialStoreMode,
        backend: &dyn CredentialBackend,
    ) -> Result<String> {
        self.resolve_mcp_inner(config, Some(mode), backend)
            .map(|value| value.1)
    }

    /// Observe the original published reference and actual backing without
    /// creating locks, recovering a transaction, refreshing or writing secrets.
    /// Returned revisions never contain values and grant no execution authority.
    pub fn observe_mcp_connection_revision(
        &self,
        config: &McpServerConfig,
        mode: CredentialStoreMode,
        backend: &dyn CredentialBackend,
    ) -> Result<String> {
        let reference = config
            .policy
            .credential_ref
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("mcp_credential_reference_required"))?;
        ensure!(
            reference.id.len() == 37
                && reference.id.starts_with("cred-")
                && reference.id[5..]
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit()),
            "mcp_credential_invalid_reference"
        );
        self.directory.verify_trusted_config_directory()?;
        let mut locks = Vec::new();
        for name in [
            ".provider-transaction.json.lock",
            "settings.json.lock",
            "credentials.json.lock",
        ] {
            let file = self
                .directory
                .open_single_link_regular_file(OsStr::new(name))?;
            verify_observation_file(&file)?;
            let identity = PrivateDirectory::identity_of_file(&file)?;
            fs2::FileExt::try_lock_shared(&file)
                .map_err(|_| anyhow::anyhow!("mcp_credential_observation_busy"))?;
            ensure!(
                self.directory.regular_file_identity(OsStr::new(name))? == identity,
                "mcp_credential_observation_changed"
            );
            locks.push((name, file, identity));
        }
        // Same fixed-observer refusal as provider_transaction, but relative to
        // the held private directory and without opening journal payload bytes.
        let refuse_pending = || -> Result<()> {
            for name in [".provider-transaction.json", super::GROUP_JOURNAL] {
                match self.directory.entry_metadata(OsStr::new(name)) {
                    Ok(_) => anyhow::bail!("CONFIGURATION_READ_ONLY_TRANSACTION_PENDING"),
                    Err(error) if missing(&error) => (),
                    Err(error) => return Err(error),
                }
            }
            Ok(())
        };
        refuse_pending()?;
        let mut file = self
            .directory
            .open_single_link_regular_file(OsStr::new("credentials.json"))?;
        let identity = PrivateDirectory::identity_of_file(&file)?;
        verify_observation_file(&file)?;
        ensure!(
            file.metadata()?.len() <= MAX_BYTES,
            "credential_import_budget_exceeded"
        );
        let mut bytes = Zeroizing::new(Vec::new());
        (&mut file).take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 <= MAX_BYTES,
            "credential_import_budget_exceeded"
        );
        let private = PrivateCredentials(
            serde_json::from_slice(&bytes)
                .map_err(|_| anyhow::anyhow!("credential_import_invalid_metadata"))?,
        );
        let metadata = &private.0.imported_credentials;
        metadata.validate()?;
        let receipt = metadata
            .receipts
            .get(&reference.id)
            .ok_or_else(|| anyhow::anyhow!("mcp_credential_reference_missing"))?;
        self.check(&receipt.reference)?;
        ensure!(
            receipt.reference.operation_id == reference.id
                && receipt.state == ImportState::Published
                && receipt.fingerprint.len() == 64
                && receipt
                    .fingerprint
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit()),
            "credential_import_invalid_metadata"
        );
        ensure!(
            mode == CredentialStoreMode::Auto
                || matches!(
                    (mode, receipt.reference.storage),
                    (CredentialStoreMode::File, ImportStorage::File)
                        | (CredentialStoreMode::Keyring, ImportStorage::Keyring)
                ),
            "mcp_credential_policy_mismatch"
        );
        let CredentialSubject::Mcp {
            binding: expected, ..
        } = &receipt.reference.subject
        else {
            anyhow::bail!("mcp_credential_wrong_subject")
        };
        ensure!(
            receipt.reference.provider == config.name && binding_revision(config)? == *expected,
            "mcp_credential_target_changed"
        );
        for (id, group) in &metadata.groups {
            group.validate()?;
            ensure!(id == &group.group_id, "credential_group_invalid_metadata");
            if let Some(group_ref) = group
                .references
                .iter()
                .find(|item| item.operation_id == reference.id)
            {
                ensure!(
                    group_ref == &receipt.reference
                        && group.outcome == CredentialGroupOutcome::Committed,
                    "mcp_credential_publication_changed"
                );
            }
        }
        // Preserve the resolver's actual backing checks. OsCredentialBackend::get
        // only reads its original keyring entry; values remain zeroizing/private.
        self.check_binding(
            &private.0,
            &receipt.reference,
            &receipt.fingerprint,
            backend,
        )?;
        let secret = if receipt.reference.storage == ImportStorage::File {
            Zeroizing::new(
                binding(&private.0, &receipt.reference)
                    .ok_or_else(|| anyhow::anyhow!("mcp_credential_target_changed"))?
                    .to_owned(),
            )
        } else {
            Zeroizing::new(
                backend
                    .get(&receipt.reference.account)
                    .map_err(|_| anyhow::anyhow!("credential_import_backend_unavailable"))?
                    .ok_or_else(|| anyhow::anyhow!("credential_import_keyring_entry_missing"))?,
            )
        };
        ensure!(
            hash(&secret) == receipt.fingerprint,
            "mcp_credential_target_changed"
        );
        let values = McpSecretValues::decode(&secret)?;
        values.validate_subject(&receipt.reference.subject)?;
        refuse_pending()?;
        ensure!(
            self.directory
                .regular_file_identity(OsStr::new("credentials.json"))?
                == identity
                && PrivateDirectory::identity_of_file(&file)? == identity,
            "mcp_credential_observation_changed"
        );
        verify_observation_file(&file)?;
        for (name, file, identity) in &locks {
            ensure!(
                self.directory.regular_file_identity(OsStr::new(name))? == *identity
                    && PrivateDirectory::identity_of_file(file)? == *identity,
                "mcp_credential_observation_changed"
            );
            verify_observation_file(file)?;
        }
        self.directory.verify_trusted_config_directory()?;
        Ok(format!("mcp:{}:{}", reference.id, identity))
    }
    fn resolve_mcp_inner(
        &self,
        config: &McpServerConfig,
        mode: Option<CredentialStoreMode>,
        backend: &dyn CredentialBackend,
    ) -> Result<(McpSecretValues, String)> {
        let reference = config
            .policy
            .credential_ref
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("mcp_credential_reference_required"))?;
        ensure!(
            reference.id.len() == 37
                && reference.id.starts_with("cred-")
                && reference.id[5..]
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit()),
            "mcp_credential_invalid_reference"
        );
        let _coordinator = self.lock(".provider-transaction.json.lock", true)?;
        self.require_no_pending_pair()?;
        self.recover_group_locked()?;
        let _settings = self.lock("settings.json.lock", false)?;
        let policy = match mode {
            Some(mode) => mode,
            None => self
                .settings()?
                .get("credential_store")
                .cloned()
                .map(serde_json::from_value::<CredentialStoreMode>)
                .transpose()
                .map_err(|_| anyhow::anyhow!("mcp_credential_invalid_policy"))?
                .unwrap_or_default(),
        };
        let _lock = self.lock("credentials.json.lock", false)?;
        let store = self.read()?;
        let receipt = store
            .0
            .imported_credentials
            .receipts
            .get(&reference.id)
            .ok_or_else(|| anyhow::anyhow!("mcp_credential_reference_missing"))?;
        self.check(&receipt.reference)?;
        ensure!(
            policy == CredentialStoreMode::Auto
                || matches!(
                    (policy, receipt.reference.storage),
                    (CredentialStoreMode::File, ImportStorage::File)
                        | (CredentialStoreMode::Keyring, ImportStorage::Keyring)
                ),
            "mcp_credential_policy_mismatch"
        );
        let CredentialSubject::Mcp {
            binding: expected, ..
        } = &receipt.reference.subject
        else {
            anyhow::bail!("mcp_credential_wrong_subject")
        };
        ensure!(
            receipt.reference.provider == config.name
                && receipt.state == ImportState::Published
                && binding_revision(config)? == *expected,
            "mcp_credential_target_changed"
        );
        self.check_binding(&store.0, &receipt.reference, &receipt.fingerprint, backend)?;
        let secret = if receipt.reference.storage == ImportStorage::File {
            Zeroizing::new(binding(&store.0, &receipt.reference).unwrap().to_owned())
        } else {
            Zeroizing::new(
                backend
                    .get(&receipt.reference.account)
                    .map_err(|_| anyhow::anyhow!("credential_import_backend_unavailable"))?
                    .ok_or_else(|| anyhow::anyhow!("credential_import_keyring_entry_missing"))?,
            )
        };
        ensure!(
            hash(&secret) == receipt.fingerprint,
            "mcp_credential_target_changed"
        );
        let values = McpSecretValues::decode(&secret)?;
        values.validate_subject(&receipt.reference.subject)?;
        let revision = format!(
            "mcp:{}:{}",
            reference.id,
            self.directory
                .regular_file_identity(OsStr::new("credentials.json"))?
        );
        Ok((values, revision))
    }
}

impl CredentialImportRef {
    pub fn mcp_reference(&self) -> Result<McpCredentialRef> {
        validate_reference(self)?;
        ensure!(!self.subject.is_provider(), "mcp_credential_wrong_subject");
        Ok(McpCredentialRef {
            id: self.operation_id.clone(),
        })
    }
}
