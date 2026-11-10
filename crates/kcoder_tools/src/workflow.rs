use crate::{AgentRunOptions, AgentRunner, Tool, ToolContext, ToolError, ToolOutput};
pub use kcoder_tool_input::builtin::workflow::WorkflowInput;
mod native_definition;
mod native_launch;
use async_trait::async_trait;
use kcoder_state::{Task, TaskKind, TaskStatus};
use kcoder_workflow::{
    AgentExecutor, AgentRequest, EventSink, WorkflowError, WorkflowEvent, WorkflowRuntime,
    WorkflowRuntimeConfig,
};
use kcoder_workflow_observations::run_files::{
    acquire_initial_resume_lease, acquire_resume_lease, atomic_write_file, lexical_normalize,
    secure_append_file, secure_create_dir, secure_create_new_dir, secure_read_file,
    secure_remove_file,
};
pub use native_definition::WorkflowNativeDefinition;
pub use native_launch::{WorkflowNativeLaunch, WorkflowNativeLaunchObserver};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, atomic::Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
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

#[derive(Debug, Default)]
pub struct WorkflowTool;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkflowRunState {
    run_id: String,
    name: String,
    status: String,
    source: String,
    #[serde(default)]
    definition_sha256: Option<String>,
    #[serde(default)]
    native_definition: bool,
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

struct ToolAgentExecutor {
    require_checkpoint_match: bool,
    require_legacy_agent_request: bool,
    verification_store: Option<Arc<WorkflowRunStore>>,
    isolate_context: bool,
    pinned_model: Option<kcoder_types::ModelConfigurationSummary>,
    native_parent_state: Option<kcoder_state::AppState>,
    collaboration_artifacts: Option<Arc<collaboration::NativeArtifacts>>,
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
        let mut schema = WorkflowInput::schema();
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
        let mut input: WorkflowInput = WorkflowInput::parse(&input).map_err(|error| match error {
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
        let lossless_arguments =
            input.args_json.is_some() || ctx.workflow_native_definition.is_some();
        if let Some(text) = input.args_json.take() {
            if text.len() > 128 * 1024 {
                return Err(ToolError::InvalidInput("args_json exceeds 128 KiB".into()));
            }
            input.args = serde_json::from_str(&text)
                .map_err(|error| ToolError::InvalidInput(format!("args_json: {error}")))?;
        }
        if let Some(definition) = &ctx.workflow_native_definition {
            if ctx.workflow_native_launch_observer.is_none() {
                return Err(ToolError::Execution(
                    "WORKFLOW_NATIVE_OWNER_UNAVAILABLE".into(),
                ));
            }
            definition.verify_call(&input)?;
            input.args = definition.arguments().clone();
        }
        let scenario = verification::decode_scenario(
            input.verification_scenario.take(),
            input.verification_scenario_json.take(),
        )?;
        if scenario.is_some() && input.definition_id.is_none() && input.resume.is_none() {
            return Err(ToolError::InvalidInput("verification_scenario requires a pinned definition graph; inline/named/file scripts are unsupported".into()));
        }
        let pinned_model = ctx
            .agent_runner
            .as_ref()
            .map(|runner| runner.workflow_model_configuration())
            .transpose()
            .map_err(|error| ToolError::Execution(error.to_string()))?
            .flatten();
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
                    let definition = if let Some(native) = &ctx.workflow_native_definition {
                        native.definition().clone()
                    } else {
                        let library = kcoder_workflow::store::WorkflowStore::new(
                            crate::workflow_draft::library_root(ctx)?,
                        );
                        library
                            .read_saved(id, Some(version))
                            .map_err(|error| ToolError::Execution(error.to_string()))?
                    };
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
                    store.state.lock().unwrap().native_definition =
                        ctx.workflow_native_definition.is_some();
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
        if let Some(observer) = &ctx.workflow_native_launch_observer {
            let observed = (|| {
                let definition = pinned_definition
                    .as_ref()
                    .filter(|_| !is_resume)
                    .ok_or_else(|| {
                        ToolError::InvalidInput(
                            "native workflow launch requires a new pinned definition".into(),
                        )
                    })?;
                let version = definition.saved_version.ok_or_else(|| {
                    ToolError::Execution("native workflow version is unavailable".into())
                })?;
                use sha2::Digest;
                let input_bytes = serde_json::to_vec(&workflow_args).map_err(|_| {
                    ToolError::Execution("native workflow inputs are invalid".into())
                })?;
                observer.before_dispatch(&WorkflowNativeLaunch {
                    run_id: run_id.clone(),
                    definition_id: definition.id.clone(),
                    version,
                    definition_sha256: kcoder_workflow::store::definition_fingerprint(definition)
                        .map_err(|_| {
                        ToolError::Execution("WORKFLOW_NATIVE_DEFINITION_INVALID".into())
                    })?,
                    inputs_sha256: format!("{:x}", sha2::Sha256::digest(input_bytes)),
                })
            })();
            if let Err(error) = observed {
                let _ = store.finish(Err(
                    "workflow_native_registration_failed: no workflow work was dispatched".into(),
                ));
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
        let collaboration_artifacts = pinned_definition
            .as_ref()
            .filter(|definition| {
                definition
                    .nodes
                    .iter()
                    .any(|node| node.config.collaboration_role.is_some())
            })
            .map(|definition| {
                let observations = ctx
                    .settings_persistence_path
                    .as_deref()
                    .and_then(Path::parent)
                    .ok_or_else(|| {
                        anyhow::anyhow!("workflow_artifact: native profile unavailable")
                    })?
                    .join("workflow-runs");
                collaboration::NativeArtifacts::new(
                    store.run_dir.clone(),
                    if is_resume {
                        Some(store.run_dir.clone())
                    } else {
                        checkpoint_run_dir.clone()
                    },
                    observations,
                    run_id.clone(),
                    definition.clone(),
                    &checkpoint_context,
                    ctx.state.clone(),
                )
                .map(Arc::new)
            })
            .transpose()
            .map_err(|error| ToolError::Execution(format!("{error:#}")))?;
        let executor: Arc<dyn AgentExecutor> = Arc::new(ToolAgentExecutor {
            require_checkpoint_match: unresolved_execution_limits != 0
                && pinned_definition.is_some()
                && store.state.lock().unwrap().checkpoint_format == Some(1),
            require_legacy_agent_request: unresolved_execution_limits != 0
                && is_resume
                && (pinned_definition.is_none() || legacy_node_identities),
            verification_store: Some(store.clone()),
            isolate_context: pinned_definition.is_some(),
            pinned_model,
            native_parent_state: Some(ctx.state.clone()),
            collaboration_artifacts,
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
        // Graph checkpoints reuse completed nodes; each resumed Agent needs a new task identity.
        // Legacy runs still reconcile their original Agent receipt paths.
        let agent_resume_attempt = if pinned_definition.is_some() && !legacy_node_identities {
            store.state.lock().unwrap().resume_count
        } else {
            0
        };
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
                agent_resume_attempt,
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

mod agent_recovery;
#[path = "workflow/checkpoints.rs"]
mod checkpoints;
#[path = "workflow/direct_tool.rs"]
mod direct_tool;
mod execution_adapter;
pub use agent_recovery::WorkflowAgentRecovery;
pub(crate) mod collaboration;
use execution_adapter::*;

mod run_store;
mod verification;
use run_store::*;

#[cfg(test)]
#[path = "workflow/tests.rs"]
mod tests;
