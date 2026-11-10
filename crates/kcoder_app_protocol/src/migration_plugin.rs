//! User selections identify Native grants and operation receipts; clients cannot supply path authority.
use kcoder_types::{
    migration::MigrationSourceKind,
    migration_plugins::{MigrationPluginCandidate, MigrationPluginJob},
};
use serde::{Deserialize, Serialize};
pub const CAPABILITY_MIGRATION_PLUGIN_PROJECTS_V1: &str = "migrationPluginProjectsV1";
pub const CAPABILITY_MIGRATION_SOURCE_TRANSFER_PLUGINS_V1: &str =
    "migrationSourceTransferPluginsV1";
pub const CAPABILITY_MIGRATION_SOURCE_UPLOADED_PLUGINS_V1: &str =
    "migrationSourceUploadedPluginsV1";
fn is_false(value: &bool) -> bool {
    !*value
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationPluginProjectMapping {
    CurrentWorkspace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationPluginDiscoverParams {
    #[serde(default)]
    pub sources: Vec<MigrationSourceKind>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub include_project: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub include_uploaded: bool,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationPluginDiscoverResult {
    pub candidates: Vec<MigrationPluginCandidate>,
    pub next_cursor: Option<String>,
    pub problems: Vec<crate::MigrationDiscoveryProblem>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationPluginPlanParams {
    pub request_id: String,
    pub candidate_id: String,
    #[serde(default)]
    pub target_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_mapping: Option<MigrationPluginProjectMapping>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationPluginReadParams {
    pub operation_id: String,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationPluginOperationParams {
    pub operation_id: String,
    pub expected_sequence: u64,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationPluginListParams {
    pub cursor: Option<String>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationPluginStateResult {
    pub job: MigrationPluginJob,
    pub worker_running: bool,
    pub worker_error: Option<String>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationPluginListResult {
    pub items: Vec<MigrationPluginJob>,
    pub next_cursor: Option<String>,
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_options_preserve_old_wire_and_never_accept_path_or_trust_authority() {
        let old = serde_json::json!({"sources":[],"cursor":null});
        let params: MigrationPluginDiscoverParams = serde_json::from_value(old.clone()).unwrap();
        assert!(!params.include_project);
        assert!(!params.include_uploaded);
        assert_eq!(serde_json::to_value(params).unwrap(), old);
        let old = serde_json::json!({"requestId":"op","candidateId":"grant","targetName":null});
        let params: MigrationPluginPlanParams = serde_json::from_value(old.clone()).unwrap();
        assert!(params.project_mapping.is_none());
        assert_eq!(serde_json::to_value(params).unwrap(), old);
        for field in [
            "workspacePath",
            "sourceProject",
            "trusted",
            "projectIdentity",
        ] {
            let mut value = old.clone();
            value[field] = serde_json::json!("forged");
            assert!(serde_json::from_value::<MigrationPluginPlanParams>(value).is_err());
        }
        assert!(serde_json::from_value::<MigrationPluginPlanParams>(serde_json::json!({"requestId":"op","candidateId":"grant","projectMapping":"source_project"})).is_err());
    }
    #[test]
    fn uploaded_discovery_is_explicit_data_selection_not_a_path_grant() {
        let selected: MigrationPluginDiscoverParams =
            serde_json::from_value(serde_json::json!({"sources":["codex"],"includeUploaded":true}))
                .unwrap();
        assert!(selected.include_uploaded);
        assert!(!selected.include_project);
        for key in [
            "uploadedRoot",
            "sourcePath",
            "manifestSha256",
            "operationId",
        ] {
            let mut value = serde_json::json!({"sources":["codex"],"includeUploaded":true});
            value[key] = serde_json::json!("untrusted");
            assert!(serde_json::from_value::<MigrationPluginDiscoverParams>(value).is_err());
        }
    }
    #[test]
    fn plugin_operations_cannot_supply_source_paths_or_ownership_proofs() {
        for key in [
            "sourcePath",
            "profile",
            "owner",
            "packageSha256",
            "nativeOperation",
            "enabled",
        ] {
            let mut value = serde_json::json!({"requestId":"operation","candidateId":"grant"});
            value[key] = serde_json::json!("untrusted");
            assert!(serde_json::from_value::<MigrationPluginPlanParams>(value).is_err());
        }
        assert!(
            serde_json::from_value::<MigrationPluginOperationParams>(
                serde_json::json!({"operationId":"op","expectedSequence":1,"force":true})
            )
            .is_err()
        );
    }
    #[test]
    fn source_plugin_queries_and_received_opt_in_preserve_old_wire() {
        let query: crate::MigrationSourceSessionQuery = serde_json::from_value(serde_json::json!({"kind":"plugins","params":{"sources":["codex"],"includeProject":true}})).unwrap();
        assert!(
            matches!(query, crate::MigrationSourceSessionQuery::Plugins(params) if params.include_project)
        );
        let old: crate::MigrationSourceReceivedReadV1 = serde_json::from_value(
            serde_json::json!({"manifestSha256":"a".repeat(64),"pageIndex":0}),
        )
        .unwrap();
        assert!(!old.include_plugins);
        assert!(
            serde_json::to_value(old)
                .unwrap()
                .get("includePlugins")
                .is_none()
        );
        let selected: crate::MigrationSourceSelectionV1 =
            serde_json::from_value(serde_json::json!({"kind":"plugin","candidateId":"plug-owned"}))
                .unwrap();
        assert!(selected.valid());
        assert!(serde_json::from_value::<crate::MigrationSourceSelectionV1>(serde_json::json!({"kind":"plugin","candidateId":"plug-owned","sourcePath":"/untrusted"})).is_err());
    }
}
