//! Explicit project MCP references inherit names without copying lower-layer values to disk.
use crate::Settings;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const PROJECT_MCP_INHERITED_SERVERS: &str = "mcp_inherited_servers";
const MAX_NAMES: usize = 1024;

/// A bounded preview contains names and a revision, never inherited definitions or private values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectMcpCatalog {
    pub names: Vec<String>,
    pub revision: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectMcpCatalogSelection {
    pub names: Vec<String>,
    pub expected_revision: String,
}
impl ProjectMcpCatalog {
    pub fn from_settings(settings: &Settings) -> Result<Self> {
        let names = settings
            .mcp_servers
            .iter()
            .map(|server| server.name.clone())
            .collect::<Vec<_>>();
        validate_names(&names)?;
        // Canonical objects make the revision independent of HashMap iteration.
        let material = canonical(serde_json::to_value((
            &settings.mcp_servers,
            &settings.mcp_disabled_servers,
        ))?);
        let revision = format!("{:x}", Sha256::digest(serde_json::to_vec(&material)?));
        Ok(Self { names, revision })
    }
    /// Selecting an empty list is an explicit decision to inherit no existing servers.
    pub fn select(&self, names: Vec<String>) -> Result<ProjectMcpCatalogSelection> {
        validate_names(&names)?;
        ensure!(
            names.iter().all(|name| self.names.contains(name)),
            "migration_project_mcp_selection_changed"
        );
        Ok(ProjectMcpCatalogSelection {
            names,
            expected_revision: self.revision.clone(),
        })
    }
}
impl ProjectMcpCatalogSelection {
    pub fn validate(&self) -> Result<()> {
        validate_names(&self.names)?;
        ensure!(
            self.expected_revision.len() == 64
                && self
                    .expected_revision
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
            "migration_project_mcp_invalid_selection"
        );
        Ok(())
    }
    pub fn verify(&self, catalog: &ProjectMcpCatalog) -> Result<()> {
        self.validate()?;
        ensure!(
            self.expected_revision == catalog.revision
                && self.names.iter().all(|name| catalog.names.contains(name)),
            "migration_target_changed"
        );
        Ok(())
    }
}
fn canonical(value: Value) -> Value {
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(name, value)| (name, canonical(value)))
                .collect::<BTreeMap<_, _>>()
                .into_iter()
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(canonical).collect()),
        other => other,
    }
}
pub(crate) fn validate_names(names: &[String]) -> Result<()> {
    ensure!(
        names.len() <= MAX_NAMES
            && names.iter().all(|name| !name.is_empty()
                && name.len() <= 128
                && name.trim() == name
                && !name.chars().any(char::is_control))
            && names.iter().collect::<BTreeSet<_>>().len() == names.len(),
        "migration_project_mcp_invalid_selection"
    );
    Ok(())
}

/// Only the actual project layer interprets the new explicit directive. Every
/// other layer keeps its historical array replacement semantics.
pub(crate) fn expand_layer(lower: &Value, document: &mut Value, project: bool) -> Result<()> {
    let Some(value) = document.get(PROJECT_MCP_INHERITED_SERVERS) else {
        return Ok(());
    };
    if value.is_null() {
        document
            .as_object_mut()
            .context("migration_invalid_target_configuration")?
            .remove(PROJECT_MCP_INHERITED_SERVERS);
        return Ok(());
    }
    ensure!(project, "migration_project_mcp_directive_project_only");
    let names: Vec<String> = serde_json::from_value(value.clone())
        .map_err(|_| anyhow::anyhow!("migration_project_mcp_invalid_selection"))?;
    validate_names(&names)?;
    let owned = document
        .get("mcp_servers")
        .and_then(Value::as_array)
        .context("migration_project_mcp_servers_required")?;
    let mut servers = Vec::new();
    let selected = names.iter().map(String::as_str).collect::<BTreeSet<_>>();
    let mut seen = BTreeSet::new();
    if let Some(inherited) = lower.get("mcp_servers").and_then(Value::as_array) {
        for server in inherited {
            let name = server
                .get("name")
                .and_then(Value::as_str)
                .context("migration_invalid_target_configuration")?;
            if selected.contains(name) {
                ensure!(
                    seen.insert(name.to_owned()),
                    "migration_project_mcp_ambiguous_catalog"
                );
                servers.push(server.clone());
            }
        }
    }
    // A removed lower-layer name is absent, never rebuilt from a cached snapshot.
    for server in owned {
        let name = server
            .get("name")
            .and_then(Value::as_str)
            .context("migration_invalid_target_configuration")?;
        ensure!(
            !selected.contains(name) && seen.insert(name.to_owned()),
            "migration_target_conflict"
        );
        servers.push(server.clone());
    }
    let root = document
        .as_object_mut()
        .context("migration_invalid_target_configuration")?;
    root.remove(PROJECT_MCP_INHERITED_SERVERS);
    root.insert("mcp_servers".into(), Value::Array(servers));
    Ok(())
}

/// Scope-aware writers validate the directive before publishing a settings file.
pub(crate) fn validate_scope(document: &Value, project: bool) -> Result<()> {
    let mut projection = document.clone();
    expand_layer(&Value::Null, &mut projection, project)
}

/// Validate the project-owned fragment only. Inheritance and publication still
/// require the actual loader/profile guard; this function grants no workspace authority.
pub fn validate_project_mcp_fragment(document: &Value) -> Result<()> {
    let mut owned = document.clone();
    if let Some(value) = owned.get(PROJECT_MCP_INHERITED_SERVERS)
        && !value.is_null()
    {
        let names: Vec<String> = serde_json::from_value(value.clone())
            .map_err(|_| anyhow::anyhow!("migration_project_mcp_invalid_selection"))?;
        validate_names(&names)?;
        ensure!(
            owned.get("mcp_servers").is_some_and(Value::is_array),
            "migration_project_mcp_servers_required"
        );
    }
    owned
        .as_object_mut()
        .context("migration_invalid_target_configuration")?
        .remove(PROJECT_MCP_INHERITED_SERVERS);
    crate::validate_and_resolve_settings_document(&owned).map(drop)
}

#[cfg(test)]
mod tests;
