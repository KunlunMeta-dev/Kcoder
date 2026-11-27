//! Usage recording at skill activation and overlay injection
//! (plan sections 3.2, 6.1 and 12).

use super::{EvolutionRuntime, OpenUsage, ScopeKind, now_ms, redacted_snippet, short_hash};
use async_trait::async_trait;
use kcoder_evolution::{EvolutionStore, RolloutPolicy, overlay_marker, render_overlay_block};
use kcoder_state::AppState;
use kcoder_tools::skill_evolution::{SkillActivationEvent, SkillEvolutionObserver};
use kcoder_types::evolution::{
    Channel, EVOLUTION_RECORD_VERSION, ProfileHints, TargetKey, TargetRevision, TargetType,
    UsageRecord, UsageTask,
};
use kcoder_types::{ContentBlock, Message};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Instant;

/// Request snippets stored as task evidence (bytes).
const TASK_SNIPPET_BYTES: usize = 2048;

/// Engine-side observer installed into the main thread's and its
/// subagents' tool contexts.
pub(crate) struct EngineSkillObserver {
    pub(crate) runtime: Arc<EvolutionRuntime>,
    /// State of the conversation the skill runs in (the child's for a
    /// subagent); its real user messages give the `turn-N` index.
    pub(crate) state: AppState,
    /// Thread identity of usage records: the agent task id for a subagent
    /// (what `evolution/rate` with `subagentId` resolves), otherwise the
    /// session id.
    pub(crate) thread_id: Option<String>,
    pub(crate) settings: Arc<RwLock<kcoder_config::Settings>>,
    pub(crate) cwd: PathBuf,
    /// Owning engine, for curator callbacks (archive/restore, scores).
    pub(crate) engine: crate::QueryEngine,
}

/// Real user messages in `messages`, i.e. the current `turn-N` index.
pub(crate) fn turn_index(messages: &[Message]) -> usize {
    messages
        .iter()
        .filter(|message| kcoder_types::is_real_user_message(message))
        .count()
}

/// Client-visible identity of the turn a usage belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UsageTurn {
    /// The id clients see for the turn and send to `evolution/rate`.
    pub(crate) turn_id: String,
    pub(crate) attempt_id: Option<String>,
}

/// Turn identity of a usage recorded now in `state`, in the order the
/// clients' turn ids are assigned:
///
/// 1. the task-local attempt of the running turn: the app-server's `turn-N`
///    from `turn/start` (which also counts Hook-blocked turns and is
///    independent of compaction) or a local foreground turn's own id;
/// 2. the attempt the tail of the live messages belongs to
///    ([`AppState::tail_history_attempt`]): after a local turn, or for
///    messages appended without an attempt scope that continue a turn,
///    exactly as the durable transcript projection groups them;
/// 3. legacy `turn-N` over the live messages, for sessions without
///    attempt records.
///
/// An identity that is not a valid evolution id falls back to the next
/// source, so a usage is never lost to an unexpected id format.
pub(crate) fn usage_turn(state: &AppState, messages: &[Message]) -> UsageTurn {
    let valid =
        |value: &str| kcoder_types::evolution::validate_evolution_id("turnId", value).is_ok();
    let attempt = state
        .current_history_attempt_identity()
        .filter(|identity| valid(identity.turn_id.as_str()))
        .or_else(|| {
            state
                .tail_history_attempt()
                .filter(|identity| valid(identity.turn_id.as_str()))
        });
    match attempt {
        Some(identity) => UsageTurn {
            attempt_id: Some(identity.attempt_id).filter(|id| valid(id.as_str())),
            turn_id: identity.turn_id,
        },
        None => UsageTurn {
            turn_id: format!("turn-{}", turn_index(messages)),
            attempt_id: None,
        },
    }
}

/// The turn id `/rate` addresses for the latest turn of `state`: the same
/// identity [`usage_turn`] records once no turn is running.
pub fn latest_rating_turn_id(state: &AppState) -> Option<String> {
    let messages = state.messages();
    if turn_index(&messages) == 0 {
        return None;
    }
    Some(usage_turn(state, &messages).turn_id)
}

/// A tool call id usable as an evolution id (provider ids are opaque).
pub(crate) fn recorded_tool_call_id(id: Option<&str>) -> Option<String> {
    id.filter(|id| kcoder_types::evolution::validate_evolution_id("toolCallId", id).is_ok())
        .map(str::to_string)
}

pub(crate) fn latest_user_text(messages: &[Message]) -> Option<String> {
    messages.iter().rev().find_map(|message| {
        if !kcoder_types::is_real_user_message(message) {
            return None;
        }
        let Message::User { content, .. } = message else {
            return None;
        };
        let text = content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        (!text.trim().is_empty()).then_some(text)
    })
}

fn transcript_contains(messages: &[Message], marker: &str) -> bool {
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

/// Stable usage id: one usage per (thread, turn, target). `turn` is the
/// recorded turn id (`turn-N` or an attempt's turn id).
pub(crate) fn usage_id(thread: &str, turn: &str, key: &TargetKey) -> String {
    format!("use-{}", short_hash(&[thread, turn, &key.to_string()]))
}

/// Domain preferences relevant to an activated target, rendered once per
/// session (plan section 10).
fn preference_block(
    store: &EvolutionStore,
    domain: Option<&str>,
    key: &TargetKey,
) -> Option<(String, String)> {
    let scope = domain
        .map(str::to_string)
        .unwrap_or_else(|| key.target_type().as_str().to_string());
    let document = store.read_preferences().ok()?;
    let prefix = format!("pref.{scope}.");
    let lines: Vec<String> = document
        .items
        .iter()
        .filter(|(name, _)| name.starts_with(&prefix))
        .map(|(name, entry)| format!("- {}: {}", &name[prefix.len()..], entry.value))
        .collect();
    if lines.is_empty() {
        return None;
    }
    let marker = format!(
        "<evolution_preferences scope=\"{scope}\" revision=\"{}\">",
        document.revision
    );
    Some((
        marker.clone(),
        format!(
            "{marker}\nThe user's learned preferences for this kind of work. They take precedence \
             over learned target notes; the user's current instructions take precedence over \
             both.\n{}\n</evolution_preferences>",
            lines.join("\n")
        ),
    ))
}

impl EngineSkillObserver {
    fn record(&self, event: &SkillActivationEvent) -> Option<String> {
        let settings = self
            .settings
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let workflow_draft = self.state.session_mode() == kcoder_state::SessionMode::WorkflowDraft;
        if !super::collection_allowed(&settings, workflow_draft, true)
            || !super::target_active(&settings.evolution, &event.target_key)
        {
            return None;
        }
        let key = &event.target_key;
        let scope = EvolutionRuntime::scope_of(key, event.project_scope);
        let store = self.runtime.store(scope, &self.cwd)?;
        let messages = self.state.messages();
        let thread = self
            .thread_id
            .clone()
            .unwrap_or_else(|| self.state.session_id());
        let turn = turn_index(&messages);
        let usage_turn = usage_turn(&self.state, &messages);
        let now = now_ms();
        let id = usage_id(&thread, &usage_turn.turn_id, key);

        // Base-revision drift marks the overlay for revalidation; such an
        // overlay is shown in the UI but never served.
        let previous = store.overlay_document(key).ok().flatten();
        let needs_revalidation = store
            .observe_base_revision(key, &event.base_revision, now)
            .unwrap_or(true);
        // A base-layer change (user edit, upgrade) is explicit evidence for
        // the next distillation (plan section 13.1).
        if let Some(previous) = previous
            && needs_revalidation
            && !previous.needs_revalidation
        {
            let text = format!(
                "base revision changed\nThe target's own content changed from {} to {}; the \
                 learned overlay needs revalidation before it is served again.",
                previous.base_revision, event.base_revision
            );
            if let Ok(id) = store.put_evidence(&text, now, settings.evolution.evidence_ttl_days) {
                let _ = store.update_state(|state| {
                    let cursor = state.distill.entry(key.clone()).or_default();
                    if !cursor.user_edit_evidence.contains(&id) {
                        cursor.user_edit_evidence.push(id.clone());
                    }
                    let excess = cursor
                        .user_edit_evidence
                        .len()
                        .saturating_sub(kcoder_evolution::USER_EDIT_EVIDENCE_MAX);
                    cursor.user_edit_evidence.drain(..excess);
                });
            }
        }
        let document = store.overlay_document(key).ok().flatten();
        let canary_active = document
            .as_ref()
            .is_some_and(|document| document.canary_active());
        // Assign with the traffic the canary was started with (an evaluated
        // candidate may use the full configured share).
        let mut policy = RolloutPolicy::from_settings(&settings.evolution, false);
        if let Some(traffic) = document
            .as_ref()
            .and_then(|document| document.candidate.as_ref())
            .and_then(|candidate| candidate.traffic)
        {
            policy.candidate_traffic = traffic;
        }
        let channel = policy.assign_channel(&thread, key, canary_active);
        let served = if needs_revalidation {
            None
        } else {
            store.serving_overlay(key, channel).ok().flatten()
        };
        let overlay_revision = served.as_ref().map(|(revision, _)| *revision).unwrap_or(0);
        let channel = if served.is_some() {
            channel
        } else {
            Channel::Stable
        };

        let already_open = {
            let state = self.runtime.lock_state();
            state.open.iter().any(|open| open.usage_id == id)
        };
        if !already_open {
            let concurrent: Vec<TargetKey> = {
                let mut state = self.runtime.lock_state();
                // Starting another target of the same type closes earlier
                // turns' windows (plan section 7.2).
                let closing: Vec<OpenUsage> = state
                    .open
                    .iter()
                    .filter(|open| {
                        open.turn_index < turn
                            && open.target_key != *key
                            && open.target_key.target_type() == key.target_type()
                    })
                    .cloned()
                    .collect();
                state.open.retain(|open| {
                    !closing
                        .iter()
                        .any(|closed| closed.usage_id == open.usage_id)
                });
                drop(state);
                self.runtime.close_windows(&closing, &self.cwd);
                self.runtime
                    .lock_state()
                    .open
                    .iter()
                    .filter(|open| open.turn_index == turn && open.target_key != *key)
                    .map(|open| open.target_key.clone())
                    .collect()
            };
            let request = latest_user_text(&messages);
            let evidence_ref = request.as_deref().and_then(|text| {
                store
                    .put_evidence(
                        &redacted_snippet(text, TASK_SNIPPET_BYTES),
                        now,
                        settings.evolution.evidence_ttl_days,
                    )
                    .ok()
            });
            let mut domain = BTreeMap::new();
            if let Some(category) = event.domain.as_deref()
                && kcoder_types::evolution::validate_evolution_id("domain", category).is_ok()
            {
                domain.insert("category".to_string(), category.to_string());
            }
            let record = UsageRecord {
                version: EVOLUTION_RECORD_VERSION,
                usage_id: id.clone(),
                thread_id: thread.clone(),
                turn_id: Some(usage_turn.turn_id.clone()),
                attempt_id: usage_turn.attempt_id.clone(),
                tool_call_id: recorded_tool_call_id(event.tool_call_id.as_deref()),
                target_key: key.clone(),
                revision: TargetRevision::new(event.base_revision.clone(), overlay_revision),
                channel,
                task: UsageTask {
                    request_hash: request
                        .as_deref()
                        .map(|text| format!("req-{}", short_hash(&[text]))),
                    arguments: event
                        .arguments
                        .as_deref()
                        .map(|args| redacted_snippet(args, 1024).replace(char::is_control, " ")),
                    domain,
                    evidence_ref,
                    workspace_dependent: false,
                },
                profile_hints: ProfileHints::default(),
                artifacts: Vec::new(),
                concurrent_targets: concurrent,
                started_at_ms: now,
            };
            if let Err(error) = store.append_usage(&record) {
                self.runtime
                    .note_diagnostic(format!("usage record not written: {error}"));
                return None;
            }
            let overlay_text = served
                .as_ref()
                .map(|(_, content)| format!("{}\n{}", content.lessons, content.checklist));
            self.runtime.lock_state().open.push(OpenUsage {
                usage_id: id,
                target_key: key.clone(),
                scope,
                skill_name: event.skill_name.clone(),
                turn_index: turn,
                message_index: messages.len(),
                overlay_text,
                settled: false,
                classified: false,
                regenerated: false,
                last_activity: Instant::now(),
            });
        }

        let mut appendix = Vec::new();
        if let Some((revision, content)) = &served
            && content.char_count() > 0
            && !transcript_contains(&messages, &overlay_marker(key, *revision))
        {
            let base = document
                .as_ref()
                .map(|document| document.base_revision.as_str())
                .unwrap_or(event.base_revision.as_str());
            appendix.push(render_overlay_block(key, base, *revision, content));
        }
        if key.target_type() == TargetType::Skill
            && settings
                .evolution
                .targets
                .type_enabled(TargetType::Preference)
            && let Some(user_store) = self.runtime.store(ScopeKind::User, &self.cwd)
            && let Some((marker, block)) =
                preference_block(&user_store, event.domain.as_deref(), key)
            && !transcript_contains(&messages, &marker)
        {
            appendix.push(block);
        }
        (!appendix.is_empty()).then(|| appendix.join("\n\n"))
    }
}

#[async_trait]
impl SkillEvolutionObserver for EngineSkillObserver {
    async fn skill_activated(&self, event: SkillActivationEvent) -> Option<String> {
        self.record(&event)
    }

    fn curation_signal(
        &self,
        target_key: &TargetKey,
    ) -> Option<kcoder_tools::skill_evolution::SkillCurationSignal> {
        self.engine.evolution_curation_signal(target_key)
    }

    fn target_archived(&self, target_key: &TargetKey, archived: bool) {
        self.engine.evolution_target_archived(target_key, archived);
    }
}

/// Global preferences (`pref.global.*`) for the per-turn memory context.
pub(crate) fn global_preference_lines(store: &EvolutionStore) -> Vec<String> {
    let Ok(document) = store.read_preferences() else {
        return Vec::new();
    };
    document
        .items
        .iter()
        .filter_map(|(name, entry)| {
            name.strip_prefix("pref.global.")
                .map(|category| format!("- [preference:{category}] {}", entry.value))
        })
        .collect()
}
