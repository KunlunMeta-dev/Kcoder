//! `workflow_template` learnable target (plan sections 3, 3.2 and 18
//! phase 6).
//!
//! Target keys:
//!
//! - sub-agent roles: `workflow_template:agent:<role>` (canonical built-in
//!   role), `workflow_template:persona:<name>` (Orchestrate roster persona)
//!   and `workflow_template:plugin:<plugin agent>`; user partition;
//! - workflow runs: `workflow_template:saved:<definition id>`,
//!   `workflow_template:named:<script name>` and
//!   `workflow_template:file:<script path>`; project partition, because the
//!   same name may mean different workflows in different projects. Inline
//!   scripts have no stable identity and are not recorded.
//!
//! Usage = one newly started run (model `spawn_agent`, `PlanAgent`,
//! `explore_agent` or `Workflow` calls of the main thread, plus host-started
//! workflows). The usage id derives from the run id, and the usage record
//! stores the template revision the run started with. Signals come from the
//! run's task record when it is terminal: completed, failed, cancelled and
//! unknown stay distinct (only completed and failed score; environment
//! causes never score), plus turn count (sub-agents), provider tokens and
//! retries (resumes of a workflow run, re-spawns of a role after a failed
//! run in the same turn).
//!
//! Injection applies only to newly started runs and goes with the launch
//! parameters (plan section 3.2): for sub-agents the guidance block is
//! appended to the delegated `message`, and a `turn_budget: N` line in the
//! overlay sets `max_turns` when the call omitted it, never above the
//! configured `default_subagent_max_turns` (the tool clamps it into its own
//! limits). For workflow runs the guidance is appended to the start receipt
//! for the coordinating model; node prompts and run limits are not changed,
//! so checkpoint fingerprints stay intact. A resumed run receives nothing:
//! it keeps the revision recorded at its start, and the workflow runtime
//! alone decides which checkpoints are compatible.

use super::turns::{environment_failure, observation};
use super::{ScopeKind, now_ms, redacted_snippet, short_hash};
use crate::QueryEngine;
use kcoder_evolution::{
    Injection, InjectionPlacement, LearnableTarget, RolloutPolicy, SignalProfile, WritePolicy,
    overlay_marker,
};
use kcoder_tools::ToolOutput;
use kcoder_types::evolution::{
    Channel, EVOLUTION_RECORD_VERSION, OutcomeCause, OverlayContent, ProfileHints,
    ProposalLocation, SignalKind, TargetKey, TargetRevision, TargetType, UsageRecord, UsageTask,
};
use kcoder_types::{ContentBlock, Message, TaskStatus};
use serde_json::Value;
use std::collections::HashMap;

/// Character ceiling of rendered template guidance.
pub(crate) const TEMPLATE_MAX_CHARS: usize = 2000;
/// Runs awaiting a terminal state, per engine.
const MAX_PENDING_RUNS: usize = 64;
/// Sub-agent transcripts larger than this are not parsed for a turn count.
const TRANSCRIPT_MAX_BYTES: u64 = 4 * 1024 * 1024;
const FAILURE_EXCERPT_BYTES: usize = 1200;
const TEMPLATE_CLOSE: &str = "</evolution_overlay>";
const AGENT_TOOLS: &[&str] = &["spawn_agent", "PlanAgent", "explore_agent"];

/// Partition of a template key: workflow scripts are project-specific.
pub(crate) fn workflow_scope(key: &TargetKey) -> ScopeKind {
    match key.source() {
        "saved" | "named" | "file" => ScopeKind::Project,
        _ => ScopeKind::User,
    }
}

/// Usage id of a run: stable across sessions and resumes.
pub(crate) fn run_usage_id(run_id: &str) -> String {
    format!("use-{}", short_hash(&["run", run_id]))
}

/// Template key and base revision of a sub-agent launch.
pub(crate) fn agent_template(tool: &str, input: &Value) -> Option<(TargetKey, String)> {
    let text = |field: &str| {
        input
            .get(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let (source, name, base) = match tool {
        "PlanAgent" => role(kcoder_tools::AgentKind::Plan),
        "explore_agent" => role(kcoder_tools::AgentKind::Explore),
        "spawn_agent" => {
            if let Some(plugin) = text("plugin_agent") {
                ("plugin", plugin.to_string(), "plugin".to_string())
            } else {
                match text("agent_type") {
                    None => role(kcoder_tools::AgentKind::General),
                    Some(value) => match kcoder_tools::AgentKind::from_alias(value) {
                        Some(kind) => role(kind),
                        None => ("persona", value.to_string(), "persona".to_string()),
                    },
                }
            }
        }
        _ => return None,
    };
    Some((
        TargetKey::new(TargetType::WorkflowTemplate, source, name).ok()?,
        base,
    ))
}

fn role(kind: kcoder_tools::AgentKind) -> (&'static str, String, String) {
    (
        "agent",
        kind.as_str().to_string(),
        format!("role-{}", short_hash(&[kind.system_prompt()])),
    )
}

/// Template key and base revision of a new workflow run; `None` for inline
/// scripts and resumes.
pub(crate) fn workflow_template(input: &Value) -> Option<(TargetKey, String)> {
    let text = |field: &str| {
        input
            .get(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    if text("resume").is_some() {
        return None;
    }
    let (source, name, base) = if let Some(id) = text("definition_id") {
        let version = input
            .get("version")
            .and_then(Value::as_u64)
            .map(|version| format!("v{version}"))
            .unwrap_or_else(|| "v?".into());
        ("saved", id.to_string(), version)
    } else if let Some(name) = text("name") {
        ("named", name.to_string(), "script".to_string())
    } else if let Some(path) = text("script_path") {
        ("file", path.to_string(), "script".to_string())
    } else {
        return None;
    };
    Some((
        TargetKey::new(TargetType::WorkflowTemplate, source, name).ok()?,
        base,
    ))
}

/// A `turn_budget: N` line of the overlay (lessons or checklist).
pub(crate) fn suggested_turn_budget(content: &OverlayContent) -> Option<usize> {
    content
        .lessons
        .lines()
        .chain(content.checklist.lines())
        .find_map(|line| {
            let line = line.trim().trim_start_matches(['-', '*']).trim();
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("turn_budget")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
                .filter(|budget| *budget > 0)
        })
}

fn without_budget(text: &str) -> String {
    text.lines()
        .filter(|line| {
            let line = line.trim().trim_start_matches(['-', '*']).trim();
            !line
                .split_once(':')
                .is_some_and(|(name, _)| name.trim().eq_ignore_ascii_case("turn_budget"))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Render template guidance as a marked block, clipped to
/// [`TEMPLATE_MAX_CHARS`] characters of learned text.
pub(crate) fn render_template_block(
    key: &TargetKey,
    revision: u64,
    content: &OverlayContent,
) -> String {
    let mut body = String::new();
    let lessons = without_budget(&content.lessons);
    if !lessons.trim().is_empty() {
        body.push_str(lessons.trim());
        body.push('\n');
    }
    let checklist = without_budget(&content.checklist);
    if !checklist.trim().is_empty() {
        body.push_str("Checklist:\n");
        body.push_str(checklist.trim());
        body.push('\n');
    }
    for example in &content.examples {
        body.push_str(&format!(
            "Example ({}): {}\n",
            example.name.trim(),
            example.text.trim()
        ));
    }
    if let Some(budget) = suggested_turn_budget(content) {
        body.push_str(&format!("Suggested turn budget: {budget}\n"));
    }
    let body = match body.char_indices().nth(TEMPLATE_MAX_CHARS) {
        Some((cut, _)) => format!("{}…", body[..cut].trim_end()),
        None => body.trim_end().to_string(),
    };
    format!(
        "{}\nTemplate guidance for this kind of run, learned from this user's past runs; the \
         delegated task and the user's current instructions take precedence.\n{body}\n\
         {TEMPLATE_CLOSE}",
        overlay_marker(key, revision)
    )
}

/// The run template as a learnable target (evaluator `None`).
pub(crate) struct WorkflowTemplateTarget {
    pub(crate) key: TargetKey,
    pub(crate) revision: TargetRevision,
}

impl LearnableTarget for WorkflowTemplateTarget {
    fn key(&self) -> &TargetKey {
        &self.key
    }

    fn revision(&self) -> TargetRevision {
        self.revision.clone()
    }

    fn signal_profiles(&self) -> &[SignalProfile] {
        &[SignalProfile::Procedure, SignalProfile::Explicit]
    }

    fn inject(&self, overlay: &OverlayContent, overlay_revision: u64) -> Injection {
        Injection {
            placement: InjectionPlacement::LaunchParameters,
            text: render_template_block(&self.key, overlay_revision, overlay),
        }
    }

    fn write_policy(&self) -> WritePolicy {
        WritePolicy {
            location: ProposalLocation::Overlay,
            always_requires_confirmation: false,
            max_chars: TEMPLATE_MAX_CHARS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum LaunchKind {
    Agent,
    Workflow,
    Resume(String),
}

/// Facts captured before a launch runs.
pub(crate) struct LaunchPlan {
    kind: LaunchKind,
    key: Option<TargetKey>,
    thread: String,
    turn: Option<usize>,
    revision: TargetRevision,
    channel: Channel,
    block: Option<String>,
    arguments: String,
    retry_count: u32,
}

/// One run awaiting its terminal state.
#[derive(Debug, Clone)]
pub(crate) struct PendingRun {
    run_id: String,
    usage_id: String,
    key: TargetKey,
    scope: ScopeKind,
    thread: String,
    turn: Option<usize>,
    agent: bool,
    /// Distinguishes the terminal observations of resumed attempts.
    attempt: String,
    retry_count: u32,
}

/// Runs of this engine awaiting a terminal state.
#[derive(Debug, Default)]
pub(crate) struct RunTracker {
    pending: Vec<PendingRun>,
    /// Failed or cancelled runs per (thread, turn, role), for re-spawn
    /// retry counts.
    role_failures: HashMap<(String, usize, TargetKey), u32>,
}

fn launch_summary(tool: &str, input: &Value) -> String {
    let field = |name: &str| {
        input.get(name).map(|value| match value {
            Value::String(text) => text.chars().take(80).collect::<String>(),
            other => other.to_string(),
        })
    };
    let fields: &[&str] = if tool == "Workflow" {
        &[
            "definition_id",
            "version",
            "name",
            "max_agent_turns",
            "max_concurrency",
            "reuse_from_run",
        ]
    } else {
        &[
            "agent_type",
            "plugin_agent",
            "max_turns",
            "context_mode",
            "run_in_background",
            "isolation",
        ]
    };
    let mut parts = vec![format!("tool={tool}")];
    parts.extend(
        fields
            .iter()
            .filter_map(|name| field(name).map(|value| format!("{name}={value}"))),
    );
    parts.join("; ").replace(char::is_control, " ")
}

/// Run id reported by a launch receipt.
fn receipt_id(output: &ToolOutput, field: &str) -> Option<String> {
    output.content.iter().find_map(|block| match block {
        ContentBlock::Text { text } => serde_json::from_str::<Value>(text)
            .ok()?
            .get(field)?
            .as_str()
            .map(str::to_string),
        _ => None,
    })
}

fn transcript_turns(path: &std::path::Path) -> Option<usize> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > TRANSCRIPT_MAX_BYTES {
        return None;
    }
    let messages: Vec<Message> = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    Some(
        messages
            .iter()
            .filter(|message| matches!(message, Message::Assistant { .. }))
            .count(),
    )
}

impl QueryEngine {
    fn evolution_templates_collecting(&self) -> bool {
        if !self.evolution_main_thread() {
            return false;
        }
        let settings = crate::recover_read_lock(&self.settings, "settings");
        let draft = self.state.session_mode() == kcoder_state::SessionMode::WorkflowDraft;
        super::collection_allowed(&settings, draft, true)
            && settings
                .evolution
                .targets
                .type_enabled(TargetType::WorkflowTemplate)
    }

    /// Resolve and (for sub-agents) apply the template of a model launch.
    pub(crate) fn evolution_launch_begin(
        &self,
        name: &str,
        input: &mut Value,
    ) -> Option<LaunchPlan> {
        if !AGENT_TOOLS.contains(&name) && name != "Workflow" {
            return None;
        }
        if !self.evolution_templates_collecting() {
            return None;
        }
        self.launch_plan(name, input, true)
    }

    fn launch_plan(&self, name: &str, input: &mut Value, apply: bool) -> Option<LaunchPlan> {
        let thread = self.state.session_id();
        let turn = self.evolution.lock_state().tools.current_turn(&thread);
        if name == "Workflow"
            && let Some(run_id) = input
                .get("resume")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        {
            return Some(LaunchPlan {
                kind: LaunchKind::Resume(run_id.to_string()),
                key: None,
                thread,
                turn,
                revision: TargetRevision::new("", 0),
                channel: Channel::Stable,
                block: None,
                arguments: String::new(),
                retry_count: 0,
            });
        }
        let agent = AGENT_TOOLS.contains(&name);
        let (key, base_revision) = if agent {
            agent_template(name, input)?
        } else {
            workflow_template(input)?
        };
        let (evolution, default_turns) = {
            let settings = crate::recover_read_lock(&self.settings, "settings");
            (
                settings.evolution.clone(),
                settings.default_subagent_max_turns,
            )
        };
        if !evolution.target_enabled(&key) {
            return None;
        }
        let store = self.evolution.store(workflow_scope(&key), &self.cwd)?;
        let now = now_ms();
        let needs_revalidation = store
            .observe_base_revision(&key, &base_revision, now)
            .unwrap_or(true);
        let canary = store
            .overlay_document(&key)
            .ok()
            .flatten()
            .is_some_and(|document| document.canary_active());
        let target = WorkflowTemplateTarget {
            key: key.clone(),
            revision: TargetRevision::new(base_revision.clone(), 0),
        };
        let assigned = RolloutPolicy::from_settings(&evolution, target.has_offline_evaluator())
            .assign_channel(&thread, &key, canary);
        let served = if needs_revalidation {
            None
        } else {
            store
                .serving_overlay(&key, assigned)
                .ok()
                .flatten()
                .filter(|(_, content)| !content.is_empty())
        };
        let (channel, overlay_revision, block, budget) = match &served {
            Some((revision, content)) => (
                assigned,
                *revision,
                Some(target.inject(content, *revision).text),
                suggested_turn_budget(content),
            ),
            None => (Channel::Stable, 0, None, None),
        };
        if apply
            && agent
            && let Some(block) = &block
        {
            let field = if input.get("message").is_some() {
                "message"
            } else {
                "description"
            };
            if let Some(Value::String(message)) = input.get_mut(field) {
                message.push_str("\n\n");
                message.push_str(block);
            }
            if let Some(budget) = budget
                && let Value::Object(fields) = input
                && !fields.contains_key("max_turns")
            {
                fields.insert(
                    "max_turns".into(),
                    Value::from(budget.min(default_turns).max(1)),
                );
            }
        }
        let retry_count = turn
            .and_then(|turn| {
                self.evolution
                    .lock_state()
                    .runs
                    .role_failures
                    .get(&(thread.clone(), turn, key.clone()))
                    .copied()
            })
            .unwrap_or(0);
        Some(LaunchPlan {
            kind: if agent {
                LaunchKind::Agent
            } else {
                LaunchKind::Workflow
            },
            arguments: launch_summary(name, input),
            key: Some(key),
            thread,
            turn,
            revision: TargetRevision::new(base_revision, overlay_revision),
            channel,
            block,
            retry_count,
        })
    }

    /// Record the launched run (or the resume of a recorded run).
    pub(crate) fn evolution_launch_finish(&self, plan: LaunchPlan, output: &mut ToolOutput) {
        match &plan.kind {
            LaunchKind::Resume(run_id) => {
                if !output.is_error {
                    self.note_run_resumed(run_id);
                }
                return;
            }
            LaunchKind::Workflow if output.is_error => return,
            _ => {}
        }
        let agent = plan.kind == LaunchKind::Agent;
        let Some(run_id) = receipt_id(output, if agent { "agent_id" } else { "run_id" }) else {
            return;
        };
        let Some(key) = plan.key.clone() else {
            return;
        };
        if !agent && let Some(block) = &plan.block {
            output.content.push(ContentBlock::Text {
                text: block.clone(),
            });
        }
        let scope = workflow_scope(&key);
        let Some(store) = self.evolution.store(scope, &self.cwd) else {
            return;
        };
        let usage_id = run_usage_id(&run_id);
        let record = UsageRecord {
            version: EVOLUTION_RECORD_VERSION,
            usage_id: usage_id.clone(),
            thread_id: plan.thread.clone(),
            // The client-visible id of the launching turn (see `usage_turn`).
            turn_id: plan
                .turn
                .map(|_| super::recording::usage_turn(&self.state, &self.state.messages()).turn_id),
            attempt_id: None,
            tool_call_id: None,
            target_key: key.clone(),
            revision: plan.revision.clone(),
            channel: plan.channel,
            task: UsageTask {
                request_hash: None,
                arguments: Some(plan.arguments.clone()),
                domain: Default::default(),
                evidence_ref: None,
                workspace_dependent: true,
            },
            profile_hints: ProfileHints::default(),
            artifacts: Vec::new(),
            concurrent_targets: Vec::new(),
            started_at_ms: now_ms(),
        };
        if let Err(error) = store.append_usage(&record) {
            self.evolution
                .note_diagnostic(format!("run usage record not written: {error}"));
            return;
        }
        {
            let mut state = self.evolution.lock_state();
            let pending = &mut state.runs.pending;
            pending.retain(|run| run.run_id != run_id);
            pending.push(PendingRun {
                run_id,
                usage_id,
                key,
                scope,
                thread: plan.thread,
                turn: plan.turn,
                agent,
                attempt: "start".into(),
                retry_count: plan.retry_count,
            });
            let overflow = pending.len().saturating_sub(MAX_PENDING_RUNS);
            pending.drain(..overflow);
        }
        // Foreground sub-agents are already terminal.
        self.evolution_observe_runs();
    }

    /// A host-started workflow (`start_workflow*`): recorded like a model
    /// launch, but its input and receipt are never changed.
    pub(crate) fn evolution_host_workflow_started(
        &self,
        input: &Value,
        result: &Result<ToolOutput, kcoder_tools::ToolError>,
    ) {
        let Ok(output) = result else {
            return;
        };
        if !self.evolution_templates_collecting() {
            return;
        }
        let mut input = input.clone();
        let Some(mut plan) = self.launch_plan("Workflow", &mut input, false) else {
            return;
        };
        plan.block = None;
        let mut output = output.clone();
        self.evolution_launch_finish(plan, &mut output);
    }

    /// A resumed run keeps its original usage and template revision; only
    /// the attempt changes.
    fn note_run_resumed(&self, run_id: &str) {
        let usage_id = run_usage_id(run_id);
        let attempt = format!("resume-{}", now_ms());
        {
            let mut state = self.evolution.lock_state();
            if let Some(run) = state
                .runs
                .pending
                .iter_mut()
                .find(|run| run.run_id == run_id)
            {
                run.attempt = attempt;
                run.retry_count += 1;
                return;
            }
        }
        for scope in [ScopeKind::Project, ScopeKind::User] {
            let Some(store) = self.evolution.store(scope, &self.cwd) else {
                continue;
            };
            let Some(usage) = store.read_usages().ok().and_then(|read| {
                read.records
                    .into_iter()
                    .find(|usage| usage.usage_id == usage_id)
            }) else {
                continue;
            };
            let previous = store
                .read_outcomes()
                .map(|read| {
                    read.records
                        .iter()
                        .filter(|item| {
                            item.usage_id == usage_id && item.signal == SignalKind::TaskTerminal
                        })
                        .count()
                })
                .unwrap_or(0);
            let mut state = self.evolution.lock_state();
            state.runs.pending.push(PendingRun {
                run_id: run_id.to_string(),
                usage_id,
                key: usage.target_key,
                scope,
                thread: usage.thread_id,
                turn: None,
                agent: false,
                attempt,
                retry_count: previous.max(1) as u32,
            });
            let overflow = state.runs.pending.len().saturating_sub(MAX_PENDING_RUNS);
            state.runs.pending.drain(..overflow);
            return;
        }
    }

    /// Write terminal observations of pending runs whose task finished.
    pub(crate) fn evolution_observe_runs(&self) {
        let pending: Vec<PendingRun> = self.evolution.lock_state().runs.pending.clone();
        if pending.is_empty() {
            return;
        }
        let evolution = crate::recover_read_lock(&self.settings, "settings")
            .evolution
            .clone();
        let ttl_days = evolution.evidence_ttl_days;
        for run in pending {
            let Some(task) = self.state.task(&run.run_id) else {
                continue;
            };
            let terminal = matches!(
                task.status,
                TaskStatus::Completed
                    | TaskStatus::Failed
                    | TaskStatus::Cancelled
                    | TaskStatus::Unknown(_)
            );
            if !terminal {
                continue;
            }
            let failed = !matches!(task.status, TaskStatus::Completed);
            // A target switched off since the launch records nothing more.
            if super::target_active(&evolution, &run.key)
                && let Some(store) = self.evolution.store(run.scope, &self.cwd)
            {
                let item = run_observation(&store, &run, &task, ttl_days);
                if let Err(error) = store.append_outcome(&item) {
                    self.evolution
                        .note_diagnostic(format!("run outcome not written: {error}"));
                }
            }
            let mut state = self.evolution.lock_state();
            state
                .runs
                .pending
                .retain(|other| !(other.run_id == run.run_id && other.attempt == run.attempt));
            if failed
                && run.agent
                && let Some(turn) = run.turn
            {
                *state
                    .runs
                    .role_failures
                    .entry((run.thread.clone(), turn, run.key.clone()))
                    .or_default() += 1;
            }
            if state.runs.role_failures.len() > 256 {
                state.runs.role_failures.clear();
            }
        }
    }

    /// Body and base revision of a template target for distillation, from
    /// its latest recorded run.
    pub(crate) fn evolution_workflow_target(
        &self,
        key: &TargetKey,
    ) -> Option<(ScopeKind, String, String)> {
        if key.target_type() != TargetType::WorkflowTemplate {
            return None;
        }
        let scope = workflow_scope(key);
        let store = self.evolution.store(scope, &self.cwd)?;
        let latest = store
            .read_usages()
            .ok()?
            .records
            .into_iter()
            .rev()
            .find(|usage| &usage.target_key == key)?;
        let applied = if key.source() == "saved"
            || key.source() == "named"
            || key.source() == "file"
        {
            "appended to the start receipt of new workflow runs for the coordinating model; node \
             prompts and run limits are not changed"
        } else {
            "appended to the delegated task message of newly started sub-agent runs of this role"
        };
        let body = format!(
            "Run template `{}` ({}).\nLatest launch parameters: {}\n\nThe learned guidance is \
             {applied}, at most {TEMPLATE_MAX_CHARS} characters. Write decomposition hints, \
             role instructions and checks as lessons or checklist items. A checklist line \
             `turn_budget: N` suggests a sub-agent turn budget; it is used only when the call \
             omits `max_turns` and never exceeds the configured default. Running and resumed \
             runs never change their template.",
            key.name(),
            key.source(),
            latest.task.arguments.as_deref().unwrap_or("(none)"),
        );
        Some((scope, body, latest.revision.base_revision))
    }
}

/// The terminal observation of one run attempt.
fn run_observation(
    store: &kcoder_evolution::EvolutionStore,
    run: &PendingRun,
    task: &kcoder_state::Task,
    ttl_days: u32,
) -> kcoder_types::evolution::OutcomeObservation {
    let mut item = observation(
        &run.usage_id,
        SignalKind::TaskTerminal,
        "workflow_template",
        &["terminal", &run.attempt],
    );
    let extra = &mut item.metrics.extra;
    match &task.status {
        TaskStatus::Completed => {
            item.metrics.success = Some(true);
            extra.insert("completed".into(), 1.0);
        }
        TaskStatus::Failed => {
            item.metrics.success = Some(false);
            extra.insert("failed".into(), 1.0);
            let text = task.output.as_deref().unwrap_or_default();
            item.cause = Some(if environment_failure(text) {
                OutcomeCause::Environment
            } else {
                OutcomeCause::Target
            });
            let evidence = format!(
                "run of `{}` failed\n{}",
                run.key.name(),
                redacted_snippet(text, FAILURE_EXCERPT_BYTES)
            );
            item.evidence_ref = store.put_evidence(&evidence, now_ms(), ttl_days).ok();
        }
        // Interrupted and unknown results are recorded, never scored.
        TaskStatus::Cancelled => {
            extra.insert("cancelled".into(), 1.0);
        }
        _ => {
            extra.insert("unknown".into(), 1.0);
        }
    }
    item.metrics.retry_count = Some(run.retry_count);
    if task.usage.input_tokens > 0 || task.usage.output_tokens > 0 {
        extra.insert("inputTokens".into(), task.usage.input_tokens as f64);
        extra.insert("outputTokens".into(), task.usage.output_tokens as f64);
    }
    if let Some(max_turns) = task.max_turns {
        extra.insert("maxTurns".into(), max_turns as f64);
    }
    if run.agent
        && let Some(turns) = task.transcript_path.as_deref().and_then(transcript_turns)
    {
        extra.insert("turns".into(), turns as f64);
    }
    item
}
