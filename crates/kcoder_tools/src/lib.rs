use async_trait::async_trait;
use kcoder_types::ContentBlock;
use serde_json::Value;
use thiserror::Error;

pub mod agent;
pub mod agent_fleet;
pub mod apply_patch;
pub mod arrangement;
pub mod ask_user_question;
pub mod background;
pub mod bash;
pub mod bundled_skills;
pub mod close_agent;
pub mod config_tool;
mod context;
pub mod control_agent;
pub mod cron;
pub mod ctx_inspect;
pub mod session_inspect;
pub mod discover_skills;
pub mod edit;
pub mod file;
pub mod glob;
pub mod goal;
pub mod grep;
mod input_schema;
pub mod local_memory_recall;
pub mod lsp;
pub mod memory;
pub mod moa_plan;
pub mod ocr;
pub mod orchestrate;
pub mod os_sandbox;
pub mod plan;
mod peer_guidance;
pub use peer_guidance::project_builtin_peer_guidance;
pub mod powershell;
mod process;
mod pdf_read;
mod registry;
pub mod repl;
pub mod review_vote;
mod ripgrep;
pub mod sandbox;
pub mod semantic_coerce;
pub mod send_message;
pub mod shell_snapshot;
pub mod skill;
pub mod skill_curator;
pub mod skill_guard;
pub mod skill_hub;
pub mod skill_manage;
pub mod skill_provenance;
pub mod skill_telemetry;
pub mod sleep;
pub mod snip;
pub mod specs;
pub mod task;
mod text_file;
pub mod todo;
pub mod truncate;
pub mod user_question;
pub mod verifier_vote;
pub mod wait_agent;
pub mod web_browser;
pub mod web_fetch;
pub mod web_search;
#[cfg(windows)]
mod windows_sandbox;
pub mod workflow;
pub mod worktree;
pub mod write;

pub use agent::{AgentKind, AgentTool, ExploreAgentTool, PlanAgentTool};
pub use agent_fleet::AgentFleetTool;
pub use apply_patch::ApplyPatchTool;
pub use arrangement::{
    AppendNotepadTool, EditPlanTool, EditReportTool, WritePlanTool, WriteReportTool,
};
pub use ask_user_question::AskUserQuestionTool;
pub use bash::BashTool;
pub use close_agent::CloseAgentTool;
pub use config_tool::ConfigTool;
pub use context::{
    AgentArtifactExecution, AgentDeliveryContext, AgentError, AgentPersonaOptions, AgentRunOptions,
    AgentRunResult, AgentRunner, AgentRuntimeSelection, AgentToolExecution, BackgroundJobSpawner,
    LifecycleHookEmitter, LifecycleHookResult, MAX_SUBAGENT_DEPTH, SkillGuardPolicy, SpawnError,
    SubagentContextMode, ToolCapabilities, ToolContext, ToolContextView, VerifierRunOptions,
    VerifierTestOrigin, VerifierWorkspaceBaseline, check_allowed_write_path,
};
pub use control_agent::ControlAgentTool;
pub use cron::{CronCreateTool, CronDeleteTool, CronFire, CronListTool, CronScheduler};
pub use ctx_inspect::CtxInspectTool;
pub use discover_skills::DiscoverSkillsTool;
pub use edit::FileEditTool;
pub use file::FileReadTool;
pub use glob::GlobTool;
pub use goal::{CreateGoalTool, GetGoalTool, UpdateGoalTool};
pub use grep::GrepTool;
pub use input_schema::{
    clean_schema, coerce_input, coerce_input_with_options, description_with_input_shape,
    example_input_for_schema, inline_local_schema_refs_for_model, normalize_tool_input,
    parse_input, schema_with_parameter_guidance, validate_input_against_schema,
};
pub use local_memory_recall::LocalMemoryRecallTool;
pub use memory::{MemoryGetTool, MemorySearchTool, MemoryTool};
pub use moa_plan::{MoaPlanSubmission, SubmitMoaPlanTool};
pub use ocr::OcrReviewTool;
pub use orchestrate::{
    AppendWorkNotepadTool, CreateWorkPlanTool, EditWorkPlanTool, PlanProgressTool,
    RecordTaskAcceptanceTool, RecordTaskAcceptancesTool, ReopenTaskTool, SelectActiveWorkTool,
};
pub use plan::{EnterPlanModeTool, ExitPlanModeTool, VerifyPlanExecutionTool};
pub use powershell::PowerShellTool;
pub use registry::{ToolRegistrationError, ToolRegistry, ToolRegistryRevision, ToolSource};
pub use repl::REPLTool;
pub use review_vote::{
    REVIEW_VOTE_TOOL_NAME, ReviewFinding, ReviewVoteChannel, ReviewVoteExpectation,
    ReviewVoteInput, ReviewVoteOutcome, ReviewVoteRecord, ReviewVoteTool,
};
pub use sandbox::Sandbox;
pub use semantic_coerce::{CoercionOptions, CoercionResult};
pub use send_message::{SendMessageTool, SubagentSteerReceipt, SubagentSteerStatus};
pub use shell_snapshot::ShellEnvironmentSnapshot;
pub use skill::SkillTool;
pub use skill_curator::SkillCuratorTool;
pub use skill_guard::SkillGuardTool;
pub use skill_hub::SkillHubTool;
pub use skill_manage::SkillManageTool;
pub use sleep::SleepTool;
pub use snip::SnipTool;
pub use specs::{
    SpecArchiveTool, SpecCheckTool, SpecConfigTool, SpecInitTool, SpecNewChangeTool,
    SpecParallelDraftTool, SpecRecordVerificationTool, SpecReviewTool, SpecStatusTool,
    SpecSyncTool, SpecUpdateTool,
};
pub use task::{
    TaskCreateTool, TaskGetTool, TaskListTool, TaskOutputTool, TaskStopTool, TaskUpdateTool,
};
pub use todo::TodoWriteTool;
pub use truncate::{
    TruncatedText, truncate_and_spill, truncate_text, truncate_text_with_reason,
    truncate_tool_output,
};
pub use user_question::{
    DenyAllUserQuestioner, Question, QuestionOption, UserQuestionRequest, UserQuestionResponse,
    UserQuestioner,
};
pub use verifier_vote::{
    VERIFIER_VOTE_TOOL_NAME, VerifiedCommand, VerifierVoteChannel, VerifierVoteInput,
    VerifierVoteOutcome, VerifierVoteRecord, VerifierVoteTool,
};
pub use wait_agent::WaitAgentTool;
pub use web_browser::WebBrowserTool;
pub use web_fetch::WebFetchTool;
pub use web_search::WebSearchTool;
pub use workflow::WorkflowTool;
pub use worktree::{EnterWorktreeTool, ExitWorktreeTool, WorktreeCreateTool, WorktreeRemoveTool};
pub use write::FileWriteTool;

#[derive(Debug, Error)]
pub enum ToolError {
    #[error("input validation failed: {0}")]
    InvalidInput(String),
    #[error("tool execution failed: {0}")]
    Execution(String),
    #[error("sandbox denied: {reason}")]
    SandboxDenied {
        reason: String,
        output: Option<String>,
    },
    #[error("tool was aborted")]
    Aborted,
}

/// Output produced by a tool invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolExecutionMetadata {
    /// A terminal background result returned by a trusted tool; acknowledged only after history commit.
    BackgroundResultDelivery { run: kcoder_types::BackgroundRunKey },
    /// Runtime observations loaded from the task's committed validation report.
    ArtifactValidation(kcoder_state::ArtifactValidationReport),
    /// Generated directly from `ExitStatus` by the shell implementation and never constructed from transcript text.
    Process {
        exit_code: Option<i32>,
        signal: Option<i32>,
        cwd: std::path::PathBuf,
    },
    /// Stable artifact identity generated by a file tool after a successful write.
    Artifact {
        path: std::path::PathBuf,
        sha256: String,
    },
}

#[derive(Debug, Clone)]
pub struct ToolOutput {
    pub content: Vec<ContentBlock>,
    pub is_error: bool,
    /// Trusted execution metadata produced by the runtime and never serialized into a model-forgeable transcript.
    pub execution_metadata: Vec<ToolExecutionMetadata>,
    /// Synthetic user content appended after this tool's `tool_result`.
    ///
    /// Keep tool-protocol output concise and correctly paired; pass normalized context such as activated skills in a later user message.
    pub user_context: Vec<ContentBlock>,
}

fn artifact_freshness_report_supported(
    task: &kcoder_state::Task,
    report: &kcoder_state::ArtifactValidationReport,
) -> bool {
    use kcoder_state::{ArtifactBaselineState, ArtifactValidationStatus};
    if report.entries.len() != task.artifact_requirements.len() {
        return false;
    }
    let valid_hash = |entry: &kcoder_state::ArtifactValidationEntry| {
        entry.size_bytes.is_some()
            && entry.sha256.as_ref().is_some_and(|hash| {
                hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
    };
    task.artifact_requirements
        .iter()
        .zip(&report.entries)
        .enumerate()
        .all(|(index, (requirement, entry))| {
            if entry.index != index || entry.path != requirement.path {
                return false;
            }
            if !requirement.require_changed || entry.status != ArtifactValidationStatus::Passed {
                return true;
            }
            let previous = task
                .artifact_baseline
                .as_ref()
                .filter(|baseline| {
                    baseline.run == report.run && baseline.state == ArtifactBaselineState::Ready
                })
                .and_then(|baseline| baseline.entries.get(index))
                .filter(|previous| previous.index == index && previous.path == requirement.path);
            valid_hash(entry)
                && previous.is_some_and(|previous| match previous.status {
                    ArtifactValidationStatus::Missing
                    | ArtifactValidationStatus::SkippedMissing => true,
                    ArtifactValidationStatus::Passed if valid_hash(previous) => !previous
                        .sha256
                        .as_ref()
                        .unwrap()
                        .eq_ignore_ascii_case(entry.sha256.as_ref().unwrap()),
                    _ => false,
                })
        })
}

impl ToolOutput {
    /// Attach only current durable observations, never model-authored report text.
    pub fn with_artifact_validation(mut self, task: Option<&kcoder_state::Task>) -> Self {
        self.execution_metadata
            .retain(|metadata| !matches!(metadata, ToolExecutionMetadata::ArtifactValidation(_)));
        let Some(task) = task else { return self };
        if task.artifact_requirements.is_empty() {
            return self;
        }
        let report = task.artifact_validation_report.as_ref().filter(|report| {
            task.status == kcoder_state::TaskStatus::Completed
                && task.artifact_validation_run.as_ref() == Some(&report.run)
                && report.run.declarations_sha256
                    == kcoder_state::artifact_declarations_sha256(&task.artifact_requirements)
                && artifact_freshness_report_supported(task, report)
        });
        let status = match report {
            Some(report) if report.failure_count() > 0 => "failed",
            Some(report) if report.unavailable_count() == 0 => "passed",
            _ => "unavailable",
        };
        if let Some(report) = report {
            self.execution_metadata
                .push(ToolExecutionMetadata::ArtifactValidation(report.clone()));
        }
        for block in &mut self.content {
            if let ContentBlock::Text { text } = block
                && let Ok(mut value) = serde_json::from_str::<serde_json::Value>(text)
                && let Some(object) = value.as_object_mut()
            {
                object.insert(
                    "artifact_validation_status".into(),
                    serde_json::json!(status),
                );
                object.remove("artifact_validation_report");
                if let Some(report) = report {
                    object.insert(
                        "artifact_validation_report".into(),
                        serde_json::to_value(report).expect("report serializes"),
                    );
                }
                *text = value.to_string();
                break;
            }
        }
        self
    }
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![ContentBlock::Text { text: text.into() }],
            is_error: false,
            execution_metadata: Vec::new(),
            user_context: Vec::new(),
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            content: vec![ContentBlock::Text { text: text.into() }],
            is_error: true,
            execution_metadata: Vec::new(),
            user_context: Vec::new(),
        }
    }

    pub fn with_user_context(mut self, content: Vec<ContentBlock>) -> Self {
        self.user_context = content;
        self
    }

    pub fn with_background_result_delivery(mut self, task: &kcoder_state::Task) -> Self {
        if matches!(
            task.status,
            kcoder_state::TaskStatus::Completed
                | kcoder_state::TaskStatus::Failed
                | kcoder_state::TaskStatus::Cancelled
                | kcoder_state::TaskStatus::Halted
        ) && let Some(run) = &task.background_run
        {
            self.execution_metadata
                .push(ToolExecutionMetadata::BackgroundResultDelivery { run: run.clone() });
        }
        self
    }

    pub fn with_execution_metadata(mut self, metadata: ToolExecutionMetadata) -> Self {
        self.execution_metadata.push(metadata);
        self
    }
}

/// Trait implemented by every built-in tool.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum ToolInputFormat {
    #[default]
    Json,
    Freeform {
        syntax: String,
        example: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolPermissionMode {
    Ask,
    Auto,
    AcceptEdits,
    DontAsk,
    Bypass,
    Yolo,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolDescriptionContext {
    pub permission_mode: ToolPermissionMode,
    pub is_non_interactive: bool,
    pub active_skills: Vec<String>,
    /// Final names attached to this request, after mode/permission/terminal filtering.
    pub available_tools: std::collections::HashSet<String>,
}

#[async_trait]
pub trait Tool: Send + Sync + std::any::Any {
    /// Tool name exposed to the model. Dynamic (e.g. MCP) tools return an owned
    /// string; built-in tools usually return a static string via `.to_string()`.
    fn name(&self) -> String;
    /// Stable provenance for diagnostics, never an authorization grant.
    fn source(&self) -> ToolSource {
        ToolSource::Builtin
    }
    /// Human-readable description exposed to the model.
    fn description(&self) -> String;
    /// Optional UI-only metadata; never included in the model tool definition.
    fn ui_metadata(&self) -> kcoder_types::tool_ui::ToolUiMetadata {
        let mut metadata = kcoder_types::tool_ui::ToolUiMetadata::fallback(&self.name());
        metadata.description = self.description();
        metadata.bounded(&self.name())
    }
    async fn description_for_model(
        &self,
        _input: Option<&Value>,
        _ctx: &ToolDescriptionContext,
    ) -> String {
        self.description()
    }
    fn input_schema(&self) -> Value;
    /// Opt in only when input_schema is immutable for this object's entire lifetime.
    /// Mutable or externally supplied implementations default to fresh reads.
    /// This does not freeze input_format or description_for_model.
    fn input_schema_is_stable(&self) -> bool {
        false
    }
    fn input_format(&self) -> ToolInputFormat {
        ToolInputFormat::Json
    }
    fn is_read_only(&self) -> bool {
        false
    }
    fn is_destructive(&self) -> bool {
        false
    }
    /// Whether this invocation may run in parallel with another tool call from
    /// the same model response.
    ///
    /// The default is deliberately fail-closed. Implementations may return
    /// `true` only when concurrent calls cannot mutate shared runtime state,
    /// race on files or fixed temporary paths, prompt for user input, or depend
    /// on ordering relative to another tool. Read-only filesystem/network
    /// operations with internally synchronized caches are typical safe cases.
    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    /// Execute the tool with the given JSON input.
    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError>;
}

/// Default tool registry.
pub fn default_registry() -> ToolRegistry {
    default_registry_for_platform(ToolPlatform::current())
}

/// Core registry for local models, including development, multi-agent, task, goal, and web tools.
pub fn core_registry() -> ToolRegistry {
    core_registry_for_platform(ToolPlatform::current())
}

/// Minimal registry for small local models, retaining basic development tools without user-question tools.
pub fn nano_registry() -> ToolRegistry {
    nano_registry_for_platform(ToolPlatform::current())
}

/// Tool registry for the Arrangement main orchestrator. It can read, plan,
/// delegate, supervise, and report, but it cannot directly edit source files or
/// run shell commands. Worker sub-agents should be built from a separate full
/// registry and then filtered by role.
pub fn arrangement_orchestrator_registry() -> ToolRegistry {
    ToolRegistry::new()
        .register(FileReadTool)
        .register(GlobTool)
        .register(GrepTool)
        .register(MemorySearchTool)
        .register(MemoryGetTool)
        .register(PlanAgentTool)
        .register(AgentTool)
        .register(ExploreAgentTool)
        .register(WorkflowTool)
        .register(SendMessageTool)
        .register(WaitAgentTool)
        .register(CloseAgentTool)
        .register(TodoWriteTool)
        .register(AskUserQuestionTool)
        .register(EditPlanTool)
        .register(WriteReportTool)
        .register(EditReportTool)
        .register(AppendNotepadTool)
        .register(WebFetchTool)
        .register(WebSearchTool::default())
        .register(CtxInspectTool)
        .register(SkillTool)
        .register(DiscoverSkillsTool)
        .register(GetGoalTool)
        .register(UpdateGoalTool)
        .register(CronCreateTool)
        .register(CronDeleteTool)
        .register(CronListTool)
        .register(SleepTool)
}

/// Primary orchestration tool surface for orchestration sessions. It is separate
/// from legacy Arrangement goals so `/ultgoal` retains its established registry and schema during compatibility.
pub fn orchestrate_orchestrator_registry() -> ToolRegistry {
    ToolRegistry::new()
        .register(FileReadTool)
        .register(GlobTool)
        .register(GrepTool)
        .register(MemorySearchTool)
        .register(MemoryGetTool)
        .register(PlanAgentTool)
        .register(AgentTool)
        .register(ExploreAgentTool)
        .register(WorkflowTool)
        .register(SendMessageTool)
        .register(AgentFleetTool)
        .register(ControlAgentTool)
        .register(WaitAgentTool)
        .register(CloseAgentTool)
        .register(TodoWriteTool)
        .register(AskUserQuestionTool)
        .register(CreateWorkPlanTool)
        .register(EditWorkPlanTool)
        .register(AppendWorkNotepadTool)
        .register(RecordTaskAcceptanceTool)
        .register(RecordTaskAcceptancesTool)
        .register(ReopenTaskTool)
        .register(SelectActiveWorkTool)
        .register(PlanProgressTool)
        .register(WriteReportTool)
        .register(EditReportTool)
        .register(WebFetchTool)
        .register(WebSearchTool::default())
        .register(CtxInspectTool)
        .register(SkillTool)
        .register(DiscoverSkillsTool)
        .register(GetGoalTool)
        .register(UpdateGoalTool)
        .register(CronCreateTool)
        .register(CronDeleteTool)
        .register(CronListTool)
        .register(SleepTool)
}

/// Tool registry for Arrangement sub-agents before role filtering. It keeps the
/// full worker tool surface and adds plan-artifact writing for Plan agents.
pub fn arrangement_subagent_registry() -> ToolRegistry {
    default_registry().register(WritePlanTool)
}

pub fn orchestrate_subagent_registry() -> ToolRegistry {
    arrangement_subagent_registry()
        .register(CreateWorkPlanTool)
        .register(AppendWorkNotepadTool)
        .register(PlanProgressTool)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolPlatform {
    Windows,
    UnixLike,
}

impl ToolPlatform {
    fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::UnixLike
        }
    }
}

fn default_registry_for_platform(platform: ToolPlatform) -> ToolRegistry {
    let registry = ToolRegistry::new()
        .register(FileReadTool)
        .register(FileWriteTool)
        .register(FileEditTool)
        .register(ApplyPatchTool)
        .register(GlobTool)
        .register(GrepTool)
        .register(MemoryTool)
        .register(MemorySearchTool)
        .register(MemoryGetTool)
        .register(SkillTool)
        .register(SkillCuratorTool)
        .register(SkillGuardTool)
        .register(SkillHubTool)
        .register(SkillManageTool)
        .register(AgentTool)
        .register(ExploreAgentTool)
        .register(SendMessageTool)
        .register(AskUserQuestionTool)
        .register(TodoWriteTool)
        .register(TaskCreateTool)
        .register(TaskUpdateTool)
        .register(TaskListTool)
        .register(TaskGetTool)
        .register(TaskOutputTool)
        .register(TaskStopTool)
        .register(WaitAgentTool)
        .register(CloseAgentTool)
        .register(WebFetchTool)
        .register(WebSearchTool::default())
        .register(CtxInspectTool)
        .register(OcrReviewTool)
        .register(LocalMemoryRecallTool)
        .register(GetGoalTool)
        .register(CreateGoalTool)
        .register(UpdateGoalTool)
        .register(CronCreateTool)
        .register(CronDeleteTool)
        .register(CronListTool)
        .register(DiscoverSkillsTool)
        .register(SleepTool)
        .register(SnipTool)
        .register(EnterPlanModeTool)
        .register(ExitPlanModeTool)
        .register(VerifyPlanExecutionTool)
        .register(REPLTool)
        .register(WorkflowTool)
        .register(WebBrowserTool)
        .register(EnterWorktreeTool)
        .register(ExitWorktreeTool)
        .register(WorktreeCreateTool)
        .register(WorktreeRemoveTool)
        .register(SpecInitTool)
        .register(SpecNewChangeTool)
        .register(SpecArchiveTool)
        .register(SpecStatusTool)
        .register(SpecUpdateTool)
        .register(SpecCheckTool)
        .register(SpecSyncTool)
        .register(SpecRecordVerificationTool)
        .register(SpecReviewTool)
        .register(SpecParallelDraftTool)
        .register(SpecConfigTool);

    match platform {
        ToolPlatform::Windows => registry.register(PowerShellTool),
        ToolPlatform::UnixLike => registry.register(BashTool),
    }
}

fn core_registry_for_platform(platform: ToolPlatform) -> ToolRegistry {
    nano_registry_for_platform(platform)
        .register(AgentTool)
        .register(ExploreAgentTool)
        .register(SendMessageTool)
        .register(WaitAgentTool)
        .register(CloseAgentTool)
        .register(TaskCreateTool)
        .register(TaskUpdateTool)
        .register(TaskListTool)
        .register(TaskGetTool)
        .register(TaskOutputTool)
        .register(TaskStopTool)
        .register(GetGoalTool)
        .register(CreateGoalTool)
        .register(UpdateGoalTool)
        .register(WebFetchTool)
        .register(WebSearchTool::default())
        .register(WebBrowserTool)
}

fn nano_registry_for_platform(platform: ToolPlatform) -> ToolRegistry {
    let registry = ToolRegistry::new()
        .register(CtxInspectTool)
        .register(FileReadTool)
        .register(FileWriteTool)
        .register(FileEditTool)
        .register(ApplyPatchTool)
        .register(GlobTool)
        .register(GrepTool)
        .register(TodoWriteTool)
        .register(SleepTool);

    match platform {
        ToolPlatform::Windows => registry.register(PowerShellTool),
        ToolPlatform::UnixLike => registry.register(BashTool),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn artifact_freshness_report_requires_matching_baseline() {
        use super::*;
        use kcoder_state::*;
        let mut task = Task::new("fresh", "observe");
        task.status = TaskStatus::Completed;
        task.artifact_requirements = serde_json::from_value(serde_json::json!([
            {"path":"artifact","require_changed":true}
        ]))
        .unwrap();
        let run = ArtifactValidationRun {
            run_id: "run".into(),
            delivery_key: None,
            declarations_sha256: artifact_declarations_sha256(&task.artifact_requirements),
        };
        let entry = ArtifactValidationEntry {
            index: 0,
            path: "artifact".into(),
            status: ArtifactValidationStatus::Passed,
            size_bytes: Some(1),
            sha256: Some("a".repeat(64)),
        };
        task.artifact_validation_run = Some(run.clone());
        task.artifact_validation_report = Some(ArtifactValidationReport {
            run: run.clone(),
            observed_at_ms: 1,
            entries: vec![entry.clone()],
        });
        let visible = |task: &Task| {
            !ToolOutput::text("{}")
                .with_artifact_validation(Some(task))
                .execution_metadata
                .is_empty()
        };
        assert!(
            !visible(&task),
            "a legacy success without baseline must be hidden"
        );
        task.artifact_baseline = Some(ArtifactBaseline {
            run,
            state: ArtifactBaselineState::Ready,
            entries: vec![entry],
        });
        assert!(
            !visible(&task),
            "unchanged bytes cannot support a passed report"
        );
        task.artifact_baseline.as_mut().unwrap().entries[0].sha256 = Some("b".repeat(64));
        assert!(visible(&task));
        task.artifact_baseline.as_mut().unwrap().entries[0].sha256 = Some("invalid".into());
        assert!(!visible(&task));
        task.artifact_baseline.as_mut().unwrap().entries[0].status =
            ArtifactValidationStatus::Missing;
        assert!(visible(&task));
        task.artifact_baseline.as_mut().unwrap().entries[0].path = "other".into();
        assert!(!visible(&task));
    }

    #[test]
    fn artifact_validation_redecoration_clears_old_report_metadata() {
        use super::*;
        let mut task = kcoder_state::Task::new("artifact", "observe");
        task.status = kcoder_state::TaskStatus::Completed;
        task.artifact_requirements =
            serde_json::from_value(serde_json::json!([{"path":"artifact"}])).unwrap();
        let run = kcoder_state::ArtifactValidationRun {
            run_id: "old-run".into(),
            declarations_sha256: kcoder_state::artifact_declarations_sha256(
                &task.artifact_requirements,
            ),
            delivery_key: None,
        };
        task.artifact_validation_run = Some(run.clone());
        task.artifact_validation_report = Some(kcoder_state::ArtifactValidationReport {
            run,
            observed_at_ms: 1,
            entries: vec![kcoder_state::ArtifactValidationEntry {
                index: 0,
                path: "artifact".into(),
                status: kcoder_state::ArtifactValidationStatus::Passed,
                size_bytes: Some(1),
                sha256: Some("observed".into()),
            }],
        });
        let process = ToolExecutionMetadata::Process {
            exit_code: Some(0),
            signal: None,
            cwd: std::path::PathBuf::from("workspace"),
        };
        let completed = ToolOutput::text("{}")
            .with_execution_metadata(process.clone())
            .with_artifact_validation(Some(&task));
        assert_eq!(completed.execution_metadata.len(), 2);
        task.status = kcoder_state::TaskStatus::Running;
        let pending = completed.with_artifact_validation(Some(&task));
        assert_eq!(pending.execution_metadata, vec![process]);
        let ContentBlock::Text { text } = &pending.content[0] else {
            panic!("text")
        };
        let value: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(value["artifact_validation_status"], "unavailable");
        assert!(value.get("artifact_validation_report").is_none());
    }

    #[test]
    fn artifact_validation_report_is_hidden_during_new_run_or_preflight_failure() {
        use super::*;
        let mut task = kcoder_state::Task::new("artifact", "observe");
        task.artifact_requirements =
            serde_json::from_value(serde_json::json!([{"path":"artifact"}])).unwrap();
        let run = kcoder_state::ArtifactValidationRun {
            run_id: "old-run".into(),
            declarations_sha256: kcoder_state::artifact_declarations_sha256(
                &task.artifact_requirements,
            ),
            delivery_key: None,
        };
        task.artifact_validation_run = Some(run.clone());
        task.artifact_validation_report = Some(kcoder_state::ArtifactValidationReport {
            run,
            observed_at_ms: 1,
            entries: vec![kcoder_state::ArtifactValidationEntry {
                index: 0,
                path: "artifact".into(),
                status: kcoder_state::ArtifactValidationStatus::Passed,
                size_bytes: Some(1),
                sha256: Some("observed".into()),
            }],
        });
        for status in [
            kcoder_state::TaskStatus::Pending,
            kcoder_state::TaskStatus::Running,
            kcoder_state::TaskStatus::Failed,
            kcoder_state::TaskStatus::Cancelled,
        ] {
            task.status = status;
            let output = ToolOutput::text("{}").with_artifact_validation(Some(&task));
            assert!(
                output.execution_metadata.is_empty(),
                "old report leaked for {status:?}"
            );
            let ContentBlock::Text { text } = &output.content[0] else {
                panic!("text")
            };
            let value: serde_json::Value = serde_json::from_str(text).unwrap();
            assert_eq!(value["artifact_validation_status"], "unavailable");
            assert!(value.get("artifact_validation_report").is_none());
        }
        task.status = kcoder_state::TaskStatus::Completed;
        assert_eq!(
            ToolOutput::text("{}")
                .with_artifact_validation(Some(&task))
                .execution_metadata
                .len(),
            1
        );
        task.artifact_validation_report = None;
        let missing = ToolOutput::text("{}").with_artifact_validation(Some(&task));
        assert!(missing.execution_metadata.is_empty());
        assert!(
            matches!(&missing.content[..], [ContentBlock::Text { text }] if text.contains("unavailable"))
        );
        task.artifact_requirements.clear();
        assert!(
            ToolOutput::text("{}")
                .with_artifact_validation(Some(&task))
                .execution_metadata
                .is_empty()
        );
    }

    #[test]
    fn builtin_ui_metadata_describes_file_and_shell_tools() {
        use kcoder_types::tool_ui::{ToolUiGroup, ToolUiIcon};
        let registry = super::default_registry_for_platform(super::ToolPlatform::UnixLike);
        for (name, label, group, icon) in [
            ("read", "Read file", ToolUiGroup::Files, ToolUiIcon::File),
            ("edit", "Edit file", ToolUiGroup::Files, ToolUiIcon::File),
            ("write", "Write file", ToolUiGroup::Files, ToolUiIcon::File),
            (
                "bash",
                "Run command",
                ToolUiGroup::Terminal,
                ToolUiIcon::Terminal,
            ),
        ] {
            let metadata = registry.get(name).unwrap().ui_metadata();
            assert_eq!(metadata.display_name, label);
            assert_eq!(metadata.group, group);
            assert_eq!(metadata.icon, icon);
        }
    }

    use super::*;
    use std::sync::Arc;

    #[test]
    fn dynamic_registration_keeps_original_on_collision() {
        struct NamedTool(&'static str);
        #[async_trait]
        impl Tool for NamedTool {
            fn name(&self) -> String {
                "read".into()
            }
            fn description(&self) -> String {
                self.0.into()
            }
            fn input_schema(&self) -> Value {
                serde_json::json!({})
            }
            async fn call(&self, _: Value, _: &ToolContext) -> Result<ToolOutput, ToolError> {
                Ok(ToolOutput::text(self.0))
            }
        }
        let mut registry = ToolRegistry::new().register(NamedTool("original"));
        let errors = registry.extend([Arc::new(NamedTool("replacement")) as Arc<dyn Tool>]);
        assert_eq!(errors.len(), 1);
        assert_eq!(registry.get("read").unwrap().description(), "original");
    }

    #[test]
    fn default_registry_exposes_only_goal_tool_names() {
        let names = default_registry().names();
        let removed_suffix = ["lo", "op"].concat();

        for name in ["get_goal", "create_goal", "update_goal"] {
            assert!(names.contains(&name.to_string()));
        }
        for verb in ["get", "create", "update"] {
            let legacy_name = format!("{verb}_{removed_suffix}");
            assert!(!names.contains(&legacy_name.to_string()));
        }
    }

    #[test]
    fn arrangement_orchestrator_registry_excludes_direct_mutation_tools() {
        let names = arrangement_orchestrator_registry().names();

        assert!(names.contains(&"read".to_string()));
        assert!(names.contains(&"PlanAgent".to_string()));
        assert!(names.contains(&"EditPlan".to_string()));
        assert!(names.contains(&"WriteReport".to_string()));
        assert!(names.contains(&"update_goal".to_string()));
        let removed_suffix = ["lo", "op"].concat();
        for verb in ["get", "create", "update"] {
            assert!(!names.contains(&format!("{verb}_{removed_suffix}")));
        }
        assert!(!names.contains(&"bash".to_string()));
        assert!(!names.contains(&"PowerShell".to_string()));
        assert!(!names.contains(&"edit".to_string()));
        assert!(!names.contains(&"write".to_string()));
        assert!(!names.contains(&"WritePlan".to_string()));
    }

    #[test]
    fn arrangement_subagent_registry_adds_plan_artifact_tool() {
        let names = arrangement_subagent_registry().names();

        assert!(names.contains(&"WritePlan".to_string()));
        assert!(names.contains(&"edit".to_string()));
        assert!(names.contains(&"write".to_string()));
    }

    #[test]
    fn orchestrate_registry_adds_planstore_controls_without_direct_mutation_tools() {
        let names = orchestrate_orchestrator_registry().names();

        for required in [
            "AgentFleet",
            "ControlAgent",
            "CreateWorkPlan",
            "EditWorkPlan",
            "AppendWorkNotepad",
            "RecordTaskAcceptance",
            "RecordTaskAcceptances",
            "ReopenTask",
            "SelectActiveWork",
            "PlanProgress",
        ] {
            assert!(names.contains(&required.to_string()), "missing {required}");
        }
        for forbidden in ["bash", "PowerShell", "edit", "write", "WritePlan"] {
            assert!(
                !names.contains(&forbidden.to_string()),
                "Orchestrate main agent must not expose {forbidden}"
            );
        }
    }

    #[test]
    fn orchestrate_optional_tool_config_matches_registered_non_core_tools() {
        let names = orchestrate_orchestrator_registry()
            .names()
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        let core = kcoder_config::orchestrate_main_core_tools();
        let optional = kcoder_config::orchestrate_main_optional_tools();

        for required in core {
            assert!(
                !optional.contains(required),
                "core tool must not be configurable: {required}"
            );
        }
        let classified = core
            .iter()
            .chain(optional.iter())
            .map(|name| (*name).to_string())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(
            names, classified,
            "every Orchestrate main tool must be explicitly classified as core or optional"
        );
    }

    #[test]
    fn filtered_out_by_patterns_removes_exact_and_prefix_matches() {
        let registry = default_registry();
        let filtered = registry.filtered_out_by_patterns(&[
            "Spec*".to_string(),
            "memory_*".to_string(),
            "LocalMemoryRecall".to_string(),
        ]);
        let names = filtered.names();
        assert!(
            !names.iter().any(|name| name.starts_with("Spec")),
            "Spec tools must be gone: {names:?}"
        );
        assert!(!names.contains(&"memory_search".to_string()));
        assert!(!names.contains(&"memory_get".to_string()));
        assert!(!names.contains(&"LocalMemoryRecall".to_string()));
        // Unrelated tools stay.
        assert!(names.contains(&"bash".to_string()));
        assert!(names.contains(&"read".to_string()));
        // Empty pattern list keeps the registry intact.
        assert_eq!(
            registry.names(),
            registry.filtered_out_by_patterns(&[]).names()
        );
    }

    #[test]
    fn read_tool_schema_is_object() {
        let registry = default_registry();
        let read = registry.get("read").unwrap();
        let schema = read.input_schema();
        assert_eq!(schema.get("type").unwrap(), "object");
        assert!(
            !schema
                .get("properties")
                .unwrap()
                .as_object()
                .unwrap()
                .is_empty()
        );
        assert!(!schema.as_object().unwrap().contains_key("$schema"));
    }

    #[test]
    fn default_registry_includes_ask_user_question() {
        let registry = default_registry();
        let tool = registry.get("AskUserQuestion");
        assert!(tool.is_some(), "AskUserQuestion tool should be registered");
        assert_eq!(tool.unwrap().name(), "AskUserQuestion");
    }

    #[test]
    fn default_registry_includes_explore_agent() {
        let registry = default_registry();
        let tool = registry.get("explore_agent");
        assert!(tool.is_some(), "explore_agent tool should be registered");
        let tool = tool.unwrap();
        assert_eq!(tool.name(), "explore_agent");
        assert!(tool.description().contains("read-only"));
        assert!(tool.description().contains("Prefer this tool"));
    }

    #[test]
    fn default_registry_includes_send_message() {
        let registry = default_registry();
        let tool = registry.get("SendMessage");
        assert!(tool.is_some(), "SendMessage tool should be registered");
        assert_eq!(tool.unwrap().name(), "SendMessage");
    }

    #[test]
    fn default_registry_includes_structured_memory_tools() {
        let registry = default_registry();
        assert!(registry.get("memory_search").is_some());
        assert!(registry.get("memory_get").is_some());
        assert!(registry.get("memory_summary_search").is_none());
        assert!(registry.get("memory_timeline").is_none());
    }

    #[test]
    fn default_registry_exposes_twenty_consolidated_memory_skill_and_spec_tools() {
        let registry = default_registry();
        let expected = [
            "remember",
            "memory_search",
            "memory_get",
            "LocalMemoryRecall",
            "skill",
            "skill_manage",
            "skill_hub",
            "skill_curator",
            "skill_guard",
            "SpecInit",
            "SpecUpdate",
            "SpecNewChange",
            "SpecArchive",
            "SpecSync",
            "SpecParallelDraft",
            "SpecRecordVerification",
            "SpecStatus",
            "SpecCheck",
            "SpecReview",
            "SpecConfig",
        ];
        assert_eq!(expected.len(), 20);
        for name in expected {
            assert!(registry.get(name).is_some(), "{name} should be registered");
        }
        for removed in [
            "memory_summary_search",
            "memory_timeline",
            "skill_sync",
            "skill_usage",
        ] {
            assert!(
                registry.get(removed).is_none(),
                "{removed} should be removed"
            );
        }
    }

    #[test]
    fn default_registry_includes_ocr_tool() {
        let registry = default_registry();
        let tool = registry.get("ocr");
        assert!(tool.is_some(), "ocr tool should be registered");
        assert_eq!(tool.unwrap().name(), "ocr");
    }

    #[test]
    fn default_registry_includes_worktree_lifecycle_tools() {
        let registry = default_registry();
        assert!(registry.get("EnterWorktree").is_some());
        assert!(registry.get("ExitWorktree").is_some());
        assert!(registry.get("WorktreeCreate").is_some());
        assert!(registry.get("WorktreeRemove").is_some());
    }

    #[test]
    fn built_in_registries_explicitly_opt_into_stable_schemas() {
        for registry in [
            default_registry_for_platform(ToolPlatform::UnixLike),
            default_registry_for_platform(ToolPlatform::Windows),
            arrangement_orchestrator_registry(),
            arrangement_subagent_registry(),
        ] {
            for tool in registry.all() {
                assert!(tool.input_schema_is_stable(), "{}", tool.name());
                assert_eq!(tool.input_schema(), tool.input_schema(), "{}", tool.name());
            }
        }
    }

    #[test]
    fn default_registry_uses_platform_shell_tools() {
        let unix = default_registry_for_platform(ToolPlatform::UnixLike);
        assert!(unix.get("bash").is_some());
        assert!(unix.get("PowerShell").is_none());

        let windows = default_registry_for_platform(ToolPlatform::Windows);
        assert!(windows.get("PowerShell").is_some());
        assert!(windows.get("bash").is_none());
    }

    #[test]
    fn core_registry_uses_platform_shell_tools() {
        let unix = core_registry_for_platform(ToolPlatform::UnixLike);
        assert!(unix.get("bash").is_some());
        assert!(unix.get("PowerShell").is_none());

        let windows = core_registry_for_platform(ToolPlatform::Windows);
        assert!(windows.get("PowerShell").is_some());
        assert!(windows.get("bash").is_none());
    }

    #[test]
    fn nano_registry_uses_platform_shell_tools() {
        let unix = nano_registry_for_platform(ToolPlatform::UnixLike);
        assert!(unix.get("bash").is_some());
        assert!(unix.get("PowerShell").is_none());

        let windows = nano_registry_for_platform(ToolPlatform::Windows);
        assert!(windows.get("PowerShell").is_some());
        assert!(windows.get("bash").is_none());
    }

    #[test]
    fn default_registry_matches_current_platform_shell_tool() {
        let registry = default_registry();
        if cfg!(windows) {
            assert!(registry.get("PowerShell").is_some());
            assert!(registry.get("bash").is_none());
        } else {
            assert!(registry.get("bash").is_some());
            assert!(registry.get("PowerShell").is_none());
        }
    }

    #[test]
    fn registry_iteration_is_stable_by_tool_name() {
        let registry = default_registry();
        let names = registry.names();
        let all_names = registry
            .all()
            .into_iter()
            .map(|tool| tool.name())
            .collect::<Vec<_>>();

        assert!(names.windows(2).all(|pair| pair[0] <= pair[1]));
        assert_eq!(all_names, names);
    }

    #[test]
    fn core_registry_includes_agents_tasks_goals_and_web() {
        let registry = core_registry();

        for name in [
            "spawn_agent",
            "explore_agent",
            "SendMessage",
            "wait",
            "close_agent",
            "TaskCreate",
            "TaskUpdate",
            "TaskList",
            "TaskGet",
            "TaskOutput",
            "TaskStop",
            "get_goal",
            "create_goal",
            "update_goal",
            "WebFetch",
            "WebSearch",
            "WebBrowser",
        ] {
            assert!(registry.get(name).is_some(), "{name} should be registered");
        }
        for full_only in ["remember", "skill", "Workflow", "SpecInit"] {
            assert!(
                registry.get(full_only).is_none(),
                "{full_only} should remain full-only"
            );
        }
        assert!(registry.get("AskUserQuestion").is_none());
    }

    #[test]
    fn nano_registry_keeps_small_local_model_tools_without_questions() {
        let registry = nano_registry();

        for name in [
            "read",
            "write",
            "edit",
            "glob",
            "grep",
            "TodoWrite",
            "Sleep",
        ] {
            assert!(registry.get(name).is_some(), "{name} should be registered");
        }
        assert!(registry.get("AskUserQuestion").is_none());
        assert!(registry.get("spawn_agent").is_none());
        assert!(registry.get("TaskCreate").is_none());
        assert!(registry.get("get_goal").is_none());
        assert!(registry.get("WebSearch").is_none());
        assert!(registry.names().len() <= 10);
    }

    #[test]
    fn registries_include_apply_patch_and_exclude_removed_review_artifacts() {
        let default = default_registry();
        let core = core_registry();
        let nano = nano_registry();

        // Both edit surfaces are always registered; the engine hides the
        // inactive one per tools.file_edit_tool (see the engine surface tests).
        for registry in [&default, &core, &nano] {
            assert!(registry.get("edit").is_some());
            assert!(registry.get("apply_patch").is_some());
            assert!(registry.get("ReviewArtifact").is_none());
        }
        // The Arrangement orchestrator is read-only and gets neither surface.
        assert!(arrangement_orchestrator_registry().get("edit").is_none());
        assert!(
            arrangement_orchestrator_registry()
                .get("apply_patch")
                .is_none()
        );
    }

    #[tokio::test]
    async fn description_for_model_defaults_to_static_description() {
        let tool = FileReadTool;
        let ctx = ToolDescriptionContext {
            permission_mode: ToolPermissionMode::Ask,
            is_non_interactive: false,
            active_skills: Vec::new(),
            available_tools: Default::default(),
        };

        assert_eq!(
            tool.description_for_model(None, &ctx).await,
            tool.description()
        );
    }

    #[test]
    fn ask_user_question_description_contains_shape_guardrails() {
        let tool = AskUserQuestionTool;
        let description = tool.description();

        assert!(description.contains("\"questions\":["));
        assert!(description.contains("\"options\":["));
        assert!(description.contains("always an array"));
        assert!(description.contains("label"));
        assert!(description.contains("description"));
        assert!(description.contains("multi_select"));
        assert!(description.contains("Do not send"));
    }

    #[test]
    fn default_registry_includes_consolidated_spec_tools() {
        let registry = default_registry();
        for name in ["SpecStatus", "SpecCheck", "SpecReview", "SpecConfig"] {
            assert!(registry.get(name).is_some(), "{name} should be registered");
        }
        for removed in [
            "SpecShow",
            "SpecValidate",
            "SpecVerify",
            "SpecApplyPreflight",
            "SpecReviewDispatch",
            "SpecReviewWriteback",
            "SpecConfigGet",
            "SpecConfigSet",
        ] {
            assert!(
                registry.get(removed).is_none(),
                "{removed} should be removed"
            );
        }
    }

    #[test]
    fn default_registry_includes_spec_parallel_draft() {
        let registry = default_registry();
        let tool = registry.get("SpecParallelDraft");
        assert!(
            tool.is_some(),
            "SpecParallelDraft tool should be registered"
        );
        assert_eq!(tool.unwrap().name(), "SpecParallelDraft");
    }

    #[test]
    fn default_registry_includes_spec_update() {
        let registry = default_registry();
        let tool = registry.get("SpecUpdate");
        assert!(tool.is_some(), "SpecUpdate tool should be registered");
        assert_eq!(tool.unwrap().name(), "SpecUpdate");
    }

    #[test]
    fn default_registry_includes_spec_record_verification() {
        let registry = default_registry();
        let tool = registry.get("SpecRecordVerification");
        assert!(
            tool.is_some(),
            "SpecRecordVerification tool should be registered"
        );
        assert_eq!(tool.unwrap().name(), "SpecRecordVerification");
    }

    #[test]
    fn user_question_response_type_is_exported() {
        // Compile-time check that the response type is reachable from the crate root.
        let _response = UserQuestionResponse {
            questions: Vec::new(),
            answers: std::collections::HashMap::new(),
            annotations: None,
        };
    }

    #[test]
    fn example_input_for_schema_shows_nested_array_shapes() {
        let tool = AskUserQuestionTool;
        let example = example_input_for_schema(&tool.input_schema())
            .expect("AskUserQuestion schema should produce an example");

        assert!(example["questions"].is_array());
        assert!(example["questions"][0]["options"].is_array());
        assert_eq!(
            example["questions"][0]["question"],
            "Which option should I choose?"
        );
        assert_eq!(example["questions"][0]["options"][0]["label"], "Option A");
    }

    #[test]
    fn description_with_input_shape_leaves_structural_contract_in_schema() {
        let tool = AskUserQuestionTool;
        let schema = tool.input_schema();
        assert_eq!(description_with_input_shape("  Ask the user.  ", &schema), "Ask the user.");
        assert_eq!(schema["type"], "object");
        assert!(schema["required"].as_array().unwrap().contains(&serde_json::json!("questions")));
        assert_eq!(schema["properties"]["questions"]["type"], "array");
    }

    #[test]
    fn schema_with_parameter_guidance_enriches_nested_question_schema() {
        let tool = AskUserQuestionTool;
        let schema = schema_with_parameter_guidance(&tool.name(), &tool.input_schema());
        let properties = schema["properties"].as_object().unwrap();
        let questions_description = properties["questions"]["description"].as_str().unwrap();
        assert!(questions_description.contains("Must be a JSON array"));
        assert!(questions_description.contains("1-4 question objects"));

        let question_properties = schema["definitions"]["QuestionInput"]["properties"]
            .as_object()
            .unwrap();
        let options_description = question_properties["options"]["description"]
            .as_str()
            .unwrap();
        assert!(options_description.contains("2-4 option objects"));
        assert!(options_description.contains("do not include an `Other` option"));
        assert_eq!(question_properties["options"]["type"], "array");
        assert!(!options_description.contains("Use a real JSON array"));

        let option_properties = schema["definitions"]["QuestionOptionInput"]["properties"]
            .as_object()
            .unwrap();
        let label_description = option_properties["label"]["description"].as_str().unwrap();
        assert!(label_description.contains("1-5 words"));
        let description_description = option_properties["description"]["description"]
            .as_str()
            .unwrap();
        assert!(description_description.contains("impact"));
        assert!(description_description.contains("trade-off"));
    }

    #[test]
    fn schema_with_parameter_guidance_enriches_todo_array_schema() {
        let tool = TodoWriteTool;
        let schema = schema_with_parameter_guidance(&tool.name(), &tool.input_schema());
        let todos_description = schema["properties"]["TodoList"]["description"]
            .as_str()
            .unwrap();
        assert!(todos_description.contains("Complete replacement TodoList"));
        assert_eq!(schema["properties"]["TodoList"]["type"], "array");
        assert!(!todos_description.contains("numeric-key object"));
        assert!(todos_description.contains("placeholder strings"));
        assert!(todos_description.contains("{\"TodoList\":[\"\"]}"));
        assert!(todos_description.contains("Do not send `null`"));
        assert!(todos_description.contains("null-valued fields"));
        assert!(todos_description.contains("all todos are completed"));

        let item_properties = schema["definitions"]["TodoWriteItem"]["properties"]
            .as_object()
            .unwrap();
        assert!(
            item_properties["content"]["description"]
                .as_str()
                .unwrap()
                .contains("non-null string")
        );
        assert!(
            item_properties["activeForm"]["description"]
                .as_str()
                .unwrap()
                .contains("Present-continuous")
        );
        assert!(
            item_properties["activeForm"]["description"]
                .as_str()
                .unwrap()
                .contains("do not send `null`")
        );
        assert!(
            item_properties["status"]["description"]
                .as_str()
                .unwrap()
                .contains("non-null enum string")
        );
    }

    #[test]
    fn inline_local_schema_refs_exposes_todo_item_shape_to_models() {
        let tool = TodoWriteTool;
        let schema = schema_with_parameter_guidance(&tool.name(), &tool.input_schema());
        let schema = inline_local_schema_refs_for_model(&schema);

        assert!(schema.pointer("/definitions").is_none());
        assert!(schema.pointer("/properties/TodoList/items/$ref").is_none());
        assert_eq!(schema["properties"]["TodoList"]["items"]["type"], "object");

        let item_properties = schema["properties"]["TodoList"]["items"]["properties"]
            .as_object()
            .unwrap();
        assert!(item_properties.contains_key("content"));
        assert!(item_properties.contains_key("activeForm"));
        assert!(item_properties.contains_key("status"));
        assert_eq!(item_properties["status"]["type"], "string");
        assert_eq!(
            item_properties["status"]["enum"],
            serde_json::json!(["pending", "in_progress", "completed"])
        );
        assert!(
            item_properties["status"].pointer("/allOf").is_none(),
            "single-ref allOf should be flattened for model-facing schemas"
        );
    }

    #[test]
    fn schema_with_parameter_guidance_enriches_explore_agent_schema() {
        let tool = ExploreAgentTool;
        let schema = schema_with_parameter_guidance(&tool.name(), &tool.input_schema());
        let message = schema["properties"]["message"]["description"]
            .as_str()
            .unwrap();
        let max_turns = schema["properties"]["max_turns"]["description"]
            .as_str()
            .unwrap();

        assert!(message.contains("read-only reconnaissance"));
        assert!(message.contains("path:line evidence"));
        assert!(max_turns.contains("Explore sub-agent"));
    }

    #[test]
    fn schema_with_parameter_guidance_enriches_write_and_edit_schemas() {
        let write = FileWriteTool;
        let write_schema = schema_with_parameter_guidance(&write.name(), &write.input_schema());
        let content = &write_schema["properties"]["content"];
        let content_description = content["description"].as_str().unwrap();

        assert_eq!(
            content["maxLength"],
            Value::from(crate::write::MAX_WRITE_CONTENT_BYTES)
        );
        assert!(write.description().contains("256 KiB"));
        assert!(write.description().contains("Prefer an attached targeted-edit tool"));
        assert!(write.description().contains("README.md"));
        assert!(content_description.contains("256 KiB"));
        assert!(content_description.contains("do not send huge generated files"));
        assert!(content_description.contains("Prefer an attached targeted-edit tool"));
        assert!(content_description.contains("README.md"));

        let edit = FileEditTool;
        let edit_schema = schema_with_parameter_guidance(&edit.name(), &edit.input_schema());
        let old_string_description = edit_schema["properties"]["old_string"]["description"]
            .as_str()
            .unwrap();
        let new_string_description = edit_schema["properties"]["new_string"]["description"]
            .as_str()
            .unwrap();
        let replace_all_description = edit_schema["properties"]["replace_all"]["description"]
            .as_str()
            .unwrap();

        assert!(edit.description().contains("read the target file first"));
        assert!(edit.description().contains("line number prefix"));
        assert!(edit.description().contains("Use replace_all"));
        assert!(old_string_description.contains("Read the target file"));
        assert!(old_string_description.contains("line number prefix"));
        assert!(old_string_description.contains("whitespace preserved exactly"));
        assert!(old_string_description.contains("CRLF files"));
        assert!(new_string_description.contains("Do not add emojis"));
        assert!(replace_all_description.contains("deliberate rename"));
    }

    #[test]
    fn schema_with_parameter_guidance_enriches_shell_schemas() {
        let bash = BashTool;
        let bash_schema = schema_with_parameter_guidance(&bash.name(), &bash.input_schema());
        let bash_command = bash_schema["properties"]["command"]["description"]
            .as_str()
            .unwrap();
        let bash_background = bash_schema["properties"]["run_in_background"]["description"]
            .as_str()
            .unwrap();
        let bash_timeout = bash_schema["properties"]["timeout"]["description"]
            .as_str()
            .unwrap();

        assert!(bash.description().contains("specialized file tools"));
        assert!(
            bash.description()
                .contains("Do not prefix commands with `cd`")
        );
        assert!(bash.description().contains("run_in_background"));
        assert!(bash_command.contains("Do not prefix with `cd`"));
        assert!(bash_command.contains("specialized file tools"));
        assert!(bash_command.contains("Quote file paths"));
        assert!(bash_background.contains("Do not append `&`"));
        assert!(bash_background.contains("persistent server or watcher"));
        assert!(bash_background.contains("explicit total lifetime"));
        assert!(bash_background.contains("do not poll with `sleep`"));
        assert!(bash_timeout.contains("300000"));
        assert!(bash_timeout.contains("300 seconds"));
        assert!(bash_timeout.contains("foreground blocking budget"));
        assert!(bash_timeout.contains("total command lifetime"));

        let powershell = PowerShellTool;
        let powershell_schema =
            schema_with_parameter_guidance(&powershell.name(), &powershell.input_schema());
        let powershell_command = powershell_schema["properties"]["command"]["description"]
            .as_str()
            .unwrap();
        let powershell_background =
            powershell_schema["properties"]["run_in_background"]["description"]
                .as_str()
                .unwrap();
        let powershell_timeout = powershell_schema["properties"]["timeout"]["description"]
            .as_str()
            .unwrap();

        assert!(powershell.description().contains("specialized file tools"));
        assert!(powershell.description().contains("Set-Location"));
        assert!(powershell.description().contains("Start-Sleep"));
        assert!(powershell_command.contains("Set-Location"));
        assert!(powershell_command.contains("specialized file tools"));
        assert!(powershell_background.contains("Start-Job"));
        assert!(powershell_background.contains("Start-Sleep"));
        assert!(powershell_timeout.contains("300000"));
        assert!(powershell_timeout.contains("300 seconds"));
    }

    #[test]
    fn schema_with_parameter_guidance_explains_ocr_background_timeout() {
        let ocr = OcrReviewTool;
        let schema = schema_with_parameter_guidance(&ocr.name(), &ocr.input_schema());
        let preview = schema["properties"]["preview"]["description"]
            .as_str()
            .unwrap();
        let foreground = schema["properties"]["foregroundTimeoutSeconds"]["description"]
            .as_str()
            .unwrap();
        let timeout = schema["properties"]["timeoutMinutes"]["description"]
            .as_str()
            .unwrap();

        assert!(ocr.description().contains("background task id"));
        assert!(preview.contains("inspect the review scope"));
        assert!(foreground.contains("Defaults to 60"));
        assert!(foreground.contains("attached managed-output control"));
        assert!(timeout.contains("not the foreground progress timeout"));
    }

    #[test]
    fn schema_with_parameter_guidance_enriches_misc_upstream_tools() {
        let sleep = SleepTool;
        let sleep_schema = schema_with_parameter_guidance(&sleep.name(), &sleep.input_schema());
        let duration = sleep_schema["properties"]["duration_seconds"]["description"]
            .as_str()
            .unwrap();
        assert!(sleep.description().contains("sleep or rest"));
        assert!(duration.contains("JSON number"));
        assert!(duration.contains("Bash sleep"));

        let snip = SnipTool;
        let snip_schema = schema_with_parameter_guidance(&snip.name(), &snip.input_schema());
        let message_ids = snip_schema["properties"]["message_ids"]["description"]
            .as_str()
            .unwrap();
        let reason = snip_schema["properties"]["reason"]["description"]
            .as_str()
            .unwrap();
        assert!(snip.description().contains("context window"));
        assert!(message_ids.contains("JSON array"));
        assert!(reason.contains("cannot be undone"));

        let browser = WebBrowserTool;
        let browser_schema =
            schema_with_parameter_guidance(&browser.name(), &browser.input_schema());
        let url = browser_schema["properties"]["url"]["description"]
            .as_str()
            .unwrap();
        let action = browser_schema["properties"]["action"]["description"]
            .as_str()
            .unwrap();
        assert!(
            browser
                .description()
                .contains("No JavaScript execution")
        );
        assert!(url.contains("server-rendered HTML"));
        assert!(action.contains("text snapshot"));

        let repl = REPLTool;
        let repl_schema = schema_with_parameter_guidance(&repl.name(), &repl.input_schema());
        let code = repl_schema["properties"]["code"]["description"]
            .as_str()
            .unwrap();
        let timeout = repl_schema["properties"]["timeout"]["description"]
            .as_str()
            .unwrap();
        assert!(repl.description().contains("current working directory"));
        assert!(code.contains("batch operations"));
        assert!(timeout.contains("60 seconds"));
    }

    #[test]
    fn schema_with_parameter_guidance_enriches_local_memory_and_task_schemas() {
        let memory = LocalMemoryRecallTool;
        let memory_schema = schema_with_parameter_guidance(&memory.name(), &memory.input_schema());
        let action_description = memory_schema["properties"]["action"]
            .as_object()
            .unwrap()
            .get("description")
            .and_then(Value::as_str)
            .unwrap();
        let preview_description = memory_schema["properties"]["preview_only"]
            .as_object()
            .unwrap()
            .get("description")
            .and_then(Value::as_str)
            .unwrap();
        assert!(action_description.contains("list_stores"));
        assert!(preview_description.contains("100 KiB per-turn budget"));

        let task = TaskUpdateTool;
        let task_schema = schema_with_parameter_guidance(&task.name(), &task.input_schema());
        let status_description = task_schema["properties"]["status"]
            .as_object()
            .unwrap()
            .get("description")
            .and_then(Value::as_str)
            .unwrap();
        assert!(status_description.contains("completed only after"));
        assert!(status_description.contains("deleted"));
    }

    #[test]
    fn ask_user_question_accepts_string_booleans() {
        let tool = AskUserQuestionTool;
        let mut input = serde_json::json!({
            "questions": [{
                "question": "Pick one",
                "header": "choice",
                "options": [
                    {"label": "A", "description": "option A"},
                    {"label": "B", "description": "option B"}
                ],
                "multi_select": "false"
            }]
        });
        coerce_input(&mut input, &tool.input_schema());
        let parsed: ask_user_question::AskUserQuestionInput =
            parse_input(&input).expect("string 'false' should be accepted as boolean");
        assert!(!parsed.questions[0].multi_select);
    }

    #[test]
    fn coerce_input_converts_string_numbers_and_booleans() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "enabled": {"type": "boolean"},
                "numeric_enabled": {"type": "boolean"},
                "string_numeric_enabled": {"type": "boolean"},
                "count": {"type": "integer"},
                "ratio": {"type": "number"},
                "nested": {
                    "type": "object",
                    "properties": {
                        "items": {
                            "type": "array",
                            "items": {"type": "integer"}
                        }
                    }
                }
            }
        });
        let mut input = serde_json::json!({
            "enabled": "true",
            "numeric_enabled": 1,
            "string_numeric_enabled": "1",
            "count": "42",
            "ratio": "3.14",
            "nested": {
                "items": ["1", "2", "3"]
            }
        });
        coerce_input(&mut input, &schema);
        assert_eq!(input["enabled"], true);
        assert_eq!(input["numeric_enabled"], true);
        assert_eq!(input["string_numeric_enabled"], true);
        assert_eq!(input["count"], 42);
        let expected_ratio: f64 = "3.14".parse().unwrap();
        assert_eq!(input["ratio"].as_f64().unwrap(), expected_ratio);
        assert_eq!(input["nested"]["items"], serde_json::json!([1, 2, 3]));
    }

    #[test]
    fn coerce_input_can_be_configured_strict() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "enabled": {"type": "boolean"},
                "count": {"type": "integer"}
            },
            "required": ["enabled", "count"]
        });
        let mut input = serde_json::json!({
            "enabled": "true",
            "count": "42"
        });

        coerce_input_with_options(&mut input, &schema, &CoercionOptions::strict());

        assert_eq!(input["enabled"], "true");
        assert_eq!(input["count"], "42");
        assert!(validate_input_against_schema(&input, &schema).is_err());
    }

    #[test]
    fn coerce_input_converts_string_numbers_inside_optional_schema() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "line": {
                    "anyOf": [
                        {"type": "integer"},
                        {"type": "null"}
                    ]
                },
                "column": {
                    "type": ["integer", "null"]
                }
            }
        });
        let mut input = serde_json::json!({
            "line": "3",
            "column": "7"
        });

        coerce_input(&mut input, &schema);

        assert_eq!(input["line"], 3);
        assert_eq!(input["column"], 7);
    }

    #[test]
    fn normalize_tool_input_repairs_todo_null_and_partial_items() {
        let tool = TodoWriteTool;
        let mut input = serde_json::json!({
            "todos": [
                null,
                "Check current worktree",
                "",
                {
                    "content": "Run focused tests",
                    "activeForm": null,
                    "status": null
                },
                {
                    "content": null,
                    "active_form": "Reviewing results",
                    "status": "in_progress"
                },
                {
                    "activeForm": null,
                    "status": "pending"
                }
            ]
        });

        normalize_tool_input("TodoWrite", &mut input);
        assert!(input.get("todos").is_none());
        assert!(input.get("TodoList").is_some());
        coerce_input(&mut input, &tool.input_schema());
        validate_input_against_schema(&input, &tool.input_schema())
            .expect("normalized TodoWrite input should validate");
        let parsed: todo::TodoWriteInput =
            parse_input(&input).expect("normalized TodoWrite input should parse");

        assert_eq!(parsed.todos.len(), 3);
        assert_eq!(parsed.todos[0].content, "Check current worktree");
        assert_eq!(parsed.todos[0].active_form, "Check current worktree");
        assert!(matches!(
            parsed.todos[0].status,
            todo::TodoWriteStatus::Pending
        ));
        assert_eq!(parsed.todos[1].content, "Run focused tests");
        assert_eq!(parsed.todos[1].active_form, "Run focused tests");
        assert!(matches!(
            parsed.todos[1].status,
            todo::TodoWriteStatus::Pending
        ));
        assert_eq!(parsed.todos[2].content, "Reviewing results");
        assert_eq!(parsed.todos[2].active_form, "Reviewing results");
        assert!(matches!(
            parsed.todos[2].status,
            todo::TodoWriteStatus::InProgress
        ));
    }

    #[test]
    fn normalize_tool_input_does_not_silently_turn_blank_todo_strings_into_clear() {
        let tool = TodoWriteTool;
        let mut input = serde_json::json!({
            "TodoList": [""]
        });

        normalize_tool_input("TodoWrite", &mut input);
        coerce_input(&mut input, &tool.input_schema());

        let validation = validate_input_against_schema(&input, &tool.input_schema());
        assert!(
            validation.is_err(),
            "blank TodoWrite string items should remain invalid instead of normalizing to a clearing empty list; normalized input was {input}"
        );
    }

    #[test]
    fn coerce_input_normalizes_aliases_and_enum_values() {
        let tool = TaskUpdateTool;
        let mut input = serde_json::json!({
            "task_id": "task-1",
            "active_form": "Running focused tests",
            "status": "In Progress",
            "add_blocks": "task-2, task-3",
            "add_blocked_by": {
                "first": "task-0"
            }
        });

        coerce_input(&mut input, &tool.input_schema());
        let parsed: task::TaskUpdateInput =
            parse_input(&input).expect("aliases and enum values should be normalized");

        assert_eq!(parsed.task_id, "task-1");
        assert_eq!(parsed.active_form.as_deref(), Some("Running focused tests"));
        assert!(matches!(
            parsed.status,
            Some(task::TaskUpdateStatus::InProgress)
        ));
        assert_eq!(
            parsed.add_blocks.as_deref(),
            Some(["task-2".to_string(), "task-3".to_string()].as_slice())
        );
        assert_eq!(
            parsed.add_blocked_by.as_deref(),
            Some(["task-0".to_string()].as_slice())
        );
    }

    #[test]
    fn coerce_input_parses_stringified_json_for_complex_fields() {
        let tool = AskUserQuestionTool;
        let mut input = serde_json::json!({
            "questions": [{
                "question": "Pick one",
                "header": "choice",
                "multiSelect": "false",
                "options": "[{\"label\":\"A\",\"description\":\"option A\"},{\"label\":\"B\",\"description\":\"option B\"}]"
            }]
        });

        coerce_input(&mut input, &tool.input_schema());
        let parsed: ask_user_question::AskUserQuestionInput =
            parse_input(&input).expect("stringified options array should be parsed");

        assert_eq!(parsed.questions.len(), 1);
        assert_eq!(parsed.questions[0].options.len(), 2);
        assert!(!parsed.questions[0].multi_select);

        let tool = TodoWriteTool;
        let mut input = Value::String(
            r#"{"TodoList":[{"content":"Run tests","active_form":"Running tests","status":"Completed"}]}"#
                .to_string(),
        );

        coerce_input(&mut input, &tool.input_schema());
        let parsed: todo::TodoWriteInput =
            parse_input(&input).expect("stringified root object should be parsed");

        assert_eq!(parsed.todos.len(), 1);
        assert_eq!(parsed.todos[0].active_form, "Running tests");
        assert!(matches!(
            parsed.todos[0].status,
            todo::TodoWriteStatus::Completed
        ));
    }

    #[test]
    fn coerce_input_converts_scalar_and_map_values_to_arrays() {
        let tool = SnipTool;
        let mut input = serde_json::json!({
            "message_ids": "msg-1, msg-2\nmsg-3",
            "reason": "compact old results"
        });

        coerce_input(&mut input, &tool.input_schema());
        let parsed: snip::SnipInput =
            parse_input(&input).expect("string list should become message id array");
        assert_eq!(parsed.message_ids, vec!["msg-1", "msg-2", "msg-3"]);
    }

    #[test]
    fn coerce_input_converts_numeric_object_to_array_for_ask_user_question() {
        let tool = AskUserQuestionTool;
        let mut input = serde_json::json!({
            "questions": {
                "0": {
                    "question": "Pick one",
                    "header": "choice",
                    "options": {
                        "0": {"label": "A", "description": "option A"},
                        "1": {"label": "B", "description": "option B"}
                    },
                    "multi_select": "false"
                }
            }
        });
        coerce_input(&mut input, &tool.input_schema());
        let parsed: ask_user_question::AskUserQuestionInput =
            parse_input(&input).expect("numeric-object array should be coerced to sequence");
        assert_eq!(parsed.questions.len(), 1);
        assert_eq!(parsed.questions[0].options.len(), 2);
        assert!(!parsed.questions[0].multi_select);
    }

    #[test]
    fn coerce_input_unwraps_item_array_for_ask_user_question_options() {
        let tool = AskUserQuestionTool;
        let mut input = serde_json::json!({
            "questions": [{
                "question": "Pick a goal direction",
                "header": "Goal 方向",
                "multi_select": "false",
                "options": {
                    "item": [
                        {"label": "Goal", "description": "Use /goal to drive multi-step work"},
                        {"label": "Manual", "description": "Continue one step at a time"}
                    ]
                }
            }]
        });

        coerce_input(&mut input, &tool.input_schema());
        let parsed: ask_user_question::AskUserQuestionInput =
            parse_input(&input).expect("item wrapper should be unwrapped to options array");

        assert_eq!(parsed.questions.len(), 1);
        assert_eq!(parsed.questions[0].options.len(), 2);
        assert_eq!(parsed.questions[0].options[0].label, "Goal");
        assert!(!parsed.questions[0].multi_select);
    }

    #[test]
    fn coerce_input_wraps_single_question_object_for_ask_user_question() {
        let tool = AskUserQuestionTool;
        let mut input = serde_json::json!({
            "questions": {
                "question": "Pick one",
                "header": "choice",
                "options": [
                    {"label": "A", "description": "option A"},
                    {"label": "B", "description": "option B"}
                ],
                "multi_select": "false"
            }
        });

        coerce_input(&mut input, &tool.input_schema());
        let parsed: ask_user_question::AskUserQuestionInput =
            parse_input(&input).expect("single question object should be wrapped as array");

        assert_eq!(parsed.questions.len(), 1);
        assert_eq!(parsed.questions[0].question, "Pick one");
        assert!(!parsed.questions[0].multi_select);
    }

    #[test]
    fn coerce_input_wraps_single_option_object_for_ask_user_question() {
        let tool = AskUserQuestionTool;
        let mut input = serde_json::json!({
            "questions": [{
                "question": "Pick one",
                "header": "choice",
                "options": {"label": "A", "description": "option A"},
                "multi_select": "false"
            }]
        });

        coerce_input(&mut input, &tool.input_schema());
        let parsed: ask_user_question::AskUserQuestionInput =
            parse_input(&input).expect("single option object should be wrapped as array");

        assert_eq!(parsed.questions.len(), 1);
        assert_eq!(parsed.questions[0].options.len(), 1);
        assert_eq!(parsed.questions[0].options[0].label, "A");
    }

    #[tokio::test]
    async fn ask_user_question_single_option_error_is_actionable() {
        let tool = AskUserQuestionTool;
        let input = serde_json::json!({
            "questions": [{
                "question": "Pick one",
                "header": "choice",
                "options": {"label": "A", "description": "option A"}
            }]
        });

        let err = tool
            .call(input, &ToolContext::new(kcoder_state::AppState::new(".")))
            .await
            .expect_err("single option should fail the 2-4 option rule");

        let ToolError::InvalidInput(detail) = err else {
            panic!("expected invalid input error");
        };
        assert!(detail.contains("$.questions[0].options"));
        assert!(detail.contains("expected an array with 2-4 option objects"));
        assert!(detail.contains("\"questions\":["));
        assert!(detail.contains("\"options\":["));
    }

    #[test]
    fn validate_input_accepts_null_for_nullable_schema_fields() {
        // schemars renders Option<T> as `type: ["T", "null"]`: null is an
        // explicitly allowed value and validation must accept it.
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "description": {"type": ["string", "null"]},
                "run_in_background": {"type": ["boolean", "null"]},
                "mode": {"enum": ["fast", "slow", null]}
            },
            "required": ["command"]
        });
        let input = serde_json::json!({
            "command": "ls",
            "description": null,
            "run_in_background": null,
            "mode": null
        });
        assert_eq!(validate_input_against_schema(&input, &schema), Ok(()));

        // Null for a non-nullable field is still rejected.
        let bad = serde_json::json!({"command": null});
        assert!(validate_input_against_schema(&bad, &schema).is_err());
    }

    #[tokio::test]
    async fn moa_plan_submit_tool_accepts_exactly_one_non_empty_document() {
        let (tool, submission) = SubmitMoaPlanTool::draft();
        let context = ToolContext::new(kcoder_state::AppState::new("."));

        let empty = tool
            .call(serde_json::json!({"content": "  "}), &context)
            .await
            .unwrap();
        assert!(empty.is_error);
        assert!(submission.take().is_none());

        let accepted = tool
            .call(serde_json::json!({"content": "# 计划\n\n正文"}), &context)
            .await
            .unwrap();
        assert!(!accepted.is_error);
        assert_eq!(submission.take().as_deref(), Some("# 计划\n\n正文"));

        let duplicate = tool
            .call(serde_json::json!({"content": "第二版"}), &context)
            .await
            .unwrap();
        assert!(duplicate.is_error);
    }
}
