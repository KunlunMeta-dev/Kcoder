//! Native Provider publication preserves the target catalog and current selection.
use crate::{NormalizedItem, ProviderCandidate};
use anyhow::{Result, ensure};
use kcoder_config::{PrivateDirectory, ProviderConfig};
use kcoder_types::migration::{MigrationIssueCode as Code, MigrationItemStatus as Status};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;
mod read_errors;

/// Values the user confirms in the preview, never inferred from compaction thresholds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelLimits {
    pub context_window_tokens: u64,
    pub output_headroom_tokens: u64,
    pub max_output_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderResolution {
    pub item_id: String,
    pub target_name: String,
    pub endpoint: Option<String>,
    pub model: Option<String>,
    pub limits: Option<ModelLimits>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderPlan {
    pub(crate) plan_id: String,
    pub(crate) target_id: String,
    pub(crate) target_name: String,
    pub(crate) expected_revision: String,
    pub(crate) published_revision: String,
    pub(crate) catalog_was_explicit: bool,
    pub(crate) selection_was_explicit: bool,
    #[serde(default, skip_serializing_if = "crate::project_settings::user_plan")]
    pub(crate) project: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) project_catalog: Option<Value>,
    pub(crate) provider: ProviderConfig,
    pub(crate) item: NormalizedItem,
}

impl ProviderPlan {
    pub fn id(&self) -> &str {
        &self.plan_id
    }

    pub fn item(&self) -> &NormalizedItem {
        &self.item
    }

    pub fn target_name(&self) -> &str {
        &self.target_name
    }

    pub fn provider(&self) -> &ProviderConfig {
        &self.provider
    }
}

pub struct ProviderPublication {
    pub target_id: String,
    pub target_revision: String,
    /// Recovery can observe matching bytes without claiming ownership of the original write.
    pub ownership_confirmed: bool,
}

/// A native user profile or bound trusted project, never a renderer-supplied destination.
pub struct ProviderTarget {
    target_id: String,
    settings: kcoder_config::ProfileSettingsFile,
    project: Option<crate::project_settings::ProjectSettingsScope>,
    credential_settings: Option<kcoder_config::ProfileSettingsFile>,
    templates: crate::templates::TemplateTarget,
}

impl ProviderTarget {
    pub(crate) fn settings_target_id(&self) -> &str {
        &self.target_id
    }

    pub(crate) fn templates(&self) -> Result<&crate::templates::TemplateTarget> {
        ensure!(
            self.project.is_none(),
            "migration_project_templates_unsupported"
        );
        Ok(&self.templates)
    }
    pub(crate) fn template_dependencies(&self) -> &crate::templates::TemplateTarget {
        &self.templates
    }
    pub(crate) fn project_binding(&self) -> Option<&crate::source_transfer::ReceivedProjectTarget> {
        self.project.as_ref().map(|value| value.binding())
    }
    fn credential_settings(&self) -> &kcoder_config::ProfileSettingsFile {
        self.credential_settings.as_ref().unwrap_or(&self.settings)
    }
    pub fn open_project(
        profile: &Path,
        project: &crate::source_transfer::ReceivedProjectTarget,
        create: bool,
    ) -> Result<Self> {
        let (scope, directory, target_id) =
            crate::project_settings::ProjectSettingsScope::open(profile, project, create)?;
        Ok(Self {
            target_id,
            settings: kcoder_config::ProfileSettingsFile::new(directory)?,
            templates: crate::templates::TemplateTarget::open(profile)?,
            credential_settings: Some(kcoder_config::ProfileSettingsFile::new(
                PrivateDirectory::open_existing(profile)?,
            )?),
            project: Some(scope),
        })
    }
    pub(crate) fn directory_identity(&self) -> Result<String> {
        self.settings.directory_identity()
    }
    pub(crate) fn observe(&self, plan: &ProviderPlan) -> Result<bool> {
        self.check_binding(plan)?;
        Ok(self
            .read_settings()?
            .get("providers")
            .and_then(|providers| providers.get(plan.target_name()))
            == Some(&serde_json::to_value(plan.provider())?))
    }
    pub fn open(profile: &Path) -> Result<Self> {
        let profile = profile
            .canonicalize()
            .map_err(|_| anyhow::anyhow!("migration_target_unavailable"))?;
        let directory = PrivateDirectory::open_existing(&profile)
            .map_err(|_| anyhow::anyhow!("migration_unsafe_target"))?;
        directory
            .verify_trusted_config_directory()
            .map_err(|_| anyhow::anyhow!("migration_unsafe_target"))?;
        let mut identity = Sha256::new();
        identity.update(profile.as_os_str().as_encoded_bytes());
        identity.update([0]);
        identity.update(directory.directory_identity()?.as_bytes());
        let target_id = format!("profile-{:x}", identity.finalize());
        Ok(Self {
            target_id,
            project: None,
            credential_settings: None,
            templates: crate::templates::TemplateTarget::open(&profile)?,
            settings: kcoder_config::ProfileSettingsFile::new(directory)?,
        })
    }

    pub fn prepare(
        &self,
        item: &NormalizedItem,
        resolution: &ProviderResolution,
    ) -> Result<ProviderPlan> {
        let current = self.read_settings()?;
        self.prepare_on(item, resolution, &current)
    }

    pub(crate) fn read_settings(&self) -> Result<Value> {
        if let Some(scope) = &self.project {
            scope.verify()?;
        }
        self.settings.read().map_err(read_errors::classify)
    }
    pub(crate) fn update_settings_with_catalog(
        &self,
        catalog: Option<&Value>,
        change: impl FnOnce(&mut Value) -> Result<()>,
    ) -> Result<()> {
        self.update_settings_with_catalogs(catalog, None, change)
    }
    pub(crate) fn update_settings_with_catalogs(
        &self,
        catalog: Option<&Value>,
        mcp: Option<&kcoder_config::ProjectMcpCatalogSelection>,
        change: impl FnOnce(&mut Value) -> Result<()>,
    ) -> Result<()> {
        if let Some(scope) = &self.project {
            if mcp.is_some() {
                scope.update_preserving_catalogs(&self.settings, catalog, mcp, change)
            } else {
                scope.update_preserving_catalog(&self.settings, catalog, change)
            }
        } else {
            ensure!(catalog.is_none() && mcp.is_none(), "migration_wrong_target");
            self.settings.update(change).map(|_| ())
        }
    }

    pub(crate) fn update_settings(
        &self,
        change: impl FnOnce(&mut Value) -> Result<()>,
    ) -> Result<()> {
        if let Some(scope) = &self.project {
            scope.update(&self.settings, change)
        } else {
            self.settings.update(change).map(|_| ())
        }
    }
    pub(crate) fn prepare_on(
        &self,
        item: &NormalizedItem,
        resolution: &ProviderResolution,
        current: &Value,
    ) -> Result<ProviderPlan> {
        let (item, provider) = resolve(item, resolution)?;
        let mut next = current.clone();
        let project_catalog = self
            .project
            .as_ref()
            .map(|scope| scope.implicit_provider_catalog(current))
            .transpose()?
            .flatten();
        if let Some(catalog) = &project_catalog {
            next["providers"] = catalog.clone();
        }
        if self.project.is_some() {
            insert_project_provider(&mut next, &resolution.target_name, &provider)?;
        } else {
            insert_provider(&mut next, &resolution.target_name, &provider)?;
        }
        if let Some(scope) = &self.project {
            scope.validate(&self.settings, current, &next)?;
        }
        ensure!(
            !self
                .credential_settings()
                .has_stored_credential_namespace(&resolution.target_name)
                .map_err(|_| anyhow::anyhow!("migration_credential_metadata_unavailable"))?,
            "migration_existing_credentials_require_confirmation"
        );
        Ok(ProviderPlan {
            plan_id: format!("plan-{}", uuid::Uuid::new_v4().simple()),
            target_id: self.target_id.clone(),
            target_name: resolution.target_name.clone(),
            expected_revision: revision(current),
            published_revision: revision(&next),
            catalog_was_explicit: current.get("providers").is_some(),
            selection_was_explicit: current.get("active_provider").is_some(),
            project: self.project.is_some(),
            project_catalog,
            provider,
            item,
        })
    }

    pub(crate) fn check_publication_requirements(&self, plan: &ProviderPlan) -> Result<()> {
        self.check_binding(plan)?;
        ensure!(
            !self
                .credential_settings()
                .has_stored_credential_namespace(plan.target_name())?,
            "migration_existing_credentials_require_confirmation"
        );
        Ok(())
    }

    /// The journal must record a committing intent before invoking this method.
    /// A repeated call reconciles the exact published revision instead of replaying it.
    pub(crate) fn publish(
        &self,
        plan: &ProviderPlan,
        cancelled: bool,
        source_blocked: bool,
    ) -> Result<ProviderPublication> {
        self.check_binding(plan)?;
        let mut ownership_confirmed = false;
        self.update_settings_with_catalog(plan.project_catalog.as_ref(), |current| {
            let observed = revision(current);
            if observed == plan.published_revision {
                return Ok(());
            }
            ensure!(!cancelled, "migration_cancelled_unsettled_publication");
            ensure!(!source_blocked, "migration_source_changed");
            ensure!(
                !self
                    .credential_settings()
                    .has_stored_credential_namespace(&plan.target_name)
                    .map_err(|_| anyhow::anyhow!("migration_credential_metadata_unavailable"))?,
                "migration_existing_credentials_require_confirmation"
            );
            ensure!(
                observed == plan.expected_revision,
                "migration_target_changed"
            );
            insert_planned_provider(current, plan)?;
            ensure!(
                revision(current) == plan.published_revision,
                "migration_plan_changed"
            );
            ownership_confirmed = true;
            Ok(())
        })
        .map_err(|error| {
            // Config validation errors can contain target values; expose reviewed codes only.
            let code = error.to_string();
            if matches!(
                code.as_str(),
                "migration_cancel_pending"
                    | "migration_cancelled_unsettled_publication"
                    | "migration_target_changed"
                    | "migration_plan_changed"
                    | "migration_source_changed"
                    | "migration_existing_credentials_require_confirmation"
            ) {
                anyhow::anyhow!(code)
            } else {
                anyhow::anyhow!("migration_publication_unconfirmed")
            }
        })?;
        Ok(ProviderPublication {
            target_id: self.target_id.clone(),
            target_revision: plan.published_revision.clone(),
            ownership_confirmed,
        })
    }
}

impl ProviderTarget {
    pub(crate) fn check_binding(&self, plan: &ProviderPlan) -> Result<()> {
        ensure!(
            plan.target_id == self.target_id && plan.project == self.project.is_some(),
            "migration_wrong_target"
        );
        if let Some(scope) = &self.project {
            scope.verify()?;
        }
        Ok(())
    }
    pub(crate) fn require_no_credential_dependency(&self, plan: &ProviderPlan) -> Result<()> {
        ensure!(
            !self
                .credential_settings()
                .has_stored_credential_namespace(plan.target_name())?,
            "migration_provider_credentials_depend_on_import"
        );
        Ok(())
    }

    /// The coordinator must require an authoritative ownership receipt before rollback.
    pub(crate) fn rollback(&self, plan: &ProviderPlan) -> Result<()> {
        self.check_binding(plan)?;
        if revision(&self.read_settings()?) == plan.expected_revision {
            return Ok(());
        }
        self.templates
            .with_unreferenced_providers(&[plan.target_name()], || {
                self.update_settings(|current| {
                    self.require_no_credential_dependency(plan)?;
                    let observed = revision(current);
                    if observed == plan.expected_revision {
                        return Ok(());
                    }
                    ensure!(
                        observed == plan.published_revision,
                        "migration_target_changed"
                    );
                    remove_import(current, plan)?;
                    ensure!(
                        revision(current) == plan.expected_revision,
                        "migration_plan_changed"
                    );
                    Ok(())
                })
                .map_err(|error| {
                    if matches!(
                        error.to_string().as_str(),
                        "migration_target_changed"
                            | "migration_provider_credentials_depend_on_import"
                    ) {
                        anyhow::anyhow!(error.to_string())
                    } else {
                        anyhow::anyhow!("migration_rollback_unconfirmed")
                    }
                })
            })?;
        Ok(())
    }
}

pub(crate) fn remove_import(current: &mut Value, plan: &ProviderPlan) -> Result<()> {
    let root = current
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("migration_invalid_target_configuration"))?;
    if plan.catalog_was_explicit {
        root.get_mut("providers")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow::anyhow!("migration_invalid_target_configuration"))?
            .remove(&plan.target_name);
    } else {
        root.remove("providers");
    }
    if !plan.selection_was_explicit {
        root.remove("active_provider");
    }
    Ok(())
}

pub(crate) fn resolve(
    item: &NormalizedItem,
    resolution: &ProviderResolution,
) -> Result<(NormalizedItem, ProviderConfig)> {
    ensure!(
        resolution.item_id == item.preview.id,
        "migration_unknown_item"
    );
    ensure!(
        resolution.target_name.len() <= 128
            && resolution.target_name.trim() == resolution.target_name
            && kcoder_config::validate_provider_id(&resolution.target_name).is_ok(),
        "migration_invalid_provider_name"
    );
    let mut item = item.clone();
    let candidate = item
        .provider
        .as_mut()
        .ok_or_else(|| anyhow::anyhow!("migration_not_a_provider"))?;
    if let Some(endpoint) = &resolution.endpoint {
        candidate.endpoint = Some(endpoint.clone());
    }
    if let Some(model) = &resolution.model {
        candidate.model = Some(model.clone());
    }
    if let Some(limits) = &resolution.limits {
        candidate.context_window_tokens = Some(limits.context_window_tokens);
        candidate.output_headroom_tokens = Some(limits.output_headroom_tokens);
        candidate.max_output_tokens = Some(limits.max_output_tokens);
    }
    let provider = provider_config(candidate)?;
    // Only fields actually resolved by this mapping may lose their import blocker.
    item.preview
        .issues
        .retain(|issue| !resolution_can_fix(issue));
    ensure!(
        !item
            .preview
            .issues
            .iter()
            .any(|issue| issue.blocks_import()),
        "migration_item_requires_resolution"
    );
    item.preview.status = Status::Staged;
    Ok((item, provider))
}

pub(crate) fn resolution_can_fix(issue: &kcoder_types::migration::MigrationIssue) -> bool {
    matches!(
        (issue.code, issue.field.as_deref()),
        (Code::MissingModel, Some("model"))
            | (Code::MissingModelLimits, Some("model_limits"))
            | (
                Code::InvalidEndpoint | Code::RequiresReview,
                Some("endpoint")
            )
            | (Code::RequiresReview, Some("model"))
    )
}

fn provider_config(candidate: &ProviderCandidate) -> Result<ProviderConfig> {
    let endpoint = candidate
        .endpoint
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("migration_missing_endpoint"))?;
    let url =
        url::Url::parse(endpoint).map_err(|_| anyhow::anyhow!("migration_invalid_endpoint"))?;
    ensure!(
        endpoint.len() <= 4096
            && !endpoint.chars().any(char::is_control)
            && matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "migration_invalid_endpoint"
    );
    let model = candidate
        .model
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("migration_missing_model"))?;
    ensure!(
        !model.is_empty()
            && model.len() <= 512
            && model.trim() == model
            && !model.chars().any(char::is_control),
        "migration_invalid_model"
    );
    ensure!(
        matches!(
            candidate.api_format.as_str(),
            "anthropic_messages" | "openai_responses"
        ),
        "migration_unsupported_protocol"
    );
    let context = candidate.context_window_tokens.unwrap_or(0);
    let headroom = candidate.output_headroom_tokens.unwrap_or(0);
    let output = candidate.max_output_tokens.unwrap_or(0);
    ensure!(
        context > 0
            && headroom > 0
            && output > 0
            && headroom <= context
            && output <= context
            && usize::try_from(context).is_ok()
            && usize::try_from(headroom).is_ok()
            && u32::try_from(output).is_ok(),
        "migration_invalid_model_limits"
    );
    // Do not silently assert capabilities or auto-discover models through an unverified endpoint.
    let provider: ProviderConfig = serde_json::from_value(json!({
        "api_format": candidate.api_format,
        "endpoint": endpoint,
        "default_model": model,
        "context_window_tokens": context,
        "output_headroom_tokens": headroom,
        "max_output_tokens": output,
        "capabilities": kcoder_config::ModelCapabilities::text_only(),
        "discover_models": false,
    }))
    .map_err(|_| anyhow::anyhow!("migration_invalid_provider"))?;
    provider
        .validate_models()
        .map_err(|_| anyhow::anyhow!("migration_invalid_provider"))?;
    Ok(provider)
}

pub(crate) fn insert_provider(
    current: &mut Value,
    name: &str,
    provider: &ProviderConfig,
) -> Result<()> {
    let before = kcoder_config::validate_and_resolve_settings_document(current)
        .map_err(|_| anyhow::anyhow!("migration_invalid_target_configuration"))?;
    let root = current
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("migration_invalid_target_configuration"))?;
    if !root.contains_key("providers") {
        // Explicit declarations own the catalog. Preserve implicit defaults before declaring it.
        root.insert("providers".into(), serde_json::to_value(&before.providers)?);
    }
    let providers = root
        .get_mut("providers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow::anyhow!("migration_invalid_target_configuration"))?;
    ensure!(!providers.contains_key(name), "migration_target_conflict");
    providers.insert(name.into(), serde_json::to_value(provider)?);
    if !root.contains_key("active_provider") {
        root.insert(
            "active_provider".into(),
            serde_json::to_value(&before.active_provider)?,
        );
    }
    let after = kcoder_config::validate_and_resolve_settings_document(current)
        .map_err(|_| anyhow::anyhow!("migration_invalid_target_configuration"))?;
    ensure!(
        before.active_provider == after.active_provider && before.model == after.model,
        "migration_default_selection_changed"
    );
    Ok(())
}

pub(crate) fn revision(value: &Value) -> String {
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Object(fields) => {
                let sorted = fields.iter().collect::<std::collections::BTreeMap<_, _>>();
                Value::Object(
                    sorted
                        .into_iter()
                        .map(|(key, value)| (key.clone(), canonical(value)))
                        .collect(),
                )
            }
            Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
            other => other.clone(),
        }
    }
    format!(
        "sha256-{:x}",
        Sha256::digest(serde_json::to_vec(&canonical(value)).expect("JSON values serialize"))
    )
}

pub(crate) fn insert_planned_provider(current: &mut Value, plan: &ProviderPlan) -> Result<()> {
    if plan.project {
        if let Some(catalog) = &plan.project_catalog {
            ensure!(current.get("providers").is_none(), "migration_plan_changed");
            current["providers"] = catalog.clone();
        }
        insert_project_provider(current, plan.target_name(), plan.provider())
    } else {
        insert_provider(current, plan.target_name(), plan.provider())
    }
}
fn insert_project_provider(
    current: &mut Value,
    name: &str,
    provider: &ProviderConfig,
) -> Result<()> {
    let root = current
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("migration_invalid_target_configuration"))?;
    let providers = root
        .entry("providers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("migration_invalid_target_configuration"))?;
    ensure!(!providers.contains_key(name), "migration_target_conflict");
    providers.insert(name.into(), serde_json::to_value(provider)?);
    Ok(())
}
