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
    /// Preferred recovery for an existing failed/interrupted/cancelled run: supply its run_id, without script/name/script_path/definition_id/version. Reuses matching completed agent outputs; unfinished work reruns. Omit args to retain saved arguments. Never blindly replay effects with unknown outcomes.
    #[serde(default)]
    pub resume: Option<String>,
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
    /// Maximum agents this workflow may run concurrently (1-4).
    #[serde(default)]
    pub max_concurrency: Option<usize>,
    /// Default max turns for each agent call (1-100; omitted defaults to 60).
    #[serde(default)]
    pub max_agent_turns: Option<usize>,
    /// Whole-workflow wall clock limit in seconds (1-86400).
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
    agent_started: usize,
    agent_completed: usize,
    agent_failed: usize,
    #[serde(default)]
    agent_reused: usize,
    event_count: usize,
    #[serde(default)]
    resume_count: usize,
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
}

struct ResumeRollback {
    state: WorkflowRunState,
    args: Vec<u8>,
}

struct ResumeLease {
    _file: fs::File,
}

struct ToolAgentExecutor {
    isolate_context: bool,
    runner: Arc<dyn AgentRunner>,
    arrangement_mode: bool,
    resume_run_dir: Option<PathBuf>,
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
        "Run a deterministic JavaScript workflow or an explicitly published library definition_id and version in an embedded QuickJS runtime. Execution, including validation runs after generation, requires an explicit user request. If the user requested only authoring/saving, proactively ask whether they want execution verification and wait for an affirmative answer. An existing request to generate and test is sufficient; do not seek duplicate confirmation. Once authorized, verify results and artifacts against the agreed criteria, fix failed nodes and retest corrected saved versions rather than stopping at schema validation. Static authoring checks do not authorize starting a run, agent calls or external side effects. Scripts may use agent(), parallel(), pipeline(), phase(), workflow(), log(), and args. Agent calls use real KCoder sub-agents; the workflow runs in the background and persists script, arguments, state, journal, per-agent output, and final output under the current session. Prefer args_json containing complete serialized JSON for arrays and nested objects; it preserves explicit JSON types. Native args remains supported, but never supply both. A root array is args itself; to access args.items pass an object with an items array. Do not add item wrappers or change whitespace to work around transport corruption. Use a saved input_schema to reject wrong types before execution; without a schema KCoder cannot infer whether an arbitrary item object was intended. Saved graph arguments are checked before creating a run; needs_input means no task or agent was started. Ask concise questions for the missing/invalid information, retain supplied values, then retry the same version. For an existing failed/interrupted/cancelled run, inspect its status/error and prefer Workflow({resume: run_id}) over creating a new run. Keep the original arguments unless a correction is required. Resume reuses matching completed agent outputs and retries unfinished work; it is not instruction-level continuation and cannot guarantee exactly-once external effects. Never blindly replay an unknown side effect. A definition change requires saving a new version and explicitly starting a new run, not resuming the old pinned version. Inspect the persisted run status and result before waiting again. completed means execution ended; only configured result checks can provide machine verification. Inspect verification.status and checkedNodes in the graph output, and verify required artifacts before claiming the task is correct. No Bun or Node installation is required."
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
        schema["not"] = json!({"required":["args","args_json"]});
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
        let lossless_arguments = input.args_json.is_some();
        if let Some(text) = input.args_json.take() {
            if text.len() > 128 * 1024 {
                return Err(ToolError::InvalidInput("args_json exceeds 128 KiB".into()));
            }
            input.args = serde_json::from_str(&text)
                .map_err(|error| ToolError::InvalidInput(format!("args_json: {error}")))?;
        }
        let session_cap = ctx
            .max_concurrent_subagents
            .unwrap_or(MAX_WORKFLOW_CONCURRENCY)
            .clamp(1, MAX_WORKFLOW_CONCURRENCY);
        let max_agent_turns = input
            .max_agent_turns
            .unwrap_or(DEFAULT_AGENT_MAX_TURNS)
            .clamp(1, MAX_AGENT_MAX_TURNS);
        let timeout_seconds = input
            .timeout_seconds
            .unwrap_or(DEFAULT_TIMEOUT_SECONDS)
            .clamp(1, MAX_TIMEOUT_SECONDS);
        let resume_id = input
            .resume
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let mut pinned_definition = None;
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
                let args_override = (!input.args.is_null()).then_some(&input.args);
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
                let state = store.state.lock().unwrap().clone();
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
                            "next_action":"No run or agent was started. First correct the tool args using values already supplied in the user request and the saved input schema; do not ask the user to resend known values or approve reading the schema. Ask only for genuinely missing information. Retry this same definition_id and version with corrected args_json containing the complete JSON input. Preserve array/number/boolean types and nesting; an item wrapper is not an array. Do not invent values or require the user to write JSON."
                        }).to_string()));
                        }
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
                    max_concurrency,
                )?;
                if let Some(definition) = &pinned_definition {
                    use sha2::Digest;
                    let bytes = serde_json::to_vec(definition)
                        .map_err(|e| ToolError::Execution(e.to_string()))?;
                    atomic_write_file(&store.run_dir.join("definition.json"), &bytes)
                        .map_err(|e| ToolError::Execution(e.to_string()))?;
                    store.state.lock().unwrap().definition_sha256 =
                        Some(format!("{:x}", sha2::Sha256::digest(&bytes)));
                    store.persist_state()?;
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
            Some(store.begin_resume(&workflow_args, max_concurrency)?)
        } else {
            None
        };

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
            isolate_context: pinned_definition.is_some(),
            runner,
            arrangement_mode: ctx.arrangement_mode,
            resume_run_dir: is_resume.then(|| store.run_dir.clone()),
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
            // Fan out every runtime exit (including quota failure or dropped future)
            // to the host-side agents and tools sharing this workflow token.
            let _cancel_on_exit = workflow_cancel.clone().drop_guard();
            let config = WorkflowRuntimeConfig {
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
                "definition_id": definition_reference.as_ref().map(|reference| &reference.0),
                "version": definition_reference.as_ref().and_then(|reference| reference.1),
                "title": definition_reference.as_ref().map(|reference| &reference.2),
                "description": description,
                "state_file": state_path,
                "journal_file": journal_path,
                "output_file": output_path,
                "max_concurrency": max_concurrency,
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

#[path = "workflow/direct_tool.rs"]
mod direct_tool;
mod execution_adapter;
use execution_adapter::*;

mod run_store;
use run_store::*;

#[cfg(test)]
mod tests {
    #[test]
    fn source_selection_schema_rejects_empty_ambiguous_and_orphan_inputs() {
        use crate::Tool;
        let schema = super::WorkflowTool.input_schema();
        for input in [
            serde_json::json!({}),
            serde_json::json!({"args_json":"{}"}),
            serde_json::json!({"definition_id":"saved"}),
            serde_json::json!({"script":"return 1;","resume":"run-1"}),
            serde_json::json!({"script":"return 1;","version":1}),
            serde_json::json!({"script":"return 1;","args":{},"args_json":"{}"}),
        ] {
            assert!(
                kcoder_workflow::graph::validate_data(&schema, &input).is_err(),
                "{input}"
            );
        }
        for input in [
            serde_json::json!({"definition_id":"saved","version":1,"args_json":"{}"}),
            serde_json::json!({"script":"return args;","args":{"n":2}}),
            serde_json::json!({"resume":"run-1"}),
            serde_json::json!({"name":"project"}),
        ] {
            kcoder_workflow::graph::validate_data(&schema, &input).unwrap();
        }
        assert!(
            crate::input_schema::example_input_for_schema(&schema).is_none(),
            "do not suggest the invalid empty object as a complete call"
        );
    }

    use super::*;
    use crate::background::BackgroundJobEvent;
    use crate::{AgentError, BackgroundJobSpawner, SpawnError};
    use kcoder_state::{AppState, Task, TaskKind, TaskStatus};
    use std::collections::HashMap;
    use std::future::Future;
    use std::pin::Pin;
    use tokio::sync::broadcast;

    #[test]
    fn rejects_unsafe_names_and_paths() {
        assert!(validate_workflow_name("review-changes_2").is_ok());
        assert!(validate_workflow_name("../escape").is_err());
        assert!(ensure_workspace_path(Path::new("/tmp/work/a.js"), Path::new("/tmp/work")).is_ok());
        assert!(
            ensure_workspace_path(Path::new("/tmp/escape.js"), Path::new("/tmp/work")).is_err()
        );
    }

    #[cfg(windows)]
    #[test]
    fn workspace_path_containment_is_case_insensitive_on_windows() {
        assert!(
            ensure_workspace_path(
                Path::new(r"C:\WorkSpace\scripts\review.js"),
                Path::new(r"c:\workspace"),
            )
            .is_ok()
        );
    }

    #[cfg(any(target_os = "linux", windows))]
    #[test]
    fn secure_script_read_rejects_symlink_escape() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let outside = temp.path().join("outside.js");
        fs::write(&outside, "return 'outside';").unwrap();
        let link = workspace.join("escape.js");
        #[cfg(target_os = "linux")]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&outside, &link).unwrap();

        assert!(securely_read_workspace_file(&link, &workspace).is_err());
    }

    #[cfg(any(target_os = "linux", windows))]
    #[test]
    fn artifact_io_does_not_follow_file_or_parent_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let run_dir = temp.path().join("run");
        secure_create_dir(&run_dir).unwrap();
        let outside = temp.path().join("outside.txt");
        fs::write(&outside, "outside").unwrap();
        let linked_file = run_dir.join("state.json");
        #[cfg(target_os = "linux")]
        std::os::unix::fs::symlink(&outside, &linked_file).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&outside, &linked_file).unwrap();

        assert!(secure_read_file(&linked_file, 1024).is_err());
        assert!(secure_append_file(&linked_file, b"-escaped").is_err());
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside");
        atomic_write_file(&linked_file, b"inside").unwrap();
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside");
        assert_eq!(fs::read_to_string(&linked_file).unwrap(), "inside");

        let outside_dir = temp.path().join("outside-dir");
        fs::create_dir(&outside_dir).unwrap();
        let linked_dir = run_dir.join("agents");
        #[cfg(target_os = "linux")]
        std::os::unix::fs::symlink(&outside_dir, &linked_dir).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&outside_dir, &linked_dir).unwrap();
        assert!(secure_create_dir(&linked_dir.join("nested")).is_err());
        assert!(!outside_dir.join("nested").exists());
        assert!(atomic_write_file(&linked_dir.join("escaped"), b"no").is_err());
        assert!(!outside_dir.join("escaped").exists());
    }

    #[test]
    fn cache_requires_atomic_completion_marker() {
        let temp = tempfile::tempdir().unwrap();
        let agent_dir = temp.path().join("agent");
        secure_create_dir(&agent_dir).unwrap();
        let request = AgentRequest {
            output_repair_only: false,
            prompt: "review".to_string(),
            agent_type: "review".to_string(),
            max_turns: 4,
            allowed_write_paths: Vec::new(),
            acceptance_criteria: Vec::new(),
            expected_artifacts: Vec::new(),
            context_paths: Vec::new(),
            out_of_scope: Vec::new(),
            verification: Vec::new(),
        };
        atomic_write_file(
            &agent_dir.join("request.json"),
            serde_json::to_vec(&request).unwrap(),
        )
        .unwrap();
        atomic_write_file(&agent_dir.join("output.md"), b"partial").unwrap();
        assert!(!cached_agent_request_matches(&agent_dir, &request));
        atomic_write_file(&agent_dir.join("completed"), b"ok\n").unwrap();
        assert!(cached_agent_request_matches(&agent_dir, &request));
    }

    #[cfg(any(target_os = "linux", windows))]
    #[test]
    fn saved_arguments_are_schema_aware_and_respect_coercion_options() {
        let temp = tempfile::tempdir().unwrap();
        let store = kcoder_workflow::store::WorkflowStore::new(temp.path().join("library"));
        let mut definition = store.create("Args", "").unwrap();
        definition.input_schema = Some(
            json!({"type":"object","required":["count"],"properties":{"count":{"type":"integer"},"label":{"type":"string","default":"test"}},"additionalProperties":false}),
        );
        let encoded = json!("{\"count\":3}");
        assert_eq!(
            prepare_model_arguments(
                &definition,
                &mut encoded.clone(),
                &crate::CoercionOptions::default()
            )
            .unwrap(),
            json!({"count":3,"label":"test"})
        );
        let scalar = json!("{\"count\":\"3\"}");
        assert!(
            prepare_model_arguments(
                &definition,
                &mut scalar.clone(),
                &crate::CoercionOptions::strict()
            )
            .is_err()
        );
        assert_eq!(
            prepare_model_arguments(
                &definition,
                &mut scalar.clone(),
                &crate::CoercionOptions::default()
            )
            .unwrap()["count"],
            3
        );
        assert!(
            prepare_model_arguments(
                &definition,
                &mut json!("{broken}"),
                &crate::CoercionOptions::default()
            )
            .is_err()
        );
        let mut missing = json!("{\"label\":\"provided\"}");
        assert!(
            prepare_model_arguments(
                &definition,
                &mut missing,
                &crate::CoercionOptions::default()
            )
            .is_err()
        );
        assert_eq!(missing, json!({"label":"provided"}));
        definition.input_schema = Some(json!({"type":"string"}));
        assert_eq!(
            prepare_model_arguments(
                &definition,
                &mut encoded.clone(),
                &crate::CoercionOptions::default()
            )
            .unwrap(),
            encoded
        );
        definition.input_schema = None;
        assert_eq!(
            prepare_model_arguments(
                &definition,
                &mut encoded.clone(),
                &crate::CoercionOptions::default()
            )
            .unwrap(),
            encoded
        );
    }

    #[tokio::test]
    async fn resume_lease_is_exclusive_and_released_on_drop() {
        let temp = tempfile::tempdir().unwrap();
        let run_dir = temp.path().join("workflow-test");
        secure_create_dir(&run_dir).unwrap();
        let first = try_acquire_resume_lease(&run_dir).unwrap();
        assert!(try_acquire_resume_lease(&run_dir).is_err());
        drop(first);
        acquire_resume_lease(&run_dir)
            .await
            .expect("lease owner drop 后应在有界等待内重新获取");
    }

    #[cfg(any(target_os = "linux", windows))]
    #[tokio::test]
    async fn initial_run_does_not_ignore_resume_lease_conflict() {
        let temp = tempfile::tempdir().unwrap();
        let run_dir = temp.path().join("workflow-test");
        secure_create_dir(&run_dir).unwrap();
        let _resume = try_acquire_resume_lease(&run_dir).unwrap();

        let error = match acquire_initial_resume_lease(&run_dir).await {
            Err(error) => error,
            Ok(_) => panic!("initial run must not ignore a conflicting resume lease"),
        };

        assert!(
            error
                .to_string()
                .contains("workflow resume is already being prepared or is running"),
            "{error}"
        );
    }

    #[cfg(any(target_os = "linux", windows))]
    #[tokio::test]
    async fn resume_lease_waits_for_a_finishing_owner() {
        let temp = tempfile::tempdir().unwrap();
        let run_dir = temp.path().join("workflow-test");
        secure_create_dir(&run_dir).unwrap();
        let lease = try_acquire_resume_lease(&run_dir).unwrap();
        let release = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            drop(lease);
        });

        let next = acquire_resume_lease(&run_dir)
            .await
            .expect("完成中的 workflow 应在有界等待后释放 lease");
        release.await.unwrap();
        drop(next);
    }

    #[test]
    fn loop_iteration_completion_does_not_complete_the_outer_node() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("observations");
        let store = WorkflowRunStore::create(
            temp.path().join("workflow-loop"),
            "workflow-loop".into(),
            "loop".into(),
            "inline".into(),
            "return null;",
            &Value::Null,
            1,
        )
        .unwrap();
        *store.observation.lock().unwrap() = Some(
            crate::workflow_runs::RunObservation::start(
                root.clone(),
                kcoder_types::workflow_runs::WorkflowRunSnapshot {
                    revision: 1,
                    run_id: "workflow-loop".into(),
                    definition_id: None,
                    version: None,
                    thread_id: "thread".into(),
                    workspace: "owned".into(),
                    status: "running".into(),
                    error: None,
                    started_at_ms: 1,
                    updated_at_ms: 1,
                    resume_count: 0,
                    node_states: vec![],
                },
            )
            .unwrap(),
        );
        store.record(WorkflowEvent::NodeStarted {
            node_id: "loop".into(),
            iteration: None,
            attempt: 0,
            agent_id: None,
        });
        store.record(WorkflowEvent::NodeStarted {
            node_id: "loop".into(),
            iteration: Some(0),
            attempt: 0,
            agent_id: Some("agent".into()),
        });
        store.record(WorkflowEvent::NodeCompleted {
            node_id: "loop".into(),
            iteration: Some(0),
            attempt: 0,
            agent_id: Some("agent".into()),
            output: json!("iteration done"),
        });
        let active = crate::workflow_runs::read(root.clone(), "workflow-loop").unwrap();
        assert_eq!(active.node_states[0].status, "running");
        assert_eq!(
            active.node_states[0].iteration_status.as_deref(),
            Some("completed")
        );
        assert!(active.node_states[0].finished_at_ms.is_none());
        store.record(WorkflowEvent::NodeCompleted {
            node_id: "loop".into(),
            iteration: None,
            attempt: 0,
            agent_id: None,
            output: json!(["iteration done"]),
        });
        assert_eq!(
            crate::workflow_runs::read(root, "workflow-loop")
                .unwrap()
                .node_states[0]
                .status,
            "completed"
        );
    }

    #[test]
    fn rejected_repair_outputs_are_not_reused_but_original_outputs_are() {
        let temp = tempfile::tempdir().unwrap();
        let run_dir = temp.path().join("workflow-repair");
        let store = WorkflowRunStore::create(
            run_dir.clone(),
            "workflow-repair".into(),
            "repair".into(),
            "inline".into(),
            "return null;",
            &Value::Null,
            1,
        )
        .unwrap();
        for (id, repair) in [("original", false), ("repair", true)] {
            let request:AgentRequest=serde_json::from_value(json!({"prompt":"output","agent_type":"general","max_turns":1,"output_repair_only":repair})).unwrap();
            store.record(WorkflowEvent::AgentStarted {
                agent_id: id.into(),
                request: request.clone(),
            });
            store.record(WorkflowEvent::AgentCompleted {
                agent_id: id.into(),
                output: "invalid json".into(),
            });
            let dir = run_dir.join("agents").join(id);
            assert!(cached_agent_request_matches(&dir, &request));
            store.record(WorkflowEvent::NodeFailed {
                node_id: "n".into(),
                iteration: None,
                attempt: 1,
                agent_id: Some(id.into()),
                error: "schema invalid".into(),
                will_retry: true,
            });
            assert_eq!(cached_agent_request_matches(&dir, &request), !repair);
        }
    }

    #[test]
    fn concurrent_events_keep_journal_and_state_valid() {
        let temp = tempfile::tempdir().unwrap();
        let run_dir = temp.path().join("workflow-test");
        let store = WorkflowRunStore::create(
            run_dir.clone(),
            "workflow-test".to_string(),
            "parallel".to_string(),
            "inline".to_string(),
            "return null;",
            &Value::Null,
            4,
        )
        .unwrap();
        let mut threads = Vec::new();
        for worker in 0..8 {
            let store = Arc::clone(&store);
            threads.push(std::thread::spawn(move || {
                for event in 0..100 {
                    store.record(WorkflowEvent::Log {
                        message: format!("{worker}:{event}"),
                    });
                }
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }

        let journal = fs::read_to_string(run_dir.join("journal.jsonl")).unwrap();
        assert_eq!(journal.lines().count(), 801);
        for line in journal.lines() {
            serde_json::from_str::<Value>(line).unwrap();
        }
        let state: WorkflowRunState =
            serde_json::from_slice(&fs::read(run_dir.join("state.json")).unwrap()).unwrap();
        assert_eq!(state.event_count, 800);
    }

    #[test]
    fn runtime_cancellation_persists_cancelled_terminal_state() {
        let temp = tempfile::tempdir().unwrap();
        let run_dir = temp.path().join("workflow-cancelled");
        let store = WorkflowRunStore::create(
            run_dir.clone(),
            "workflow-cancelled".to_string(),
            "cancelled".to_string(),
            "inline".to_string(),
            "return null;",
            &Value::Null,
            1,
        )
        .unwrap();
        let task_state = AppState::new(temp.path());
        let mut task = Task::new("workflow-cancelled", "cancelled workflow");
        task.kind = TaskKind::Workflow;
        task.status = TaskStatus::Running;
        task_state.upsert_task(task);

        let output = finish_workflow_result(
            &store,
            &task_state,
            "workflow-cancelled",
            Err(WorkflowError::Cancelled),
        );

        assert!(output.is_error);
        let state: WorkflowRunState =
            serde_json::from_slice(&fs::read(run_dir.join("state.json")).unwrap()).unwrap();
        assert_eq!(state.status, "cancelled");
        assert_eq!(
            task_state.task("workflow-cancelled").unwrap().status,
            TaskStatus::Cancelled
        );
        let persisted: Value =
            serde_json::from_slice(&fs::read(run_dir.join("output.json")).unwrap()).unwrap();
        assert_eq!(persisted["status"], "cancelled");
    }

    #[test]
    fn preview_is_unicode_safe() {
        assert_eq!(preview("你好世界", 2), "你好...");
        assert_eq!(preview("你好", 2), "你好");
    }

    #[derive(Default)]
    struct RecordingRunner(
        Mutex<Vec<String>>,
        Mutex<Vec<String>>,
        Mutex<Vec<Option<Vec<String>>>>,
        Mutex<Vec<crate::SubagentContextMode>>,
    );

    #[async_trait]
    impl AgentRunner for RecordingRunner {
        async fn run_agent(&self, prompt: String, _max_turns: usize) -> Result<String, AgentError> {
            Ok(format!("done:{prompt}"))
        }

        async fn run_agent_session_with_options(
            &self,
            agent_id: String,
            prompt: String,
            _max_turns: usize,
            _agent_kind: crate::AgentKind,
            options: AgentRunOptions,
        ) -> Result<String, AgentError> {
            self.0.lock().unwrap().push(agent_id);
            self.1.lock().unwrap().push(prompt);
            self.2.lock().unwrap().push(options.tool_allowlist);
            self.3.lock().unwrap().push(options.context_mode);
            Ok("agent result".to_string())
        }
    }

    struct ExecutingWorkflowManager {
        state: AppState,
        tx: broadcast::Sender<BackgroundJobEvent>,
        handles: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
    }

    struct FailingResumeManager {
        tx: broadcast::Sender<BackgroundJobEvent>,
    }

    impl FailingResumeManager {
        fn new() -> Self {
            let (tx, _) = broadcast::channel(4);
            Self { tx }
        }
    }

    impl BackgroundJobSpawner for FailingResumeManager {
        fn spawn(
            &self,
            _description: String,
            _work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
            _max_concurrent: Option<usize>,
        ) -> Result<String, SpawnError> {
            Err(SpawnError::TooManyConcurrent {
                running: 1,
                limit: 1,
            })
        }

        fn respawn_workflow(
            &self,
            _id: String,
            _description: String,
            _work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
            _max_concurrent: Option<usize>,
        ) -> Result<String, SpawnError> {
            Err(SpawnError::TooManyConcurrent {
                running: 1,
                limit: 1,
            })
        }

        fn subscribe(&self) -> broadcast::Receiver<BackgroundJobEvent> {
            self.tx.subscribe()
        }

        fn abort(&self, _id: &str) -> bool {
            false
        }
    }

    impl ExecutingWorkflowManager {
        fn new(state: AppState) -> Self {
            let (tx, _) = broadcast::channel(16);
            Self {
                state,
                tx,
                handles: Mutex::new(HashMap::new()),
            }
        }

        async fn wait_for_completion(&self, workflow_id: &str) {
            self.wait_for_completion_with_timeout(workflow_id, std::time::Duration::from_secs(5))
                .await;
        }

        async fn wait_for_completion_with_timeout(
            &self,
            workflow_id: &str,
            timeout: std::time::Duration,
        ) {
            let mut handle = self
                .handles
                .lock()
                .unwrap()
                .remove(workflow_id)
                .unwrap_or_else(|| panic!("workflow {workflow_id} has no tracked task"));
            match tokio::time::timeout(timeout, &mut handle).await {
                Ok(result) => result
                    .unwrap_or_else(|error| panic!("workflow {workflow_id} task failed: {error}")),
                Err(_) => {
                    handle.abort();
                    if tokio::time::timeout(std::time::Duration::from_secs(1), &mut handle)
                        .await
                        .is_err()
                    {
                        panic!(
                            "workflow {workflow_id} task timed out and did not terminate after abort"
                        );
                    }
                    panic!(
                        "workflow {workflow_id} task did not finish before timeout; task aborted"
                    );
                }
            }
        }
    }

    impl BackgroundJobSpawner for ExecutingWorkflowManager {
        fn spawn(
            &self,
            _description: String,
            _work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
            _max_concurrent: Option<usize>,
        ) -> Result<String, SpawnError> {
            panic!("workflow test must use spawn_workflow_with_id")
        }

        fn spawn_workflow_with_id(
            &self,
            id: String,
            description: String,
            mut work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
            _max_concurrent: Option<usize>,
        ) -> Result<String, SpawnError> {
            let mut task = Task::new(&id, description);
            task.kind = TaskKind::Workflow;
            task.status = TaskStatus::Running;
            self.state.upsert_task(task);
            let state = self.state.clone();
            let task_id = id.clone();
            let handle = tokio::spawn(async move {
                let output = work.as_mut().await;
                // The workflow future holds the resume lease; drop it before exposing the test task's completion boundary.
                drop(work);
                let mut task = state.task(&task_id).unwrap();
                task.status = if output.is_error {
                    TaskStatus::Failed
                } else {
                    TaskStatus::Completed
                };
                state.upsert_task(task);
            });
            assert!(
                self.handles
                    .lock()
                    .unwrap()
                    .insert(id.clone(), handle)
                    .is_none(),
                "workflow {id} already has a tracked task"
            );
            Ok(id)
        }

        fn subscribe(&self) -> broadcast::Receiver<BackgroundJobEvent> {
            self.tx.subscribe()
        }

        fn abort(&self, _id: &str) -> bool {
            false
        }
    }

    async fn wait_for_workflow_status(run_dir: &Path, expected: &str) {
        for _ in 0..200 {
            let status = fs::read(run_dir.join("state.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .and_then(|state| state["status"].as_str().map(str::to_string));
            if status.as_deref() == Some(expected) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("workflow did not reach status {expected}");
    }

    #[tokio::test]
    async fn graph_nodes_do_not_inherit_the_parent_launch_request() {
        let runner = Arc::new(RecordingRunner::default());
        let executor = ToolAgentExecutor {
            isolate_context: true,
            runner: runner.clone(),
            arrangement_mode: false,
            resume_run_dir: None,
            tool_run_dir: None,
            library_root: None,
            wait_root: None,
            run_id: String::new(),
            cancellation: CancellationToken::new(),
        };
        let request: AgentRequest = serde_json::from_value(
            json!({"prompt":"Return node result", "agent_type":"general", "max_turns":2}),
        )
        .unwrap();
        executor.execute("node", request).await.unwrap();
        assert_eq!(
            runner.3.lock().unwrap().as_slice(),
            &[crate::SubagentContextMode::None]
        );
    }

    #[tokio::test]
    async fn graph_output_repair_forces_empty_agent_tool_allowlist() {
        let runner = Arc::new(RecordingRunner::default());
        let executor = ToolAgentExecutor {
            isolate_context: false,
            runner: runner.clone(),
            arrangement_mode: false,
            resume_run_dir: None,
            tool_run_dir: None,
            library_root: None,
            wait_root: None,
            run_id: String::new(),
            cancellation: CancellationToken::new(),
        };
        let request:AgentRequest=serde_json::from_value(json!({"prompt":"format only","agent_type":"general","max_turns":1,"output_repair_only":true})).unwrap();
        executor.execute("repair-agent", request).await.unwrap();
        assert_eq!(
            runner.2.lock().unwrap().as_slice(),
            &[Some(Vec::<String>::new())]
        );
    }

    #[tokio::test]
    async fn graph_parallel_nodes_have_durable_independent_run_observations() {
        struct BlockingRunner {
            entered: AtomicU64,
            release: Arc<tokio::sync::Semaphore>,
            outputs: Mutex<HashMap<String, String>>,
        }
        #[async_trait]
        impl AgentRunner for BlockingRunner {
            async fn run_agent(&self, prompt: String, _: usize) -> Result<String, AgentError> {
                Ok(prompt)
            }
            async fn run_agent_session_with_options(
                &self,
                id: String,
                prompt: String,
                _turns: usize,
                _kind: crate::AgentKind,
                _options: AgentRunOptions,
            ) -> Result<String, AgentError> {
                self.entered.fetch_add(1, Ordering::SeqCst);
                let permit = self.release.acquire().await.unwrap();
                permit.forget();
                let output = format!("actual-output:{prompt}");
                self.outputs.lock().unwrap().insert(id, output.clone());
                Ok(output)
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("profile");
        let library = kcoder_workflow::store::WorkflowStore::new(profile.join("workflow-library"));
        let mut def = library.create("parallel", "").unwrap();
        for id in ["left", "right"] {
            def = library
                .upsert_node(
                    &def.id,
                    def.revision,
                    serde_json::from_value(json!({"id":id,"title":id,"prompt":id})).unwrap(),
                )
                .unwrap();
        }
        let def = library.save(&def.id, def.revision).unwrap();
        let state = AppState::new(temp.path());
        let project = profile.join("projects/p");
        fs::create_dir_all(&project).unwrap();
        state.with_history_path(project.join("s.jsonl"));
        let runner = Arc::new(BlockingRunner {
            entered: AtomicU64::new(0),
            release: Arc::new(tokio::sync::Semaphore::new(0)),
            outputs: Mutex::new(HashMap::new()),
        });
        let manager = Arc::new(ExecutingWorkflowManager::new(state.clone()));
        let abort = CancellationToken::new();
        let ctx = ToolContext::new(state)
            .with_abort_token(abort.clone())
            .with_settings_persistence_path(Some(profile.join("settings.json")))
            .with_agent_runner(runner.clone())
            .with_background_job_manager(manager.clone());
        let out = WorkflowTool
            .call(json!({"definition_id":def.id,"version":1}), &ctx)
            .await
            .unwrap();
        let kcoder_types::ContentBlock::Text { text } = &out.content[0] else {
            panic!("text")
        };
        let reply: Value = serde_json::from_str(text).unwrap();
        let id = reply["run_id"].as_str().unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while runner.entered.load(Ordering::SeqCst) != 2 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let root = profile.join("workflow-runs");
        let active = crate::workflow_runs::read(root.clone(), id).unwrap();
        assert_eq!(active.node_states.len(), 2);
        assert!(active.node_states.iter().all(|n| n.status == "running"));
        assert_ne!(
            active.node_states[0].agent_id,
            active.node_states[1].agent_id
        );
        runner.release.add_permits(2);
        manager.wait_for_completion(id).await;
        let done = crate::workflow_runs::read(root.clone(), id).unwrap();
        assert_eq!(done.status, "completed");
        assert!(done.node_states.iter().all(|n| n.status == "completed"));
        let left = done
            .node_states
            .iter()
            .find(|n| n.node_id == "left")
            .unwrap();
        let expected = runner
            .outputs
            .lock()
            .unwrap()
            .get(left.agent_id.as_ref().unwrap())
            .unwrap()
            .clone();
        assert_eq!(
            crate::workflow_runs::output(root.clone(), id, "left", 0, 65536).unwrap()["text"],
            expected
        );
        let updated = library
            .update_metadata(
                &def.id,
                def.revision,
                "parallel",
                "",
                Some(json!({"type":"object","required":["required_field"]})),
            )
            .unwrap();
        library.save(&updated.id, updated.revision).unwrap();
        let failed = WorkflowTool
            .call(json!({"definition_id":def.id,"version":2,"args":{}}), &ctx)
            .await
            .unwrap();
        let kcoder_types::ContentBlock::Text { text } = &failed.content[0] else {
            panic!("text")
        };
        let failed: Value = serde_json::from_str(text).unwrap();
        assert_eq!(failed["status"], "needs_input");
        assert!(failed.get("run_id").is_none());
        assert_eq!(failed["missing_fields"][0]["name"], "required_field");
        assert_eq!(runner.entered.load(Ordering::SeqCst), 2);
        assert_eq!(crate::workflow_runs::list(root.clone()).unwrap().len(), 1);
        let cancelled = WorkflowTool
            .call(json!({"definition_id":def.id,"version":1}), &ctx)
            .await
            .unwrap();
        let kcoder_types::ContentBlock::Text { text } = &cancelled.content[0] else {
            panic!("text")
        };
        let cancelled: Value = serde_json::from_str(text).unwrap();
        let cancelled_id = cancelled["run_id"].as_str().unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while runner.entered.load(Ordering::SeqCst) != 4 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        abort.cancel();
        manager.wait_for_completion(cancelled_id).await;
        let cancelled = crate::workflow_runs::read(root, cancelled_id).unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert!(
            cancelled
                .node_states
                .iter()
                .all(|n| n.status == "cancelled")
        );
    }

    #[tokio::test]
    async fn published_definition_executes_explicit_version_and_rejects_mixed_sources() {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("profile");
        let library = kcoder_workflow::store::WorkflowStore::new(profile.join("workflow-library"));
        let draft = library.create("Published review", "").unwrap();
        let node = serde_json::from_value(
            json!({"id":"review","title":"Review","prompt":"inspect","agentType":"review"}),
        )
        .unwrap();
        let draft = library
            .upsert_node(&draft.id, draft.revision, node)
            .unwrap();
        let saved = library.save(&draft.id, draft.revision).unwrap();
        let state = AppState::new(temp.path());
        let project = profile.join("projects/project");
        fs::create_dir_all(&project).unwrap();
        state.with_history_path(project.join("session.jsonl"));
        let runner = Arc::new(RecordingRunner::default());
        let manager = Arc::new(ExecutingWorkflowManager::new(state.clone()));
        let context = ToolContext::new(state.clone())
            .with_settings_persistence_path(Some(profile.join("settings.json")))
            .with_agent_runner(runner.clone())
            .with_background_job_manager(manager.clone());
        assert!(
            WorkflowTool
                .call(
                    json!({"definition_id":saved.id,"version":1,"script":"return 1"}),
                    &context
                )
                .await
                .is_err()
        );
        assert!(
            WorkflowTool
                .call(json!({"definition_id":saved.id}), &context)
                .await
                .is_err()
        );
        assert!(
            WorkflowTool
                .call(
                    json!({"definition_id":saved.id,"version":1,"resume":"workflow-invalid"}),
                    &context
                )
                .await
                .is_err()
        );
        let output = WorkflowTool
            .call(
                json!({"definition_id":saved.id,"version":1,"args":{"marker":"first-saved-args"}}),
                &context,
            )
            .await
            .unwrap();
        let kcoder_types::ContentBlock::Text { text } = &output.content[0] else {
            panic!("expected text")
        };
        let result: Value = serde_json::from_str(text).unwrap();
        let run_id = result["run_id"].as_str().unwrap();
        manager.wait_for_completion(run_id).await;
        assert_eq!(state.task(run_id).unwrap().status, TaskStatus::Completed);
        assert_eq!(runner.0.lock().unwrap().len(), 1);
        assert!(runner.1.lock().unwrap()[0].contains("first-saved-args"));
        let resumed = WorkflowTool
            .call(
                json!({"resume":run_id,"args":{"marker":"replacement-saved-args"}}),
                &context,
            )
            .await
            .unwrap();
        let kcoder_types::ContentBlock::Text { text } = &resumed.content[0] else {
            panic!("expected text")
        };
        let reference: Value = serde_json::from_str(text).unwrap();
        assert_eq!(reference["run_id"], run_id);
        assert_eq!(reference["definition_id"], saved.id);
        assert_eq!(reference["version"], 1);
        assert_eq!(reference["title"], "Published review");
        manager.wait_for_completion(run_id).await;
        assert_eq!(
            runner.0.lock().unwrap().len(),
            2,
            "changed args must not reuse the old output"
        );
        assert!(runner.1.lock().unwrap()[1].contains("replacement-saved-args"));
        assert!(!runner.1.lock().unwrap()[1].contains("first-saved-args"));

        assert_eq!(
            library.read_saved(&saved.id, Some(1)).unwrap().revision,
            saved.revision
        );
    }

    #[tokio::test]
    async fn lossless_args_run_without_silently_accepting_flattened_fields() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("projects/project");
        fs::create_dir_all(&project).unwrap();
        let state = AppState::new(temp.path());
        state.with_history_path(project.join("session.jsonl"));
        let manager = Arc::new(ExecutingWorkflowManager::new(state.clone()));
        let context = ToolContext::new(state)
            .with_agent_runner(Arc::new(RecordingRunner::default()))
            .with_background_job_manager(manager.clone());
        for input in [
            json!({"script":"return args;","args":"","mode":"audit"}),
            json!({"script":"return args;","args":null,"args_json":"{}"}),
        ] {
            assert!(WorkflowTool.call(input, &context).await.is_err());
        }
        for args in [
            json!({"count":20,"descending":true,"items":["1","2","3"]}),
            json!(["1", "2", "3"]),
            json!({"item":["1","2","3"]}),
        ] {
            for field in ["args", "args_json"] {
                let mut input = json!({"script":"return args;"});
                input[field] = if field == "args_json" {
                    json!(serde_json::to_string(&args).unwrap())
                } else {
                    args.clone()
                };
                crate::coerce_input(&mut input, &WorkflowTool.input_schema());
                let output = WorkflowTool.call(input, &context).await.unwrap();
                let kcoder_types::ContentBlock::Text { text } = &output.content[0] else {
                    panic!("text expected")
                };
                let receipt: Value = serde_json::from_str(text).unwrap();
                manager
                    .wait_for_completion(receipt["run_id"].as_str().unwrap())
                    .await;
                let output_path = PathBuf::from(receipt["output_file"].as_str().unwrap());
                let stored: Value =
                    serde_json::from_slice(&fs::read(&output_path).unwrap()).unwrap();
                let persisted: Value = serde_json::from_slice(
                    &fs::read(output_path.parent().unwrap().join("args.json")).unwrap(),
                )
                .unwrap();
                assert_eq!(persisted, args, "persisted arguments via {field}");
                assert_eq!(stored["result"], args, "executed arguments via {field}");
            }
        }
    }

    #[tokio::test]
    async fn tool_runs_embedded_script_and_persists_session_artifacts() {
        let temp = tempfile::tempdir().unwrap();
        let project_dir = temp.path().join("projects/project");
        fs::create_dir_all(&project_dir).unwrap();
        let state = AppState::new(temp.path());
        state.with_history_path(project_dir.join("session-1.jsonl"));
        let runner = Arc::new(RecordingRunner::default());
        let manager = Arc::new(ExecutingWorkflowManager::new(state.clone()));
        let context = ToolContext::new(state.clone())
            .with_agent_runner(runner.clone())
            .with_background_job_manager(manager.clone());

        let output = WorkflowTool
            .call(
                json!({
                    "script": "return await agent({prompt: 'inspect', agent_type: 'review'});",
                    "args": {"unused": true}
                }),
                &context,
            )
            .await
            .unwrap();
        let text = match &output.content[0] {
            kcoder_types::ContentBlock::Text { text } => text,
            other => panic!("unexpected workflow output: {other:?}"),
        };
        let start: Value = serde_json::from_str(text).unwrap();
        let run_id = start["run_id"].as_str().unwrap();
        let output_path = PathBuf::from(start["output_file"].as_str().unwrap());

        for _ in 0..100 {
            if output_path.exists()
                && state
                    .task(run_id)
                    .is_some_and(|task| task.status == TaskStatus::Completed)
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        manager.wait_for_completion(run_id).await;

        assert!(output_path.exists());
        let run_dir = output_path.parent().unwrap();
        assert!(run_dir.join("script.js").exists());
        assert!(run_dir.join("state.json").exists());
        assert!(run_dir.join("journal.jsonl").exists());
        assert!(
            run_dir
                .join("agents")
                .join(format!("{run_id}-agent-1"))
                .join("request.json")
                .exists()
        );
        assert!(
            run_dir
                .join("agents")
                .join(format!("{run_id}-agent-1"))
                .join("completed")
                .exists()
        );
        let final_output: Value = serde_json::from_slice(&fs::read(&output_path).unwrap()).unwrap();
        assert_eq!(final_output["result"], "agent result");
        {
            let agent_ids = runner.0.lock().unwrap();
            assert_eq!(agent_ids.as_slice(), &[format!("{run_id}-agent-1")]);
        }

        assert!(state.remove_task(run_id));

        let resumed = WorkflowTool
            .call(json!({"resume": run_id}), &context)
            .await
            .unwrap();
        let resumed_text = match &resumed.content[0] {
            kcoder_types::ContentBlock::Text { text } => text,
            other => panic!("unexpected resume output: {other:?}"),
        };
        let resumed_start: Value = serde_json::from_str(resumed_text).unwrap();
        assert_eq!(resumed_start["resumed"], true);
        assert_eq!(state.task(run_id).unwrap().kind, TaskKind::Workflow);
        wait_for_workflow_status(run_dir, "completed").await;
        manager.wait_for_completion(run_id).await;
        assert_eq!(
            runner.0.lock().unwrap().as_slice(),
            &[format!("{run_id}-agent-1")],
            "resume should reuse the completed agent result"
        );
        let journal = fs::read_to_string(run_dir.join("journal.jsonl")).unwrap();
        assert!(journal.contains("workflow_resumed"));
        assert!(journal.contains("agent_reused"));

        WorkflowTool
            .call(
                json!({"resume": run_id, "args": {"unused": false}}),
                &context,
            )
            .await
            .unwrap();
        wait_for_workflow_status(run_dir, "completed").await;
        manager.wait_for_completion(run_id).await;
        assert_eq!(
            runner.0.lock().unwrap().len(),
            1,
            "unused args must not invalidate an unchanged agent request"
        );
        let state: Value = serde_json::from_slice(
            &secure_read_file(&run_dir.join("state.json"), 1024 * 1024).unwrap(),
        )
        .unwrap();
        assert_eq!(state["agent_started"], 1);
        assert_eq!(state["agent_completed"], 1);
        assert_eq!(state["agent_reused"], 1);

        struct DropFlag(Arc<std::sync::atomic::AtomicBool>);

        impl Drop for DropFlag {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let drop_flag = DropFlag(dropped.clone());
        let timeout_id = "workflow-timeout-cleanup";
        manager
            .spawn_workflow_with_id(
                timeout_id.to_string(),
                "timeout cleanup".to_string(),
                Box::pin(async move {
                    let _drop_flag = drop_flag;
                    std::future::pending::<ToolOutput>().await
                }),
                None,
            )
            .unwrap();
        let waiting_manager = manager.clone();
        let waiter = tokio::spawn(async move {
            waiting_manager
                .wait_for_completion_with_timeout(timeout_id, std::time::Duration::from_millis(10))
                .await;
        });
        let panic = waiter.await.unwrap_err();
        assert!(panic.is_panic());
        let payload = panic.into_panic();
        let message = payload
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| payload.downcast_ref::<&str>().copied())
            .unwrap();
        assert_eq!(
            message,
            "workflow workflow-timeout-cleanup task did not finish before timeout; task aborted"
        );
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn resume_reruns_agent_when_args_change_its_request() {
        let temp = tempfile::tempdir().unwrap();
        let project_dir = temp.path().join("projects/project");
        fs::create_dir_all(&project_dir).unwrap();
        let state = AppState::new(temp.path());
        state.with_history_path(project_dir.join("session-1.jsonl"));
        let runner = Arc::new(RecordingRunner::default());
        let manager = Arc::new(ExecutingWorkflowManager::new(state.clone()));
        let context = ToolContext::new(state)
            .with_agent_runner(runner.clone())
            .with_background_job_manager(manager.clone());

        let output = WorkflowTool
            .call(
                json!({
                    "script": "return await agent({prompt: args.prompt, agent_type: 'review'});",
                    "args": {"prompt": "first"}
                }),
                &context,
            )
            .await
            .unwrap();
        let text = match &output.content[0] {
            kcoder_types::ContentBlock::Text { text } => text,
            other => panic!("unexpected workflow output: {other:?}"),
        };
        let start: Value = serde_json::from_str(text).unwrap();
        let run_id = start["run_id"].as_str().unwrap();
        let run_dir = PathBuf::from(start["state_file"].as_str().unwrap())
            .parent()
            .unwrap()
            .to_path_buf();
        wait_for_workflow_status(&run_dir, "completed").await;
        manager.wait_for_completion(run_id).await;
        for _ in 0..100 {
            if runner.0.lock().unwrap().len() == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        WorkflowTool
            .call(
                json!({"resume": run_id, "args": {"prompt": "second"}}),
                &context,
            )
            .await
            .unwrap();
        wait_for_workflow_status(&run_dir, "completed").await;
        manager.wait_for_completion(run_id).await;
        for _ in 0..100 {
            if runner.0.lock().unwrap().len() == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(runner.0.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn failed_resume_spawn_rolls_back_state_and_arguments() {
        let temp = tempfile::tempdir().unwrap();
        let project_dir = temp.path().join("projects/project");
        fs::create_dir_all(&project_dir).unwrap();
        let state = AppState::new(temp.path());
        state.with_history_path(project_dir.join("session-1.jsonl"));
        let runner = Arc::new(RecordingRunner::default());
        let manager = Arc::new(ExecutingWorkflowManager::new(state.clone()));
        let context = ToolContext::new(state.clone())
            .with_agent_runner(runner.clone())
            .with_background_job_manager(manager.clone());
        let output = WorkflowTool
            .call(
                json!({
                    "script": "return await agent(args.prompt);",
                    "args": {"prompt": "original"}
                }),
                &context,
            )
            .await
            .unwrap();
        let text = match &output.content[0] {
            kcoder_types::ContentBlock::Text { text } => text,
            other => panic!("unexpected workflow output: {other:?}"),
        };
        let started: Value = serde_json::from_str(text).unwrap();
        let run_id = started["run_id"].as_str().unwrap();
        let run_dir = PathBuf::from(started["state_file"].as_str().unwrap())
            .parent()
            .unwrap()
            .to_path_buf();
        wait_for_workflow_status(&run_dir, "completed").await;
        manager.wait_for_completion(run_id).await;

        let failing_context = ToolContext::new(state)
            .with_agent_runner(runner)
            .with_background_job_manager(Arc::new(FailingResumeManager::new()));
        let error = WorkflowTool
            .call(
                json!({"resume": run_id, "args": {"prompt": "replacement"}}),
                &failing_context,
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("too many concurrent"));
        let persisted: Value = serde_json::from_slice(
            &secure_read_file(&run_dir.join("state.json"), 1024 * 1024).unwrap(),
        )
        .unwrap();
        assert_eq!(persisted["status"], "completed");
        let args: Value = serde_json::from_slice(
            &secure_read_file(&run_dir.join("args.json"), 1024 * 1024).unwrap(),
        )
        .unwrap();
        assert_eq!(args["prompt"], "original");
        assert!(
            fs::read_to_string(run_dir.join("journal.jsonl"))
                .unwrap()
                .contains("workflow_resume_rolled_back")
        );
    }
}
