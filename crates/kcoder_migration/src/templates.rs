//! Profile templates depend on a confirmed connection and publish through native ownership receipts.
use crate::{NormalizedItem, providers::ProviderPublication};
use anyhow::{Result, ensure};
use kcoder_config::{
    PrivateDirectory, ProviderConfig,
    settings_templates::{SettingsTemplateStore, TemplateImportRef, TemplateImportState},
};
use kcoder_types::migration::{MigrationIssueCode, MigrationItemStatus};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplateResolution {
    pub item_id: String,
    pub target_name: String,
    pub provider_item_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderDependency {
    pub item_id: String,
    pub action_id: String,
    pub name: String,
    pub definition: ProviderConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplatePlan {
    pub item: NormalizedItem,
    pub reference: TemplateImportRef,
    pub provider: ProviderDependency,
    content: String,
}
pub struct TemplateSettings {
    pub id: String,
    pub provider_name: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
}
impl TemplatePlan {
    pub fn operation_id(&self) -> &str {
        &self.reference.operation_id
    }
    pub fn template_id(&self) -> &str {
        &self.reference.id
    }
    pub(crate) fn semantic_fingerprint(&self) -> Result<String> {
        fingerprint(self.template_id(), &self.content, &self.provider)
    }
    pub(crate) fn settings(&self) -> TemplateSettings {
        TemplateSettings {
            id: self.template_id().into(),
            provider_name: self.provider.name.clone(),
            model: self.provider.definition.default_model.clone(),
            reasoning_effort: self
                .item
                .template
                .as_ref()
                .and_then(|item| item.reasoning_effort.clone()),
        }
    }
}

fn fingerprint(id: &str, content: &str, provider: &ProviderDependency) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            id,
            content,
            &provider.name,
            &provider.definition,
        ))?)
    ))
}

pub struct TemplateTarget {
    store: SettingsTemplateStore,
    identity: String,
}
impl TemplateTarget {
    pub fn open(profile: &Path) -> Result<Self> {
        let directory = PrivateDirectory::open_existing(profile)?;
        directory.verify_trusted_config_directory()?;
        Ok(Self {
            store: SettingsTemplateStore::open(profile)?,
            identity: directory.directory_identity()?,
        })
    }
    pub(crate) fn identity(&self) -> &str {
        &self.identity
    }
    pub(crate) fn with_unreferenced_providers<T>(
        &self,
        names: &[&str],
        operation: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let mut started = false;
        let result = self.store.with_unreferenced_providers(names, || {
            started = true;
            operation()
        });
        result.map_err(|error| {
            if !started && error.to_string() != "settings_template_provider_referenced" {
                anyhow::anyhow!("migration_template_references_unknown")
            } else {
                safe_error(error)
            }
        })
    }
    pub fn prepare(
        &self,
        item: &NormalizedItem,
        resolution: &TemplateResolution,
        provider: ProviderDependency,
    ) -> Result<TemplatePlan> {
        let content = Self::resolved_content(item, resolution, &provider)?;
        let reference = self
            .store
            .prepare_owned(
                &resolution.target_name,
                &item.preview.source_name,
                None,
                &content,
            )
            .map_err(safe_error)?;
        Ok(TemplatePlan {
            item: resolved_item(item),
            reference,
            provider,
            content,
        })
    }

    pub(crate) fn requested_fingerprint(
        item: &NormalizedItem,
        resolution: &TemplateResolution,
        provider: &ProviderDependency,
    ) -> Result<String> {
        fingerprint(
            &resolution.target_name,
            &Self::resolved_content(item, resolution, provider)?,
            provider,
        )
    }

    fn resolved_content(
        item: &NormalizedItem,
        resolution: &TemplateResolution,
        provider: &ProviderDependency,
    ) -> Result<String> {
        ensure!(
            item.preview.id == resolution.item_id
                && provider.item_id == resolution.provider_item_id,
            "migration_template_dependency_mismatch"
        );
        ensure!(
            !item
                .preview
                .issues
                .iter()
                .any(|issue| issue.blocks_import()),
            "migration_item_requires_resolution"
        );
        let candidate = item
            .template
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_not_a_template"))?;
        let mut content = serde_json::json!({"active_provider":provider.name,"model":provider.definition.default_model});
        if let Some(effort) = &candidate.reasoning_effort {
            content["model_reasoning_effort"] = effort.clone().into();
        }
        Ok(serde_json::to_string_pretty(&content)?)
    }

    pub(crate) fn observe(&self, plan: &TemplatePlan) -> Result<Option<bool>> {
        ensure!(
            plan.reference.profile_identity == self.identity,
            "migration_wrong_target"
        );
        let state = self
            .store
            .import_state_with_provider(
                &plan.reference,
                &plan.provider.name,
                &plan.provider.definition,
            )
            .map_err(safe_error)?;
        Ok((state == Some(TemplateImportState::Committed)).then_some(false))
    }
    pub fn publish(
        &self,
        plan: &TemplatePlan,
        cancelled: bool,
        blocked: bool,
        reconcile_only: bool,
    ) -> Result<ProviderPublication> {
        ensure!(
            plan.reference.profile_identity == self.identity,
            "migration_wrong_target"
        );
        let state = self
            .store
            .import_state(&plan.reference)
            .map_err(safe_error)?;
        if state != Some(TemplateImportState::Committed) {
            ensure!(
                !matches!(
                    state,
                    Some(TemplateImportState::Undone | TemplateImportState::Superseded)
                ),
                "migration_template_target_changed"
            );
            ensure!(!cancelled, "migration_cancelled_unsettled_publication");
            ensure!(!blocked, "migration_source_changed");
            ensure!(
                !reconcile_only || state == Some(TemplateImportState::Staged),
                "migration_template_publication_unconfirmed"
            );
            self.store
                .install_owned_with_provider(
                    &plan.reference,
                    &plan.content,
                    &plan.provider.name,
                    &plan.provider.definition,
                )
                .map_err(safe_error)?;
        }
        Ok(ProviderPublication {
            target_id: self.identity.clone(),
            target_revision: plan.reference.content_digest.clone(),
            ownership_confirmed: true,
        })
    }
    pub fn rollback(&self, plan: &TemplatePlan) -> Result<()> {
        ensure!(
            plan.reference.profile_identity == self.identity,
            "migration_wrong_target"
        );
        self.store.undo_owned(&plan.reference).map_err(safe_error)?;
        Ok(())
    }
}

pub(crate) fn resolved_item(item: &NormalizedItem) -> NormalizedItem {
    let mut item = item.clone();
    item.preview.issues.retain(|issue| {
        !(issue.code == MigrationIssueCode::MissingDependency
            && issue.field.as_deref() == Some("session_template"))
    });
    item.preview.status = MigrationItemStatus::Staged;
    item
}

pub(crate) fn safe_error(error: anyhow::Error) -> anyhow::Error {
    let code = error.to_string();
    if code.starts_with("invalid settings template id:") {
        return anyhow::anyhow!("migration_invalid_template_name");
    }
    if code.starts_with("migration_")
        && code.len() < 128
        && code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
    {
        return error;
    }
    anyhow::anyhow!(match error.to_string().as_str() {
        "settings_template_provider_changed" => "migration_template_dependency_changed",
        "settings_template_import_target_exists" => "migration_target_conflict",
        "settings_template_import_target_changed" | "settings_template_import_receipt_conflict" =>
            "migration_template_target_changed",
        "settings_template_import_referenced" | "settings_template_provider_referenced" =>
            "migration_template_referenced",
        "settings_template_wrong_profile" => "migration_wrong_target",
        _ => "migration_template_operation_unconfirmed",
    })
}
