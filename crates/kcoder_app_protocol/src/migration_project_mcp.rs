//! Explicit inherited-name selection for a first project MCP declaration.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectMcpInheritanceSelection {
    pub names: Vec<String>,
    pub expected_revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectMcpCatalogParams {
    pub job_id: String,
    #[serde(default)]
    pub page_index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationProjectMcpCatalogStatus {
    SelectionRequired,
    AlreadyDeclared,
    NotProject,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectMcpCatalogResult {
    pub job_id: String,
    pub status: MigrationProjectMcpCatalogStatus,
    pub names: Vec<String>,
    pub total_names: usize,
    pub revision: Option<String>,
    pub next_page_index: Option<usize>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_batch_plan_does_not_implicitly_choose_inherited_names() {
        let value = json!({
            "jobId":"owned-job", "expectedSequence":1, "choices":[],
            "includeDefaultItems":false, "excludedItemIds":[], "reuseExisting":false
        });
        let request: crate::MigrationBatchPlanParams =
            serde_json::from_value(value.clone()).unwrap();
        assert!(request.project_mcp_inheritance.is_none());
        assert_eq!(serde_json::to_value(request).unwrap(), value);
    }

    #[test]
    fn explicit_empty_inheritance_is_distinct_from_no_selection() {
        let mut value = json!({"jobId":"owned-job", "expectedSequence":1, "choices":[]});
        value["projectMcpInheritance"] = json!({"names":[], "expectedRevision":"a".repeat(64)});
        let request: crate::MigrationBatchPlanParams =
            serde_json::from_value(value.clone()).unwrap();
        assert_eq!(
            request.project_mcp_inheritance.unwrap().names,
            Vec::<String>::new()
        );
        value["projectMcpInheritance"]["definitions"] = json!([]);
        assert!(serde_json::from_value::<crate::MigrationBatchPlanParams>(value).is_err());
        assert!(
            serde_json::from_value::<MigrationProjectMcpCatalogParams>(json!({
                "jobId":"owned-job", "profile":"another-account"
            }))
            .is_err()
        );
    }
}
