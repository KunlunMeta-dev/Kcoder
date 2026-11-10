use kcoder_tool_error::ToolError;
use kcoder_types::workflow::{WorkflowDefinition, WorkflowNode};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Help,
    CollaborationPresets,
    ApplyCollaboration,
    PreviewRunArchive,
    ArchiveRuns,
    ReadArchivedRun,
    Capacity,
    MigrateStorage,
    RollbackStorage,
    Verification,
    VersionReferences,
    ArchiveVersion,
    ReadHistory,
    List,
    Update,
    Clone,
    Versions,
    Export,
    Import,
    Create,
    UpsertNode,
    PatchNodes,
    RemoveNode,
    Read,
    Save,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ResponseDetail {
    Full,
    Changes,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub action: Action,
    /// Exact run IDs selected for preview_run_archive/archive_runs; never choose history automatically.
    pub run_ids: Option<Vec<String>>,
    /// Content token returned by preview_run_archive for the exact selected IDs.
    pub preview_token: Option<String>,
    /// Required true only after explicit user confirmation of the selected history archive.
    pub confirm: Option<bool>,
    /// ID for read_archived_run.
    pub run_id: Option<String>,
    /// Optional on-demand help selector; does not execute this node.
    pub node_kind: Option<kcoder_types::workflow::WorkflowNodeKind>,
    /// For tool help, inspect only the actual currently registered safe target contract.
    pub tool_name: Option<String>,
    /// For mutations, changes returns metadata and only affected nodes; full (default) returns the entire definition. Read/export always return the complete definition.
    pub response_detail: Option<ResponseDetail>,
    pub id: Option<String>,
    pub title: Option<String>,
    #[serde(default)]
    pub description: String,
    #[schemars(range(min = 1))]
    pub expected_revision: Option<u64>,
    pub collaboration_plan: Option<kcoder_types::workflow::WorkflowCollaborationPlan>,
    pub collaboration_plan_json: Option<String>,
    pub node: Option<WorkflowNode>,
    /// Lossless JSON text alternative to node, for providers that rewrite nested argument types.
    pub node_json: Option<String>,
    /// Lossless JSON text alternative to nodes; must encode an array of partial node objects.
    pub nodes_json: Option<String>,
    /// Lossless JSON text alternative to input_schema; numbers/booleans/arrays remain native JSON types.
    pub input_schema_json: Option<String>,
    /// Lossless JSON text alternative to definition for import.
    pub definition_json: Option<String>,
    /// Partial node fields for patch_nodes. Omit nodes/nodes_json for a deletion-only patch. Omitted fields and config keys are preserved.
    #[schemars(with = "Option<Vec<WorkflowNode>>")]
    pub nodes: Option<Vec<Value>>,
    /// IDs to delete in the same patch; nodes is optional for deletion-only edits. Rewire remaining dependents explicitly. Clearing all nodes leaves an unpublished empty draft.
    #[serde(default)]
    pub remove_node_ids: Vec<String>,
    pub definition: Option<WorkflowDefinition>,
    pub node_id: Option<String>,
    pub offset: Option<usize>,
    #[schemars(range(min = 1, max = 32))]
    pub limit: Option<usize>,
    /// Workflow input JSON Schema object or boolean, not a JSON-encoded string. Omit/null clears it on update.
    pub input_schema: Option<Value>,
    #[schemars(range(min = 1))]
    pub version: Option<u64>,
}
impl Input {
    pub fn decode_json_fields(&mut self) -> Result<(), ToolError> {
        fn decode<T: serde::de::DeserializeOwned>(
            value: &mut Option<T>,
            text: Option<String>,
            field: &str,
        ) -> Result<(), ToolError> {
            if let Some(text) = text {
                if value.is_some() {
                    return Err(ToolError::InvalidInput(format!(
                        "{field} and {field}_json are mutually exclusive"
                    )));
                }
                if text.len() > 128 * 1024 {
                    return Err(ToolError::InvalidInput(format!(
                        "{field}_json exceeds 128 KiB"
                    )));
                }
                *value =
                    Some(serde_json::from_str(&text).map_err(|error| {
                        ToolError::InvalidInput(format!("{field}_json: {error}"))
                    })?);
            }
            Ok(())
        }
        decode(
            &mut self.collaboration_plan,
            self.collaboration_plan_json.take(),
            "collaboration_plan",
        )?;
        decode(&mut self.node, self.node_json.take(), "node")?;
        decode(&mut self.nodes, self.nodes_json.take(), "nodes")?;
        decode(
            &mut self.definition,
            self.definition_json.take(),
            "definition",
        )?;
        decode(
            &mut self.input_schema,
            self.input_schema_json.take(),
            "input_schema",
        )?;
        if self.input_schema.as_ref().is_some_and(Value::is_null) {
            self.input_schema = None;
        }
        Ok(())
    }
}

builtin_input!(Input);
