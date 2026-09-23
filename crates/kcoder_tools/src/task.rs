use crate::{LifecycleHookResult, Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use kcoder_state::{Task, TaskKind, TaskStatus};
use kcoder_types::ContentBlock;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use tokio::time::{Duration, Instant, sleep};

/// Create a new task in the task list.
#[derive(Debug, Default)]
pub struct TaskCreateTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskCreateInput {
    /// Brief user-visible task title.
    pub subject: String,
    /// What needs to be done and why it matters.
    pub description: String,
    /// Present-continuous form shown in the spinner when in progress, e.g.
    /// `Running tests`.
    #[serde(rename = "activeForm")]
    pub active_form: Option<String>,
    /// Optional arbitrary metadata object. Values must be valid JSON.
    pub metadata: Option<HashMap<String, Value>>,
}

/// Update a task in the task list.
#[derive(Debug, Default)]
pub struct TaskUpdateTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskUpdateInput {
    /// ID of the task to update.
    #[serde(rename = "taskId")]
    pub task_id: String,
    /// Optional replacement subject.
    pub subject: Option<String>,
    /// Optional replacement description.
    pub description: Option<String>,
    /// Optional replacement present-continuous form shown while in progress.
    #[serde(rename = "activeForm")]
    pub active_form: Option<String>,
    /// Optional new status enum: `pending`, `in_progress`, `completed`, or
    /// `deleted`.
    pub status: Option<TaskUpdateStatus>,
    /// Task IDs that this task blocks. Must be a JSON array of strings.
    #[serde(rename = "addBlocks")]
    pub add_blocks: Option<Vec<String>>,
    /// Task IDs that block this task. Must be a JSON array of strings.
    #[serde(rename = "addBlockedBy")]
    pub add_blocked_by: Option<Vec<String>>,
    /// Optional owner name or agent identifier.
    pub owner: Option<String>,
    /// Metadata keys to merge into the task. Set a key to null to delete it.
    /// Values must be valid JSON.
    pub metadata: Option<HashMap<String, Value>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TaskUpdateStatus {
    Pending,
    InProgress,
    Completed,
    Deleted,
}

/// List all tasks in the task list.
#[derive(Debug, Default)]
pub struct TaskListTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskListInput {}

/// Get a task by ID from the task list.
#[derive(Debug, Default)]
pub struct TaskGetTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskGetInput {
    /// The ID of the task to retrieve.
    #[serde(rename = "taskId")]
    pub task_id: String,
}

/// Read output/logs from a background task.
#[derive(Debug, Default)]
pub struct TaskOutputTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskOutputInput {
    /// Exact run to inspect; defaults to the run active when this call starts.
    #[serde(default)]
    pub run_id: Option<String>,
    /// ID of the background task to inspect.
    pub task_id: String,
    /// JSON boolean. Set true only when the result is on the current critical
    /// path; false performs a non-blocking status/output check.
    #[serde(default = "default_block")]
    pub block: bool,
    /// Maximum wait time in milliseconds when `block=true`. Use a JSON integer.
    #[serde(default)]
    pub timeout: Option<u64>,
}

fn default_block() -> bool {
    false
}

/// Stop a running background task by ID.
#[derive(Debug, Default)]
pub struct TaskStopTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TaskStopInput {
    /// ID of the background task to stop. Omit only when using the deprecated
    /// `shell_id` alias.
    pub task_id: Option<String>,
    /// Deprecated alias for task_id. Prefer `task_id`.
    pub shell_id: Option<String>,
}

/// Extra fields stored inside `Task.output` so the simple in-memory `Task`
/// type can carry the richer task-list metadata used by the TypeScript tools.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TaskPayload {
    #[serde(default)]
    subject: String,
    #[serde(default)]
    description: String,
    #[serde(
        rename = "activeForm",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    active_form: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    owner: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    blocks: Vec<String>,
    #[serde(rename = "blockedBy", default, skip_serializing_if = "Vec::is_empty")]
    blocked_by: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    metadata: Option<HashMap<String, Value>>,
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn make_task_id(ctx: &ToolContext) -> String {
    // Not `count + 1`: after a task is removed that scheme reuses a live id
    // and silently overwrites the existing task's state. Take the largest
    // numeric id instead.
    let max_id = ctx
        .state
        .tasks()
        .keys()
        .filter_map(|id| id.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    format!("{}", max_id + 1)
}

fn task_status_to_string(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Pending => "pending",
        TaskStatus::Running => "in_progress",
        TaskStatus::Paused => "paused",
        TaskStatus::Halted => "halted",
        TaskStatus::Completed => "completed",
        TaskStatus::Failed => "failed",
        TaskStatus::Cancelled => "cancelled",
    }
}

fn task_type(task: &Task) -> String {
    match task.kind {
        TaskKind::Subagent => "subagent".to_string(),
        TaskKind::Workflow => "workflow".to_string(),
        TaskKind::Generic => crate::background::tool_background_task_name(&task.description)
            .unwrap_or(if task.managed {
                "background_tool"
            } else {
                "task"
            })
            .to_ascii_lowercase(),
    }
}

fn task_delivery(task: &Task) -> &'static str {
    match task.delivery {
        kcoder_state::TaskDelivery::Foreground => "foreground",
        kcoder_state::TaskDelivery::Background => "background",
    }
}

fn parse_task_status(status: &TaskUpdateStatus) -> Option<TaskStatus> {
    match status {
        TaskUpdateStatus::Pending => Some(TaskStatus::Pending),
        TaskUpdateStatus::InProgress => Some(TaskStatus::Running),
        TaskUpdateStatus::Completed => Some(TaskStatus::Completed),
        TaskUpdateStatus::Deleted => None,
    }
}

fn load_payload(task: &Task) -> TaskPayload {
    let mut payload: TaskPayload = task
        .output
        .as_ref()
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default();
    if payload.subject.is_empty() {
        payload.subject = task.description.clone();
    }
    payload
}

fn save_payload(payload: &TaskPayload) -> String {
    serde_json::to_string(payload).unwrap_or_default()
}

fn payload_with_defaults(subject: &str, description: &str) -> TaskPayload {
    TaskPayload {
        subject: subject.to_string(),
        description: description.to_string(),
        ..Default::default()
    }
}

fn lifecycle_block_error(event: &str, result: &LifecycleHookResult) -> ToolError {
    ToolError::Execution(format!(
        "{event} hook blocked task operation: {}",
        result.block_reason()
    ))
}

fn append_lifecycle_messages(output: &mut ToolOutput, event: &str, result: &LifecycleHookResult) {
    for (text, is_error) in &result.messages {
        let level = if *is_error { "error" } else { "message" };
        output.content.push(ContentBlock::Text {
            text: format!("[hook:{event}:{level}] {text}"),
        });
    }
}

#[async_trait]
impl Tool for TaskCreateTool {
    fn name(&self) -> String {
        "TaskCreate".to_string()
    }

    fn description(&self) -> String {
        "Create a structured task in the session task list — the cross-turn orchestration layer. Tasks carry status, owner, and dependency edges (blockedBy/blocks), persist across turns, and emit <task_notification> on completion. Use it when work spans multiple turns, has ordered or dependent subtasks, or its progress must stay visible to the user across the session. Do NOT use it for the current turn's internal checklist: use TodoWrite for that instead (TodoWrite tracks what you are doing right now; TaskCreate tracks orchestrated work that outlives individual turns). Do not create tasks for a single trivial action. New tasks start as pending; use TaskUpdate to mark in_progress, completed, deleted, assign owner, or add dependencies.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(TaskCreateInput))
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: TaskCreateInput = parse_input(&input)?;
        let id = make_task_id(ctx);
        let payload = payload_with_defaults(&input.subject, &input.description);
        let mut payload = payload;
        payload.active_form = input.active_form;
        payload.metadata = input.metadata;

        let task = Task {
            id: id.clone(),
            description: input.subject.clone(),
            status: TaskStatus::Pending,
            output: Some(save_payload(&payload)),
            output_path: None,
            transcript_path: None,
            pending_messages: Vec::new(),
            message_queue: Vec::new(),
            dead_letter_messages: Vec::new(),
            delivery_lease_timeout_seconds: 120,
            delivery_max_attempts: 8,
            run_started_at_ms: None,
            background_run: None,
            background_runs: Vec::new(),
            created_at_ms: now_millis(),
            updated_at_ms: now_millis(),
            kind: TaskKind::Generic,
            managed: false,
            delivery: kcoder_state::TaskDelivery::Background,
            notification_injected_at_ms: None,
            notify_parent_on_completion: true,
            allowed_write_paths: Vec::new(),
            artifact_requirements: Vec::new(),
            artifact_validation_run: None,
            artifact_baseline: None,
            artifact_validation_report: None,
            allowed_shell_prefixes: Vec::new(),
            worktree_path: None,
            worktree_branch: None,
            parent_session_id: None,
            agent_kind: None,
            context_mode: None,
            context_turns: None,
            agent_depth: None,
            max_turns: None,
            arrangement_mode: None,
            agent_provider: None,
            agent_model: None,
            roster_name: None,
            resolved_profile_fingerprint: None,
            resolved_tool_allowlist: Vec::new(),
            orchestrate_work_id: None,
            review_vote_summary: None,
            current_progress: None,
            usage: Default::default(),
            control: Default::default(),
            breaker: Default::default(),
            parent_tool_call_id: None,
            accepting_subagent_messages: true,
        };

        ctx.state.upsert_task(task);
        let hook_result = ctx
            .emit_lifecycle_hook(
                "TaskCreated",
                id.clone(),
                serde_json::json!({
                    "task_id": id.clone(),
                    "subject": input.subject,
                    "description": input.description,
                    "active_form": payload.active_form,
                    "metadata": payload.metadata,
                    "status": "pending",
                }),
            )
            .await?;
        if hook_result.should_block() {
            ctx.state.remove_task(&id);
            return Err(lifecycle_block_error("TaskCreated", &hook_result));
        }

        let mut output = ToolOutput::text(
            serde_json::json!({
                "task": {
                    "id": id,
                    "subject": payload.subject,
                }
            })
            .to_string(),
        );
        append_lifecycle_messages(&mut output, "TaskCreated", &hook_result);
        Ok(output)
    }
}

#[async_trait]
impl Tool for TaskUpdateTool {
    fn name(&self) -> String {
        "TaskUpdate".to_string()
    }

    fn description(&self) -> String {
        "Update an existing task's status, title, description, owner, metadata, or dependency edges. Read the latest task state with TaskGet when unsure. Mark a task completed only after the described work is fully finished and verified; if blocked or partial, keep it in_progress and create/update a blocker task instead. Use status deleted only for obsolete or erroneous tasks.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(TaskUpdateInput))
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: TaskUpdateInput = parse_input(&input)?;

        let Some(mut task) = ctx.state.task(&input.task_id) else {
            return Ok(ToolOutput::text(
                serde_json::json!({
                    "success": false,
                    "taskId": input.task_id,
                    "updatedFields": [],
                    "error": "Task not found",
                })
                .to_string(),
            ));
        };

        // Managed tasks (background jobs, sub-agents) are owned by the
        // engine's lifecycle; letting the model forge their status would
        // fabricate terminal states for jobs that are still running.
        if task.managed && input.status.is_some() {
            return Ok(ToolOutput::text(
                serde_json::json!({
                    "success": false,
                    "taskId": input.task_id,
                    "updatedFields": [],
                    "error": "Task status is managed by the engine; use TaskStop to cancel a running background task.",
                })
                .to_string(),
            ));
        }

        let original_task = task.clone();
        let from_status = task.status;
        let mut updated_fields: Vec<String> = Vec::new();
        let mut payload = load_payload(&task);

        if let Some(subject) = input.subject {
            payload.subject = subject.clone();
            task.description = subject;
            updated_fields.push("subject".to_string());
        }

        if let Some(description) = input.description {
            payload.description = description;
            updated_fields.push("description".to_string());
        }

        if let Some(active_form) = input.active_form {
            payload.active_form = Some(active_form);
            updated_fields.push("activeForm".to_string());
        }

        if let Some(owner) = input.owner {
            payload.owner = Some(owner);
            updated_fields.push("owner".to_string());
        }

        if let Some(metadata) = input.metadata {
            let merged = payload.metadata.get_or_insert_with(HashMap::new);
            for (key, value) in metadata {
                if value.is_null() {
                    merged.remove(&key);
                } else {
                    merged.insert(key, value);
                }
            }
            updated_fields.push("metadata".to_string());
        }

        let mut status_change = None;
        if let Some(status) = input.status {
            if matches!(status, TaskUpdateStatus::Deleted) {
                task.status = TaskStatus::Cancelled;
                task.output = Some(save_payload(&payload));
                task.updated_at_ms = now_millis();
                ctx.state.upsert_task(task);
                return Ok(ToolOutput::text(
                    serde_json::json!({
                        "success": true,
                        "taskId": input.task_id,
                        "updatedFields": ["deleted"],
                        "statusChange": {
                            "from": task_status_to_string(from_status),
                            "to": "deleted",
                        }
                    })
                    .to_string(),
                ));
            }

            if let Some(new_status) = parse_task_status(&status)
                && new_status != task.status
            {
                status_change = Some((task.status, new_status));
                task.status = new_status;
                updated_fields.push("status".to_string());
            }
        }

        if let Some(add_blocks) = input.add_blocks {
            for block_id in add_blocks {
                if !payload.blocks.contains(&block_id) {
                    payload.blocks.push(block_id);
                }
            }
            if !payload.blocks.is_empty() {
                updated_fields.push("blocks".to_string());
            }
        }

        if let Some(add_blocked_by) = input.add_blocked_by {
            for blocker_id in add_blocked_by {
                if !payload.blocked_by.contains(&blocker_id) {
                    payload.blocked_by.push(blocker_id);
                }
            }
            if !payload.blocked_by.is_empty() {
                updated_fields.push("blockedBy".to_string());
            }
        }

        task.output = Some(save_payload(&payload));
        task.updated_at_ms = now_millis();
        let completed_payload = if matches!(status_change, Some((_, TaskStatus::Completed))) {
            Some(serde_json::json!({
                "task_id": input.task_id.clone(),
                "subject": payload.subject,
                "description": payload.description,
                "status_change": status_change.map(|(from, to)| {
                    serde_json::json!({
                        "from": task_status_to_string(from),
                        "to": task_status_to_string(to),
                    })
                }),
                "blocks": payload.blocks,
                "blocked_by": payload.blocked_by,
                "owner": payload.owner,
                "metadata": payload.metadata,
            }))
        } else {
            None
        };

        ctx.state.upsert_task(task);

        let hook_result = if let Some(data) = completed_payload {
            let result = ctx
                .emit_lifecycle_hook("TaskCompleted", input.task_id.clone(), data)
                .await?;
            if result.should_block() {
                ctx.state.upsert_task(original_task);
                return Err(lifecycle_block_error("TaskCompleted", &result));
            }
            result
        } else {
            LifecycleHookResult::default()
        };

        let mut output = ToolOutput::text(
            serde_json::json!({
                "success": true,
                "taskId": input.task_id,
                "updatedFields": updated_fields,
                "statusChange": status_change.map(|(from, to)| {
                    serde_json::json!({
                        "from": task_status_to_string(from),
                        "to": task_status_to_string(to),
                    })
                }),
            })
            .to_string(),
        );
        append_lifecycle_messages(&mut output, "TaskCompleted", &hook_result);
        Ok(output)
    }
}

#[async_trait]
impl Tool for TaskListTool {
    fn name(&self) -> String {
        "TaskList".to_string()
    }

    fn description(&self) -> String {
        "List current session tasks and managed background jobs with type, status, owner, and unresolved blockers. This includes sub-agents that automatically moved to background delivery. Use TaskOutput for the live output/status of one managed background job.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(TaskListInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let _: TaskListInput = parse_input(&input)?;
        let tasks = ctx.state.tasks();
        let completed_ids: HashSet<String> = tasks
            .values()
            .filter(|t| t.status == TaskStatus::Completed)
            .map(|t| t.id.clone())
            .collect();

        let task_summaries: Vec<Value> = tasks
            .values()
            .map(|task| {
                let payload = load_payload(task);
                let blocked_by: Vec<String> = payload
                    .blocked_by
                    .into_iter()
                    .filter(|id| !completed_ids.contains(id))
                    .collect();
                serde_json::json!({
                    "id": task.id,
                    "type": task_type(task),
                    "delivery": task_delivery(task),
                    "subject": payload.subject,
                    "status": task_status_to_string(task.status),
                    "owner": payload.owner,
                    "blockedBy": blocked_by,
                })
            })
            .collect();

        Ok(ToolOutput::text(
            serde_json::json!({ "tasks": task_summaries }).to_string(),
        ))
    }
}

#[async_trait]
impl Tool for TaskGetTool {
    fn name(&self) -> String {
        "TaskGet".to_string()
    }

    fn description(&self) -> String {
        "Retrieve details for one task or managed background job by ID, including its type, description, and dependency edges. Use TaskOutput instead when you need live output from a running background job.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(TaskGetInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: TaskGetInput = parse_input(&input)?;

        let Some(task) = ctx.state.task(&input.task_id) else {
            return Ok(ToolOutput::text(
                serde_json::json!({ "task": null }).to_string(),
            ));
        };

        let payload = load_payload(&task);
        Ok(ToolOutput::text(
            serde_json::json!({
                "task": {
                    "id": task.id,
                    "type": task_type(&task),
                    "delivery": task_delivery(&task),
                    "subject": payload.subject,
                    "description": payload.description,
                    "status": task_status_to_string(task.status),
                    "blocks": payload.blocks,
                    "blockedBy": payload.blocked_by,
                }
            })
            .to_string(),
        ))
    }
}

#[async_trait]
impl Tool for TaskOutputTool {
    fn name(&self) -> String {
        "TaskOutput".to_string()
    }

    fn description(&self) -> String {
        "Read status/output for any managed background task, including shell commands, workflows, and sub-agents that explicitly or automatically moved to background delivery. Use block=false for a non-blocking check and block=true only when the current step is blocked on the result. Do not poll by reflex; sub-agent completion is also delivered automatically.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        let mut schema = crate::clean_schema(schemars::schema_for!(TaskOutputInput));
        if let Value::Object(ref mut map) = schema
            && let Some(Value::Object(props)) = map.get_mut("properties")
        {
            props.insert(
                    "timeout".to_string(),
                    serde_json::json!({
                        "type": "integer",
                        "minimum": 1,
                        "default": 5000,
                        "description": "Maximum blocking wait time in milliseconds. Defaults to 5000. The effective default and bounds are configured by tool_limits.task_output_timeout_ms."
                    }),
                );
        }
        schema
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: TaskOutputInput = parse_input(&input)?;

        let binding = BackgroundReadBinding::capture(ctx, &input.task_id, input.run_id.as_deref())?;
        let task = binding.read(ctx)?;

        let payload = load_payload(&task);

        if !input.block {
            let retrieval_status =
                if task.status == TaskStatus::Running || task.status == TaskStatus::Pending {
                    "not_ready"
                } else {
                    "success"
                };
            return Ok(ToolOutput::text(build_output_value(
                retrieval_status,
                &task,
                &payload,
                None,
            ))
            .with_artifact_validation(Some(&task))
            .with_background_result_delivery(&task));
        }

        // Blocking wait: poll until the task is no longer running/pending.
        let timeout_settings = &ctx.tool_limits.task_output_timeout_ms;
        let timeout_ms = input
            .timeout
            .unwrap_or(timeout_settings.default_ms)
            .clamp(timeout_settings.min_ms, timeout_settings.max_ms);
        let timeout = Duration::from_millis(timeout_ms);
        let start = Instant::now();
        loop {
            if ctx.is_aborted() {
                return Err(ToolError::Aborted);
            }

            let current = binding.read(ctx)?;

            if current.status != TaskStatus::Running && current.status != TaskStatus::Pending {
                let payload = load_payload(&current);
                return Ok(ToolOutput::text(build_output_value(
                    "success",
                    &current,
                    &payload,
                    Some(timeout_ms),
                ))
                .with_artifact_validation(Some(&current))
                .with_background_result_delivery(&current));
            }

            if start.elapsed() >= timeout {
                let payload = load_payload(&current);
                return Ok(ToolOutput::text(build_output_value(
                    "timeout",
                    &current,
                    &payload,
                    Some(timeout_ms),
                ))
                .with_artifact_validation(Some(&current))
                .with_background_result_delivery(&current));
            }

            sleep(Duration::from_millis(100)).await;
        }
    }
}

/// Captures a read identity once; never silently follows an agent into its next run.
pub(crate) struct BackgroundReadBinding {
    id: String,
    run: Option<kcoder_types::BackgroundRunKey>,
    legacy_started_at: Option<u64>,
}

impl BackgroundReadBinding {
    pub(crate) fn capture(
        ctx: &ToolContext,
        id: &str,
        run_id: Option<&str>,
    ) -> Result<Self, ToolError> {
        let task = ctx
            .state
            .task(id)
            .ok_or_else(|| ToolError::InvalidInput(format!("task {id} not found")))?;
        let mut run = task.background_run.clone();
        if let Some(requested) = run_id {
            let key = run
                .as_mut()
                .ok_or_else(|| ToolError::InvalidInput("legacy task has no run identity".into()))?;
            key.run_id = requested.to_string();
        }
        Ok(Self {
            id: id.to_string(),
            run,
            legacy_started_at: task.run_started_at_ms,
        })
    }

    pub(crate) fn read(&self, ctx: &ToolContext) -> Result<Task, ToolError> {
        let task = self.peek(ctx)?;
        acknowledge_legacy_background_read(ctx, &task);
        Ok(task)
    }

    pub(crate) fn peek(&self, ctx: &ToolContext) -> Result<Task, ToolError> {
        let task = if let Some(run) = &self.run {
            ctx.state.task_for_background_run(run)
        } else {
            ctx.state.task(&self.id).filter(|task| {
                task.background_run.is_none() && task.run_started_at_ms == self.legacy_started_at
            })
        };
        let task = task.ok_or_else(|| {
            ToolError::Execution(format!(
                "task {} requested run is no longer available",
                self.id
            ))
        })?;
        Ok(task)
    }
}

fn acknowledge_legacy_background_read(ctx: &ToolContext, task: &Task) {
    if task.background_run.is_none()
        && !matches!(task.status, TaskStatus::Running | TaskStatus::Pending)
    {
        // Old histories have no durable run identity. Preserve their historical delivery marker,
        // but re-check under the state lock so a concurrently started modern run is never claimed.
        ctx.state.update_task(&task.id, |current| {
            if current.background_run.is_none()
                && current.run_started_at_ms == task.run_started_at_ms
                && !matches!(current.status, TaskStatus::Running | TaskStatus::Pending)
            {
                current
                    .notification_injected_at_ms
                    .get_or_insert_with(now_millis);
            }
        });
    }
}

/// Exposes only status flags from the trusted run ledger, never hook definitions or credentials.
pub(crate) fn background_delivery_diagnostics(task: &Task) -> Option<Value> {
    let run = task.background_run.as_ref()?;
    let record = task
        .background_runs
        .iter()
        .find(|record| &record.key == run)?;
    let followup_state = if record.followup_handled {
        "handled"
    } else if record.followup_started {
        "started_or_interrupted"
    } else if record.followup_turn_id.is_some() {
        "reserved"
    } else {
        "unreserved"
    };
    Some(serde_json::json!({
        "legacy_uncertain": record.legacy_uncertain,
        "suppressed": record.suppressed,
        "terminal_committed": record.terminal.is_some(),
        "tool_result_pending": record.pending_result_message_id.is_some() && record.delivered_message_id.is_none(),
        "hook_uncertain": (record.hook_claimed && !record.hook_completed)
            || record.hook_executions.values().any(|receipt| receipt.claimed && !receipt.completed),
        "followup_state": followup_state,
    }))
}

fn build_output_value(
    retrieval_status: &str,
    task: &Task,
    payload: &TaskPayload,
    effective_timeout_ms: Option<u64>,
) -> String {
    let output = resolved_task_output(task);
    let mut value = serde_json::json!({
        "retrieval_status": retrieval_status,
        "next_action": task_output_next_action(retrieval_status),
        "task": {
            "task_id": task.id,
            "run_id": task.background_run.as_ref().map(|run| &run.run_id),
            "task_type": task_type(task),
            "delivery": task_delivery(task),
            "status": task_status_to_string(task.status),
            "description": payload.subject,
            "output": output,
            "output_file": task.output_path.as_ref().map(|path| path.display().to_string()),
            "created_at_ms": task.created_at_ms,
            "updated_at_ms": task.updated_at_ms,
            "run_started_at_ms": task.run_started_at_ms,
        }
    });
    if let Some(diagnostics) = background_delivery_diagnostics(task) {
        value["delivery_diagnostics"] = diagnostics;
    }
    if let Some(timeout_ms) = effective_timeout_ms {
        value["effective_timeout_ms"] = serde_json::json!(timeout_ms);
    }
    value.to_string()
}

fn resolved_task_output(task: &Task) -> String {
    let file_output = task
        .output_path
        .as_deref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .filter(|text| !text.trim().is_empty());
    if matches!(task.kind, TaskKind::Generic) && matches!(task.status, TaskStatus::Cancelled) {
        return file_output
            .or_else(|| task.output.clone())
            .unwrap_or_else(|| "cancelled by user".to_string());
    }
    task.output.clone().or(file_output).unwrap_or_default()
}

fn task_output_next_action(retrieval_status: &str) -> &'static str {
    match retrieval_status {
        "timeout" => {
            "The task is still running. Do other useful work or poll later with a short timeout."
        }
        "not_ready" => "The task is still running. Avoid blocking unless its result is required.",
        "success" => {
            "Use the task output and stop polling this task unless more updates are expected."
        }
        _ => "Inspect the task status before deciding whether another poll is needed.",
    }
}

#[async_trait]
impl Tool for TaskStopTool {
    fn name(&self) -> String {
        "TaskStop".to_string()
    }

    fn description(&self) -> String {
        "Stop a running background task by task_id. Use only when a long-running task is no longer needed, is stuck, or the user asked to terminate it. Deprecated shell_id is accepted for old KillShell-style calls, but task_id is preferred.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(TaskStopInput))
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: TaskStopInput = parse_input(&input)?;
        let id = input.task_id.or(input.shell_id);

        let Some(id) = id else {
            return Ok(ToolOutput::error(
                "Missing required parameter: task_id".to_string(),
            ));
        };

        let Some(mut task) = ctx.state.task(&id) else {
            return Ok(ToolOutput::error(format!("No task found with ID: {}", id)));
        };
        let stopped_task_type = task_type(&task);

        if task.status != TaskStatus::Running {
            return Ok(ToolOutput::text(
                serde_json::json!({
                    "message": format!("Task {} is not running (status: {})", id, task_status_to_string(task.status)),
                    "task_id": id,
                    "task_type": stopped_task_type,
                })
                .to_string(),
            ));
        }

        // Delivery is acknowledged only after the returned tool result is committed.
        let aborted_background_job = ctx.abort_background_job(&id).await.unwrap_or(false);
        if aborted_background_job {
            ctx.state.update_task(&id, |current| {
                if matches!(current.status, TaskStatus::Pending | TaskStatus::Running) {
                    current.status = TaskStatus::Cancelled;
                    current
                        .output
                        .get_or_insert_with(|| "cancelled by user".to_string());
                    current.updated_at_ms = now_millis();
                }
            });
            let current = ctx.state.task(&id).ok_or_else(|| {
                ToolError::Execution("task disappeared after cancellation".to_string())
            })?;
            acknowledge_legacy_background_read(ctx, &current);
            return Ok(ToolOutput::text(
                serde_json::json!({
                    "message": format!("Successfully stopped task: {}", id),
                    "task_id": id,
                    "task_type": stopped_task_type,
                    "status": task_status_to_string(current.status),
                    "aborted_background_job": true,
                    "output": resolved_task_output(&current),
                    "command": current.description,
                })
                .to_string(),
            )
            .with_background_result_delivery(&current));
        }
        if let Some(current) = ctx.state.task(&id)
            && current.status != TaskStatus::Running
            && current.status != TaskStatus::Pending
        {
            return Ok(ToolOutput::text(
                    serde_json::json!({
                        "message": format!("Task {} finished before it could be stopped (status: {})", id, task_status_to_string(current.status)),
                        "task_id": id,
                        "task_type": stopped_task_type,
                        "aborted_background_job": false,
                    })
                    .to_string(),
                ));
        }

        task.status = TaskStatus::Cancelled;
        task.updated_at_ms = now_millis();
        let mut payload = load_payload(&task);
        payload
            .metadata
            .get_or_insert_with(HashMap::new)
            .insert("stopped".to_string(), Value::Bool(true));
        task.output = Some(save_payload(&payload));
        ctx.state.upsert_task(task);

        Ok(ToolOutput::text(
            serde_json::json!({
                "message": format!("Successfully stopped task: {}", id),
                "task_id": id,
                "task_type": stopped_task_type,
                "aborted_background_job": aborted_background_job,
                "command": payload.subject,
            })
            .to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::background::BackgroundJobEvent;
    use crate::{BackgroundJobSpawner, LifecycleHookEmitter, SpawnError};
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::{Arc, Mutex};

    fn output_text(output: &ToolOutput) -> String {
        output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn task_create_schema_is_object() {
        let tool = TaskCreateTool;
        let schema = tool.input_schema();
        assert_eq!(schema.get("type").unwrap(), "object");
        assert!(
            schema
                .get("properties")
                .unwrap()
                .as_object()
                .unwrap()
                .contains_key("subject")
        );
    }

    #[test]
    fn task_update_schema_is_object() {
        let tool = TaskUpdateTool;
        let schema = tool.input_schema();
        assert_eq!(schema.get("type").unwrap(), "object");
        assert!(
            schema
                .get("properties")
                .unwrap()
                .as_object()
                .unwrap()
                .contains_key("taskId")
        );
    }

    #[test]
    fn task_output_schema_bounds_timeout() {
        let tool = TaskOutputTool;
        let schema = tool.input_schema();
        let timeout = schema.get("properties").unwrap().get("timeout").unwrap();
        assert_eq!(timeout.get("minimum").unwrap(), 1);
        assert_eq!(timeout.get("default").unwrap(), 5000);
        assert!(timeout.get("maximum").is_none());
    }

    #[derive(Default)]
    struct FakeBackgroundJobManager {
        aborted: Mutex<Vec<String>>,
    }

    impl BackgroundJobSpawner for FakeBackgroundJobManager {
        fn spawn(
            &self,
            _description: String,
            _work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
            _max_concurrent: Option<usize>,
        ) -> Result<String, SpawnError> {
            Ok("job-unused".to_string())
        }

        fn subscribe(&self) -> tokio::sync::broadcast::Receiver<BackgroundJobEvent> {
            let (_, rx) = tokio::sync::broadcast::channel(1);
            rx
        }

        fn abort(&self, id: &str) -> bool {
            self.aborted.lock().unwrap().push(id.to_string());
            true
        }
    }

    #[derive(Default)]
    struct RecordingLifecycleEmitter {
        events: Mutex<Vec<(String, String, Value)>>,
        block_event: Mutex<Option<String>>,
    }

    #[async_trait::async_trait]
    impl LifecycleHookEmitter for RecordingLifecycleEmitter {
        async fn emit(&self, event: &str, query: String, data: Value) -> LifecycleHookResult {
            self.events
                .lock()
                .unwrap()
                .push((event.to_string(), query, data));
            if self
                .block_event
                .lock()
                .unwrap()
                .as_deref()
                .is_some_and(|blocked| blocked == event)
            {
                return LifecycleHookResult {
                    blocking_error: Some("blocked by test hook".to_string()),
                    ..LifecycleHookResult::default()
                };
            }
            LifecycleHookResult::default()
        }
    }

    #[tokio::test]
    async fn task_create_emits_task_created_hook() {
        let state = kcoder_state::AppState::new("/tmp");
        let emitter = Arc::new(RecordingLifecycleEmitter::default());
        let ctx = ToolContext::new(state.clone()).with_lifecycle_hooks(emitter.clone());

        TaskCreateTool
            .call(
                serde_json::json!({
                    "subject": "Wire hooks",
                    "description": "Connect lifecycle hooks"
                }),
                &ctx,
            )
            .await
            .unwrap();

        let events = emitter.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "TaskCreated");
        assert_eq!(events[0].2["subject"], "Wire hooks");
        assert_eq!(state.tasks().len(), 1);
    }

    #[tokio::test]
    async fn task_create_blocking_hook_rolls_back_task() {
        let state = kcoder_state::AppState::new("/tmp");
        let emitter = Arc::new(RecordingLifecycleEmitter::default());
        *emitter.block_event.lock().unwrap() = Some("TaskCreated".to_string());
        let ctx = ToolContext::new(state.clone()).with_lifecycle_hooks(emitter);

        let result = TaskCreateTool
            .call(
                serde_json::json!({
                    "subject": "Blocked",
                    "description": "Should not remain"
                }),
                &ctx,
            )
            .await;

        assert!(result.is_err());
        assert!(state.tasks().is_empty());
    }

    #[tokio::test]
    async fn task_update_completed_emits_task_completed_hook() {
        let state = kcoder_state::AppState::new("/tmp");
        let mut task = Task::new("task-1", "finish me");
        task.output = Some(save_payload(&payload_with_defaults(
            "finish me",
            "done when green",
        )));
        state.upsert_task(task);
        let emitter = Arc::new(RecordingLifecycleEmitter::default());
        let ctx = ToolContext::new(state.clone()).with_lifecycle_hooks(emitter.clone());

        TaskUpdateTool
            .call(
                serde_json::json!({
                    "taskId": "task-1",
                    "status": "completed"
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert_eq!(state.task("task-1").unwrap().status, TaskStatus::Completed);
        let events = emitter.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "TaskCompleted");
        assert_eq!(events[0].1, "task-1");
        assert_eq!(events[0].2["status_change"]["to"], "completed");
    }

    #[tokio::test]
    async fn task_completed_blocking_hook_rolls_back_status() {
        let state = kcoder_state::AppState::new("/tmp");
        let task = Task::new("task-1", "finish me");
        state.upsert_task(task);
        let emitter = Arc::new(RecordingLifecycleEmitter::default());
        *emitter.block_event.lock().unwrap() = Some("TaskCompleted".to_string());
        let ctx = ToolContext::new(state.clone()).with_lifecycle_hooks(emitter);

        let result = TaskUpdateTool
            .call(
                serde_json::json!({
                    "taskId": "task-1",
                    "status": "completed"
                }),
                &ctx,
            )
            .await;

        assert!(result.is_err());
        assert_eq!(state.task("task-1").unwrap().status, TaskStatus::Pending);
    }

    #[tokio::test]
    async fn task_stop_aborts_underlying_background_job() {
        let state = kcoder_state::AppState::new("/tmp");
        let mut task = Task::new("job-1", "long command");
        task.status = TaskStatus::Running;
        state.upsert_task(task);

        let manager = Arc::new(FakeBackgroundJobManager::default());
        let ctx = ToolContext::new(state.clone()).with_background_job_manager(manager.clone());

        let output = TaskStopTool
            .call(serde_json::json!({ "task_id": "job-1" }), &ctx)
            .await
            .unwrap();

        assert_eq!(manager.aborted.lock().unwrap().as_slice(), ["job-1"]);
        assert_eq!(state.task("job-1").unwrap().status, TaskStatus::Cancelled);

        let text = output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["aborted_background_job"], true);
        assert!(
            state
                .task("job-1")
                .unwrap()
                .notification_injected_at_ms
                .is_some()
        );
    }

    #[tokio::test]
    async fn task_output_preserves_legacy_delivery_marker() {
        let state = kcoder_state::AppState::new("/tmp");
        let mut task = Task::new(
            "job-done",
            crate::background::tool_background_description("ocr", "review"),
        );
        task.managed = true;
        task.status = TaskStatus::Completed;
        task.output = Some("review done".to_string());
        state.upsert_task(task);
        let ctx = ToolContext::new(state.clone());

        let output = TaskOutputTool
            .call(
                serde_json::json!({"task_id": "job-done", "block": false}),
                &ctx,
            )
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&output_text(&output)).unwrap();
        assert_eq!(value["task"]["output"], "review done");
        assert!(
            state
                .task("job-done")
                .unwrap()
                .notification_injected_at_ms
                .is_some()
        );
    }

    #[tokio::test]
    async fn task_output_returns_requested_old_run_without_consuming_it() {
        let state = kcoder_state::AppState::new("/tmp");
        let mut task = Task::new("multi-run", "subagent");
        task.kind = TaskKind::Subagent;
        task.status = TaskStatus::Running;
        state.upsert_task(task);
        let first = state.begin_background_run("multi-run").unwrap();
        state.update_task("multi-run", |task| {
            task.output = Some("first result".into())
        });
        state
            .commit_background_terminal(
                &kcoder_types::BackgroundEventIdentity::terminal(first.clone()),
                TaskStatus::Completed,
                None,
            )
            .unwrap();
        let binding =
            BackgroundReadBinding::capture(&ToolContext::new(state.clone()), "multi-run", None)
                .unwrap();
        let second = state.begin_background_run("multi-run").unwrap();
        state.update_task("multi-run", |task| {
            task.status = TaskStatus::Running;
            task.output = Some("second in progress".into());
        });
        let ctx = ToolContext::new(state.clone());
        assert_eq!(
            binding.read(&ctx).unwrap().output.as_deref(),
            Some("first result")
        );
        let output = TaskOutputTool
            .call(
                serde_json::json!({
                    "task_id": "multi-run", "run_id": first.run_id, "block": false
                }),
                &ctx,
            )
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&output_text(&output)).unwrap();
        assert_eq!(value["task"]["output"], "first result");
        assert_eq!(value["task"]["run_id"], first.run_id);
        assert_eq!(
            value["delivery_diagnostics"],
            serde_json::json!({
                "legacy_uncertain": false,
                "suppressed": false,
                "terminal_committed": true,
                "tool_result_pending": false,
                "hook_uncertain": false,
                "followup_state": "unreserved",
            })
        );
        assert!(
            output
                .execution_metadata
                .iter()
                .any(|metadata| matches!(metadata,
            crate::ToolExecutionMetadata::BackgroundResultDelivery { run } if run == &first))
        );
        assert!(
            state
                .background_run_record(&first)
                .unwrap()
                .delivered_message_id
                .is_none()
        );
        assert_eq!(
            state.task("multi-run").unwrap().background_run,
            Some(second)
        );
    }

    #[test]
    fn raw_background_task_output_keeps_task_description() {
        let mut task = Task::new("job-raw", "cargo test");
        task.status = TaskStatus::Completed;
        task.output = Some("stdout:\nok".to_string());
        let payload = load_payload(&task);

        let value: serde_json::Value =
            serde_json::from_str(&build_output_value("success", &task, &payload, None)).unwrap();

        assert_eq!(value["task"]["description"], "cargo test");
        assert_eq!(value["task"]["output"], "stdout:\nok");
    }

    #[test]
    fn task_output_identifies_subagent_and_exposes_output_file() {
        let mut task = Task::new("job-agent", "Review agent: inspect parser");
        task.kind = TaskKind::Subagent;
        task.status = TaskStatus::Running;
        task.output_path = Some(std::path::PathBuf::from(
            "/tmp/subagents/job-agent/output.md",
        ));
        let payload = load_payload(&task);

        let value: serde_json::Value =
            serde_json::from_str(&build_output_value("not_ready", &task, &payload, None)).unwrap();

        assert_eq!(value["task"]["task_type"], "subagent");
        assert_eq!(
            value["task"]["output_file"],
            "/tmp/subagents/job-agent/output.md"
        );
    }

    #[test]
    fn task_output_identifies_managed_shell_and_delivery_mode() {
        let mut task = Task::new(
            "job-shell",
            crate::background::tool_background_description("bash", "cargo test"),
        );
        task.managed = true;
        task.delivery = kcoder_state::TaskDelivery::Background;
        task.status = TaskStatus::Running;
        let payload = load_payload(&task);

        let value: serde_json::Value =
            serde_json::from_str(&build_output_value("not_ready", &task, &payload, None)).unwrap();

        assert_eq!(value["task"]["task_type"], "bash");
        assert_eq!(value["task"]["delivery"], "background");
        assert_eq!(value["task"]["status"], "in_progress");
    }

    #[test]
    fn task_output_preserves_terminal_failure_and_cancellation_statuses() {
        assert_eq!(task_status_to_string(TaskStatus::Completed), "completed");
        assert_eq!(task_status_to_string(TaskStatus::Failed), "failed");
        assert_eq!(task_status_to_string(TaskStatus::Cancelled), "cancelled");
    }

    #[test]
    fn cancelled_managed_command_preserves_partial_output_file() {
        let tmp = tempfile::tempdir().unwrap();
        let output_path = tmp.path().join("output.txt");
        std::fs::write(&output_path, "stdout:\nearly output\n").unwrap();
        let mut task = Task::new(
            "job-cancelled-output",
            crate::background::tool_background_description("PowerShell", "slow command"),
        );
        task.kind = TaskKind::Generic;
        task.managed = true;
        task.status = TaskStatus::Cancelled;
        task.output = None;
        task.output_path = Some(output_path);
        let payload = load_payload(&task);

        let value: serde_json::Value =
            serde_json::from_str(&build_output_value("success", &task, &payload, None)).unwrap();

        assert_eq!(value["task"]["status"], "cancelled");
        assert_eq!(value["task"]["output"], "stdout:\nearly output\n");
    }
}
