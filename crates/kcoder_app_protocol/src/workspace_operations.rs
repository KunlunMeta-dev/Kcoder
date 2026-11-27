//! Durable receipts for opening and preparing registered workspaces.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const CAPABILITY_WORKSPACE_OPERATION_RECEIPTS_V1: &str = "workspaceOperationReceiptsV1";
pub const METHOD_WORKSPACE_OPERATION_READ: &str = "runtime.workspaces.operation/read";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOperationMutationParams {
    pub workspace_path: String,
    #[serde(default)]
    pub client_request_id: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub action: Option<WorkspacePrepareAction>,
    #[serde(flatten)]
    pub options: std::collections::BTreeMap<String, Value>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspacePrepareAction {
    Create,
    Select,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOperationReadParams {
    pub client_request_id: String,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceOperationStatus {
    Ready,
    Unknown,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOperationReceipt {
    pub client_request_id: String,
    pub method: String,
    pub status: WorkspaceOperationStatus,
    pub workspace_path: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOperationReadResult {
    pub receipt: Option<WorkspaceOperationReceipt>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn receipt_wire_names_and_action_validation() {
        let params: WorkspaceOperationMutationParams = serde_json::from_value(serde_json::json!({"workspacePath":"/project","clientRequestId":"intent","action":"create","label":"Project"})).unwrap();
        assert_eq!(params.client_request_id.as_deref(), Some("intent"));
        assert!(
            serde_json::from_value::<WorkspaceOperationMutationParams>(
                serde_json::json!({"workspacePath":"/project","action":"destroy"})
            )
            .is_err()
        );
        let value = serde_json::to_value(WorkspaceOperationReceipt {
            client_request_id: "intent".into(),
            method: "runtime.workspaces.open".into(),
            status: WorkspaceOperationStatus::Unknown,
            workspace_path: None,
        })
        .unwrap();
        assert_eq!(value["clientRequestId"], "intent");
        assert_eq!(value["status"], "unknown");
    }
}

// V2 is negotiated separately. It never reads or migrates V1's unbound IDs.
pub const CAPABILITY_WORKSPACE_OPERATION_RECEIPTS_V2: &str = "workspaceOperationReceiptsV2";
pub const METHOD_WORKSPACE_OPERATION_SCOPE_V2: &str = "runtime.workspaces.operation/scopeV2";
pub const METHOD_WORKSPACE_OPERATION_READ_V2: &str = "runtime.workspaces.operation/readV2";
pub const METHOD_WORKSPACE_OPEN_V2: &str = "runtime.workspaces.openV2";
pub const METHOD_WORKSPACE_PREPARE_V2: &str = "runtime.workspaces.prepareV2";
pub const METHOD_WORKTREE_PREPARE_V2: &str = "runtime.worktrees.prepareV2";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceOperationScopeV2 {
    #[serde(deserialize_with = "workspace_version_two")]
    pub version: u8,
    pub root_id: String,
    pub scope_id: String,
    /// Stable installation/selected-target fence; independent of mutable ownership.
    pub family_id: String,
}

fn workspace_version_two<'de, D: serde::Deserializer<'de>>(input: D) -> Result<u8, D::Error> {
    let version = u8::deserialize(input)?;
    if version != 2 {
        return Err(serde::de::Error::custom(
            "unsupported workspace receipt version",
        ));
    }
    Ok(version)
}

pub fn is_workspace_operation_v2(method: &str) -> bool {
    matches!(
        method,
        METHOD_WORKSPACE_OPERATION_SCOPE_V2
            | METHOD_WORKSPACE_OPERATION_READ_V2
            | METHOD_WORKSPACE_OPEN_V2
            | METHOD_WORKSPACE_PREPARE_V2
            | METHOD_WORKTREE_PREPARE_V2
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceOperationScopeParamsV2 {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceOperationReadParamsV2 {
    pub client_request_id: String,
    pub scope_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceOperationMutationParamsV2 {
    pub client_request_id: String,
    pub scope_id: String,
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<WorkspacePrepareAction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreeOperationMutationParamsV2 {
    pub client_request_id: String,
    pub scope_id: String,
    pub source_path: String,
    pub worktree_id: String,
    #[serde(default)]
    pub permanent: bool,
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub git_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceOperationReceiptV2 {
    pub client_request_id: String,
    pub method: String,
    pub params_digest: String,
    pub status: WorkspaceOperationStatus,
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceOperationReadResultV2 {
    pub scope: WorkspaceOperationScopeV2,
    pub receipt: Option<WorkspaceOperationReceiptV2>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceOperationMutationResultV2 {
    pub scope: WorkspaceOperationScopeV2,
    pub receipt: WorkspaceOperationReceiptV2,
    pub result: Value,
}
