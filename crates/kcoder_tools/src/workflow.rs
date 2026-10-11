use crate::{
    AgentRunOptions, AgentRunner, Tool, ToolContext, ToolError, ToolOutput, clean_schema,
    parse_input,
};
use async_trait::async_trait;
use kcoder_state::{Task, TaskKind, TaskStatus};
use kcoder_workflow::{
    AgentExecutor, AgentRequest, EventSink, WorkflowError, WorkflowEvent, WorkflowRuntime,
    WorkflowRuntimeConfig,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio_util::sync::CancellationToken;

/// Coordination tools may await/cancel other executions and must not hold their gate.
pub fn coordinates_execution(name: &str) -> bool {
    matches!(
        name,
        "Workflow"
            | "WorkflowDraft"
            | "spawn_agent"
            | "explore_agent"
            | "close_agent"
            | "SendMessage"
            | "wait"
            | "TaskOutput"
            | "TaskStop"
            | "TaskGet"
            | "TaskList"
            | "AskUserQuestion"
            | "EnterPlanMode"
            | "ExitPlanMode"
            | "create_goal"
            | "update_goal"
            | "get_goal"
            | "Agent"
            | "Task"
            | "Sleep"
            | "task_output"
            | "task_stop"
    )
}

const DEFAULT_MAX_CONCURRENCY: usize = 4;
const MAX_WORKFLOW_CONCURRENCY: usize = 4;
const DEFAULT_AGENT_MAX_TURNS: usize = 60;
const MAX_AGENT_MAX_TURNS: usize = 100;
const MAX_SCRIPT_BYTES: usize = 256 * 1024;
const DEFAULT_TIMEOUT_SECONDS: u64 = 30 * 60;
const MAX_TIMEOUT_SECONDS: u64 = 24 * 60 * 60;
const JOURNAL_EVENT_BATCH: usize = 32;

fn default_agent_max_turns() -> usize {
    DEFAULT_AGENT_MAX_TURNS
}

fn default_timeout_seconds() -> u64 {
    DEFAULT_TIMEOUT_SECONDS
}

#[derive(Clone, Copy)]
struct WorkflowRunLimits {
    max_concurrency: usize,
    max_agent_turns: usize,
    timeout_seconds: u64,
    unresolved_execution_limits: u8,
}

impl Default for WorkflowRunLimits {
    fn default() -> Self {
        Self {
            max_concurrency: DEFAULT_MAX_CONCURRENCY,
            max_agent_turns: DEFAULT_AGENT_MAX_TURNS,
            timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
            unresolved_execution_limits: 0,
        }
    }
}

static NEXT_ARTIFACT_WRITE_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Default)]
pub struct WorkflowTool;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkflowRunState {
    run_id: String,
    name: String,
    status: String,
    source: String,
    #[serde(default)]
    definition_sha256: Option<String>,
    script_path: PathBuf,
    args_path: PathBuf,
    journal_path: PathBuf,
    output_path: PathBuf,
    started_at_ms: u64,
    updated_at_ms: u64,
    max_concurrency: usize,
    #[serde(default = "default_agent_max_turns")]
    max_agent_turns: usize,
    #[serde(default = "default_timeout_seconds")]
    timeout_seconds: u64,
    #[serde(default)]
    unresolved_execution_limits: u8,
    agent_started: usize,
    agent_completed: usize,
    agent_failed: usize,
    #[serde(default)]
    agent_reused: usize,
    event_count: usize,
    #[serde(default)]
    resume_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reuse_from_run: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    checkpoint_format: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

struct WorkflowRunStore {
    run_dir: PathBuf,
    state_path: PathBuf,
    state: Mutex<WorkflowRunState>,
    events: Mutex<()>,
    io: Mutex<()>,
    journal_buffer: Mutex<Vec<u8>>,
    observation: Mutex<Option<crate::workflow_runs::RunObservation>>,
    verification: Mutex<
        Option<(
            kcoder_workflow::store::WorkflowStore,
            kcoder_workflow::store::RuntimeVerification,
            kcoder_types::workflow::WorkflowDefinition,
        )>,
    >,
}

struct ResumeRollback {
    state: WorkflowRunState,
    args: Vec<u8>,
}

struct ResumeLease {
    _file: fs::File,
}

struct ToolAgentExecutor {
    require_checkpoint_match: bool,
    require_legacy_agent_request: bool,
    verification_store: Option<Arc<WorkflowRunStore>>,
    isolate_context: bool,
    runner: Arc<dyn AgentRunner>,
    arrangement_mode: bool,
    resume_run_dir: Option<PathBuf>,
    checkpoint_run_dir: Option<PathBuf>,
    tool_run_dir: Option<PathBuf>,
    library_root: Option<PathBuf>,
    wait_root: Option<PathBuf>,
    run_id: String,
    cancellation: CancellationToken,
}

#[async_trait]
impl Tool for WorkflowTool {
    fn name(&self) -> String {
        "Workflow".to_string()
    }

    fn description(&self) -> String {
        "Run a deterministic JavaScript workflow or an explicitly published library definition_id and version in an embedded QuickJS runtime. Execution, including validation runs after generation, requires an explicit user request. If the user requested only authoring/saving, proactively ask whether they want execution verification and wait for an affirmative answer. An existing request to generate and test is sufficient; do not seek duplicate confirmation. Once authorized, verify results and artifacts against the agreed criteria, fix failed nodes and retest corrected saved versions rather than stopping at schema validation. Static authoring checks do not authorize starting a run, agent calls or external side effects. Scripts may use agent(), parallel(), pipeline(), phase(), workflow(), log(), and args. Agent calls use real KCoder sub-agents; the workflow runs in the background and persists script, arguments, state, journal, per-agent output, and final output under the current session. Prefer args_json containing complete serialized JSON for arrays and nested objects; it preserves explicit JSON types. Native args remains supported, but never supply both. A root array is args itself; to access args.items pass an object with an items array. Do not add item wrappers or change whitespace to work around transport corruption. Use a saved input_schema to reject wrong types before execution; without a schema KCoder cannot infer whether an arbitrary item object was intended. Saved graph arguments are checked before creating a run; needs_input means no task or agent was started. Ask concise questions for the missing/invalid information, retain supplied values, then retry the same version. For an existing failed/interrupted/cancelled run, inspect its status/error and prefer Workflow({resume: run_id}) over creating a new run. Keep the original arguments unless a correction is required. Resume reuses successful checkpoints for every node kind when its execution semantics, all upstream nodes, effective inputs and run configuration match; unfinished and affected nodes rerun. For a changed workflow, save the new version and call Workflow({definition_id, version, reuse_from_run: old_run_id}) to create a new run retaining the old history and reusing its unchanged dependency-closed prefix. Supply an explicit source run and saved target version; never guess the version or automatically choose a source. Result checks run again on reused outputs. Legacy JavaScript resumes still reuse matching Agent outputs. This is node-level recovery and cannot guarantee exactly-once external effects. Never blindly replay an unknown side effect; direct-tool receipts with unknown outcomes block recovery until inspected. Inspect the persisted run status and result before waiting again. completed means execution ended; only configured result checks can provide machine verification. Inspect verification.status and checkedNodes in the graph output, and verify required artifacts before claiming the task is correct. For an explicitly authorized finite verification case on a pinned graph, optionally supply verification_scenario (or its lossless JSON text alternative) with an ASCII id, requiredCheckNodes and optional exact expectedSkippedNodes. Do not supply a verdict/status. Script sources reject named cases. Declared scenario coverage is separate from configured checks and full-graph claims; no scenario means unrecorded. Each resumed input/case owns a distinct artifact attempt, preserving old evidence. No Bun or Node installation is required."
            .to_string()
    }

    async fn description_for_model(
        &self,
        _input: Option<&Value>,
        ctx: &crate::ToolDescriptionContext,
    ) -> String {
        let mut description = self.description();
        if ctx.available_tools.contains("TaskOutput") {
            description.push_str(" Use TaskOutput to inspect background results.");
        }
        description
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        let mut schema = clean_schema(schemars::schema_for!(WorkflowInput));
        let choices = Value::Array(["definition_id", "resume", "script", "name", "script_path"].iter().map(|field| {
            let mut branch = json!({"type":"object","required":[field],"properties":{*field:{"type":"string","minLength":1}}});
            if *field == "definition_id" {
                branch["required"] = json!(["definition_id","version"]);
                branch["properties"]["version"] = json!({"type":"integer","minimum":1});
            } else {
                branch["properties"]["version"] = json!({"type":"null"});
            }
            branch
        }).collect());
        schema["allOf"] = json!([{"oneOf":choices}]);
        schema["not"] = json!({"anyOf":[{"required":["args","args_json"]},{"required":["verification_scenario","verification_scenario_json"]}]});
        schema["allOf"].as_array_mut().unwrap().push(json!({"if":{"required":["reuse_from_run"],"properties":{"reuse_from_run":{"type":"string"}}},"then":{"required":["definition_id","version"],"not":{"required":["resume"]}}}));
        let node_id =
            json!({"type":"string","minLength":1,"maxLength":64,"pattern":"^[A-Za-z0-9_-]+$"});
        schema["properties"]["verification_scenario"] = json!({"type":["object","null"],"description":"Explicit declared configured-check case for a pinned graph only; not execution consent or a model verdict.","additionalProperties":false,"properties":{"id":node_id,"requiredCheckNodes":{"type":"array","minItems":1,"maxItems":64,"uniqueItems":true,"items":node_id},"expectedSkippedNodes":{"type":["array","null"],"maxItems":64,"uniqueItems":true,"items":node_id}},"required":["id","requiredCheckNodes"]});
        schema["properties"]["verification_scenario_json"]["maxLength"] = json!(16384);
        schema["allOf"].as_array_mut().unwrap().push(json!({"if":{"anyOf":[{"required":["verification_scenario"],"properties":{"verification_scenario":{"type":"object"}}},{"required":["verification_scenario_json"],"properties":{"verification_scenario_json":{"type":"string"}}}]},"then":{"anyOf":[{"required":["definition_id"]},{"required":["resume"]}]}}));
        schema
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }
        if input.get("args").is_some() && input.get("args_json").is_some() {
            return Err(ToolError::InvalidInput(
                "args and args_json are mutually exclusive".into(),
            ));
        }
        let supplied_arguments = input.get("args").is_some() || input.get("args_json").is_some();
        if input.get("verification_scenario").is_some()
            && input.get("verification_scenario_json").is_some()
        {
            return Err(ToolError::InvalidInput(
                "verification_scenario and verification_scenario_json are mutually exclusive"
                    .into(),
            ));
        }
        let mut input: WorkflowInput = parse_input(&input).map_err(|error| match error {
            ToolError::InvalidInput(message) if message.contains("unknown field") => {
                ToolError::InvalidInput(format!(
                    "{message}. Workflow inputs belong inside args, not at the top level. If nested fields were flattened by the provider, omit args and use args_json containing serialized JSON for all workflow inputs. Keep definition_id and version at the top level; do not repeat the same flattened call."
                ))
            }
            other => other,
        })?;
        let selectors = usize::from(input.definition_id.is_some())
            + usize::from(input.resume.is_some())
            + usize::from(input.script.is_some())
            + usize::from(input.name.is_some())
            + usize::from(input.script_path.is_some());
        if selectors != 1 {
            return Err(ToolError::InvalidInput("Select exactly one workflow source: {definition_id, version} for a saved graph, {resume} for an existing run, or one of script/name/script_path. args/args_json only supply inputs; they do not select a workflow. For a saved graph use {\"definition_id\":\"<saved-id>\",\"version\":1,\"args_json\":\"{}\"}.".into()));
        }
        if input.reuse_from_run.is_some() && input.definition_id.is_none() {
            return Err(ToolError::InvalidInput("reuse_from_run requires definition_id and an explicit saved version; it cannot be combined with resume or scripts".into()));
        }
        let lossless_arguments = input.args_json.is_some();
        if let Some(text) = input.args_json.take() {
            if text.len() > 128 * 1024 {
                return Err(ToolError::InvalidInput("args_json exceeds 128 KiB".into()));
            }
            input.args = serde_json::from_str(&text)
                .map_err(|error| ToolError::InvalidInput(format!("args_json: {error}")))?;
        }
        let scenario = verification::decode_scenario(
            input.verification_scenario.take(),
            input.verification_scenario_json.take(),
        )?;
        if scenario.is_some() && input.definition_id.is_none() && input.resume.is_none() {
            return Err(ToolError::InvalidInput("verification_scenario requires a pinned definition graph; inline/named/file scripts are unsupported".into()));
        }
        let session_cap = ctx
            .max_concurrent_subagents
            .unwrap_or(MAX_WORKFLOW_CONCURRENCY)
            .clamp(1, MAX_WORKFLOW_CONCURRENCY);
        let mut max_agent_turns = input
            .max_agent_turns
            .unwrap_or(DEFAULT_AGENT_MAX_TURNS)
            .clamp(1, MAX_AGENT_MAX_TURNS);
        let mut timeout_seconds = input
            .timeout_seconds
            .unwrap_or(DEFAULT_TIMEOUT_SECONDS)
            .clamp(1, MAX_TIMEOUT_SECONDS);
        let resume_id = input
            .resume
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let mut pinned_definition = None;
        let mut checkpoint_run_dir = None;
        let mut reuse_source_lease = None;
        let mut source_concurrency = None;
        let omitted_limits = u8::from(input.max_agent_turns.is_none())
            | (u8::from(input.timeout_seconds.is_none()) << 1);
        let mut unresolved_execution_limits = 0;
        let (run_id, script, name, workflow_args, store, max_concurrency, is_resume, resume_lease) =
            if let Some(run_id) = resume_id {
                if input.script.is_some()
                    || input.name.is_some()
                    || input.script_path.is_some()
                    || input.definition_id.is_some()
                    || input.version.is_some()
                {
                    return Err(ToolError::InvalidInput(
                        "resume cannot be combined with script, name, script_path, definition_id, or version".to_string(),
                    ));
                }
                validate_workflow_run_id(run_id)?;
                if ctx.background_job_is_running(run_id) {
                    return Err(ToolError::InvalidInput(format!(
                        "workflow {run_id} is already running"
                    )));
                }
                let run_dir = workflow_run_dir(ctx, run_id);
                let resume_lease = acquire_resume_lease(&run_dir).await?;
                let args_override = supplied_arguments.then_some(&input.args);
                let store = WorkflowRunStore::open_for_resume(run_dir)?;
                let definition_path = store.run_dir.join("definition.json");
                match secure_read_file(&definition_path, 128 * 1024) {
                    Ok(bytes) => {
                        use sha2::Digest;
                        let expected = store
                            .state
                            .lock()
                            .unwrap()
                            .definition_sha256
                            .clone()
                            .ok_or_else(|| {
                                ToolError::Execution(
                                    "workflow_corrupt: unbound graph snapshot".into(),
                                )
                            })?;
                        if format!("{:x}", sha2::Sha256::digest(&bytes)) != expected {
                            return Err(ToolError::Execution(
                                "workflow_corrupt: pinned graph checksum changed".into(),
                            ));
                        }
                        pinned_definition = Some(
                            serde_json::from_slice::<kcoder_types::workflow::WorkflowDefinition>(
                                &bytes,
                            )
                            .map_err(|e| ToolError::Execution(e.to_string()))?,
                        );
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        if store.state.lock().unwrap().definition_sha256.is_some() {
                            return Err(ToolError::Execution(
                                "workflow_corrupt: pinned graph missing".into(),
                            ));
                        }
                    }
                    Err(error) => return Err(ToolError::Execution(error.to_string())),
                }
                if let Some(request) = &scenario {
                    let definition = pinned_definition.as_ref().ok_or_else(|| {
                        ToolError::InvalidInput(
                            "verification_scenario cannot resume an unpinned script".into(),
                        )
                    })?;
                    request
                        .validate(definition)
                        .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
                }
                let state = store.state.lock().unwrap().clone();
                unresolved_execution_limits = state.unresolved_execution_limits & omitted_limits;
                max_agent_turns = input
                    .max_agent_turns
                    .unwrap_or(state.max_agent_turns)
                    .clamp(1, MAX_AGENT_MAX_TURNS);
                timeout_seconds = input
                    .timeout_seconds
                    .unwrap_or(state.timeout_seconds)
                    .clamp(1, MAX_TIMEOUT_SECONDS);
                if ctx.state.task(run_id).is_none() {
                    let mut task = Task::new(run_id, format!("Workflow: {}", state.name));
                    task.kind = TaskKind::Workflow;
                    task.status = TaskStatus::Failed;
                    task.output_path = Some(state.output_path.clone());
                    ctx.state.upsert_task(task);
                }
                let script = String::from_utf8(
                    secure_read_file(&state.script_path, MAX_SCRIPT_BYTES).map_err(|error| {
                        ToolError::Execution(format!(
                            "failed to read workflow script `{}`: {error}",
                            state.script_path.display()
                        ))
                    })?,
                )
                .map_err(|error| {
                    ToolError::Execution(format!("workflow script is not UTF-8: {error}"))
                })?;
                let workflow_args = if let Some(args) = args_override {
                    args.clone()
                } else {
                    let bytes =
                        secure_read_file(&state.args_path, MAX_SCRIPT_BYTES).map_err(|error| {
                            ToolError::Execution(format!(
                                "failed to read workflow args `{}`: {error}",
                                state.args_path.display()
                            ))
                        })?;
                    serde_json::from_slice(&bytes).map_err(|error| {
                        ToolError::Execution(format!("failed to parse workflow args: {error}"))
                    })?
                };
                let max_concurrency = input
                    .max_concurrency
                    .unwrap_or(state.max_concurrency)
                    .clamp(1, MAX_WORKFLOW_CONCURRENCY)
                    .min(session_cap);
                (
                    run_id.to_string(),
                    script,
                    state.name,
                    workflow_args,
                    store,
                    max_concurrency,
                    true,
                    Some(resume_lease),
                )
            } else {
                let (script, name, source) = if let Some(id) = &input.definition_id {
                    if input.script.is_some() || input.name.is_some() || input.script_path.is_some()
                    {
                        return Err(ToolError::InvalidInput(
                            "definition_id cannot be combined with JavaScript sources".into(),
                        ));
                    }
                    let version = input.version.ok_or_else(|| {
                        ToolError::InvalidInput(
                            "definition_id requires an explicit published version".into(),
                        )
                    })?;
                    let library = kcoder_workflow::store::WorkflowStore::new(
                        crate::workflow_draft::library_root(ctx)?,
                    );
                    let definition = library
                        .read_saved(id, Some(version))
                        .map_err(|error| ToolError::Execution(error.to_string()))?;
                    if let Some(source_run) = &input.reuse_from_run {
                        let source_run = source_run.trim();
                        validate_workflow_run_id(source_run)?;
                        if ctx.background_job_is_running(source_run) {
                            return Err(ToolError::InvalidInput(
                                "reuse_from_run must reference a finished or interrupted run"
                                    .into(),
                            ));
                        }
                        let directory = workflow_run_dir(ctx, source_run);
                        reuse_source_lease = Some(acquire_resume_lease(&directory).await?);
                        let source_state =
                            checkpoints::validate_source(&directory, &definition.id)?;
                        source_concurrency = Some(source_state.max_concurrency);
                        unresolved_execution_limits =
                            source_state.unresolved_execution_limits & omitted_limits;
                        max_agent_turns = input
                            .max_agent_turns
                            .unwrap_or(source_state.max_agent_turns)
                            .clamp(1, MAX_AGENT_MAX_TURNS);
                        timeout_seconds = input
                            .timeout_seconds
                            .unwrap_or(source_state.timeout_seconds)
                            .clamp(1, MAX_TIMEOUT_SECONDS);
                        if !supplied_arguments {
                            input.args = serde_json::from_slice(
                                &secure_read_file(&directory.join("args.json"), MAX_SCRIPT_BYTES)
                                    .map_err(|e| ToolError::Execution(e.to_string()))?,
                            )
                            .map_err(|e| ToolError::Execution(e.to_string()))?;
                        }
                        checkpoint_run_dir = Some(directory);
                    }
                    crate::workflow_draft::validate_workflow_agent_types(&definition)?;
                    kcoder_workflow::graph::validate(&definition, true)
                        .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
                    let coercion_options = if let Some(settings) = &ctx.runtime_settings {
                        let settings = settings.read().map_err(|_| {
                            ToolError::Execution("Workflow settings lock is poisoned".into())
                        })?;
                        crate::CoercionOptions::from(&settings.tools.coerce)
                    } else {
                        crate::CoercionOptions::default()
                    };
                    match prepare_supplied_arguments(
                        &definition,
                        &mut input.args,
                        &coercion_options,
                        lossless_arguments,
                    ) {
                        Ok(args) => input.args = args,
                        Err(error) => {
                            let schema = definition.input_schema.as_ref();
                            let required = schema
                                .and_then(|s| s.get("required"))
                                .and_then(Value::as_array);
                            let missing = required.into_iter().flatten().filter_map(Value::as_str)
                            .filter(|name| input.args.get(*name).is_none() && schema.and_then(|s| s.get("properties")).and_then(|p| p.get(*name)).and_then(|p|p.get("default")).is_none())
                            .take(32).map(|name| {
                                let field = schema.and_then(|s|s.get("properties")).and_then(|p|p.get(name));
                                json!({"name":name,"title":field.and_then(|p|p.get("title")),"description":field.and_then(|p|p.get("description"))})
                            }).collect::<Vec<_>>();
                            return Ok(ToolOutput::text(json!({
                            "status":"needs_input", "definition_id":id, "version":version,
                            "missing_fields":missing,
                            "validation_error":error.to_string().chars().take(2048).collect::<String>(),
                            "next_action":"No run or agent was started. First correct the tool args using values already supplied in the user request and the saved input schema; do not ask the user to resend known values or approve reading the schema. Ask only for genuinely missing information. Retry this same definition_id and version with corrected args_json containing the complete JSON input. Preserve declared JSON types and nesting. Use the specific validation path and expected type; do not invent values or require the user to write JSON."
                        }).to_string()));
                        }
                    }
                    if let Some(request) = &scenario {
                        request
                            .validate(&definition)
                            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
                    }
                    pinned_definition = Some(definition.clone());
                    let script =
                        "// Executed by the pinned declarative graph runtime; see definition.json"
                            .to_string();
                    (
                        script,
                        definition.title,
                        format!("definition:{id}@{version}"),
                    )
                } else {
                    if input.version.is_some() {
                        return Err(ToolError::InvalidInput(
                            "version requires definition_id".into(),
                        ));
                    }
                    resolve_script(&input, &ctx.state.cwd()).await?
                };
                let run_id = generate_workflow_id();
                let max_concurrency = input
                    .max_concurrency
                    .or(source_concurrency)
                    .unwrap_or(DEFAULT_MAX_CONCURRENCY)
                    .clamp(1, MAX_WORKFLOW_CONCURRENCY)
                    .min(session_cap);
                let store = WorkflowRunStore::create(
                    workflow_run_dir(ctx, &run_id),
                    run_id.clone(),
                    name.clone(),
                    source,
                    &script,
                    &input.args,
                    WorkflowRunLimits {
                        max_concurrency,
                        max_agent_turns,
                        timeout_seconds,
                        unresolved_execution_limits,
                    },
                )?;
                if let Some(definition) = &pinned_definition {
                    use sha2::Digest;
                    let bytes = serde_json::to_vec(definition)
                        .map_err(|e| ToolError::Execution(e.to_string()))?;
                    atomic_write_file(&store.run_dir.join("definition.json"), &bytes)
                        .map_err(|e| ToolError::Execution(e.to_string()))?;
                    store.state.lock().unwrap().definition_sha256 =
                        Some(format!("{:x}", sha2::Sha256::digest(&bytes)));
                    store.state.lock().unwrap().reuse_from_run = input.reuse_from_run.clone();
                    store.state.lock().unwrap().checkpoint_format = Some(1);
                    store.persist_state()?;
                    if let Some(source_run) = &input.reuse_from_run {
                        store.append_json(&json!({"type":"workflow_checkpoint_source","timestamp_ms":now_millis(),"source_run_id":source_run,"definition_id":definition.id,"version":definition.saved_version}))?;
                    }
                }
                // Hold the same lease the resume path takes. On supported
                // platforms a conflict must abort the initial caller: ignoring
                // it would allow a process that won the resume race and this
                // initial run to execute the same workflow concurrently.
                let initial_lease =
                    acquire_initial_resume_lease(&workflow_run_dir(ctx, &run_id)).await?;
                (
                    run_id,
                    script,
                    name,
                    input.args.clone(),
                    store,
                    max_concurrency,
                    false,
                    initial_lease,
                )
            };
        if script.len() > MAX_SCRIPT_BYTES {
            return Err(ToolError::InvalidInput(format!(
                "workflow script is too large ({} bytes; maximum {MAX_SCRIPT_BYTES} bytes)",
                script.len()
            )));
        }
        let runner = ctx
            .agent_runner
            .as_ref()
            .cloned()
            .ok_or_else(|| ToolError::Execution("agent runner not available".to_string()))?;
        if let Some(definition) = &pinned_definition
            && is_resume
        {
            checkpoint_run_dir = Some(store.run_dir.clone());
            let reuse_source = store.state.lock().unwrap().reuse_from_run.clone();
            if let Some(source) = reuse_source {
                validate_workflow_run_id(&source)?;
                if source == run_id {
                    return Err(ToolError::Execution(
                        "workflow_corrupt: checkpoint source refers to itself".into(),
                    ));
                }
                let directory = workflow_run_dir(ctx, &source);
                reuse_source_lease = Some(acquire_resume_lease(&directory).await?);
                if checkpoints::validated_source(&directory, &definition.id)?.is_some() {
                    checkpoint_run_dir = Some(directory);
                }
            }
            checkpoints::ensure_effects_known(&store.run_dir)
                .map_err(|error| ToolError::Execution(format!("{error:#}")))?;
        }
        let checkpoint_context = checkpoints::configuration(ctx)?;
        let legacy_node_identities =
            is_resume && store.state.lock().unwrap().checkpoint_format.is_none();

        if let Some(definition) = &pinned_definition {
            let version = definition.saved_version.ok_or_else(|| {
                ToolError::Execution("workflow_corrupt: pinned definition is not published".into())
            })?;
            if store.state.lock().unwrap().source
                != format!("definition:{}@{}", definition.id, version)
            {
                return Err(ToolError::Execution(
                    "workflow_corrupt: pinned definition identity changed".into(),
                ));
            }
        }
        if let Some(profile) = ctx
            .settings_persistence_path
            .as_deref()
            .and_then(Path::parent)
        {
            let current = store.state.lock().unwrap().clone();
            let observation = crate::workflow_runs::RunObservation::start(
                profile.join("workflow-runs"),
                kcoder_types::workflow_runs::WorkflowRunSnapshot {
                    revision: 1,
                    run_id: run_id.clone(),
                    definition_id: pinned_definition.as_ref().map(|d| d.id.clone()),
                    version: pinned_definition.as_ref().and_then(|d| d.saved_version),
                    thread_id: ctx.state.session_id(),
                    workspace: ctx.state.cwd().to_string_lossy().into(),
                    status: "running".into(),
                    error: None,
                    started_at_ms: current.started_at_ms,
                    updated_at_ms: now_millis(),
                    resume_count: current
                        .resume_count
                        .saturating_add(usize::from(is_resume))
                        .min(u32::MAX as usize) as u32,
                    interaction_modified: false,
                    node_states: pinned_definition
                        .as_ref()
                        .map(|d| {
                            d.nodes
                                .iter()
                                .map(|node| kcoder_types::workflow_runs::WorkflowNodeRun {
                                    node_id: node.id.clone(),
                                    status: "pending".into(),
                                    iteration: None,
                                    iteration_status: None,
                                    attempt: 0,
                                    started_at_ms: None,
                                    finished_at_ms: None,
                                    agent_id: None,
                                    reused: false,
                                    output_preview: None,
                                    error: None,
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                },
            )
            .map_err(|e| ToolError::Execution(e.to_string()))?;
            *store.observation.lock().unwrap() = Some(observation);
        }
        let resume_rollback = if is_resume {
            Some(store.begin_resume(
                &workflow_args,
                WorkflowRunLimits {
                    max_concurrency,
                    max_agent_turns,
                    timeout_seconds,
                    unresolved_execution_limits,
                },
            )?)
        } else {
            None
        };

        if let Some(definition) = &pinned_definition {
            let configured = store
                .configure_verification(ctx, definition, &workflow_args)
                .and_then(|_| match scenario {
                    Some(request) => store.configure_verification_scenario(request),
                    None => Ok(()),
                });
            if let Err(error) = configured {
                if let Some(rollback) = resume_rollback {
                    let _ = store.finish_verification(&json!({"status":"not_started"}));
                    store.rollback_resume(rollback)?;
                } else {
                    let _ = store.finish(Err(format!("workflow_not_started: {error}")));
                }
                return Err(error);
            }
        }
        let output_path = store.output_path();
        let state_path = store.state_path.clone();
        let journal_path = store.state.lock().unwrap().journal_path.clone();
        let workflow_id = run_id.clone();
        let description = input
            .description
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("Workflow: {name}"));
        let workflow_id_for_result = workflow_id.clone();
        let definition_reference = pinned_definition.as_ref().map(|definition| {
            (
                definition.id.clone(),
                definition.saved_version,
                definition.title.clone(),
            )
        });
        let workflow_cancel = ctx
            .abort_token
            .as_ref()
            .map(CancellationToken::child_token)
            .unwrap_or_default();
        let executor: Arc<dyn AgentExecutor> = Arc::new(ToolAgentExecutor {
            require_checkpoint_match: unresolved_execution_limits != 0
                && pinned_definition.is_some()
                && store.state.lock().unwrap().checkpoint_format == Some(1),
            require_legacy_agent_request: unresolved_execution_limits != 0
                && is_resume
                && (pinned_definition.is_none() || legacy_node_identities),
            verification_store: Some(store.clone()),
            isolate_context: pinned_definition.is_some(),
            runner,
            arrangement_mode: ctx.arrangement_mode,
            resume_run_dir: (is_resume && (pinned_definition.is_none() || legacy_node_identities))
                .then(|| store.run_dir.clone()),
            checkpoint_run_dir,
            tool_run_dir: Some(store.run_dir.clone()),
            run_id: run_id.clone(),
            wait_root: ctx
                .settings_persistence_path
                .as_ref()
                .and_then(|path| path.parent())
                .map(|path| path.join("workflow-runs")),
            library_root: ctx
                .settings_persistence_path
                .as_ref()
                .and_then(|path| path.parent())
                .map(|path| path.join("workflow-library")),
            cancellation: workflow_cancel.clone(),
        });
        let sink: Arc<dyn EventSink> = store.clone();
        let run_store = store.clone();
        let workflow_task_state = ctx.state.clone();
        let cancel_store = store.clone();
        let cancel_token = workflow_cancel.clone();
        let cancel: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            cancel_token.cancel();
            if let Err(error) = cancel_store.cancel() {
                tracing::warn!(%error, "failed to persist workflow cancellation");
            }
        });
        let future = async move {
            // A process-wide advisory lease closes the gap between mutating
            // resume state and publishing the background handle. It remains
            // held for the complete resumed attempt.
            let _resume_lease = resume_lease;
            let _reuse_source_lease = reuse_source_lease;
            // Fan out every runtime exit (including quota failure or dropped future)
            // to the host-side agents and tools sharing this workflow token.
            let _cancel_on_exit = workflow_cancel.clone().drop_guard();
            let config = WorkflowRuntimeConfig {
                checkpoint_context,
                legacy_node_identities,
                agent_id_prefix: workflow_id_for_result.clone(),
                max_concurrency,
                default_agent_max_turns: max_agent_turns,
                max_agent_max_turns: MAX_AGENT_MAX_TURNS,
                max_script_bytes: MAX_SCRIPT_BYTES,
                max_runtime_millis: timeout_seconds.saturating_mul(1000),
                cancellation_token: workflow_cancel,
                ..WorkflowRuntimeConfig::default()
            };
            let result = if let Some(definition) = pinned_definition {
                WorkflowRuntime::execute_definition(
                    &definition,
                    workflow_args,
                    executor,
                    sink,
                    config,
                )
                .await
            } else {
                WorkflowRuntime::execute(&script, workflow_args, executor, sink, config).await
            };
            finish_workflow_result(
                &run_store,
                &workflow_task_state,
                &workflow_id_for_result,
                result,
            )
        };
        let spawn_result = if is_resume {
            ctx.respawn_cancellable_workflow_background(
                workflow_id,
                description.clone(),
                future,
                cancel,
            )
        } else {
            ctx.spawn_cancellable_workflow_background_with_id(
                workflow_id,
                description.clone(),
                future,
                cancel,
            )
        };
        if let Err(error) = spawn_result {
            if is_resume {
                let _ = store.finish_verification(&json!({"status":"not_started"}));
            }
            if !is_resume {
                let _ = store.finish(Err(format!("workflow_not_started: {error}")));
            }
            if let Some(rollback) = resume_rollback
                && let Err(rollback_error) = store.rollback_resume(rollback)
            {
                tracing::error!(%rollback_error, "failed to roll back workflow resume");
            }
            return Err(error);
        }
        if let Some(mut task) = ctx.state.task(&run_id) {
            task.output_path = Some(output_path.clone());
            ctx.state.upsert_task(task);
        }

        Ok(ToolOutput::text(
            json!({
                "run_id": run_id,
                "status": "running",
                "resumed": is_resume,
                "reuse_from_run": input.reuse_from_run,
                "definition_id": definition_reference.as_ref().map(|reference| &reference.0),
                "version": definition_reference.as_ref().and_then(|reference| reference.1),
                "title": definition_reference.as_ref().map(|reference| &reference.2),
                "description": description,
                "state_file": state_path,
                "journal_file": journal_path,
                "output_file": output_path,
                "max_concurrency": max_concurrency,
                "max_agent_turns": max_agent_turns,
                "execution_limits_unresolved": unresolved_execution_limits != 0,
                "timeout_seconds": timeout_seconds,
                "next_action": "The workflow is running in the background. Continue useful work; inspect it with /workflows or /workflow status <run_id>. A workflow notification will arrive when it finishes.",
            })
            .to_string(),
        ))
    }
}

async fn resolve_script(
    input: &WorkflowInput,
    cwd: &Path,
) -> Result<(String, String, String), ToolError> {
    let selected = usize::from(input.script.is_some())
        + usize::from(input.name.is_some())
        + usize::from(input.script_path.is_some());
    if selected != 1 {
        return Err(ToolError::InvalidInput(
            "provide exactly one of script, name, or script_path".to_string(),
        ));
    }
    if let Some(script) = &input.script {
        return Ok((script.clone(), "inline".to_string(), "inline".to_string()));
    }
    let (path, name, source) = if let Some(name) = &input.name {
        validate_workflow_name(name)?;
        (
            cwd.join(".kcoder")
                .join("workflows")
                .join(format!("{name}.js")),
            name.clone(),
            format!("named:{name}"),
        )
    } else {
        let requested = input.script_path.as_ref().expect("selected script_path");
        let path = if requested.is_absolute() {
            requested.clone()
        } else {
            cwd.join(requested)
        };
        ensure_workspace_path(&path, cwd)?;
        let name = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("workflow")
            .to_string();
        let source = format!("path:{}", path.display());
        (path, name, source)
    };
    ensure_workspace_path(&path, cwd)?;
    let script = securely_read_workspace_file(&path, cwd)?;
    Ok((script, name, source))
}

fn validate_workflow_name(name: &str) -> Result<(), ToolError> {
    if name.is_empty()
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err(ToolError::InvalidInput(
            "workflow name may contain only ASCII letters, digits, '-' and '_'".to_string(),
        ));
    }
    Ok(())
}

fn validate_workflow_run_id(run_id: &str) -> Result<(), ToolError> {
    if !run_id.starts_with("workflow-")
        || !run_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    {
        return Err(ToolError::InvalidInput(
            "invalid workflow run id".to_string(),
        ));
    }
    Ok(())
}

fn ensure_workspace_path(path: &Path, cwd: &Path) -> Result<(), ToolError> {
    let normalized = lexical_normalize(path);
    let root = lexical_normalize(cwd);
    if !crate::sandbox::path_starts_with(&normalized, &root) {
        return Err(ToolError::InvalidInput(format!(
            "workflow script_path must stay inside the session cwd `{}`",
            cwd.display()
        )));
    }
    if let (Ok(canonical_path), Ok(canonical_root)) = (path.canonicalize(), cwd.canonicalize())
        && !crate::sandbox::path_starts_with(&canonical_path, &canonical_root)
    {
        return Err(ToolError::InvalidInput(format!(
            "workflow script_path resolves outside the session cwd `{}`",
            cwd.display()
        )));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn securely_read_workspace_file(path: &Path, cwd: &Path) -> Result<String, ToolError> {
    use nix::fcntl::{OFlag, OpenHow, ResolveFlag, openat2};
    use std::fs::File;

    let root = lexical_normalize(cwd);
    let normalized = lexical_normalize(path);
    let relative = normalized.strip_prefix(&root).map_err(|_| {
        ToolError::InvalidInput("workflow script_path must stay inside the session cwd".to_string())
    })?;
    let dir = File::open(cwd).map_err(|error| {
        ToolError::Execution(format!(
            "failed to open workflow workspace `{}`: {error}",
            cwd.display()
        ))
    })?;
    let fd = openat2(
        &dir,
        relative,
        OpenHow::new()
            .flags(OFlag::O_RDONLY | OFlag::O_CLOEXEC)
            .resolve(ResolveFlag::RESOLVE_BENEATH | ResolveFlag::RESOLVE_NO_MAGICLINKS),
    )
    .map_err(|error| {
        ToolError::Execution(format!(
            "failed to securely open workflow script `{}`: {error}",
            path.display()
        ))
    })?;
    read_limited_script(File::from(fd), path)
}

#[cfg(not(target_os = "linux"))]
fn securely_read_workspace_file(path: &Path, cwd: &Path) -> Result<String, ToolError> {
    let canonical_root = cwd
        .canonicalize()
        .map_err(|error| ToolError::Execution(format!("failed to resolve session cwd: {error}")))?;
    let canonical_path = path.canonicalize().map_err(|error| {
        ToolError::Execution(format!("failed to resolve workflow script: {error}"))
    })?;
    if !crate::sandbox::path_starts_with(&canonical_path, &canonical_root) {
        return Err(ToolError::InvalidInput(
            "workflow script_path resolves outside the session cwd".to_string(),
        ));
    }
    let file = fs::File::open(&canonical_path).map_err(|error| {
        ToolError::Execution(format!("failed to open workflow script: {error}"))
    })?;
    read_limited_script(file, &canonical_path)
}

fn read_limited_script(mut file: fs::File, path: &Path) -> Result<String, ToolError> {
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take((MAX_SCRIPT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            ToolError::Execution(format!(
                "failed to read workflow script `{}`: {error}",
                path.display()
            ))
        })?;
    if bytes.len() > MAX_SCRIPT_BYTES {
        return Err(ToolError::InvalidInput(format!(
            "workflow script is too large (maximum {MAX_SCRIPT_BYTES} bytes)"
        )));
    }
    String::from_utf8(bytes).map_err(|error| {
        ToolError::InvalidInput(format!(
            "workflow script `{}` is not valid UTF-8: {error}",
            path.display()
        ))
    })
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                output.pop();
            }
            other => output.push(other.as_os_str()),
        }
    }
    output
}

fn workflow_run_dir(ctx: &ToolContext, run_id: &str) -> PathBuf {
    ctx.state
        .session_state_path()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| {
            kcoder_state::session_dir_path(
                ctx.state.cwd().join(".kcoder").join("projects"),
                &ctx.state.artifact_session_id(),
            )
        })
        .join("workflows")
        .join(kcoder_state::artifact_id_path_component(run_id))
}

fn generate_workflow_id() -> String {
    format!("workflow-{}", uuid::Uuid::new_v4())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(target_os = "linux")]
fn try_acquire_resume_lease(run_dir: &Path) -> Result<ResumeLease, ToolError> {
    use nix::fcntl::{OFlag, openat};
    use nix::sys::stat::Mode;
    use std::os::fd::AsRawFd;

    let parent = secure_open_dir(run_dir).map_err(|error| {
        ToolError::Execution(format!(
            "failed to open workflow run directory `{}`: {error}",
            run_dir.display()
        ))
    })?;
    let fd = openat(
        &parent,
        ".resume.lock",
        OFlag::O_RDWR | OFlag::O_CREAT | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
        Mode::S_IRUSR | Mode::S_IWUSR,
    )
    .map_err(nix_io_error)
    .map_err(|error| ToolError::Execution(format!("failed to open resume lease: {error}")))?;
    let file = fs::File::from(fd);
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        return Err(ToolError::InvalidInput(format!(
            "workflow resume is already being prepared or is running: {error}"
        )));
    }
    Ok(ResumeLease { _file: file })
}

#[cfg(windows)]
fn try_acquire_resume_lease(run_dir: &Path) -> Result<ResumeLease, ToolError> {
    use std::os::windows::fs::OpenOptionsExt;

    let path = run_dir.join(".resume.lock");
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        // A zero share mode gives this handle an exclusive Windows lease. The
        // lease is released automatically when ResumeLease drops the file.
        .share_mode(0)
        .open(&path)
        .map_err(|error| {
            ToolError::InvalidInput(format!(
                "workflow resume is already being prepared or is running: {error}"
            ))
        })?;
    Ok(ResumeLease { _file: file })
}

#[cfg(all(not(target_os = "linux"), not(windows)))]
fn try_acquire_resume_lease(_run_dir: &Path) -> Result<ResumeLease, ToolError> {
    Err(ToolError::Execution(
        "workflow resume locking is not supported on this platform".to_string(),
    ))
}

#[cfg(any(target_os = "linux", windows))]
async fn acquire_resume_lease(run_dir: &Path) -> Result<ResumeLease, ToolError> {
    const RETRY_COUNT: usize = 25;
    const RETRY_DELAY: Duration = Duration::from_millis(10);

    for attempt in 0..=RETRY_COUNT {
        match try_acquire_resume_lease(run_dir) {
            Ok(lease) => return Ok(lease),
            Err(ToolError::InvalidInput(_)) if attempt < RETRY_COUNT => {
                tokio::time::sleep(RETRY_DELAY).await;
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("bounded resume lease loop always returns")
}

#[cfg(all(not(target_os = "linux"), not(windows)))]
async fn acquire_resume_lease(run_dir: &Path) -> Result<ResumeLease, ToolError> {
    try_acquire_resume_lease(run_dir)
}

#[cfg(any(target_os = "linux", windows))]
async fn acquire_initial_resume_lease(run_dir: &Path) -> Result<Option<ResumeLease>, ToolError> {
    acquire_resume_lease(run_dir).await.map(Some)
}

#[cfg(all(not(target_os = "linux"), not(windows)))]
async fn acquire_initial_resume_lease(_run_dir: &Path) -> Result<Option<ResumeLease>, ToolError> {
    // Initial execution remains available on platforms where crash-resume
    // locking itself is unsupported.
    Ok(None)
}

#[cfg(not(target_os = "linux"))]
fn secure_reject_symlink_components(path: &Path) -> std::io::Result<()> {
    let absolute = absolute_lexical_path(path)?;
    let mut current = PathBuf::new();
    for component in absolute.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    format!(
                        "workflow artifact path contains a symbolic link: {}",
                        current.display()
                    ),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn atomic_write_file(path: &Path, bytes: impl AsRef<[u8]>) -> std::io::Result<()> {
    secure_reject_symlink_components(path.parent().unwrap_or_else(|| Path::new(".")))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("artifact");
    let temporary = path.with_file_name(format!(
        ".{file_name}.tmp-{}-{}",
        std::process::id(),
        NEXT_ARTIFACT_WRITE_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes.as_ref())?;
        file.sync_all()?;
        if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            fs::remove_file(path)?;
        }
        fs::rename(&temporary, path)?;
        sync_parent_directory(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(windows)]
fn sync_parent_directory(_path: &Path) -> std::io::Result<()> {
    // Windows does not allow directories to be opened with std::fs::File, and
    // the preceding rename is already the atomic publication point.
    Ok(())
}

#[cfg(all(not(target_os = "linux"), not(windows)))]
fn sync_parent_directory(path: &Path) -> std::io::Result<()> {
    fs::File::open(path.parent().unwrap_or_else(|| Path::new(".")))?.sync_all()
}

#[cfg(target_os = "linux")]
fn atomic_write_file(path: &Path, bytes: impl AsRef<[u8]>) -> std::io::Result<()> {
    use nix::fcntl::{OFlag, openat, renameat};
    use nix::sys::stat::Mode;

    let (parent, file_name) = secure_open_parent(path)?;
    let temporary = format!(
        ".{}.tmp-{}-{}",
        file_name.to_string_lossy(),
        std::process::id(),
        NEXT_ARTIFACT_WRITE_ID.fetch_add(1, Ordering::Relaxed)
    );
    let fd = openat(
        &parent,
        temporary.as_str(),
        OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
        Mode::S_IRUSR | Mode::S_IWUSR,
    )
    .map_err(nix_io_error)?;
    let mut file = fs::File::from(fd);
    let result = (|| {
        file.write_all(bytes.as_ref())?;
        file.sync_all()?;
        renameat(&parent, temporary.as_str(), &parent, file_name.as_os_str())
            .map_err(nix_io_error)?;
        parent.sync_all()
    })();
    if result.is_err() {
        use nix::unistd::{UnlinkatFlags, unlinkat};
        let _ = unlinkat(&parent, temporary.as_str(), UnlinkatFlags::NoRemoveDir);
    }
    result
}

#[cfg(target_os = "linux")]
fn secure_open_dir(path: &Path) -> std::io::Result<fs::File> {
    use nix::fcntl::{OFlag, OpenHow, ResolveFlag, openat2};

    let absolute = absolute_lexical_path(path)?;
    let relative = absolute
        .strip_prefix("/")
        .map_err(|_| std::io::Error::other("path is not absolute"))?;
    let root = fs::File::open("/")?;
    let fd = openat2(
        &root,
        relative,
        OpenHow::new()
            .flags(OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC)
            .resolve(ResolveFlag::RESOLVE_BENEATH | ResolveFlag::RESOLVE_NO_SYMLINKS),
    )
    .map_err(nix_io_error)?;
    Ok(fs::File::from(fd))
}

#[cfg(target_os = "linux")]
fn secure_open_parent(path: &Path) -> std::io::Result<(fs::File, std::ffi::OsString)> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("path has no parent"))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other("path has no file name"))?
        .to_os_string();
    Ok((secure_open_dir(parent)?, file_name))
}

#[cfg(target_os = "linux")]
fn secure_create_dir(path: &Path) -> std::io::Result<()> {
    use nix::errno::Errno;
    use nix::sys::stat::{Mode, mkdirat};

    if secure_open_dir(path).is_ok() {
        return Ok(());
    }
    let parent_path = path
        .parent()
        .ok_or_else(|| std::io::Error::other("directory has no parent"))?;
    secure_create_dir(parent_path)?;
    let parent = secure_open_dir(parent_path)?;
    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other("directory has no name"))?;
    match mkdirat(&parent, name, Mode::S_IRWXU) {
        Ok(()) | Err(Errno::EEXIST) => {
            secure_open_dir(path)?;
            parent.sync_all()?;
            Ok(())
        }
        Err(error) => Err(nix_io_error(error)),
    }
}

#[cfg(target_os = "linux")]
fn secure_create_new_dir(path: &Path) -> std::io::Result<()> {
    use nix::sys::stat::{Mode, mkdirat};

    let (parent, name) = secure_open_parent(path)?;
    mkdirat(&parent, name.as_os_str(), Mode::S_IRWXU).map_err(nix_io_error)?;
    secure_open_dir(path)?;
    parent.sync_all()?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn secure_create_new_dir(path: &Path) -> std::io::Result<()> {
    secure_reject_symlink_components(path.parent().unwrap_or_else(|| Path::new(".")))?;
    fs::create_dir(path)?;
    secure_reject_symlink_components(path)
}

#[cfg(not(target_os = "linux"))]
fn secure_create_dir(path: &Path) -> std::io::Result<()> {
    secure_reject_symlink_components(path)?;
    fs::create_dir_all(path)?;
    secure_reject_symlink_components(path)
}

#[cfg(target_os = "linux")]
fn secure_remove_file(path: &Path) -> std::io::Result<()> {
    use nix::errno::Errno;
    use nix::unistd::{UnlinkatFlags, unlinkat};

    let (parent, name) = secure_open_parent(path)?;
    match unlinkat(&parent, name.as_os_str(), UnlinkatFlags::NoRemoveDir) {
        Ok(()) => parent.sync_all(),
        Err(Errno::ENOENT) => Ok(()),
        Err(error) => Err(nix_io_error(error)),
    }
}

#[cfg(not(target_os = "linux"))]
fn secure_remove_file(path: &Path) -> std::io::Result<()> {
    secure_reject_symlink_components(path.parent().unwrap_or_else(|| Path::new(".")))?;
    match fs::remove_file(path) {
        Ok(()) => sync_parent_directory(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "linux")]
fn secure_read_file(path: &Path, maximum: usize) -> std::io::Result<Vec<u8>> {
    use nix::fcntl::{OFlag, OpenHow, ResolveFlag, openat2};

    let (parent, name) = secure_open_parent(path)?;
    let fd = openat2(
        &parent,
        name.as_os_str(),
        OpenHow::new()
            .flags(OFlag::O_RDONLY | OFlag::O_CLOEXEC)
            .resolve(ResolveFlag::RESOLVE_BENEATH | ResolveFlag::RESOLVE_NO_SYMLINKS),
    )
    .map_err(nix_io_error)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut fs::File::from(fd))
        .take((maximum + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(std::io::Error::other("file exceeds size limit"));
    }
    Ok(bytes)
}

#[cfg(not(target_os = "linux"))]
fn secure_read_file(path: &Path, maximum: usize) -> std::io::Result<Vec<u8>> {
    secure_reject_symlink_components(path)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut fs::File::open(path)?)
        .take((maximum + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(std::io::Error::other("file exceeds size limit"));
    }
    Ok(bytes)
}

#[cfg(target_os = "linux")]
fn secure_append_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use nix::fcntl::{OFlag, openat};
    use nix::sys::stat::Mode;

    let (parent, name) = secure_open_parent(path)?;
    let fd = openat(
        &parent,
        name.as_os_str(),
        OFlag::O_WRONLY | OFlag::O_APPEND | OFlag::O_CREAT | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
        Mode::S_IRUSR | Mode::S_IWUSR,
    )
    .map_err(nix_io_error)?;
    let mut file = fs::File::from(fd);
    file.write_all(bytes)?;
    file.sync_data()?;
    parent.sync_all()
}

#[cfg(not(target_os = "linux"))]
fn secure_append_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    secure_reject_symlink_components(path)?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_data()?;
    sync_parent_directory(path)
}

fn absolute_lexical_path(path: &Path) -> std::io::Result<PathBuf> {
    if path.is_absolute() {
        Ok(lexical_normalize(path))
    } else {
        Ok(lexical_normalize(&std::env::current_dir()?.join(path)))
    }
}

#[cfg(target_os = "linux")]
fn nix_io_error(error: nix::errno::Errno) -> std::io::Error {
    std::io::Error::from_raw_os_error(error as i32)
}

#[path = "workflow/checkpoints.rs"]
mod checkpoints;
#[path = "workflow/direct_tool.rs"]
mod direct_tool;
mod execution_adapter;
use execution_adapter::*;

mod run_store;
mod verification;
use run_store::*;

#[cfg(test)]
#[path = "workflow/tests.rs"]
mod tests;
