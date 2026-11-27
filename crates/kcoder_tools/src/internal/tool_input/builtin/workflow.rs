use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkflowInput {
    /// Inline JavaScript workflow body.
    #[serde(default)]
    pub script: Option<String>,
    /// Named project workflow from `.kcoder/workflows/<name>.js`.
    #[serde(default)]
    pub name: Option<String>,
    /// JavaScript workflow file relative to the session cwd.
    #[serde(default)]
    pub script_path: Option<PathBuf>,
    /// run_id to recover on the same pinned version, reusing successful dependency-closed checkpoints. Omit args and limits to keep saved values (legacy runs without recorded limits need the original limits).
    #[serde(default)]
    pub resume: Option<String>,
    /// Prior run_id whose unchanged successful nodes a new run of definition_id + version reuses; the old run is retained. Omit args and limits to keep source values. Not with resume or scripts.
    #[serde(default)]
    pub reuse_from_run: Option<String>,
    /// Saved workflow-library definition ID; requires version. Not with scripts or resume.
    #[serde(default)]
    pub definition_id: Option<String>,
    /// Immutable published version of definition_id to execute.
    #[serde(default)]
    pub version: Option<u64>,
    /// Native JSON value exposed as args; for object schemas pass an object, not JSON-encoded text.
    #[serde(default)]
    pub args: Value,
    /// Complete serialized JSON text for args, preserving explicit types; a root array is args itself, so args.items needs {"items":[...]}. Never also supply args.
    #[serde(default)]
    pub args_json: Option<String>,
    /// Finite configured-check case for a pinned graph: id, requiredCheckNodes, optional expectedSkippedNodes. Verdicts come only from actual checks.
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
