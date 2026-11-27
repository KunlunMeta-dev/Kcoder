//! Explicit MCP private imports pair the public reference and private binding atomically.
mod extension;
mod received;
mod source;
use crate::credentials::CredentialPhase;
use crate::{NormalizedItem, discovery::ConfigurationBinding, providers::revision};
use anyhow::{Result, ensure};
use kcoder_config::{
    CredentialBackend, CredentialStoreMode, PrivateDirectory, ProfileSettingsFile,
    imported_credentials::{
        CredentialGroupOutcome, CredentialImportRef, ImportedCredentialStore, mcp::McpSecretValues,
    },
};
pub use kcoder_types::migration::MigrationMcpPrivateField;
use kcoder_types::{McpServerConfig, migration::MigrationMcpPrivateField as Field};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
pub(crate) use source::read as read_private_literals;
use std::path::Path;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpCredentialPlan {
    pub plan_id: String,
    pub group_id: String,
    pub item_id: String,
    pub source_name: String,
    pub fields: Vec<Field>,
    pub source: crate::source_transfer::private_credentials::CredentialSourceBinding,
    pub reference: CredentialImportRef,
    pub original: McpServerConfig,
    pub config: McpServerConfig,
    pub policy: CredentialStoreMode,
    pub phase: CredentialPhase,
    #[serde(default)]
    pub undo_requested: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    published_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub atomic_group_id: Option<String>,
    fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preserved: Option<extension::PreservedFields>,
}
impl std::fmt::Debug for McpCredentialPlan {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("McpCredentialPlan")
            .field("plan_id", &self.plan_id)
            .field("phase", &self.phase)
            .finish_non_exhaustive()
    }
}

pub struct McpCredentialTarget {
    settings: ProfileSettingsFile,
    store: ImportedCredentialStore,
    mcp: crate::mcp::McpTarget,
}
impl McpCredentialPlan {
    pub fn remaining_fields(&self) -> usize {
        self.original
            .policy
            .required_env
            .iter()
            .filter(|name| !self.covers(&Field::Environment((*name).clone())))
            .count()
            + self
                .original
                .policy
                .required_headers
                .iter()
                .filter(|name| !self.covers(&Field::Header(name.to_ascii_lowercase())))
                .count()
    }
}
impl McpCredentialTarget {
    pub(crate) fn prepare_received_prospective(
        &self,
        item: &NormalizedItem,
        input: crate::source_transfer::private_credentials::ReceivedCredentialInput<'_>,
        saved: &McpServerConfig,
        fields: &[Field],
        consent: bool,
    ) -> Result<McpCredentialPlan> {
        received::prepare_material(
            &self.store,
            &self.settings.directory_identity()?,
            item,
            input,
            saved,
            fields,
            consent,
        )
    }

    pub fn open(profile: &Path) -> Result<Self> {
        Ok(Self {
            settings: ProfileSettingsFile::new(PrivateDirectory::open_existing(profile)?)?,
            store: ImportedCredentialStore::open(profile)?,
            mcp: crate::mcp::McpTarget::open(profile)?,
        })
    }

    pub(crate) fn check_import(&self, plan: &crate::mcp::McpPlan) -> Result<()> {
        self.mcp.check_binding(plan)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn prepare(
        &self,
        item: &NormalizedItem,
        binding: &ConfigurationBinding,
        saved: &McpServerConfig,
        fields: &[Field],
        consent: bool,
        policy: CredentialStoreMode,
        backend: &dyn CredentialBackend,
    ) -> Result<McpCredentialPlan> {
        let before = self.settings.read()?;
        require_server(&before, saved)?;
        let mut plan = prepare_material(
            &self.store,
            item,
            binding,
            saved,
            fields,
            consent,
            policy,
            backend,
        )?;
        let mut after = before.clone();
        replace_server(&mut after, saved, &plan.config)?;
        plan.expected_revision = Some(revision(&before));
        plan.published_revision = Some(revision(&after));
        Ok(plan)
    }

    pub fn publish(
        &self,
        plan: &McpCredentialPlan,
        policy: CredentialStoreMode,
        backend: &dyn CredentialBackend,
    ) -> Result<()> {
        ensure!(
            plan.atomic_group_id.is_none(),
            "migration_credential_group_operation_required"
        );
        ensure!(
            policy == plan.policy,
            "migration_mcp_private_storage_policy_changed"
        );
        if let Some(outcome) = self.outcome(plan)? {
            ensure!(
                outcome == CredentialGroupOutcome::Committed,
                "migration_mcp_private_import_undone"
            );
            self.store
                .verify_group(&plan.group_id, backend)
                .map_err(safe_error)?;
            return Ok(());
        }
        plan.stage_native(&self.store, backend, &self.settings.directory_identity()?)?;
        let receipt = self
            .store
            .publish_group(
                &plan.group_id,
                std::slice::from_ref(&plan.reference),
                backend,
                |document| {
                    ensure!(
                        Some(revision(document)) == plan.expected_revision,
                        "migration_mcp_private_destination_changed"
                    );
                    replace_server(document, &plan.original, &plan.config)?;
                    ensure!(
                        Some(revision(document)) == plan.published_revision,
                        "migration_mcp_private_plan_changed"
                    );
                    Ok(())
                },
            )
            .map_err(safe_error)?;
        verify_receipt(plan, &receipt)?;
        Ok(())
    }

    pub fn undo(
        &self,
        plan: &McpCredentialPlan,
        policy: CredentialStoreMode,
        backend: &dyn CredentialBackend,
    ) -> Result<()> {
        ensure!(
            plan.atomic_group_id.is_none(),
            "migration_credential_group_operation_required"
        );
        ensure!(
            policy == plan.policy,
            "migration_mcp_private_storage_policy_changed"
        );
        match self.outcome(plan)? {
            Some(CredentialGroupOutcome::Committed) => {
                self.store
                    .undo_group(&plan.group_id, backend, |document| {
                        ensure!(
                            Some(revision(document)) == plan.published_revision,
                            "migration_mcp_private_destination_changed"
                        );
                        replace_server(document, &plan.config, &plan.original)?;
                        ensure!(
                            Some(revision(document)) == plan.expected_revision,
                            "migration_mcp_private_plan_changed"
                        );
                        Ok(())
                    })
                    .map_err(safe_error)?;
            }
            Some(CredentialGroupOutcome::Undone | CredentialGroupOutcome::Aborted) | None => {}
        }
        // Staging persists its intent before touching the backend. No receipt means
        // this prepared plan never acquired a private payload or backend account.
        if self
            .store
            .state(&plan.reference, backend)
            .map_err(safe_error)?
            .is_some()
        {
            self.store
                .undo(&plan.reference, backend)
                .map_err(safe_error)?;
        }
        Ok(())
    }

    fn outcome(&self, plan: &McpCredentialPlan) -> Result<Option<CredentialGroupOutcome>> {
        self.store
            .group_receipt(&plan.group_id)
            .map_err(safe_error)?
            .map(|receipt| {
                verify_receipt(plan, &receipt)?;
                Ok(receipt.outcome)
            })
            .transpose()
    }
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn prepare_material(
    store: &ImportedCredentialStore,
    item: &NormalizedItem,
    binding: &ConfigurationBinding,
    saved: &McpServerConfig,
    fields: &[Field],
    consent: bool,
    policy: CredentialStoreMode,
    backend: &dyn CredentialBackend,
) -> Result<McpCredentialPlan> {
    ensure!(consent, "migration_mcp_private_consent_required");
    let fields = canonical_private_fields(fields)?;
    let mut original = binding
        .inventory()?
        .items
        .into_iter()
        .find(|candidate| {
            candidate.mcp.is_some() && candidate.preview.source_name == item.preview.source_name
        })
        .ok_or_else(|| anyhow::anyhow!("migration_not_an_mcp_server"))?;
    original.preview.id = item.preview.id.clone();
    if let Some(workspace) = binding.project_root() {
        original.mcp.as_mut().unwrap().config.policy.workspace =
            Some(workspace.to_string_lossy().into_owned());
    }
    let resolved = crate::mcp::resolve(
        &original,
        &crate::mcp::McpResolution {
            item_id: item.preview.id.clone(),
            target_name: saved.name.clone(),
            cwd: saved.policy.cwd.clone(),
            enable_after_import: false,
        },
    )?;
    let mut public_saved = saved.clone();
    public_saved.policy.credential_ref = None;
    ensure!(
        resolved.mcp.as_ref().unwrap().config == public_saved,
        "migration_mcp_private_destination_changed"
    );
    let preserved = extension::prepare(store, saved, &fields, policy, backend)?;
    let mut all_fields = fields.clone();
    if let Some(previous) = &preserved {
        all_fields.extend(previous.fields.iter().cloned());
    }
    let env = all_fields
        .iter()
        .filter_map(|field| {
            if let Field::Environment(name) = field {
                Some(name.clone())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    let headers = all_fields
        .iter()
        .filter_map(|field| {
            if let Field::Header(name) = field {
                Some(name.clone())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    let reference = if preserved.is_some() {
        store.prepare_mcp_extension(saved, &env, &headers, policy, backend)
    } else {
        store.prepare_mcp(saved, &env, &headers, policy, backend)
    }
    .map_err(safe_error)?;
    let secret = source::read(binding, &item.preview.source_name, &fields)?;
    let mut config = saved.clone();
    config.policy.credential_ref = Some(reference.mcp_reference().map_err(safe_error)?);
    Ok(McpCredentialPlan {
        plan_id: reference.operation_id.clone(),
        group_id: format!("group-{}", uuid::Uuid::new_v4().simple()),
        item_id: item.preview.id.clone(),
        source_name: item.preview.source_name.clone(),
        fields,
        source: crate::source_transfer::private_credentials::CredentialSourceBinding::Local(
            Box::new(binding.clone()),
        ),
        reference,
        original: saved.clone(),
        config,
        policy,
        phase: CredentialPhase::Ready,
        undo_requested: false,
        error_code: None,
        expected_revision: None,
        published_revision: None,
        atomic_group_id: None,
        fingerprint: hash(&secret),
        preserved,
    })
}

fn verify_receipt(
    plan: &McpCredentialPlan,
    receipt: &kcoder_config::imported_credentials::CredentialGroupReceipt,
) -> Result<()> {
    ensure!(
        receipt.references == [plan.reference.clone()]
            && plan
                .expected_revision
                .as_deref()
                .and_then(|value| value.strip_prefix("sha256-"))
                == Some(receipt.before_revision.as_str())
            && plan
                .published_revision
                .as_deref()
                .and_then(|value| value.strip_prefix("sha256-"))
                == Some(receipt.after_revision.as_str()),
        "migration_mcp_private_receipt_changed"
    );
    Ok(())
}
fn require_server(document: &Value, expected: &McpServerConfig) -> Result<()> {
    let matches = document
        .get("mcp_servers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|server| server.get("name").and_then(Value::as_str) == Some(expected.name.as_str()))
        .collect::<Vec<_>>();
    ensure!(
        matches.len() == 1 && *matches[0] == serde_json::to_value(expected)?,
        "migration_mcp_private_destination_changed"
    );
    Ok(())
}
pub(crate) fn replace_server(
    document: &mut Value,
    expected: &McpServerConfig,
    next: &McpServerConfig,
) -> Result<()> {
    require_server(document, expected)?;
    let servers = document
        .get_mut("mcp_servers")
        .and_then(Value::as_array_mut)
        .unwrap();
    let server = servers
        .iter_mut()
        .find(|server| server.get("name").and_then(Value::as_str) == Some(expected.name.as_str()))
        .unwrap();
    *server = serde_json::to_value(next)?;
    Ok(())
}
fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
pub(crate) fn safe_error(error: anyhow::Error) -> anyhow::Error {
    let code = error.to_string();
    if code.len() <= 120
        && code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
    {
        if code.starts_with("migration_") {
            return anyhow::anyhow!(code);
        }
        if code.starts_with("credential_import_")
            || code.starts_with("credential_group_")
            || code.starts_with("mcp_credential_")
        {
            return anyhow::anyhow!("migration_{code}");
        }
    }
    anyhow::anyhow!("migration_mcp_private_operation_unconfirmed")
}

impl McpCredentialPlan {
    pub(crate) fn bind_group(&mut self, id: &str, before: &str, after: &str) {
        self.group_id = id.into();
        self.atomic_group_id = Some(id.into());
        self.expected_revision = Some(before.into());
        self.published_revision = Some(after.into());
    }
    pub(crate) fn stage_native(
        &self,
        store: &ImportedCredentialStore,
        backend: &dyn CredentialBackend,
        profile_identity: &str,
    ) -> Result<kcoder_config::imported_credentials::ImportState> {
        let secret = self.source.mcp_values(
            profile_identity,
            backend,
            &self.source_name,
            &self.original.name,
            &self.fields,
        )?;
        ensure!(
            hash(&secret) == self.fingerprint,
            "migration_mcp_private_source_changed"
        );
        let secret = extension::merge(self, store, backend, &secret)?;
        store
            .stage(&self.reference, &secret, backend)
            .map_err(safe_error)
    }
}

impl McpCredentialPlan {
    /// Staging validates selected literals; ordinary environment references still need preflight.
    pub(crate) fn validate_activation(&self) -> Result<()> {
        let mut remaining = self.original.clone();
        remaining.policy.credential_ref = None;
        remaining
            .policy
            .required_env
            .retain(|name| !self.covers(&Field::Environment(name.clone())));
        remaining
            .policy
            .required_headers
            .retain(|name| !self.covers(&Field::Header(name.to_ascii_lowercase())));
        kcoder_mcp_policy::validate_references(&remaining)
            .map_err(|_| anyhow::anyhow!("migration_mcp_credentials_required"))
    }
}

fn canonical_private_fields(fields: &[Field]) -> Result<Vec<Field>> {
    ensure!(
        !fields.is_empty() && fields.len() <= 32,
        "migration_mcp_private_budget_exceeded"
    );
    let mut fields = fields
        .iter()
        .map(|field| match field {
            Field::Header(name) => Field::Header(name.to_ascii_lowercase()),
            other => other.clone(),
        })
        .collect::<Vec<_>>();
    fields.sort();
    ensure!(
        fields.windows(2).all(|pair| pair[0] != pair[1]),
        "migration_mcp_private_duplicate_field"
    );
    Ok(fields)
}
