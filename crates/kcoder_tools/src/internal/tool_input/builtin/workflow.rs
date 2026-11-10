use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkflowInput {
    /// Inline JavaScript workflow body. Use exactly one of script, name, script_path, or definition_id with version.
    #[serde(default)]
    pub script: Option<String>,
    /// Named project workflow from `.kcoder/workflows/<name>.js`.
    #[serde(default)]
    pub name: Option<String>,
    /// JavaScript workflow file relative to the session cwd.
    #[serde(default)]
    pub script_path: Option<PathBuf>,
    /// Recover the same pinned version using its run_id. Reuses successful dependency-closed node checkpoints. Omit args and execution limits to retain saved values. Legacy missing limits require matching saved execution evidence; otherwise supply original limits. Never blindly replay effects with unknown outcomes.
    #[serde(default)]
    pub resume: Option<String>,
    /// With definition_id and an explicit saved version, create a new run reusing successful unchanged nodes from this prior run. Omit args and execution limits to retain source values. The old run is retained; only nodes with matching semantics, all upstream nodes, effective input and execution settings are reused. Cannot combine with resume or scripts.
    #[serde(default)]
    pub reuse_from_run: Option<String>,
    /// Published workflow-library definition ID. Requires an explicit version; cannot be combined with JavaScript sources or resume.
    #[serde(default)]
    pub definition_id: Option<String>,
    /// Immutable published version of definition_id to execute.
    #[serde(default)]
    pub version: Option<u64>,
    /// Native JSON value exposed as args; for object schemas pass an object, not JSON-encoded text.
    #[serde(default)]
    pub args: Value,
    /// Preferred channel for arrays and nested objects: complete serialized JSON text. Explicit JSON types are preserved, not coerced. For args.items use {"items":["1","2"]}; a root array is args itself. Never also supply args.
    #[serde(default)]
    pub args_json: Option<String>,
    /// Explicit finite case for a pinned definition graph: id, requiredCheckNodes, expectedSkippedNodes. Verdicts come only from actual configured checks.
    #[serde(default)]
    pub verification_scenario: Option<Value>,
    /// Lossless JSON text alternative; never also supply verification_scenario.
    #[serde(default)]
    pub verification_scenario_json: Option<String>,
    /// Maximum agents this workflow may run concurrently (1-4).
    #[serde(default)]
    pub max_concurrency: Option<usize>,
    /// Default max turns for each agent call (1-100; new runs default to 60, recovery retains the source value).
    #[serde(default)]
    pub max_agent_turns: Option<usize>,
    /// Whole-workflow wall clock limit in seconds (1-86400; recovery retains the source value when omitted).
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
    /// Short user-facing description for background task lists.
    #[serde(default)]
    pub description: Option<String>,
}

builtin_input!(WorkflowInput);
