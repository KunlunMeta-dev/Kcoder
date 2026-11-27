//! Explicit API-key migration reads only a selected config field or its named environment variable.
mod received;
use crate::{NormalizedItem, discovery::ConfigurationBinding};
use anyhow::{Result, ensure};
use kcoder_config::{
    CredentialBackend, CredentialStoreMode, PrivateDirectory, ProfileSettingsFile, ProviderConfig,
    imported_credentials::{CredentialImportRef, ImportState, ImportedCredentialStore},
};
use kcoder_types::migration::MigrationSourceKind;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;
use zeroize::{Zeroize, Zeroizing};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "variable",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ApiKeySelector {
    ClaudeConfiguration,
    Environment(String),
}

pub use kcoder_types::migration::MigrationCredentialPhase as CredentialPhase;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialPlan {
    pub plan_id: String,
    pub item_id: String,
    pub target_name: String,
    pub endpoint: String,
    pub selector: ApiKeySelector,
    pub source: crate::source_transfer::private_credentials::CredentialSourceBinding,
    pub reference: CredentialImportRef,
    pub provider: ProviderConfig,
    pub policy: CredentialStoreMode,
    pub phase: CredentialPhase,
    #[serde(default)]
    pub undo_requested: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub atomic_group_id: Option<String>,
    fingerprint: String,
}
impl std::fmt::Debug for CredentialPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialPlan")
            .field("plan_id", &self.plan_id)
            .field("phase", &self.phase)
            .finish_non_exhaustive()
    }
}

pub struct CredentialTarget {
    store: ImportedCredentialStore,
    settings: ProfileSettingsFile,
    templates: kcoder_config::settings_templates::SettingsTemplateStore,
}
impl CredentialTarget {
    pub(crate) fn native(&self) -> &ImportedCredentialStore {
        &self.store
    }
    pub(crate) fn directory_identity(&self) -> Result<String> {
        self.settings.directory_identity()
    }

    pub(crate) fn stage(
        &self,
        plan: &CredentialPlan,
        backend: &dyn CredentialBackend,
        source_name: &str,
    ) -> Result<ImportState> {
        let key = plan.source.provider_key(
            &self.directory_identity()?,
            backend,
            source_name,
            &plan.target_name,
            &plan.selector,
        )?;
        ensure!(
            hash(&key) == plan.fingerprint,
            "migration_credential_source_changed"
        );
        self.store
            .stage(&plan.reference, &key, backend)
            .map_err(safe_error)
    }

    pub(crate) fn group_receipt(
        &self,
        id: &str,
    ) -> Result<Option<kcoder_config::imported_credentials::CredentialGroupReceipt>> {
        self.store.group_receipt(id).map_err(safe_error)
    }

    pub(crate) fn publish_group(
        &self,
        id: &str,
        references: &[CredentialImportRef],
        backend: &dyn CredentialBackend,
        update: impl FnOnce(&mut Value, &std::collections::BTreeSet<String>) -> Result<()>,
    ) -> Result<kcoder_config::imported_credentials::CredentialGroupReceipt> {
        self.store
            .publish_group_checked(id, references, backend, update)
            .map_err(safe_error)
    }

    pub(crate) fn undo_group(
        &self,
        id: &str,
        backend: &dyn CredentialBackend,
        update: impl FnOnce(&mut Value) -> Result<()>,
    ) -> Result<kcoder_config::imported_credentials::CredentialGroupReceipt> {
        self.store
            .undo_group(id, backend, update)
            .map_err(safe_error)
    }
    pub fn open(profile: &Path) -> Result<Self> {
        let directory = PrivateDirectory::open_existing(profile)?;
        directory.verify_trusted_config_directory()?;
        Ok(Self {
            store: ImportedCredentialStore::open(profile)?,
            templates: kcoder_config::settings_templates::SettingsTemplateStore::open(profile)?,
            settings: ProfileSettingsFile::new(directory)?,
        })
    }
    pub fn prepare(
        &self,
        item: &NormalizedItem,
        binding: &ConfigurationBinding,
        target_name: &str,
        selector: ApiKeySelector,
        policy: CredentialStoreMode,
        backend: &dyn CredentialBackend,
    ) -> Result<CredentialPlan> {
        let provider = provider_in(&self.settings.read()?, target_name)?;
        self.prepare_prospective(
            item,
            binding,
            (target_name, provider),
            selector,
            policy,
            backend,
        )
    }

    pub(crate) fn prepare_prospective(
        &self,
        item: &NormalizedItem,
        binding: &ConfigurationBinding,
        destination: (&str, ProviderConfig),
        selector: ApiKeySelector,
        policy: CredentialStoreMode,
        backend: &dyn CredentialBackend,
    ) -> Result<CredentialPlan> {
        let (target_name, provider) = destination;
        binding.validate_provider_item(item)?;
        let inventory = binding.inventory()?;
        let original = inventory
            .items
            .iter()
            .find(|source| {
                source.preview.source_name == item.preview.source_name && source.provider.is_some()
            })
            .ok_or_else(|| anyhow::anyhow!("migration_not_a_provider"))?;
        let candidate = original.provider.as_ref().unwrap();
        ensure!(
            !item
                .preview
                .issues
                .iter()
                .any(|issue| issue.blocks_import()),
            "migration_item_requires_resolution"
        );
        let original_endpoint = candidate
            .endpoint
            .as_deref()
            .or_else(|| {
                (binding.kind == MigrationSourceKind::ClaudeCode)
                    .then_some("https://api.anthropic.com")
            })
            .ok_or_else(|| anyhow::anyhow!("migration_credential_source_endpoint_unknown"))?;
        ensure!(
            same_endpoint(original_endpoint, &provider.endpoint)
                && provider.api_format.as_str() == candidate.api_format
                && provider.authentication.is_api_key(),
            "migration_credential_destination_mismatch"
        );
        if let ApiKeySelector::Environment(variable) = &selector {
            ensure!(
                candidate.credential_environment.as_deref() == Some(variable.as_str())
                    || binding.kind == MigrationSourceKind::ClaudeCode
                        && variable == "ANTHROPIC_API_KEY",
                "migration_credential_source_not_declared"
            );
        }
        let key = read_key(binding, &selector, &item.preview.source_name)?;
        let reference = self
            .store
            .prepare(target_name, policy, backend)
            .map_err(safe_error)?;
        Ok(CredentialPlan {
            plan_id: reference.operation_id.clone(),
            item_id: item.preview.id.clone(),
            target_name: target_name.into(),
            endpoint: provider.endpoint.clone(),
            selector,
            source: crate::source_transfer::private_credentials::CredentialSourceBinding::Local(
                Box::new(binding.clone()),
            ),
            reference,
            provider,
            policy,
            phase: CredentialPhase::Ready,
            undo_requested: false,
            error_code: None,
            atomic_group_id: None,
            fingerprint: hash(&key),
        })
    }
    pub(crate) fn verify_group(&self, id: &str, backend: &dyn CredentialBackend) -> Result<()> {
        self.store.verify_group(id, backend).map_err(safe_error)
    }
    pub fn publish(
        &self,
        plan: &CredentialPlan,
        backend: &dyn CredentialBackend,
        source_name: &str,
    ) -> Result<ImportState> {
        if let Some(state) = self
            .store
            .state(&plan.reference, backend)
            .map_err(safe_error)?
        {
            if state == ImportState::Published {
                return Ok(state);
            }
            ensure!(
                !matches!(state, ImportState::Undoing | ImportState::Undone),
                "migration_credential_import_undone"
            );
        }
        let key = plan.source.provider_key(
            &self.directory_identity()?,
            backend,
            source_name,
            &plan.target_name,
            &plan.selector,
        )?;
        ensure!(
            hash(&key) == plan.fingerprint,
            "migration_credential_source_changed"
        );
        self.store
            .install(&plan.reference, &key, backend, |document| {
                let current = provider_in(document, &plan.target_name)?;
                ensure!(
                    current == plan.provider,
                    "migration_credential_destination_changed"
                );
                Ok(())
            })
            .map_err(safe_error)
    }
    pub fn state(
        &self,
        plan: &CredentialPlan,
        backend: &dyn CredentialBackend,
    ) -> Result<Option<ImportState>> {
        self.store
            .state(&plan.reference, backend)
            .map_err(safe_error)
    }
    pub fn undo(
        &self,
        plan: &CredentialPlan,
        backend: &dyn CredentialBackend,
    ) -> Result<ImportState> {
        if self
            .store
            .state(&plan.reference, backend)
            .map_err(safe_error)?
            == Some(ImportState::Undone)
        {
            return Ok(ImportState::Undone);
        }
        self.templates
            .with_unreferenced_providers(&[&plan.target_name], || {
                self.store
                    .undo(&plan.reference, backend)
                    .map_err(safe_error)
            })
            .map_err(crate::templates::safe_error)
    }
}

pub(crate) fn read_key(
    binding: &ConfigurationBinding,
    selector: &ApiKeySelector,
    source_name: &str,
) -> Result<Zeroizing<String>> {
    let document = binding.read()?;
    match (binding.kind, selector) {
        (MigrationSourceKind::ClaudeCode, ApiKeySelector::ClaudeConfiguration) => {
            let mut parsed: Value =
                jsonc_parser::parse_to_serde_value(document.text(), &Default::default())
                    .map_err(|_| anyhow::anyhow!("migration_invalid_source_format"))?;
            ensure!(
                parsed.get("apiKeyHelper").is_none()
                    && parsed.pointer("/env/ANTHROPIC_AUTH_TOKEN").is_none()
                    && parsed.pointer("/env/CLAUDE_CODE_OAUTH_TOKEN").is_none(),
                "migration_credential_authentication_unsupported"
            );
            if let Some(value) = binding.read_layer_private_field("/env/ANTHROPIC_API_KEY")? {
                return validate_key(value.as_str().to_owned());
            }
            let value = parsed
                .pointer_mut("/env/ANTHROPIC_API_KEY")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
                .ok_or_else(|| anyhow::anyhow!("migration_credential_key_missing"))?;
            if let Some(Value::String(stored)) = parsed.pointer_mut("/env/ANTHROPIC_API_KEY") {
                stored.zeroize();
            }
            validate_key(value)
        }
        (kind, ApiKeySelector::Environment(variable)) => {
            ensure!(
                valid_environment(variable),
                "migration_credential_source_not_declared"
            );
            if kind == MigrationSourceKind::Codex {
                let parsed: toml::Value = toml::from_str(document.text())
                    .map_err(|_| anyhow::anyhow!("migration_invalid_source_format"))?;
                let provider = parsed
                    .get("model_providers")
                    .and_then(|value| value.get(source_name))
                    .ok_or_else(|| anyhow::anyhow!("migration_credential_source_not_declared"))?;
                ensure!(
                    provider.get("env_key").and_then(toml::Value::as_str) == Some(variable)
                        && provider
                            .get("requires_openai_auth")
                            .is_none_or(|value| value.as_bool() == Some(false))
                        && provider.get("auth").is_none()
                        && provider.get("experimental_bearer_token").is_none(),
                    "migration_credential_authentication_unsupported"
                );
            } else {
                ensure!(
                    variable == "ANTHROPIC_API_KEY",
                    "migration_credential_source_not_declared"
                );
            }
            validate_key(
                std::env::var(variable)
                    .map_err(|_| anyhow::anyhow!("migration_credential_key_missing"))?,
            )
        }
        _ => anyhow::bail!("migration_credential_authentication_unsupported"),
    }
}
fn validate_key(value: String) -> Result<Zeroizing<String>> {
    let key = Zeroizing::new(value);
    ensure!(
        !key.is_empty()
            && key.len() <= 16 * 1024
            && key.trim() == key.as_str()
            && !key.chars().any(char::is_control),
        "migration_credential_invalid_api_key"
    );
    Ok(key)
}
fn valid_environment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            byte == b'_' || byte.is_ascii_alphabetic() || index > 0 && byte.is_ascii_digit()
        })
}
fn provider_in(document: &Value, name: &str) -> Result<ProviderConfig> {
    serde_json::from_value(
        document
            .get("providers")
            .and_then(|providers| providers.get(name))
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("migration_credential_provider_missing"))?,
    )
    .map_err(|_| anyhow::anyhow!("migration_credential_invalid_destination"))
}
fn same_endpoint(source: &str, target: &str) -> bool {
    source.trim_end_matches('/') == target.trim_end_matches('/')
}
fn hash(key: &str) -> String {
    format!("{:x}", Sha256::digest(key.as_bytes()))
}
fn safe_error(error: anyhow::Error) -> anyhow::Error {
    let code = error.to_string();
    if (code.starts_with("credential_import_")
        || code.starts_with("credential_group_")
        || code.starts_with("mcp_credential_"))
        && code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
    {
        anyhow::anyhow!("migration_{code}")
    } else if code.starts_with("migration_")
        && code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
    {
        anyhow::anyhow!(code)
    } else {
        anyhow::anyhow!("migration_credential_operation_unconfirmed")
    }
}
