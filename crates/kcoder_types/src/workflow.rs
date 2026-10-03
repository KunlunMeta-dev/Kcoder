//! Portable saved-workflow data; execution and persistence belong to kcoder_workflow.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStatus {
    #[default]
    Draft,
    Saved,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct WorkflowPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowNode {
    #[serde(default, skip_serializing_if = "WorkflowNodeKind::is_agent")]
    pub kind: WorkflowNodeKind,
    #[serde(default, skip_serializing_if = "WorkflowNodeConfig::is_empty")]
    pub config: WorkflowNodeConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    /// Controls whether this node executes; its condition/switch must also be a direct dependency. Merely copying a condition output does not gate execution.
    pub run_if: Option<WorkflowBranchGuard>,
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default = "default_agent_type")]
    pub agent_type: String,
    #[serde(default = "default_max_turns")]
    pub max_turns: u32,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub position: WorkflowPosition,
    #[serde(default)]
    pub allowed_write_paths: Vec<String>,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub expected_artifacts: Vec<String>,
}
fn default_agent_type() -> String {
    "general".into()
}
fn default_max_turns() -> u32 {
    60
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowDefinition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<serde_json::Value>,
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub revision: u64,
    pub status: WorkflowStatus,
    pub nodes: Vec<WorkflowNode>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_version: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSummary {
    pub id: String,
    pub title: String,
    pub description: String,
    pub revision: u64,
    pub status: WorkflowStatus,
    pub node_count: usize,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_version: Option<u64>,
}
impl From<&WorkflowDefinition> for WorkflowSummary {
    fn from(value: &WorkflowDefinition) -> Self {
        Self {
            id: value.id.clone(),
            title: value.title.clone(),
            description: value.description.clone(),
            revision: value.revision,
            status: value.status,
            node_count: value.nodes.len(),
            created_at_ms: value.created_at_ms,
            updated_at_ms: value.updated_at_ms,
            saved_version: value.saved_version,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WorkflowNodeKind {
    #[default]
    Agent,
    Code,
    Tool,
    Subworkflow,
    Wait,
    Human,
    Event,
    Transform,
    Input,
    Template,
    Condition,
    Switch,
    Merge,
    Loop,
    Output,
}
impl WorkflowNodeKind {
    pub fn is_agent(&self) -> bool {
        *self == Self::Agent
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WorkflowMergePolicy {
    #[default]
    All,
    Any,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WorkflowLoopMode {
    #[default]
    Repeat,
    ForEach,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkflowPredicate {
    Exists {
        pointer: String,
    },
    Equals {
        pointer: String,
        value: serde_json::Value,
    },
    NotEquals {
        pointer: String,
        value: serde_json::Value,
    },
    GreaterThan {
        pointer: String,
        /// Strict threshold in the same units as the pointed-to number: equality does not pass. Choose a reachable threshold when early stopping is intended.
        value: f64,
    },
    LessThan {
        pointer: String,
        /// Strict threshold in the same units as the pointed-to number: equality does not pass.
        value: f64,
    },
    Contains {
        pointer: String,
        value: serde_json::Value,
    },
    All {
        conditions: Vec<WorkflowPredicate>,
    },
    Any {
        conditions: Vec<WorkflowPredicate>,
    },
    Not {
        condition: Box<WorkflowPredicate>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowBranchGuard {
    /// ID of a Condition or Switch node listed in dependsOn. Test matching and nonmatching branches, including absence of side effects in skipped nodes.
    pub node_id: String,
    pub equals: WorkflowBranchValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(untagged)]
pub enum WorkflowBranchValue {
    Boolean(bool),
    Route(String),
}
impl From<bool> for WorkflowBranchValue {
    fn from(value: bool) -> Self {
        Self::Boolean(value)
    }
}
impl WorkflowBranchValue {
    pub fn matches(&self, value: Option<&serde_json::Value>) -> bool {
        match self {
            Self::Boolean(expected) => {
                value.and_then(serde_json::Value::as_bool) == Some(*expected)
            }
            Self::Route(expected) => {
                value.and_then(serde_json::Value::as_str) == Some(expected.as_str())
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSwitchCase {
    pub label: String,
    pub condition: WorkflowPredicate,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSwitchConfig {
    pub cases: Vec<WorkflowSwitchCase>,
    pub default: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowLoopConfig {
    /// Optional immutable workflow executed once per iteration instead of an Agent. Its full graph result lives at /iteration/output, including outputs[]; do not assume a score field is directly at that root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<WorkflowSubworkflowConfig>,
    #[serde(default)]
    pub mode: WorkflowLoopMode,
    pub max_iterations: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection_pointer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    /// Evaluated after each response against the full context. Result fields live
    /// under /iteration/output (requires outputSchema for structured access),
    /// alongside /iteration/index and /iteration/item. Use the actual output scale, not an unreachable example threshold.
    /// Verify both early exit (exitReason=condition_met, count below the cap) and non-triggering behavior (iteration_limit for repeat; collection_exhausted for for_each). Greater-than is strict at equality.
    pub until: Option<WorkflowPredicate>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkflowTransformStep {
    Map {
        /// Output-name to item-relative JSON Pointer. For an item {"value":2}, use /value; for {"iteration":{"value":2}}, use /iteration/value. Each step sees the previous step's result.
        fields: std::collections::BTreeMap<String, String>,
    },
    Filter {
        /// Predicate context wraps the current item as input: /input/value reads its value field. nodes contains direct workflow dependencies.
        condition: WorkflowPredicate,
    },
    Sort {
        /// JSON Pointer relative to each current array item, e.g. /value. No implicit input or iteration wrapper is added. Missing values sort last.
        pointer: String,
        #[serde(default)]
        descending: bool,
    },
    Deduplicate {
        /// JSON Pointer relative to each current item, e.g. /id. Omit to compare whole items. No implicit iteration wrapper is added.
        #[serde(default)]
        pointer: Option<String>,
    },
    Limit {
        count: usize,
    },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowTransformConfig {
    /// Absolute workflow-context pointer, e.g. /input/items or /nodes/parse/rows; unlike per-item map/sort/deduplicate pointers.
    pub source_pointer: String,
    pub steps: Vec<WorkflowTransformStep>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowWaitConfig {
    #[serde(default)]
    pub delay_ms: Option<u64>,
    #[serde(default)]
    pub until_unix_ms: Option<u64>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowHumanConfig {
    /// Blocks until a real response or timeout. Keep off an unattended smoke test's required output path unless an explicitly authorized test driver supplies the response; never fabricate approval.
    pub prompt: String,
    pub response_schema: serde_json::Value,
    #[serde(default = "default_interaction_timeout")]
    pub timeout_ms: u64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowEventConfig {
    /// Requires an authenticated external response or timeout. Test separately or arrange an authorized response driver for unattended tests; declaring this node does not complete it.
    pub name: String,
    pub payload_schema: serde_json::Value,
    #[serde(default = "default_interaction_timeout")]
    pub timeout_ms: u64,
}
fn default_interaction_timeout() -> u64 {
    30 * 60 * 1000
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkflowAwaitRequest {
    Wait {
        delay_ms: Option<u64>,
        until_unix_ms: Option<u64>,
    },
    Human {
        prompt: String,
        schema: serde_json::Value,
        timeout_ms: u64,
    },
    Event {
        name: String,
        schema: serde_json::Value,
        timeout_ms: u64,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowResponseValue {
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowPendingRequest {
    pub run_id: String,
    pub request_id: String,
    pub node_id: String,
    pub request: WorkflowAwaitRequest,
    pub deadline_unix_ms: u64,
    pub status: String,
    #[serde(default)]
    pub response: Option<WorkflowResponseValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSubworkflowConfig {
    pub definition_id: String,
    /// Pin an immutable published version; never implicitly follow latest.
    pub version: u64,
    /// Named child-workflow inputs as a JSON object, e.g. {"city":"Beijing","days":3}; never a positional array. bindings override these values by key.
    #[serde(default = "empty_tool_arguments")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(with = "std::collections::BTreeMap<String, serde_json::Value>")
    )]
    pub arguments: serde_json::Value,
    #[serde(default)]
    pub bindings: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowToolConfig {
    pub name: String,
    /// Literal named tool arguments as a JSON object, not a positional array. Use bindings for values from input/dependencies.
    #[serde(default = "empty_tool_arguments")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(with = "std::collections::BTreeMap<String, serde_json::Value>")
    )]
    pub arguments: serde_json::Value,
    /// Map top-level argument names to JSON pointers in the workflow context.
    #[serde(default)]
    pub bindings: std::collections::BTreeMap<String, String>,
}
fn empty_tool_arguments() -> serde_json::Value {
    serde_json::json!({})
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCodeConfig {
    /// JavaScript function BODY, not an uncalled function declaration. Use a top-level return.
    /// Code receives input/nodes and declared bindings; resultCheck also receives result and must return true.
    pub source: String,
    #[serde(default = "default_code_timeout")]
    pub timeout_ms: u64,
}
fn default_code_timeout() -> u64 {
    1000
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowFailurePolicy {
    #[serde(default = "default_failure_attempts")]
    pub max_attempts: u8,
    #[serde(default)]
    pub delay_ms: u64,
    #[serde(default)]
    /// Ordinary errors may become explicit workflowError data for a recovery branch. This is not successful verification; required result/schema checks, cancellation and quotas must not be swallowed.
    pub continue_on_error: bool,
}
fn default_failure_attempts() -> u8 {
    1
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowNodeConfig {
    /// Required named inputs resolved from /input or /nodes/<direct dependency>.
    /// Missing pointers fail before execution. Agents and Code receive context.bindings.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub input_bindings: std::collections::BTreeMap<String, String>,
    /// Pure JavaScript postcondition. Receives input, nodes, bindings, result.
    /// Must return true; false, non-boolean or an exception fails the node and run.
    /// Assert required data presence, types, lengths and identity correspondence. Missing preview entries or workflowError must not be automatic success; deliberate negative tests must check the exact expected failure and containment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_check: Option<WorkflowCodeConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_policy: Option<WorkflowFailurePolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform: Option<WorkflowTransformConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait: Option<WorkflowWaitConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub human: Option<WorkflowHumanConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<WorkflowEventConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subworkflow: Option<WorkflowSubworkflowConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<WorkflowToolConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<WorkflowCodeConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pointer: Option<String>,
    /// Text with optional {{/input/field}} or {{/nodes/dependency/field}} placeholders. Only the text INSIDE {{...}} must be an absolute JSON Pointer. A bare /input/field is literal text, not interpolation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<WorkflowPredicate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub switch: Option<WorkflowSwitchConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    /// Merge returns an object keyed by completed dependency IDs; it never flattens their outputs.
    pub merge_policy: Option<WorkflowMergePolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#loop: Option<WorkflowLoopConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    /// Schema for this node output. type/properties/required belong inside this field, not beside it in config. On Loop, validates EACH iteration response, not the aggregate.
    /// Loop returns {iterations: [responses], count: number, exitReason: string} to downstream nodes.
    pub output_schema: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "is_zero_retry")]
    /// Malformed-JSON repair attempts (0-2); valid JSON that violates its schema fails without rewriting values. Set config.validationRetries BESIDE outputSchema, never inside it.
    pub validation_retries: u8,
}
fn is_zero_retry(value: &u8) -> bool {
    *value == 0
}
impl WorkflowNodeConfig {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowVersionSummary {
    pub version: u64,
    pub revision: u64,
    pub title: String,
    pub node_count: usize,
    pub saved_at_ms: u64,
}
