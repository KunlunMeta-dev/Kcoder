//! An explicit first project declaration stores name references, not inherited private definitions.
use super::*;
use kcoder_config::{
    PROJECT_MCP_INHERITED_SERVERS as FIELD, ProjectMcpCatalog, ProjectMcpCatalogSelection,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProjectMcpInheritancePlan {
    selection: ProjectMcpCatalogSelection,
    original_explicit_null: bool,
}
impl ProjectMcpInheritancePlan {
    pub(crate) fn selection(&self) -> &ProjectMcpCatalogSelection {
        &self.selection
    }
}
impl McpTarget {
    /// Preview only the real inherited names/revision. Existing declarations retain legacy semantics.
    pub fn project_mcp_catalog(&self) -> Result<ProjectMcpCatalog> {
        let scope = self
            .project
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_wrong_target"))?;
        scope.verify()?;
        ensure!(
            self.settings.read()?.get("mcp_servers").is_none(),
            "migration_project_mcp_catalog_already_declared"
        );
        scope.mcp_catalog()
    }
    /// The caller must explicitly choose which previewed names to keep, including an empty choice.
    pub fn with_project_mcp_catalog(mut self, choice: ProjectMcpCatalogSelection) -> Result<Self> {
        choice.verify(&self.project_mcp_catalog()?)?;
        self.project_catalog = Some(choice);
        Ok(self)
    }
}
pub(super) fn prepare(
    target: &McpTarget,
    current: &Value,
) -> Result<Option<ProjectMcpInheritancePlan>> {
    let Some(choice) = &target.project_catalog else {
        return Ok(None);
    };
    if current.get("mcp_servers").is_some() {
        return Ok(None);
    }
    choice.verify(
        &target
            .project
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_wrong_target"))?
            .mcp_catalog()?,
    )?;
    ensure!(
        current.get(FIELD).is_none_or(Value::is_null),
        "migration_project_mcp_invalid_selection"
    );
    Ok(Some(ProjectMcpInheritancePlan {
        selection: choice.clone(),
        original_explicit_null: current.get(FIELD).is_some(),
    }))
}
pub(super) fn insert(current: &mut Value, plan: &McpPlan) -> Result<()> {
    let Some(inheritance) = &plan.project_inheritance else {
        return Ok(());
    };
    ensure!(
        plan.project
            && !plan.servers_was_explicit
            && current.get("mcp_servers").is_none()
            && current.get(FIELD).is_some() == inheritance.original_explicit_null
            && current.get(FIELD).is_none_or(Value::is_null),
        "migration_plan_changed"
    );
    inheritance.selection.validate()?;
    ensure!(
        !inheritance
            .selection
            .names
            .iter()
            .any(|name| name == &plan.config().name),
        "migration_target_conflict"
    );
    current[FIELD] = serde_json::to_value(&inheritance.selection.names)?;
    Ok(())
}
pub(super) fn remove(current: &mut Value, plan: &McpPlan) -> Result<()> {
    if let Some(inheritance) = &plan.project_inheritance {
        ensure!(
            plan.project
                && !plan.servers_was_explicit
                && current.get(FIELD) == Some(&serde_json::to_value(&inheritance.selection.names)?),
            "migration_plan_changed"
        );
        if inheritance.original_explicit_null {
            current[FIELD] = Value::Null;
        } else {
            current.as_object_mut().unwrap().remove(FIELD);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
