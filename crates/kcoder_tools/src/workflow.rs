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

const DEFAULT_MAX_CONCURRENCY: usize = 4;
const MAX_WORKFLOW_CONCURRENCY: usize = 4;
const DEFAULT_AGENT_MAX_TURNS: usize = 20;
const MAX_AGENT_MAX_TURNS: usize = 100;
const MAX_SCRIPT_BYTES: usize = 256 * 1024;
const DEFAULT_TIMEOUT_SECONDS: u64 = 30 * 60;
const MAX_TIMEOUT_SECONDS: u64 = 24 * 60 * 60;
const JOURNAL_EVENT_BATCH: usize = 32;

static NEXT_WORKFLOW_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_ARTIFACT_WRITE_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Default)]
pub struct WorkflowTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WorkflowInput {
    /// Inline JavaScript workflow body. Use exactly one of script, name, or script_path.
    #[serde(default)]
    pub script: Option<String>,
    /// Named project workflow from `.kcoder/workflows/<name>.js`.
    #[serde(default)]
    pub name: Option<String>,
    /// JavaScript workflow file relative to the session cwd.
    #[serde(default)]
    pub script_path: Option<PathBuf>,
    /// Resume a terminal workflow run by ID, reusing completed agent outputs.
    #[serde(default)]
    pub resume: Option<String>,
    /// JSON value exposed to the script as `args`.
    #[serde(default)]
    pub args: Value,
    /// Maximum agents this workflow may run concurrently (1-4).
    #[serde(default)]
    pub max_concurrency: Option<usize>,
    /// Default max turns for each agent call (1-100).
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
}

struct ResumeRollback {
    state: WorkflowRunState,
    args: Vec<u8>,
}

struct ResumeLease {
    _file: fs::File,
}

impl WorkflowRunStore {
    fn create(
        run_dir: PathBuf,
        run_id: String,
        name: String,
        source: String,
        script: &str,
        args: &Value,
        max_concurrency: usize,
    ) -> Result<Arc<Self>, ToolError> {
        let parent = run_dir.parent().ok_or_else(|| {
            ToolError::Execution("workflow run directory has no parent".to_string())
        })?;
        secure_create_dir(parent).map_err(|error| {
            ToolError::Execution(format!(
                "failed to create workflow root `{}`: {error}",
                parent.display()
            ))
        })?;
        secure_create_new_dir(&run_dir).map_err(|error| {
            ToolError::Execution(format!(
                "failed to create a new workflow run directory `{}`: {error}",
                run_dir.display()
            ))
        })?;
        let script_path = run_dir.join("script.js");
        let journal_path = run_dir.join("journal.jsonl");
        let output_path = run_dir.join("output.json");
        let args_path = run_dir.join("args.json");
        let state_path = run_dir.join("state.json");
        atomic_write_file(&script_path, script).map_err(|error| {
            ToolError::Execution(format!(
                "failed to persist workflow script `{}`: {error}",
                script_path.display()
            ))
        })?;
        atomic_write_file(
            &args_path,
            serde_json::to_vec_pretty(args).map_err(|error| {
                ToolError::Execution(format!("failed to serialize workflow args: {error}"))
            })?,
        )
        .map_err(|error| {
            ToolError::Execution(format!(
                "failed to persist workflow args `{}`: {error}",
                args_path.display()
            ))
        })?;
        let now = now_millis();
        let store = Arc::new(Self {
            run_dir,
            state_path,
            state: Mutex::new(WorkflowRunState {
                run_id,
                name,
                status: "running".to_string(),
                source,
                script_path,
                args_path,
                journal_path,
                output_path,
                started_at_ms: now,
                updated_at_ms: now,
                max_concurrency,
                agent_started: 0,
                agent_completed: 0,
                agent_failed: 0,
                agent_reused: 0,
                event_count: 0,
                resume_count: 0,
                active_phase: None,
                error: None,
            }),
            events: Mutex::new(()),
            io: Mutex::new(()),
            journal_buffer: Mutex::new(Vec::new()),
        });
        store.persist_state()?;
        store.append_json(&json!({
            "type": "workflow_started",
            "timestamp_ms": now,
            "run_id": store.state.lock().unwrap().run_id,
        }))?;
        Ok(store)
    }

    fn open_for_resume(run_dir: PathBuf) -> Result<Arc<Self>, ToolError> {
        let state_path = run_dir.join("state.json");
        let mut state: WorkflowRunState = serde_json::from_slice(
            &secure_read_file(&state_path, MAX_SCRIPT_BYTES).map_err(|error| {
                ToolError::Execution(format!(
                    "failed to read workflow state `{}`: {error}",
                    state_path.display()
                ))
            })?,
        )
        .map_err(|error| {
            ToolError::Execution(format!(
                "failed to parse workflow state `{}`: {error}",
                state_path.display()
            ))
        })?;
        let expected_run_id = run_dir
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| ToolError::Execution("invalid workflow run directory".to_string()))?;
        if state.run_id != expected_run_id {
            return Err(ToolError::Execution(format!(
                "workflow state id `{}` does not match run directory `{expected_run_id}`",
                state.run_id
            )));
        }
        state.script_path = run_dir.join("script.js");
        state.args_path = run_dir.join("args.json");
        state.journal_path = run_dir.join("journal.jsonl");
        state.output_path = run_dir.join("output.json");
        if !state.script_path.is_file() || !state.args_path.is_file() {
            return Err(ToolError::Execution(format!(
                "workflow {} is missing its persisted script or arguments",
                state.run_id
            )));
        }
        Ok(Arc::new(Self {
            run_dir,
            state_path,
            state: Mutex::new(state),
            events: Mutex::new(()),
            io: Mutex::new(()),
            journal_buffer: Mutex::new(Vec::new()),
        }))
    }

    fn begin_resume(
        &self,
        args: &Value,
        max_concurrency: usize,
    ) -> Result<ResumeRollback, ToolError> {
        let previous_state = self.state.lock().unwrap().clone();
        let previous_args =
            secure_read_file(&previous_state.args_path, MAX_SCRIPT_BYTES).map_err(|error| {
                ToolError::Execution(format!("failed to snapshot workflow args: {error}"))
            })?;
        let rollback = ResumeRollback {
            state: previous_state.clone(),
            args: previous_args,
        };
        let begin = (|| {
            atomic_write_file(
                &previous_state.args_path,
                serde_json::to_vec_pretty(args).map_err(std::io::Error::other)?,
            )?;
            let now = now_millis();
            let (run_id, resume_count) = {
                let mut state = self.state.lock().unwrap();
                state.status = "running".to_string();
                state.updated_at_ms = now;
                state.active_phase = None;
                state.error = None;
                state.max_concurrency = max_concurrency;
                state.agent_started = 0;
                state.agent_completed = 0;
                state.agent_failed = 0;
                state.agent_reused = 0;
                state.resume_count += 1;
                (state.run_id.clone(), state.resume_count)
            };
            self.persist_state()
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            self.append_json(&json!({
                "type": "workflow_resumed",
                "timestamp_ms": now,
                "run_id": run_id,
                "resume_count": resume_count,
                "previous_status": previous_state.status,
            }))
            .map_err(|error| std::io::Error::other(error.to_string()))
        })();
        if let Err(error) = begin {
            let _ = self.rollback_resume(rollback);
            return Err(ToolError::Execution(format!(
                "failed to begin workflow resume: {error}"
            )));
        }
        Ok(rollback)
    }

    fn rollback_resume(&self, rollback: ResumeRollback) -> Result<(), ToolError> {
        atomic_write_file(&rollback.state.args_path, &rollback.args).map_err(|error| {
            ToolError::Execution(format!("failed to restore workflow args: {error}"))
        })?;
        *self.state.lock().unwrap() = rollback.state;
        self.persist_state()?;
        self.append_json(&json!({
            "type": "workflow_resume_rolled_back",
            "timestamp_ms": now_millis(),
        }))
    }

    fn output_path(&self) -> PathBuf {
        self.state.lock().unwrap().output_path.clone()
    }

    fn persist_state(&self) -> Result<(), ToolError> {
        let _io = self.io.lock().unwrap();
        self.flush_journal_locked()?;
        let state = self.state.lock().unwrap().clone();
        let bytes = serde_json::to_vec_pretty(&state).map_err(|error| {
            ToolError::Execution(format!("failed to serialize workflow state: {error}"))
        })?;
        atomic_write_file(&self.state_path, bytes).map_err(|error| {
            ToolError::Execution(format!("failed to write workflow state: {error}"))
        })
    }

    fn append_json(&self, value: &Value) -> Result<(), ToolError> {
        let journal_path = self.state.lock().unwrap().journal_path.clone();
        let _io = self.io.lock().unwrap();
        self.flush_journal_locked()?;
        let mut bytes = serde_json::to_vec(value).map_err(|error| {
            ToolError::Execution(format!("failed to write workflow journal: {error}"))
        })?;
        bytes.push(b'\n');
        secure_append_file(&journal_path, &bytes).map_err(|error| {
            ToolError::Execution(format!("failed to finish workflow journal entry: {error}"))
        })
    }

    fn queue_json(&self, value: &Value) -> Result<(), ToolError> {
        let mut bytes = serde_json::to_vec(value).map_err(|error| {
            ToolError::Execution(format!("failed to write workflow journal: {error}"))
        })?;
        bytes.push(b'\n');
        self.journal_buffer.lock().unwrap().extend(bytes);
        Ok(())
    }

    fn flush_journal_locked(&self) -> Result<(), ToolError> {
        let bytes = {
            let mut pending = self.journal_buffer.lock().unwrap();
            if pending.is_empty() {
                return Ok(());
            }
            std::mem::take(&mut *pending)
        };
        let journal_path = self.state.lock().unwrap().journal_path.clone();
        if let Err(error) = secure_append_file(&journal_path, &bytes) {
            self.journal_buffer.lock().unwrap().splice(0..0, bytes);
            return Err(ToolError::Execution(format!(
                "failed to flush workflow journal: {error}"
            )));
        }
        Ok(())
    }

    fn finish(&self, result: Result<Value, String>) -> Result<(), ToolError> {
        let now = now_millis();
        let output_path = self.output_path();
        let output = match result {
            Ok(result) => {
                let mut state = self.state.lock().unwrap();
                if state.status != "running" {
                    return Ok(());
                }
                state.status = "completed".to_string();
                state.updated_at_ms = now;
                state.active_phase = None;
                json!({"run_id": state.run_id, "status": "completed", "result": result})
            }
            Err(error) => {
                let mut state = self.state.lock().unwrap();
                if state.status != "running" {
                    return Ok(());
                }
                state.status = "failed".to_string();
                state.updated_at_ms = now;
                state.active_phase = None;
                state.error = Some(error.clone());
                json!({"run_id": state.run_id, "status": "failed", "error": error})
            }
        };
        atomic_write_file(
            &output_path,
            serde_json::to_vec_pretty(&output).map_err(|error| {
                ToolError::Execution(format!("failed to serialize workflow output: {error}"))
            })?,
        )
        .map_err(|error| {
            ToolError::Execution(format!("failed to write workflow output: {error}"))
        })?;
        self.persist_state()?;
        self.append_json(&json!({
            "type": "workflow_finished",
            "timestamp_ms": now,
            "status": output["status"],
            "output_file": output_path,
        }))
    }

    fn cancel(&self) -> Result<(), ToolError> {
        let now = now_millis();
        let output_path = {
            let mut state = self.state.lock().unwrap();
            if state.status != "running" {
                return Ok(());
            }
            state.status = "cancelled".to_string();
            state.updated_at_ms = now;
            state.active_phase = None;
            state.error = Some("cancelled by user".to_string());
            state.output_path.clone()
        };
        atomic_write_file(
            &output_path,
            serde_json::to_vec_pretty(&json!({
                "run_id": self.state.lock().unwrap().run_id,
                "status": "cancelled",
                "error": "cancelled by user",
            }))
            .map_err(|error| {
                ToolError::Execution(format!("failed to serialize cancelled workflow: {error}"))
            })?,
        )
        .map_err(|error| {
            ToolError::Execution(format!(
                "failed to write cancelled workflow output: {error}"
            ))
        })?;
        self.persist_state()?;
        self.append_json(&json!({
            "type": "workflow_cancelled",
            "timestamp_ms": now,
            "output_file": output_path,
        }))
    }
}

impl EventSink for WorkflowRunStore {
    fn record(&self, event: WorkflowEvent) {
        let _event = self.events.lock().unwrap();
        let now = now_millis();
        let reused_agent = matches!(
            &event,
            WorkflowEvent::AgentStarted { agent_id, request }
                if cached_agent_request_matches(
                    &self
                        .run_dir
                        .join("agents")
                        .join(kcoder_state::artifact_id_path_component(agent_id)),
                    request
                )
        );
        let persisted = match &event {
            WorkflowEvent::AgentStarted { agent_id, request } => {
                if !valid_agent_artifact_id(agent_id) {
                    tracing::error!(agent_id, "refusing unsafe workflow agent artifact id");
                    return;
                }
                let agent_dir = self
                    .run_dir
                    .join("agents")
                    .join(kcoder_state::artifact_id_path_component(agent_id));
                let output_path = agent_dir.join("output.md");
                let request_path = agent_dir.join("request.json");
                let completed_path = agent_dir.join("completed");
                let reused = cached_agent_request_matches(&agent_dir, request);
                if !reused
                    && let Err(error) = secure_create_dir(&agent_dir).and_then(|_| {
                        secure_remove_file(&output_path)?;
                        secure_remove_file(&completed_path)?;
                        atomic_write_file(
                            &request_path,
                            serde_json::to_vec_pretty(request).map_err(std::io::Error::other)?,
                        )
                    })
                {
                    tracing::warn!(agent_id, %error, "failed to persist workflow agent request");
                }
                json!({
                    "type": if reused { "agent_reused" } else { "agent_started" },
                    "timestamp_ms": now,
                    "agent_id": agent_id,
                    "request": request,
                    "request_file": request_path,
                })
            }
            WorkflowEvent::AgentCompleted { agent_id, output } => {
                if !valid_agent_artifact_id(agent_id) {
                    tracing::error!(agent_id, "refusing unsafe workflow agent artifact id");
                    return;
                }
                let agent_dir = self
                    .run_dir
                    .join("agents")
                    .join(kcoder_state::artifact_id_path_component(agent_id));
                let output_path = agent_dir.join("output.md");
                let completed_path = agent_dir.join("completed");
                if let Err(error) = secure_create_dir(&agent_dir)
                    .and_then(|_| atomic_write_file(&output_path, output.as_bytes()))
                    .and_then(|_| atomic_write_file(&completed_path, b"ok\n"))
                {
                    tracing::warn!(agent_id, %error, "failed to persist workflow agent output");
                }
                json!({
                    "type": "agent_completed",
                    "timestamp_ms": now,
                    "agent_id": agent_id,
                    "output_file": output_path,
                    "output_preview": preview(output, 240),
                })
            }
            _ => {
                let mut value = serde_json::to_value(&event).unwrap_or_else(|error| {
                    json!({"type": "event_serialization_failed", "error": error.to_string()})
                });
                if let Some(object) = value.as_object_mut() {
                    object.insert("timestamp_ms".to_string(), json!(now));
                }
                value
            }
        };

        let flush_now = {
            let mut state = self.state.lock().unwrap();
            state.updated_at_ms = now;
            state.event_count += 1;
            match &event {
                WorkflowEvent::PhaseStarted { name } => state.active_phase = Some(name.clone()),
                WorkflowEvent::PhaseCompleted { name } => {
                    if state.active_phase.as_deref() == Some(name) {
                        state.active_phase = None;
                    }
                }
                WorkflowEvent::PhaseFailed { name, .. } => {
                    if state.active_phase.as_deref() == Some(name) {
                        state.active_phase = None;
                    }
                }
                WorkflowEvent::AgentStarted { .. } => {
                    state.agent_started += 1;
                    if reused_agent {
                        state.agent_reused += 1;
                    }
                }
                WorkflowEvent::AgentCompleted { .. } => state.agent_completed += 1,
                WorkflowEvent::AgentFailed { .. } => state.agent_failed += 1,
                WorkflowEvent::Log { .. } => {}
            }
            !matches!(event, WorkflowEvent::Log { .. })
                || state.event_count.is_multiple_of(JOURNAL_EVENT_BATCH)
        };
        let result = self
            .queue_json(&persisted)
            .and_then(|_| flush_now.then(|| self.persist_state()).transpose())
            .map(|_| ());
        if let Err(error) = result {
            tracing::warn!(%error, "failed to persist workflow event");
        }
    }
}

fn finish_workflow_result(
    store: &WorkflowRunStore,
    task_state: &kcoder_state::AppState,
    workflow_id: &str,
    result: Result<Value, WorkflowError>,
) -> ToolOutput {
    match result {
        Ok(value) => match store.finish(Ok(value.clone())) {
            Ok(()) => ToolOutput::text(
                json!({
                    "run_id": workflow_id,
                    "status": "completed",
                    "result": value,
                    "output_file": store.output_path(),
                })
                .to_string(),
            ),
            Err(error) => ToolOutput::error(error.to_string()),
        },
        Err(WorkflowError::Cancelled) => {
            task_state.update_task(workflow_id, |task| {
                task.status = TaskStatus::Cancelled;
                task.output = Some(WorkflowError::Cancelled.to_string());
                task.updated_at_ms = now_millis();
            });
            if let Err(error) = store.cancel() {
                tracing::warn!(%error, "failed to persist cancelled workflow state");
            }
            ToolOutput::error(WorkflowError::Cancelled.to_string())
        }
        Err(error) => {
            let message = error.to_string();
            if let Err(persist_error) = store.finish(Err(message.clone())) {
                tracing::warn!(%persist_error, "failed to persist failed workflow state");
            }
            ToolOutput::error(message)
        }
    }
}

struct ToolAgentExecutor {
    runner: Arc<dyn AgentRunner>,
    arrangement_mode: bool,
    resume_run_dir: Option<PathBuf>,
    cancellation: CancellationToken,
}

#[async_trait]
impl AgentExecutor for ToolAgentExecutor {
    async fn execute(&self, agent_id: &str, request: AgentRequest) -> Result<String, String> {
        if let Some(run_dir) = &self.resume_run_dir {
            let agent_dir = run_dir
                .join("agents")
                .join(kcoder_state::artifact_id_path_component(agent_id));
            let cached = agent_dir.join("output.md");
            if cached_agent_request_matches(&agent_dir, &request) {
                return secure_read_file(&cached, 16 * 1024 * 1024)
                    .and_then(|bytes| {
                        String::from_utf8(bytes).map_err(|error| {
                            std::io::Error::new(std::io::ErrorKind::InvalidData, error)
                        })
                    })
                    .map_err(|error| {
                        format!(
                            "failed to read cached workflow agent output `{}`: {error}",
                            cached.display()
                        )
                    });
            }
        }
        let kind = crate::AgentKind::from_alias(&request.agent_type)
            .ok_or_else(|| format!("unknown workflow agent_type `{}`", request.agent_type))?;
        if self.arrangement_mode
            && matches!(kind, crate::AgentKind::Implementer)
            && request.allowed_write_paths.is_empty()
        {
            return Err(
                "Arrangement workflow implementer agents require allowed_write_paths".to_string(),
            );
        }
        if self.arrangement_mode
            && !matches!(
                kind,
                crate::AgentKind::Implementer | crate::AgentKind::Verifier
            )
            && !request.allowed_write_paths.is_empty()
        {
            return Err(
                "only Arrangement implementer and verifier workflow agents may receive allowed_write_paths"
                    .to_string(),
            );
        }

        let contract = crate::agent::AgentTaskContract {
            allowed_write_paths: request.allowed_write_paths.clone(),
            allowed_shell_prefixes: Vec::new(),
            acceptance_criteria: request.acceptance_criteria,
            expected_artifacts: request.expected_artifacts,
            context_paths: request.context_paths,
            out_of_scope: request.out_of_scope,
            verification: request.verification,
        };
        let prompt = kind.build_prompt_with_contract(&request.prompt, Some(&contract));
        let options = AgentRunOptions::with_allowed_write_paths(request.allowed_write_paths)
            .with_block_shell_file_mutation(crate::agent::agent_kind_blocks_shell_file_mutation(
                kind,
                self.arrangement_mode,
            ))
            .with_arrangement_mode(self.arrangement_mode)
            .with_abort_token(self.cancellation.clone());
        self.runner
            .run_agent_session_with_options(
                agent_id.to_string(),
                prompt,
                request.max_turns,
                kind,
                options,
            )
            .await
            .map_err(|error| error.to_string())
    }
}

#[async_trait]
impl Tool for WorkflowTool {
    fn name(&self) -> String {
        "Workflow".to_string()
    }

    fn description(&self) -> String {
        "Run a deterministic JavaScript workflow in an embedded QuickJS runtime. Scripts may use agent(), parallel(), pipeline(), phase(), workflow(), log(), and args. Agent calls use real KCoder sub-agents; the workflow runs in the background and persists script, arguments, state, journal, per-agent output, and final output under the current session. No Bun or Node installation is required."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(WorkflowInput))
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let input: WorkflowInput = parse_input(&input)?;
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
        let (run_id, script, name, workflow_args, store, max_concurrency, is_resume, resume_lease) =
            if let Some(run_id) = resume_id {
                if input.script.is_some() || input.name.is_some() || input.script_path.is_some() {
                    return Err(ToolError::InvalidInput(
                        "resume cannot be combined with script, name, or script_path".to_string(),
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
                let (script, name, source) = resolve_script(&input, &ctx.state.cwd()).await?;
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
        let workflow_cancel = ctx
            .abort_token
            .as_ref()
            .map(CancellationToken::child_token)
            .unwrap_or_default();
        let executor: Arc<dyn AgentExecutor> = Arc::new(ToolAgentExecutor {
            runner,
            arrangement_mode: ctx.arrangement_mode,
            resume_run_dir: is_resume.then(|| store.run_dir.clone()),
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
            let result = WorkflowRuntime::execute(
                &script,
                workflow_args,
                executor,
                sink,
                WorkflowRuntimeConfig {
                    agent_id_prefix: workflow_id_for_result.clone(),
                    max_concurrency,
                    default_agent_max_turns: max_agent_turns,
                    max_agent_max_turns: MAX_AGENT_MAX_TURNS,
                    max_script_bytes: MAX_SCRIPT_BYTES,
                    max_runtime_millis: timeout_seconds.saturating_mul(1000),
                    cancellation_token: workflow_cancel,
                    ..WorkflowRuntimeConfig::default()
                },
            )
            .await;
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
    format!(
        "workflow-{}-{}",
        now_millis(),
        NEXT_WORKFLOW_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn preview(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let value = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{value}...")
    } else {
        value
    }
}

fn cached_agent_request_matches(agent_dir: &Path, request: &AgentRequest) -> bool {
    if !regular_file_without_symlink(&agent_dir.join("output.md"))
        || !regular_file_without_symlink(&agent_dir.join("completed"))
        || !regular_file_without_symlink(&agent_dir.join("request.json"))
    {
        return false;
    }
    secure_read_file(&agent_dir.join("request.json"), MAX_SCRIPT_BYTES)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<AgentRequest>(&bytes).ok())
        .is_some_and(|cached| cached == *request)
}

fn regular_file_without_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.file_type().is_file() && !metadata.file_type().is_symlink())
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

fn valid_agent_artifact_id(agent_id: &str) -> bool {
    !agent_id.is_empty()
        && agent_id.len() <= 160
        && agent_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[cfg(test)]
mod tests {
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
    struct RecordingRunner(Mutex<Vec<String>>);

    #[async_trait]
    impl AgentRunner for RecordingRunner {
        async fn run_agent(&self, prompt: String, _max_turns: usize) -> Result<String, AgentError> {
            Ok(format!("done:{prompt}"))
        }

        async fn run_agent_session_with_options(
            &self,
            agent_id: String,
            _prompt: String,
            _max_turns: usize,
            _agent_kind: crate::AgentKind,
            _options: AgentRunOptions,
        ) -> Result<String, AgentError> {
            self.0.lock().unwrap().push(agent_id);
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
