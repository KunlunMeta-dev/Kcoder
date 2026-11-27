//! Planned native MCP writes are disabled by default and never connect while migrating.
mod catalog_preview;
mod inheritance;
use crate::{
    NormalizedItem,
    providers::{ProviderPublication, revision},
};
use anyhow::{Result, ensure};
use kcoder_config::{PrivateDirectory, ProfileSettingsFile};
use kcoder_types::{
    McpServerConfig,
    migration::{MigrationIssueCode as Code, MigrationItemStatus as Status},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpResolution {
    pub item_id: String,
    pub target_name: String,
    pub cwd: Option<String>,
    pub enable_after_import: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpPlan {
    pub(crate) plan_id: String,
    pub(crate) target_id: String,
    pub(crate) expected_revision: String,
    pub(crate) published_revision: String,
    pub(crate) servers_was_explicit: bool,
    pub(crate) disabled_was_explicit: bool,
    pub(crate) name_was_disabled: bool,
    pub(crate) original_disabled: Option<Vec<Value>>,
    pub(crate) enable_after_import: bool,
    pub(crate) item: NormalizedItem,
    #[serde(default, skip_serializing_if = "crate::project_settings::user_plan")]
    pub(crate) project: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) previous: Option<McpServerConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reuse_origin: Option<crate::batch::ReuseProof>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) project_inheritance: Option<inheritance::ProjectMcpInheritancePlan>,
}
impl McpPlan {
    pub fn id(&self) -> &str {
        &self.plan_id
    }
    pub fn item(&self) -> &NormalizedItem {
        &self.item
    }
    pub fn config(&self) -> &McpServerConfig {
        &self
            .item
            .mcp
            .as_ref()
            .expect("MCP plans contain a mapped definition")
            .config
    }
    pub fn enabled(&self) -> bool {
        self.enable_after_import
    }
}

pub struct McpTarget {
    target_id: String,
    settings: ProfileSettingsFile,
    project: Option<crate::project_settings::ProjectSettingsScope>,
    project_catalog: Option<kcoder_config::ProjectMcpCatalogSelection>,
}
impl McpTarget {
    pub(crate) fn settings_target_id(&self) -> &str {
        &self.target_id
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
            settings: ProfileSettingsFile::new(directory)?,
            project: Some(scope),
            project_catalog: None,
        })
    }
    pub(crate) fn project_binding(&self) -> Option<&crate::source_transfer::ReceivedProjectTarget> {
        self.project.as_ref().map(|value| value.binding())
    }
    fn update_with_catalog(
        &self,
        expected: Option<&kcoder_config::ProjectMcpCatalogSelection>,
        change: impl FnOnce(&mut Value) -> Result<()>,
    ) -> Result<()> {
        if let Some(scope) = &self.project {
            scope.update_preserving_catalogs(&self.settings, None, expected, change)
        } else {
            ensure!(expected.is_none(), "migration_wrong_target");
            self.update(change)
        }
    }
    fn update(&self, change: impl FnOnce(&mut Value) -> Result<()>) -> Result<()> {
        if let Some(scope) = &self.project {
            scope.update(&self.settings, change)
        } else {
            self.settings.update(change).map(|_| ())
        }
    }
    pub(crate) fn observe(&self, plan: &McpPlan) -> Result<Option<bool>> {
        self.check_binding(plan)?;
        let document = self.settings.read()?;
        let desired = serde_json::to_value(plan.config())?;
        if !document
            .get("mcp_servers")
            .and_then(Value::as_array)
            .is_some_and(|servers| servers.iter().any(|server| server == &desired))
        {
            return Ok(None);
        }
        if let Some(scope) = &self.project {
            return Ok(Some(scope.mcp_server_enabled(&plan.config().name)?));
        }
        Ok(Some(
            !document
                .get("mcp_disabled_servers")
                .and_then(Value::as_array)
                .is_some_and(|names| {
                    names
                        .iter()
                        .any(|name| name.as_str() == Some(&plan.config().name))
                }),
        ))
    }
    pub fn open(profile: &Path) -> Result<Self> {
        let profile = profile
            .canonicalize()
            .map_err(|_| anyhow::anyhow!("migration_target_unavailable"))?;
        let directory = PrivateDirectory::open_existing(&profile)?;
        directory.verify_trusted_config_directory()?;
        let mut hash = Sha256::new();
        hash.update(profile.as_os_str().as_encoded_bytes());
        hash.update([0]);
        hash.update(directory.directory_identity()?.as_bytes());
        Ok(Self {
            target_id: format!("profile-{:x}", hash.finalize()),
            project: None,
            project_catalog: None,
            settings: ProfileSettingsFile::new(directory)?,
        })
    }
    pub fn prepare(&self, item: &NormalizedItem, resolution: &McpResolution) -> Result<McpPlan> {
        let current = self
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("migration_target_configuration_unavailable"))?;
        self.prepare_on(item, resolution, &current)
    }
    pub(crate) fn prepare_on(
        &self,
        item: &NormalizedItem,
        resolution: &McpResolution,
        current: &Value,
    ) -> Result<McpPlan> {
        let item = resolve(item, resolution)?;
        let mut next = current.clone();
        let config = &item.mcp.as_ref().unwrap().config;
        let plan = McpPlan {
            plan_id: format!("plan-{}", uuid::Uuid::new_v4().simple()),
            target_id: self.target_id.clone(),
            expected_revision: revision(current),
            published_revision: String::new(),
            servers_was_explicit: current.get("mcp_servers").is_some(),
            disabled_was_explicit: current.get("mcp_disabled_servers").is_some(),
            name_was_disabled: current
                .get("mcp_disabled_servers")
                .and_then(Value::as_array)
                .is_some_and(|names| {
                    names
                        .iter()
                        .any(|name| name.as_str() == Some(config.name.as_str()))
                }),
            original_disabled: current
                .get("mcp_disabled_servers")
                .and_then(Value::as_array)
                .cloned(),
            enable_after_import: resolution.enable_after_import,
            item: item.clone(),
            project: self.project.is_some(),
            previous: None,
            reuse_origin: None,
            project_inheritance: inheritance::prepare(self, current)?,
        };
        insert(&mut next, &plan)?;
        if let Some(scope) = &self.project {
            scope.validate(&self.settings, current, &next)?;
        }
        Ok(McpPlan {
            published_revision: revision(&next),
            ..plan
        })
    }
    pub(crate) fn check_binding(&self, plan: &McpPlan) -> Result<()> {
        ensure!(
            self.target_id == plan.target_id && plan.project == self.project.is_some(),
            "migration_wrong_target"
        );
        if let Some(scope) = &self.project {
            scope.verify()?;
        }
        if let Some(inheritance) = &plan.project_inheritance {
            ensure!(
                plan.project && !plan.servers_was_explicit,
                "migration_invalid_journal"
            );
            inheritance.selection().validate()?;
        }
        Ok(())
    }
    pub(crate) fn publish(
        &self,
        plan: &McpPlan,
        cancelled: bool,
        source_blocked: bool,
    ) -> Result<ProviderPublication> {
        self.check_binding(plan)?;
        let mut owned = false;
        self.update_with_catalog(
            plan.project_inheritance
                .as_ref()
                .map(|value| value.selection()),
            |current| {
                if revision(current) == plan.published_revision {
                    return Ok(());
                }
                ensure!(!cancelled, "migration_cancelled_unsettled_publication");
                ensure!(!source_blocked, "migration_source_changed");
                ensure!(
                    revision(current) == plan.expected_revision,
                    "migration_target_changed"
                );
                if plan.enable_after_import {
                    kcoder_mcp_policy::validate_references(plan.config())
                        .map_err(|_| anyhow::anyhow!("migration_mcp_credentials_required"))?;
                }
                insert(current, plan)?;
                ensure!(
                    revision(current) == plan.published_revision,
                    "migration_plan_changed"
                );
                owned = true;
                Ok(())
            },
        )
        .map_err(safe_error)?;
        Ok(ProviderPublication {
            target_id: self.target_id.clone(),
            target_revision: plan.published_revision.clone(),
            ownership_confirmed: owned,
        })
    }
    pub(crate) fn rollback(&self, plan: &McpPlan) -> Result<()> {
        self.check_binding(plan)?;
        self.update(|current| {
            if revision(current) == plan.expected_revision {
                return Ok(());
            }
            ensure!(
                revision(current) == plan.published_revision,
                "migration_target_changed"
            );
            remove_import(current, plan)?;
            ensure!(
                revision(current) == plan.expected_revision,
                "migration_plan_changed"
            );
            Ok(())
        })
        .map_err(safe_error)?;
        Ok(())
    }
}
pub(crate) fn resolve(item: &NormalizedItem, resolution: &McpResolution) -> Result<NormalizedItem> {
    ensure!(
        item.preview.id == resolution.item_id,
        "migration_unknown_item"
    );
    let mut item = item.clone();
    let candidate = item
        .mcp
        .as_mut()
        .ok_or_else(|| anyhow::anyhow!("migration_not_an_mcp_server"))?;
    ensure!(
        !resolution.target_name.trim().is_empty()
            && resolution.target_name.trim() == resolution.target_name
            && resolution.target_name.len() <= 128
            && !resolution.target_name.chars().any(char::is_control)
            && !resolution.target_name.starts_with("plugin."),
        "migration_invalid_mcp_name"
    );
    candidate.config.name = resolution.target_name.clone();
    if let Some(cwd) = &resolution.cwd {
        ensure!(Path::new(cwd).is_absolute(), "migration_mcp_cwd_required");
        candidate.config.policy.cwd = Some(cwd.clone());
        item.preview
            .issues
            .retain(|issue| issue.field.as_deref() != Some("cwd"));
    }
    ensure!(
        !item
            .preview
            .issues
            .iter()
            .any(|issue| issue.blocks_import()),
        "migration_item_requires_resolution"
    );
    kcoder_mcp_policy::validate(&candidate.config)
        .map_err(|_| anyhow::anyhow!("migration_invalid_mcp_policy"))?;
    ensure!(
        serde_json::to_vec(&candidate.config)?.len() <= 512 * 1024,
        "migration_mcp_definition_budget_exceeded"
    );
    if let Some(cwd) = candidate.config.policy.cwd.as_deref() {
        ensure!(Path::new(cwd).is_dir(), "migration_mcp_cwd_unavailable");
    }
    if resolution.enable_after_import {
        kcoder_mcp_policy::validate_references(&candidate.config)
            .map_err(|_| anyhow::anyhow!("migration_mcp_credentials_required"))?;
    }
    // Enabling is configuration only. Actual handshake/authorization remains a separate action.
    item.preview.issues.retain(|issue| {
        !(issue.code == Code::RequiresReview
            && issue.field.as_deref() == Some("activation")
            && resolution.enable_after_import)
    });
    item.preview.status = Status::Staged;
    Ok(item)
}

pub(crate) fn remove_import(current: &mut Value, plan: &McpPlan) -> Result<()> {
    if let Some(previous) = &plan.previous {
        ensure!(plan.reuse_origin.is_some(), "migration_invalid_journal");
        return crate::mcp_credentials::replace_server(current, plan.config(), previous);
    }
    let root = current
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("migration_invalid_target_configuration"))?;
    if plan.servers_was_explicit {
        root.get_mut("mcp_servers")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| anyhow::anyhow!("migration_invalid_target_configuration"))?
            .retain(|config| {
                config.get("name").and_then(Value::as_str) != Some(plan.config().name.as_str())
            });
    } else {
        root.remove("mcp_servers");
    }
    if plan.disabled_was_explicit {
        root.insert(
            "mcp_disabled_servers".into(),
            json!(
                plan.original_disabled
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("migration_invalid_target_configuration"))?
            ),
        );
    } else {
        root.remove("mcp_disabled_servers");
    }
    inheritance::remove(current, plan)?;
    Ok(())
}

pub(crate) fn insert(current: &mut Value, plan: &McpPlan) -> Result<()> {
    if let Some(previous) = &plan.previous {
        ensure!(
            plan.reuse_origin.is_some() && previous.name == plan.config().name,
            "migration_invalid_journal"
        );
        let disabled = current
            .get("mcp_disabled_servers")
            .and_then(Value::as_array)
            .is_some_and(|names| {
                names
                    .iter()
                    .any(|name| name.as_str() == Some(previous.name.as_str()))
            });
        ensure!(disabled != plan.enabled(), "migration_reuse_target_changed");
        crate::mcp_credentials::replace_server(current, previous, plan.config())?;
        return Ok(());
    }
    inheritance::insert(current, plan)?;
    let root = current
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("migration_invalid_target_configuration"))?;
    let servers = root
        .entry("mcp_servers")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(|| anyhow::anyhow!("migration_invalid_target_configuration"))?;
    ensure!(
        !servers
            .iter()
            .any(|config| config.get("name").and_then(Value::as_str)
                == Some(plan.config().name.as_str())),
        "migration_target_conflict"
    );
    let namespace =
        kcoder_mcp_policy::mcp_tool_name(&plan.config().name, "migration_namespace_probe");
    ensure!(
        !servers
            .iter()
            .filter_map(|config| config.get("name").and_then(Value::as_str))
            .any(
                |name| kcoder_mcp_policy::mcp_tool_name(name, "migration_namespace_probe")
                    == namespace
            ),
        "migration_target_conflict"
    );
    servers.push(serde_json::to_value(plan.config())?);
    let disabled = root
        .entry("mcp_disabled_servers")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(|| anyhow::anyhow!("migration_invalid_target_configuration"))?;
    ensure!(
        disabled.iter().all(Value::is_string),
        "migration_invalid_target_configuration"
    );
    if plan.enable_after_import {
        disabled.retain(|value| value.as_str() != Some(plan.config().name.as_str()));
    } else if !disabled
        .iter()
        .any(|value| value.as_str() == Some(plan.config().name.as_str()))
    {
        disabled.push(json!(plan.config().name));
    }
    if plan.project {
        kcoder_config::validate_project_mcp_fragment(current)
            .map_err(|_| anyhow::anyhow!("migration_invalid_target_configuration"))?;
    } else {
        kcoder_config::validate_and_resolve_settings_document(current)
            .map_err(|_| anyhow::anyhow!("migration_invalid_target_configuration"))?;
    }
    Ok(())
}
fn safe_error(error: anyhow::Error) -> anyhow::Error {
    let code = error.to_string();
    if code.starts_with("migration_")
        && code.len() < 128
        && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
    {
        anyhow::anyhow!(code)
    } else {
        anyhow::anyhow!("migration_publication_unconfirmed")
    }
}
