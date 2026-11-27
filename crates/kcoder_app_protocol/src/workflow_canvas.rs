use kcoder_types::workflow::{WorkflowDefinition, WorkflowNode, WorkflowSummary};
use kcoder_types::workflow_runs::WorkflowRunSnapshot;
use serde::{Deserialize, Serialize};
pub const CAPABILITY_WORKFLOW_SWITCH_V1: &str = "workflowSwitchV1";
pub const CAPABILITY_WORKFLOW_CANVAS_V1: &str = "workflowCanvasV1";
pub const CAPABILITY_WORKFLOW_CONDITIONAL_READ_V1: &str = "workflowConditionalReadV1";
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowListParams {
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_list_limit")]
    pub limit: usize,
}
fn default_list_limit() -> usize {
    32
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowReadParams {
    pub id: String,
    #[serde(
        default,
        rename = "knownRevision",
        skip_serializing_if = "Option::is_none"
    )]
    pub known_revision: Option<u64>,
    #[serde(
        default,
        rename = "knownUpdatedAtMs",
        skip_serializing_if = "Option::is_none"
    )]
    pub known_updated_at_ms: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum WorkflowDefinitionReadResult {
    Unchanged(WorkflowDefinitionUnchanged),
    Snapshot(WorkflowDefinition),
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowDefinitionUnchanged {
    pub unchanged: bool,
    pub id: String,
    pub revision: u64,
    pub updated_at_ms: u64,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowCreateParams {
    pub title: String,
    #[serde(default)]
    pub description: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSaveParams {
    pub id: String,
    pub expected_revision: u64,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowUpsertNodeParams {
    pub id: String,
    pub expected_revision: u64,
    pub node: WorkflowNode,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRemoveNodeParams {
    pub id: String,
    pub expected_revision: u64,
    pub node_id: String,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct WorkflowListResult {
    pub items: Vec<WorkflowSummary>,
    pub truncated: bool,
    pub total: usize,
    #[serde(rename = "nextOffset", skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<usize>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn routing_contract_preserves_boolean_and_named_guards() {
        for equals in [serde_json::json!(true), serde_json::json!("true")] {
            let params: WorkflowUpsertNodeParams = serde_json::from_value(serde_json::json!({
                "id":"workflow", "expectedRevision":1,
                "node":{"id":"branch","runIf":{"nodeId":"router","equals":equals},"dependsOn":["router"]}
            })).unwrap();
            assert_eq!(
                serde_json::to_value(params).unwrap()["node"]["runIf"]["equals"],
                equals
            );
        }
        let router: WorkflowUpsertNodeParams = serde_json::from_value(serde_json::json!({
            "id":"workflow", "expectedRevision":1, "node":{"id":"router","kind":"switch", "config":{"switch":{
                "cases":[{"label":"true","condition":{"op":"exists","pointer":"/input"}}],"default":"other"
            }}}
        })).unwrap();
        assert_eq!(
            serde_json::to_value(router).unwrap()["node"]["kind"],
            "switch"
        );
    }

    #[test]
    fn graph_mutations_require_revision_and_reject_paths() {
        assert!(
            serde_json::from_value::<WorkflowSaveParams>(serde_json::json!({"id":"test"})).is_err()
        );
        assert!(
            serde_json::from_value::<WorkflowReadParams>(
                serde_json::json!({"id":"test","path":"/other"})
            )
            .is_err()
        );
        let params: WorkflowSaveParams =
            serde_json::from_value(serde_json::json!({"id":"test","expectedRevision":3})).unwrap();
        assert_eq!(params.expected_revision, 3);
    }
    #[test]
    fn conditional_reads_preserve_legacy_params_and_reject_unknown_scope_fields() {
        let old: WorkflowReadParams =
            serde_json::from_value(serde_json::json!({"id":"flow"})).unwrap();
        assert!(old.known_revision.is_none());
        assert!(old.known_updated_at_ms.is_none());
        assert_eq!(
            serde_json::to_value(old).unwrap(),
            serde_json::json!({"id":"flow"})
        );
        let next: WorkflowReadParams = serde_json::from_value(
            serde_json::json!({"id":"flow","knownRevision":4,"knownUpdatedAtMs":12}),
        )
        .unwrap();
        assert_eq!(next.known_revision, Some(4));
        assert_eq!(next.known_updated_at_ms, Some(12));
        let run: WorkflowRunReadParams =
            serde_json::from_value(serde_json::json!({"runId":"run","knownRevision":8})).unwrap();
        assert_eq!(run.known_revision, Some(8));
        assert!(
            serde_json::from_value::<WorkflowRunReadParams>(
                serde_json::json!({"runId":"run","path":"/other"})
            )
            .is_err()
        );
        let unchanged: WorkflowDefinitionReadResult = serde_json::from_value(
            serde_json::json!({"unchanged":true,"id":"flow","revision":4,"updatedAtMs":12}),
        )
        .unwrap();
        assert!(matches!(
            unchanged,
            WorkflowDefinitionReadResult::Unchanged(_)
        ));
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunsListParams {
    #[serde(default)]
    pub definition_id: Option<String>,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_list_limit")]
    pub limit: usize,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunReadParams {
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub known_revision: Option<u64>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum WorkflowRunReadResult {
    Unchanged(WorkflowRunUnchanged),
    Snapshot(WorkflowRunSnapshot),
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunUnchanged {
    pub unchanged: bool,
    pub run_id: String,
    pub revision: u64,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunOutputParams {
    pub run_id: String,
    pub node_id: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_output_limit")]
    pub limit: usize,
}
fn default_output_limit() -> usize {
    16384
}

pub const CAPABILITY_WORKFLOW_RUNS_V1: &str = "workflowRunsV1";
pub const CAPABILITY_WORKFLOW_RUN_ARCHIVE_V1: &str = "workflowRunArchiveV1";
pub use kcoder_types::workflow_runs::{WorkflowRunArchivePreview, WorkflowRunArchiveResult};
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunArchivePreviewParams {
    pub run_ids: Vec<String>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunArchiveParams {
    pub run_ids: Vec<String>,
    pub preview_token: String,
    pub confirm: bool,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowUpdateParams {
    pub id: String,
    pub expected_revision: u64,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub input_schema: Option<serde_json::Value>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowVersionParams {
    pub id: String,
    #[serde(default)]
    pub version: Option<u64>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCloneParams {
    pub id: String,
    #[serde(default)]
    pub version: Option<u64>,
    #[serde(default)]
    pub title: Option<String>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowImportParams {
    pub definition: kcoder_types::workflow::WorkflowDefinition,
}

pub const CAPABILITY_WORKFLOW_GRAPH_V2: &str = "workflowGraphV2";

/// Delete the library definition and all saved versions, retaining run history.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowDeleteParams {
    pub id: String,
    pub expected_revision: u64,
}

pub const CAPABILITY_WORKFLOW_LAYOUT_V1: &str = "workflowLayoutV1";
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowMoveNodeParams {
    pub id: String,
    pub node_id: String,
    pub expected_position: kcoder_types::workflow::WorkflowPosition,
    pub position: kcoder_types::workflow::WorkflowPosition,
}

pub const CAPABILITY_WORKFLOW_CODE_V1: &str = "workflowCodeV1";

pub const CAPABILITY_WORKFLOW_TOOL_V1: &str = "workflowToolV1";

pub const CAPABILITY_WORKFLOW_SUBWORKFLOW_V1: &str = "workflowSubworkflowV1";

pub const CAPABILITY_WORKFLOW_INTERACTIONS_V1: &str = "workflowInteractionsV1";
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRequestsParams {
    pub run_id: String,
    #[serde(default)]
    pub after: Option<String>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRespondParams {
    pub run_id: String,
    pub request_id: String,
    pub value: serde_json::Value,
}

pub const CAPABILITY_WORKFLOW_TRANSFORM_V1: &str = "workflowTransformV1";

pub const CAPABILITY_WORKFLOW_SUBGRAPH_LOOPS_V1: &str = "workflowSubgraphLoopsV1";

pub const CAPABILITY_WORKFLOW_FAILURE_POLICY_V1: &str = "workflowFailurePolicyV1";

/// Strict input bindings and bounded executable result checks on graph nodes.
pub const CAPABILITY_WORKFLOW_NODE_CONTRACTS_V1: &str = "workflowNodeContractsV1";

pub const CAPABILITY_WORKFLOW_VERIFICATION_V1: &str = "workflowVerificationV1";
pub const CAPABILITY_WORKFLOW_STORAGE_V1: &str = "workflowStorageV1";
pub const CAPABILITY_WORKFLOW_VERSION_HISTORY_V1: &str = "workflowVersionHistoryV1";
pub const CAPABILITY_WORKFLOW_SCENARIOS_V1: &str = "workflowVerificationScenariosV1";
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowScenarioParams {
    pub id: String,
    pub required_check_nodes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_skipped_nodes: Option<Vec<String>>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowVerificationReadParams {
    pub id: String,
    pub version: u64,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_list_limit")]
    pub limit: usize,
}
#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct WorkflowStorageReadParams {}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowStorageMutationParams {
    /// Explicit storage action consent; reads and polling cannot migrate or roll back.
    pub confirm: bool,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowVersionReferenceParams {
    pub id: String,
    pub version: u64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowVersionArchiveParams {
    pub id: String,
    pub version: u64,
    pub expected_revision: u64,
    pub confirm: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowStorageCapacityResult {
    pub backend: String,
    pub workflow_count: usize,
    pub workflow_limit: usize,
    pub saved_version_count: usize,
    pub saved_version_bytes: usize,
    pub version_bytes: std::collections::BTreeMap<String, usize>,
    pub backup_bytes: usize,
    pub backup_byte_limit: usize,
    pub history_bytes: usize,
    pub history_byte_limit: usize,
    pub versions_per_workflow_limit: usize,
    pub used_bytes: usize,
    pub byte_limit: usize,
    pub near_limit: bool,
    pub versions: std::collections::BTreeMap<String, usize>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowToolContractChecks {
    pub known_nodes: Vec<String>,
    pub unknown_nodes: Vec<String>,
    pub runtime_bound_nodes: Vec<String>,
    #[serde(default)]
    pub contract_sha256: std::collections::BTreeMap<String, String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowStaticVerification {
    pub saved_version: u64,
    pub definition_sha256: String,
    pub checked_at_ms: u64,
    pub checked_nodes: Vec<String>,
    pub checks: Vec<String>,
    pub tool_contracts: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_contract_details: Option<WorkflowToolContractChecks>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowScenarioVerification {
    pub request: WorkflowScenarioParams,
    pub status: String,
    pub scope: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRuntimeVerification {
    pub definition_id: String,
    pub saved_version: u64,
    pub definition_sha256: String,
    pub run_id: String,
    pub resume_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_attempt: Option<u32>,
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
    pub execution_status: String,
    pub outcome_certainty: String,
    pub check_status: String,
    pub scope: String,
    pub checked_nodes: Vec<String>,
    #[serde(default)]
    pub configured_nodes: Vec<String>,
    #[serde(default)]
    pub definition_nodes: Vec<String>,
    pub skipped_nodes: Vec<String>,
    pub input_sha256: String,
    pub private_input_ref: String,
    pub output_sha256: Option<String>,
    pub private_output_ref: Option<String>,
    pub model_snapshot: serde_json::Value,
    pub safety_sha256: Option<String>,
    pub interaction_modified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario: Option<WorkflowScenarioVerification>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowVerificationReadResult {
    pub definition_id: String,
    pub saved_version: u64,
    pub draft_status: String,
    pub availability: String,
    pub static_check: Option<WorkflowStaticVerification>,
    pub runs: Vec<WorkflowRuntimeVerification>,
    pub total_run_count: usize,
    pub next_offset: Option<usize>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowStorageMigrationResult {
    pub backend: String,
    pub migrated: bool,
    pub legacy_backup: Option<String>,
    pub workflow_count: usize,
    pub saved_version_count: usize,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowRunReferenceState {
    Active,
    Unknown,
    TerminalKnown,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowVersionRunReference {
    pub run_id: String,
    pub definition_id: String,
    pub version: u64,
    pub state: WorkflowRunReferenceState,
    pub resume_count: u32,
    #[serde(default)]
    pub definition_sha256: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowVersionPin {
    pub definition_id: String,
    pub version: Option<u64>,
    pub node_id: String,
    pub source: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowVersionReferencesResult {
    pub definition_id: String,
    pub version: u64,
    pub definition_sha256: String,
    pub availability: String,
    pub latest: bool,
    pub current_revision: Option<u64>,
    pub pin_count: usize,
    pub pins: Vec<WorkflowVersionPin>,
    pub run_reference_count: usize,
    pub runs: Vec<WorkflowVersionRunReference>,
    pub can_archive: bool,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowHistoricalVersionResult {
    pub definition: WorkflowDefinition,
    pub definition_sha256: String,
    pub static_check: Option<WorkflowStaticVerification>,
    pub archived_at_ms: u64,
    pub availability: String,
    pub available_for_new_runs: bool,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowVersionArchiveResult {
    pub definition_id: String,
    pub version: u64,
    pub definition_sha256: String,
    pub current_revision: u64,
    pub availability: String,
    pub historical_snapshot_retained: bool,
    pub already_archived: bool,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowStorageRollbackResult {
    pub backend: String,
    pub rolled_back: bool,
}

#[cfg(test)]
mod verification_contract_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn verification_pages_and_storage_mutations_have_typed_scope_and_explicit_confirmation() {
        let page: WorkflowVerificationReadParams =
            serde_json::from_value(json!({"id":"flow","version":2})).unwrap();
        assert_eq!(page.offset, 0);
        assert_eq!(page.limit, 32);
        assert!(
            serde_json::from_value::<WorkflowVerificationReadParams>(
                json!({"id":"flow","version":2,"path":"/host"})
            )
            .is_err()
        );
        assert!(serde_json::from_value::<WorkflowStorageMutationParams>(json!({})).is_err());
        let mutation: WorkflowStorageMutationParams =
            serde_json::from_value(json!({"confirm":true})).unwrap();
        assert!(mutation.confirm);
        assert!(
            serde_json::from_value::<WorkflowVersionArchiveParams>(
                json!({"id":"flow","version":1,"confirm":true})
            )
            .is_err()
        );
    }
    #[test]
    fn named_case_is_data_only_and_cannot_accept_model_verdict_fields() {
        let case: WorkflowScenarioParams = serde_json::from_value(
            json!({"id":"equality","requiredCheckNodes":["loop"],"expectedSkippedNodes":[]}),
        )
        .unwrap();
        assert_eq!(case.required_check_nodes, ["loop"]);
        assert!(
            serde_json::from_value::<WorkflowScenarioParams>(
                json!({"id":"case","requiredCheckNodes":["loop"],"status":"passed"})
            )
            .is_err()
        );
        assert_eq!(
            serde_json::to_value(case).unwrap()["expectedSkippedNodes"],
            json!([])
        );
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCapabilitiesResult {
    pub verification: bool,
    pub storage: bool,
    pub version_history: bool,
    pub scenarios: bool,
    pub conditional_read: bool,
    /// Successful node checkpoints and explicit cross-version reuse. Old targets omit it.
    #[serde(default)]
    pub checkpoint_reuse: bool,
    #[serde(default)]
    pub run_archive: bool,
}
