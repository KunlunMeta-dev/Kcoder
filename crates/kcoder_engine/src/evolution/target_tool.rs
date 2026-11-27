//! `tool_usage` learnable target (plan sections 3, 3.2 and 18 phase 4).
//!
//! Target key: `tool_usage:<source>:<name>` with `source` one of `builtin`,
//! `native` (`<feature>.<tool>`), `mcp` (`<server>.<tool>`) or `plugin`
//! (`<plugin>.<server>.<tool>`). The base revision hashes the tool's name,
//! description, input schema and native revision, so a changed tool marks
//! its learned hint for revalidation. Schemas and descriptions are only
//! read, never changed.
//!
//! Recording policy (bounded volume): main-thread model tool calls are
//! aggregated in memory per (thread, turn, tool) and written when the turn
//! settles, as one usage record plus one or two `tool_result`
//! observations. At most [`MAX_TOOL_USAGES_PER_TURN`] distinct tools are
//! recorded per turn and [`MAX_TOOL_USAGES_PER_THREAD`] usages per thread
//! and process; the selection never depends on the outcome, so error rates
//! stay unbiased. The `skill` tool (its own target), tool discovery and the
//! run-launching tools (the `workflow_template` target) are not recorded.
//! Sub-agent tool calls belong to their run's `workflow_template` usage.
//!
//! Signals: invalid-argument (schema) errors, other errors classified by the
//! engine's environment classifier (environment failures never score),
//! retries with changed argument shapes and eventual success. A failed call
//! that uses an argument the delivered hint names is a conflict event.
//!
//! Injection: the served hint (at most [`TOOL_HINT_MAX_CHARS`] characters of
//! learned text) is appended to the tool's own output, never to its schema,
//! description or the system prompt: once per session on the first call
//! after the hint revision exists, and again on the tool's first
//! non-environment error in a turn. The block starts with the shared overlay
//! marker, so the transcript persists it and a restored session does not
//! receive it again.

use super::recording::usage_id;
use super::turns::{environment_failure, observation};
use super::{ScopeKind, now_ms, redacted_snippet, short_hash};
use crate::QueryEngine;
use crate::deferred_tool_dispatch::ModelToolRegistry;
use crate::request_admission::RequestClass;
use kcoder_evolution::{
    Injection, InjectionPlacement, LearnableTarget, RolloutPolicy, SignalProfile, WritePolicy,
    overlay_marker,
};
use kcoder_tools::{Tool, ToolOutput, ToolSource};
use kcoder_types::evolution::{
    CategoryAssessment, Channel, EVOLUTION_RECORD_VERSION, OutcomeCategory, OutcomeCause,
    OverlayContent, ProfileHints, ProposalLocation, SignalKind, TargetKey, TargetRevision,
    TargetType, UsageRecord, UsageTask,
};
use kcoder_types::{ContentBlock, Message};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Character ceiling of the learned hint text delivered with a tool result.
pub(crate) const TOOL_HINT_MAX_CHARS: usize = 600;
/// Distinct tools recorded per turn.
pub(crate) const MAX_TOOL_USAGES_PER_TURN: usize = 8;
/// Tool usages recorded per thread and process.
pub(crate) const MAX_TOOL_USAGES_PER_THREAD: usize = 256;
/// Calls aggregated per (turn, tool); later calls still serve hints.
const MAX_CALLS_PER_ENTRY: usize = 32;
/// Unflushed entries idle this long are flushed by the idle poll.
const ENTRY_IDLE_FLUSH: Duration = Duration::from_secs(10 * 60);
/// Bytes of a redacted error excerpt kept as evidence.
const ERROR_EXCERPT_BYTES: usize = 800;
const ARGUMENT_SHAPE_MAX_CHARS: usize = 400;
const HINT_CLOSE: &str = "</evolution_overlay>";
/// Tools that are not `tool_usage` targets: their own target types or
/// discovery envelopes.
const EXCLUDED_TOOLS: &[&str] = &[
    "skill",
    "tool_search",
    "tool_execute",
    "spawn_agent",
    "PlanAgent",
    "explore_agent",
    "Workflow",
];

/// `tool_usage:<source>:<name>` of a tool, or `None` when the identity does
/// not form a valid key.
pub(crate) fn tool_target_key(name: &str, source: &ToolSource) -> Option<TargetKey> {
    let (source, name) = match source {
        ToolSource::Builtin => ("builtin", name.to_string()),
        ToolSource::NativeFeature { feature, tool, .. } => ("native", format!("{feature}.{tool}")),
        ToolSource::Mcp { server, tool } => ("mcp", format!("{server}.{tool}")),
        ToolSource::Plugin {
            plugin,
            server,
            tool,
        } => ("plugin", format!("{plugin}.{server}.{tool}")),
    };
    TargetKey::new(TargetType::ToolUsage, source, name).ok()
}

/// Base revision of a tool: a hash of its model-facing contract.
pub(crate) fn tool_base_revision(tool: &dyn Tool) -> String {
    let native = match tool.source() {
        ToolSource::NativeFeature { revision, .. } => revision,
        _ => String::new(),
    };
    format!(
        "tool-{}",
        short_hash(&[
            &tool.name(),
            &tool.description(),
            &tool.input_schema().to_string(),
            &native,
        ])
    )
}

fn value_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Argument shape without values: sorted top-level fields with their JSON
/// types, nested object fields one level deep.
pub(crate) fn argument_shape(input: &Value) -> String {
    let Value::Object(fields) = input else {
        return value_kind(input).to_string();
    };
    let mut names: Vec<&String> = fields.keys().collect();
    names.sort();
    let parts: Vec<String> = names
        .into_iter()
        .map(|name| {
            let value = &fields[name];
            match value {
                Value::Object(inner) => {
                    let mut inner: Vec<&String> = inner.keys().collect();
                    inner.sort();
                    let inner: Vec<&str> = inner.into_iter().map(String::as_str).collect();
                    format!("{name}: object{{{}}}", inner.join(", "))
                }
                Value::Array(items) => format!("{name}: array[{}]", items.len()),
                other => format!("{name}: {}", value_kind(other)),
            }
        })
        .collect();
    let shape = format!("{{{}}}", parts.join(", "));
    let shape = shape.replace(char::is_control, " ");
    match shape.char_indices().nth(ARGUMENT_SHAPE_MAX_CHARS) {
        Some((cut, _)) => format!("{}…", &shape[..cut]),
        None => shape,
    }
}

fn argument_names(input: &Value) -> Vec<String> {
    match input {
        Value::Object(fields) => fields.keys().cloned().collect(),
        _ => Vec::new(),
    }
}

/// Failure class of one tool call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolFailure {
    /// Schema or input validation rejected the arguments.
    InvalidArguments,
    /// Network, rate limits, permission or sandbox denials, provider errors.
    Environment,
    /// Any other failure of the call itself.
    Target,
}

impl ToolFailure {
    fn scored(self) -> bool {
        self != Self::Environment
    }

    fn label(self) -> &'static str {
        match self {
            Self::InvalidArguments => "invalid arguments",
            Self::Environment => "environment",
            Self::Target => "tool error",
        }
    }
}

/// Classify a failed call. Permission denials are environment causes;
/// validation failures are recognised before the environment classifier so
/// field names such as `timeout_ms` cannot make them look environmental.
pub(crate) fn classify_tool_failure(text: &str, permission_denied: bool) -> ToolFailure {
    if permission_denied {
        return ToolFailure::Environment;
    }
    if text.contains("input validation failed") {
        return ToolFailure::InvalidArguments;
    }
    if environment_failure(text) {
        return ToolFailure::Environment;
    }
    ToolFailure::Target
}

fn output_text(output: &ToolOutput) -> String {
    output
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Learned hint text: lessons then checklist, clipped to
/// [`TOOL_HINT_MAX_CHARS`] characters.
fn hint_text(content: &OverlayContent) -> String {
    let mut text = content.lessons.trim().to_string();
    if !content.checklist.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(content.checklist.trim());
    }
    match text.char_indices().nth(TOOL_HINT_MAX_CHARS) {
        Some((cut, _)) => format!("{}…", text[..cut].trim_end()),
        None => text,
    }
}

/// Render a served hint revision as a marked block for the tool result.
pub(crate) fn render_tool_hint(key: &TargetKey, revision: u64, content: &OverlayContent) -> String {
    format!(
        "{}\nUsage hint for this tool learned from this user's past calls; follow the current \
         task when it differs.\n{}\n{HINT_CLOSE}",
        overlay_marker(key, revision),
        hint_text(content)
    )
}

/// Whether a call used an argument field the hint names (as a whole word).
fn hint_names_argument(hint: &str, arguments: &[String]) -> bool {
    arguments.iter().filter(|name| name.len() >= 3).any(|name| {
        hint.match_indices(name.as_str()).any(|(start, _)| {
            let before = hint[..start].chars().next_back();
            let after = hint[start + name.len()..].chars().next();
            let word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
            !word(before) && !word(after)
        })
    })
}

fn messages_contain(messages: &[Message], marker: &str) -> bool {
    messages.iter().any(|message| {
        let (Message::User { content, .. } | Message::Assistant { content, .. }) = message;
        content.iter().any(|block| match block {
            ContentBlock::Text { text } => text.contains(marker),
            ContentBlock::ToolResult { content, .. } => content
                .iter()
                .any(|inner| matches!(inner, ContentBlock::Text { text } if text.contains(marker))),
            _ => false,
        })
    })
}

/// The tool as a learnable target (evaluator `None`: canary at reduced
/// traffic with a doubled observation threshold, plan section 9).
pub(crate) struct ToolUsageTarget {
    pub(crate) key: TargetKey,
    pub(crate) revision: TargetRevision,
}

impl LearnableTarget for ToolUsageTarget {
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
            placement: InjectionPlacement::ToolResult,
            text: render_tool_hint(&self.key, overlay_revision, overlay),
        }
    }

    fn write_policy(&self) -> WritePolicy {
        WritePolicy {
            location: ProposalLocation::Overlay,
            always_requires_confirmation: false,
            max_chars: TOOL_HINT_MAX_CHARS,
        }
    }
}

#[derive(Debug, Clone)]
struct CallFacts {
    shape: String,
    failure: Option<ToolFailure>,
    followed_hint: bool,
    error_excerpt: Option<String>,
}

/// Aggregate of one tool's calls in one turn.
#[derive(Debug, Clone)]
pub(crate) struct ToolTurnEntry {
    thread: String,
    turn: usize,
    /// Client-visible id of the turn (see `recording::usage_turn`).
    turn_id: String,
    key: TargetKey,
    tool_name: String,
    /// Within the recording caps; uncapped entries only serve hints.
    record: bool,
    revision: TargetRevision,
    channel: Channel,
    /// Served hint: overlay revision and rendered block.
    hint: Option<(u64, String)>,
    /// The hint was already delivered on an error of this turn (or the
    /// restored transcript shows it in this turn).
    error_hint_in_turn: bool,
    calls: Vec<CallFacts>,
    started_at_ms: u64,
    last_activity: Instant,
}

/// In-memory per-turn aggregation of tool calls.
#[derive(Debug, Default)]
pub(crate) struct ToolUsageTracker {
    /// Current main-thread turn index per thread, set at turn start.
    turns: HashMap<String, usize>,
    entries: Vec<ToolTurnEntry>,
    recorded: HashMap<String, usize>,
    /// Hint revisions the model has seen in a thread.
    delivered: HashSet<(String, TargetKey, u64)>,
    /// Base revision per tool name, keyed by the tool instance.
    revisions: HashMap<String, (usize, String)>,
}

impl ToolUsageTracker {
    /// Current main-thread turn of `thread`, when a turn started.
    pub(crate) fn current_turn(&self, thread: &str) -> Option<usize> {
        self.turns.get(thread).copied()
    }
}

/// Facts captured before a call runs.
pub(crate) struct ToolCallPlan {
    thread: String,
    turn: usize,
    key: TargetKey,
    shape: String,
    arguments: Vec<String>,
    /// The hint the model had already seen before this call.
    seen_hint: Option<String>,
}

fn find_entry<'a>(
    entries: &'a mut [ToolTurnEntry],
    thread: &str,
    turn: usize,
    key: &TargetKey,
) -> Option<&'a mut ToolTurnEntry> {
    entries
        .iter_mut()
        .find(|entry| entry.thread == thread && entry.turn == turn && &entry.key == key)
}

impl QueryEngine {
    /// Model tool execution with self-evolution observation. Records the
    /// `tool_usage` target and serves its hint inside the tool's own output,
    /// and applies `workflow_template` guidance to newly started runs. With
    /// evolution off this only forwards to the normal execution gate.
    pub(crate) async fn execute_model_request_tool_observed(
        &self,
        id: &str,
        name: &str,
        mut input: Value,
        prompt: &dyn kcoder_permissions::PermissionPrompt,
        registry: ModelToolRegistry<'_>,
    ) -> anyhow::Result<(
        ToolOutput,
        kcoder_permissions::PermissionDecision,
        Option<Value>,
        Vec<crate::EngineEvent>,
    )> {
        let tool_plan = self.evolution_tool_call_begin(name, &input, &registry);
        let launch = self.evolution_launch_begin(name, &mut input);
        let mut result = self
            .execute_model_request_tool(id, name, input, prompt, registry)
            .await;
        if let Ok((output, _, _, events)) = &mut result {
            let denied = events
                .iter()
                .any(|event| matches!(event, crate::EngineEvent::ToolDenied { .. }));
            if let Some(plan) = tool_plan {
                self.evolution_tool_call_finish(plan, output, denied);
            }
            if let Some(launch) = launch {
                self.evolution_launch_finish(launch, output);
            }
        }
        result
    }

    /// Foreground main-thread engine (not a sub-agent or internal fork).
    pub(crate) fn evolution_main_thread(&self) -> bool {
        self.request_class == RequestClass::Foreground && self.subagent_system_prompt.is_none()
    }

    fn evolution_tool_call_begin(
        &self,
        name: &str,
        input: &Value,
        registry: &ModelToolRegistry<'_>,
    ) -> Option<ToolCallPlan> {
        if !self.evolution_main_thread() || !self.turn_driver_signal().active() {
            return None;
        }
        // Cheap switch checks before any lookup.
        {
            let settings = crate::recover_read_lock(&self.settings, "settings");
            let draft = self.state.session_mode() == kcoder_state::SessionMode::WorkflowDraft;
            if !super::collection_allowed(&settings, draft, true)
                || !settings
                    .evolution
                    .targets
                    .type_enabled(TargetType::ToolUsage)
            {
                return None;
            }
        }
        let (tool_name, arguments, tool) = if name == "tool_execute" {
            let inner = input.get("tool_name")?.as_str()?;
            (
                inner.to_string(),
                input.get("arguments").cloned().unwrap_or(Value::Null),
                registry.deferred.tools.get(inner)?,
            )
        } else {
            (name.to_string(), input.clone(), registry.native.get(name)?)
        };
        if EXCLUDED_TOOLS.contains(&tool_name.as_str()) {
            return None;
        }
        let key = tool_target_key(&tool_name, &tool.source())?;
        if !crate::recover_read_lock(&self.settings, "settings")
            .evolution
            .target_enabled(&key)
        {
            return None;
        }
        let thread = self.state.session_id();
        let turn = *self.evolution.lock_state().tools.turns.get(&thread)?;
        self.ensure_tool_entry(&thread, turn, &key, &tool_name, &tool);
        let seen_hint = {
            let mut state = self.evolution.lock_state();
            let tracker = &mut state.tools;
            let hint = find_entry(&mut tracker.entries, &thread, turn, &key)
                .and_then(|entry| entry.hint.clone());
            hint.filter(|(revision, _)| {
                tracker
                    .delivered
                    .contains(&(thread.clone(), key.clone(), *revision))
            })
            .map(|(_, block)| block)
        };
        Some(ToolCallPlan {
            thread,
            turn,
            key,
            shape: argument_shape(&arguments),
            arguments: argument_names(&arguments),
            seen_hint,
        })
    }

    /// Create the (thread, turn, tool) entry: base revision, channel and
    /// served hint are resolved once per turn.
    fn ensure_tool_entry(
        &self,
        thread: &str,
        turn: usize,
        key: &TargetKey,
        tool_name: &str,
        tool: &Arc<dyn Tool>,
    ) {
        let identity = Arc::as_ptr(tool) as *const () as usize;
        let (exists, cached) = {
            let mut state = self.evolution.lock_state();
            let tracker = &mut state.tools;
            let exists = find_entry(&mut tracker.entries, thread, turn, key).is_some();
            let cached = tracker
                .revisions
                .get(tool_name)
                .filter(|(id, _)| *id == identity)
                .map(|(_, revision)| revision.clone());
            (exists, cached)
        };
        if exists {
            return;
        }
        let turn_id = super::recording::usage_turn(&self.state, &self.state.messages()).turn_id;
        let base_revision = cached.unwrap_or_else(|| {
            let revision = tool_base_revision(tool.as_ref());
            self.evolution
                .lock_state()
                .tools
                .revisions
                .insert(tool_name.to_string(), (identity, revision.clone()));
            revision
        });
        let now = now_ms();
        let target = ToolUsageTarget {
            key: key.clone(),
            revision: TargetRevision::new(base_revision.clone(), 0),
        };
        let mut channel = Channel::Stable;
        let mut hint = None;
        let mut delivered_before = false;
        let mut in_turn = false;
        if let Some(store) = self.evolution.store(ScopeKind::User, &self.cwd) {
            let needs_revalidation = store
                .observe_base_revision(key, &base_revision, now)
                .unwrap_or(true);
            let canary = store
                .overlay_document(key)
                .ok()
                .flatten()
                .is_some_and(|document| document.canary_active());
            let policy = RolloutPolicy::from_settings(
                &crate::recover_read_lock(&self.settings, "settings").evolution,
                target.has_offline_evaluator(),
            );
            let assigned = policy.assign_channel(thread, key, canary);
            let served = if needs_revalidation {
                None
            } else {
                store.serving_overlay(key, assigned).ok().flatten()
            };
            if let Some((revision, content)) = served.filter(|(_, content)| !content.is_empty()) {
                channel = assigned;
                let marker = overlay_marker(key, revision);
                let messages = self.state.messages();
                delivered_before = messages_contain(&messages, &marker);
                let current = messages
                    .iter()
                    .rposition(kcoder_types::is_real_user_message)
                    .map(|position| &messages[position..])
                    .unwrap_or(&[]);
                in_turn = messages_contain(current, &marker);
                hint = Some((revision, target.inject(&content, revision).text));
            }
        }
        let mut state = self.evolution.lock_state();
        let tracker = &mut state.tools;
        if find_entry(&mut tracker.entries, thread, turn, key).is_some() {
            return;
        }
        if delivered_before && let Some((revision, _)) = &hint {
            tracker
                .delivered
                .insert((thread.to_string(), key.clone(), *revision));
        }
        let in_turn_count = tracker
            .entries
            .iter()
            .filter(|entry| entry.thread == thread && entry.turn == turn && entry.record)
            .count();
        let recorded = tracker.recorded.entry(thread.to_string()).or_default();
        let record =
            in_turn_count < MAX_TOOL_USAGES_PER_TURN && *recorded < MAX_TOOL_USAGES_PER_THREAD;
        if record {
            *recorded += 1;
        }
        let overlay_revision = hint.as_ref().map(|(revision, _)| *revision).unwrap_or(0);
        tracker.entries.push(ToolTurnEntry {
            thread: thread.to_string(),
            turn,
            turn_id,
            key: key.clone(),
            tool_name: tool_name.to_string(),
            record,
            revision: TargetRevision::new(base_revision, overlay_revision),
            channel,
            hint,
            error_hint_in_turn: in_turn,
            calls: Vec::new(),
            started_at_ms: now,
            last_activity: Instant::now(),
        });
    }

    fn evolution_tool_call_finish(
        &self,
        plan: ToolCallPlan,
        output: &mut ToolOutput,
        permission_denied: bool,
    ) {
        let failure = output
            .is_error
            .then(|| classify_tool_failure(&output_text(output), permission_denied));
        let error_excerpt = failure.map(|_| redacted_snippet(&output_text(output), 4096));
        let followed_hint = failure.is_some_and(ToolFailure::scored)
            && plan
                .seen_hint
                .as_deref()
                .is_some_and(|hint| hint_names_argument(hint, &plan.arguments));
        let mut state = self.evolution.lock_state();
        let tracker = &mut state.tools;
        let Some(entry) = find_entry(&mut tracker.entries, &plan.thread, plan.turn, &plan.key)
        else {
            return;
        };
        entry.last_activity = Instant::now();
        if entry.calls.len() < MAX_CALLS_PER_ENTRY {
            entry.calls.push(CallFacts {
                shape: plan.shape,
                failure,
                followed_hint,
                error_excerpt,
            });
        }
        let Some((revision, block)) = entry.hint.clone() else {
            return;
        };
        let seen = (plan.thread.clone(), plan.key.clone(), revision);
        let first_in_session = !tracker.delivered.contains(&seen);
        let first_error = failure.is_some_and(ToolFailure::scored) && !entry.error_hint_in_turn;
        if first_in_session || first_error {
            entry.error_hint_in_turn |= first_error;
            tracker.delivered.insert(seen);
            output.content.push(ContentBlock::Text { text: block });
        }
    }

    /// A main-thread turn started: remember its index and flush leftovers
    /// of earlier turns of this thread.
    pub(crate) fn evolution_tool_turn_started(&self, messages: &[Message]) {
        let thread = self.state.session_id();
        let turn = super::recording::turn_index(messages);
        let leftovers = {
            let mut state = self.evolution.lock_state();
            let tracker = &mut state.tools;
            tracker.turns.insert(thread.clone(), turn);
            let (leftovers, keep): (Vec<_>, Vec<_>) = tracker
                .entries
                .drain(..)
                .partition(|entry| entry.thread == thread && entry.turn < turn);
            tracker.entries = keep;
            leftovers
        };
        self.flush_tool_entries(leftovers);
    }

    /// The main-thread turn settled: write this thread's aggregates.
    pub(crate) fn evolution_tool_turn_settled(&self) {
        let thread = self.state.session_id();
        let settled = {
            let mut state = self.evolution.lock_state();
            let tracker = &mut state.tools;
            let (settled, keep): (Vec<_>, Vec<_>) = tracker
                .entries
                .drain(..)
                .partition(|entry| entry.thread == thread);
            tracker.entries = keep;
            settled
        };
        self.flush_tool_entries(settled);
    }

    /// Idle poll: flush aggregates whose turn never settled.
    pub(crate) fn evolution_tool_poll(&self) {
        let stale = {
            let mut state = self.evolution.lock_state();
            let tracker = &mut state.tools;
            let (stale, keep): (Vec<_>, Vec<_>) = tracker
                .entries
                .drain(..)
                .partition(|entry| entry.last_activity.elapsed() >= ENTRY_IDLE_FLUSH);
            tracker.entries = keep;
            stale
        };
        self.flush_tool_entries(stale);
    }

    fn flush_tool_entries(&self, entries: Vec<ToolTurnEntry>) {
        let entries: Vec<ToolTurnEntry> = entries
            .into_iter()
            .filter(|entry| entry.record && !entry.calls.is_empty())
            .collect();
        if entries.is_empty() {
            return;
        }
        let settings = crate::recover_read_lock(&self.settings, "settings").clone();
        let draft = self.state.session_mode() == kcoder_state::SessionMode::WorkflowDraft;
        if !super::collection_allowed(&settings, draft, true) {
            return;
        }
        let Some(store) = self.evolution.store(ScopeKind::User, &self.cwd) else {
            return;
        };
        for entry in entries {
            if !super::target_active(&settings.evolution, &entry.key) {
                continue;
            }
            write_tool_usage(
                &self.evolution,
                &store,
                &entry,
                settings.evolution.evidence_ttl_days,
                settings.evolution.signals.procedure_results,
            );
        }
    }

    /// Body and base revision of a registered tool target for distillation.
    pub(crate) fn evolution_tool_target(&self, key: &TargetKey) -> Option<(String, String)> {
        if key.target_type() != TargetType::ToolUsage {
            return None;
        }
        let mut tools = self.active_tool_registry().all();
        tools.extend(self.searchable_tools().all());
        let tool = tools
            .into_iter()
            .find(|tool| tool_target_key(&tool.name(), &tool.source()).as_ref() == Some(key))?;
        let schema = tool.input_schema();
        let fields = schema
            .get("properties")
            .and_then(Value::as_object)
            .map(|properties| {
                let mut fields: Vec<String> = properties
                    .iter()
                    .map(|(name, field)| {
                        let kind = field
                            .get("type")
                            .map(|kind| match kind {
                                Value::String(kind) => kind.clone(),
                                other => other.to_string(),
                            })
                            .unwrap_or_else(|| "any".into());
                        format!("{name}: {kind}")
                    })
                    .collect();
                fields.sort();
                fields.join(", ")
            })
            .unwrap_or_default();
        let body = format!(
            "Tool `{}` ({}).\n\nDescription:\n{}\n\nInput fields: {{{fields}}}\n\nThe learned \
             usage hint is appended to this tool's own output (never to its schema or \
             description) and holds at most {TOOL_HINT_MAX_CHARS} characters: keep lessons short \
             and concrete about arguments, common errors and how to recover. Evidence records \
             argument shapes, never argument values.",
            tool.name(),
            key.source(),
            tool.description(),
        );
        Some((body, tool_base_revision(tool.as_ref())))
    }

    /// Distillation target of any distillable type: `(scope, body, base
    /// revision)`. Skills resolve through the skill registry, tools through
    /// the live tool registry and templates through their recorded runs.
    pub(crate) fn evolution_distill_target(
        &self,
        key: &TargetKey,
    ) -> Option<(ScopeKind, String, String)> {
        match key.target_type() {
            TargetType::Skill => self
                .evolution_skill_target(key)
                .map(|(scope, _, body, base)| (scope, body, base)),
            TargetType::ToolUsage => self
                .evolution_tool_target(key)
                .map(|(body, base)| (ScopeKind::User, body, base)),
            TargetType::WorkflowTemplate => self.evolution_workflow_target(key),
            TargetType::Preference | TargetType::ProjectKnowledge => None,
        }
    }
}

/// Write one aggregate: usage record, `tool_result` observations and
/// redacted evidence of the first scored failure.
fn write_tool_usage(
    runtime: &super::EvolutionRuntime,
    store: &kcoder_evolution::EvolutionStore,
    entry: &ToolTurnEntry,
    ttl_days: u32,
    outcomes_enabled: bool,
) {
    let id = usage_id(&entry.thread, &entry.turn_id, &entry.key);
    let shell = crate::tool_file_observation::is_shell_tool_name(&entry.tool_name);
    let mutation =
        crate::tool_file_observation::is_direct_file_mutation_tool_name(&entry.tool_name)
            && entry.calls.iter().any(|call| call.failure.is_none());
    let record = UsageRecord {
        version: EVOLUTION_RECORD_VERSION,
        usage_id: id.clone(),
        thread_id: entry.thread.clone(),
        turn_id: Some(entry.turn_id.clone()),
        attempt_id: None,
        tool_call_id: None,
        target_key: entry.key.clone(),
        revision: entry.revision.clone(),
        channel: entry.channel,
        task: UsageTask {
            request_hash: None,
            arguments: entry.calls.first().map(|call| call.shape.clone()),
            domain: Default::default(),
            evidence_ref: None,
            workspace_dependent: false,
        },
        profile_hints: ProfileHints {
            wrote_files: mutation,
            ran_commands: shell,
            text_only: false,
        },
        artifacts: Vec::new(),
        concurrent_targets: Vec::new(),
        started_at_ms: entry.started_at_ms,
    };
    if let Err(error) = store.append_usage(&record) {
        runtime.note_diagnostic(format!("tool usage record not written: {error}"));
        return;
    }
    if !outcomes_enabled {
        return;
    }
    for item in tool_observations(store, entry, &id, ttl_days) {
        if let Err(error) = store.append_outcome(&item) {
            runtime.note_diagnostic(format!("tool outcome not written: {error}"));
        }
    }
}

/// Observations of one aggregate:
///
/// - `calls`: success when no call failed for a scored reason; otherwise a
///   failure with the retry count, invalid-argument and changed-argument
///   retry counts, the first failure's class and argument shape, and a
///   conflict flag when the failing call followed the delivered hint. Only
///   environment failures give an environment-caused failure (not scored).
/// - `final` (only after a scored failure): whether the last call
///   succeeded, i.e. eventual recovery.
pub(crate) fn tool_observations(
    store: &kcoder_evolution::EvolutionStore,
    entry: &ToolTurnEntry,
    usage: &str,
    ttl_days: u32,
) -> Vec<kcoder_types::evolution::OutcomeObservation> {
    let calls = &entry.calls;
    let first_scored = calls
        .iter()
        .position(|call| call.failure.is_some_and(ToolFailure::scored));
    let errors = calls.iter().filter(|call| call.failure.is_some()).count();
    let invalid = calls
        .iter()
        .filter(|call| call.failure == Some(ToolFailure::InvalidArguments))
        .count();
    let environment = calls
        .iter()
        .filter(|call| call.failure == Some(ToolFailure::Environment))
        .count();
    let changed_retries = calls
        .windows(2)
        .filter(|pair| pair[0].failure.is_some() && pair[0].shape != pair[1].shape)
        .count();
    let same_retries = calls
        .windows(2)
        .filter(|pair| pair[0].failure.is_some() && pair[0].shape == pair[1].shape)
        .count();
    let last_ok = calls.last().is_some_and(|call| call.failure.is_none());
    let mut summary = observation(usage, SignalKind::ToolResult, "tool_usage", &["calls"]);
    let extra = &mut summary.metrics.extra;
    extra.insert("invocations".into(), calls.len() as f64);
    extra.insert("errors".into(), errors as f64);
    extra.insert("invalidArguments".into(), invalid as f64);
    extra.insert("environmentErrors".into(), environment as f64);
    extra.insert("changedArgumentRetries".into(), changed_retries as f64);
    extra.insert("sameArgumentRetries".into(), same_retries as f64);
    let mut items = Vec::new();
    match first_scored {
        None => {
            let any_ok = calls.iter().any(|call| call.failure.is_none());
            summary.metrics.success = Some(any_ok);
            if !any_ok {
                summary.cause = Some(OutcomeCause::Environment);
            }
            items.push(summary);
        }
        Some(first) => {
            let failed = &calls[first];
            let class = failed.failure.unwrap_or(ToolFailure::Target);
            summary.metrics.success = Some(false);
            summary.metrics.retry_count = Some((calls.len() - first - 1) as u32);
            summary.cause = Some(OutcomeCause::Target);
            summary.categories.push(CategoryAssessment {
                category: if class == ToolFailure::InvalidArguments {
                    OutcomeCategory::Format
                } else {
                    OutcomeCategory::Step
                },
                domain: None,
                confidence: 1.0,
            });
            summary.metrics.failed_step = Some(format!("{}: {}", class.label(), failed.shape));
            summary.conflict = calls.iter().any(|call| call.followed_hint);
            summary
                .metrics
                .extra
                .insert("recovered".into(), f64::from(u8::from(last_ok)));
            let mut evidence = format!(
                "tool `{}` call failed ({})\narguments shape: {}\nerror: {}",
                entry.tool_name,
                class.label(),
                failed.shape,
                redacted_snippet(
                    failed.error_excerpt.as_deref().unwrap_or_default(),
                    ERROR_EXCERPT_BYTES
                ),
            );
            if last_ok && let Some(last) = calls.last() {
                evidence.push_str(&format!(
                    "\nrecovered after {} more call(s); successful arguments shape: {}",
                    calls.len() - first - 1,
                    last.shape
                ));
            }
            summary.evidence_ref = store
                .put_evidence(&redacted_snippet(&evidence, 3500), now_ms(), ttl_days)
                .ok();
            items.push(summary);
            let mut last = observation(usage, SignalKind::ToolResult, "tool_usage", &["final"]);
            last.metrics.success = Some(last_ok);
            if !last_ok {
                last.cause = Some(
                    if calls.last().and_then(|call| call.failure) == Some(ToolFailure::Environment)
                    {
                        OutcomeCause::Environment
                    } else {
                        OutcomeCause::Target
                    },
                );
            }
            items.push(last);
        }
    }
    items
}
