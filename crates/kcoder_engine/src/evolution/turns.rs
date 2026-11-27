//! Turn boundaries: observation windows, procedure and task-terminal
//! signals from the settled transcript (plan sections 7.1 and 7.2).

use super::recording::{latest_user_text, turn_index};
use super::{
    EvolutionRuntime, OpenUsage, PendingClassification, WINDOW_IDLE, now_ms, redacted_snippet,
    short_hash,
};
use kcoder_types::evolution::{
    ArtifactRef, Attribution, EVOLUTION_RECORD_VERSION, ObservationMetrics, OutcomeCause,
    OutcomeObservation, ProfileHints, SignalKind, UsageAmendment,
};
use kcoder_types::{ContentBlock, Message};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Bytes of the user message and previous answer sent to the classifier.
const CLASSIFY_TEXT_BYTES: usize = 1500;

/// Build an observation with a deterministic id from `id_parts`.
pub(crate) fn observation(
    usage_id: &str,
    signal: SignalKind,
    source: &str,
    id_parts: &[&str],
) -> OutcomeObservation {
    let mut parts = vec![usage_id, source];
    parts.extend_from_slice(id_parts);
    OutcomeObservation {
        version: EVOLUTION_RECORD_VERSION,
        observation_id: format!("obs-{}", short_hash(&parts)),
        usage_id: usage_id.to_string(),
        signal,
        metrics: ObservationMetrics::default(),
        categories: Vec::new(),
        cause: None,
        attribution: Attribution::Direct,
        confidence: 1.0,
        conflict: false,
        hard_failure: false,
        evidence_ref: None,
        source: source.to_string(),
        observed_at_ms: now_ms(),
    }
}

/// Failures caused by the environment rather than the target: network,
/// rate limits, permission or sandbox denials and provider errors. These
/// texts are tool and provider diagnostics, not user language.
pub(crate) fn environment_failure(text: &str) -> bool {
    const PATTERNS: &[&str] = &[
        "rate limit",
        "rate-limit",
        "too many requests",
        " 429",
        "timed out",
        "timeout",
        "connection reset",
        "connection refused",
        "network is unreachable",
        "could not resolve host",
        "temporary failure in name resolution",
        "temporarily unavailable",
        "service unavailable",
        " 502",
        " 503",
        " 504",
        "overloaded",
        "provider error",
        "permission denied",
        "operation not permitted",
        "sandbox",
        "permission to use",
        "was denied",
        "access is denied",
    ];
    let lower = text.to_lowercase();
    PATTERNS.iter().any(|pattern| lower.contains(pattern))
}

/// One tool call of a transcript slice.
#[derive(Debug, Clone)]
pub(crate) struct ToolCall {
    pub(crate) name: String,
    pub(crate) input: serde_json::Value,
    pub(crate) is_error: bool,
    pub(crate) output: String,
}

pub(crate) fn tool_calls(messages: &[Message]) -> Vec<ToolCall> {
    let mut uses: HashMap<String, (String, serde_json::Value)> = HashMap::new();
    let mut order = Vec::new();
    let mut results: HashMap<String, (bool, String)> = HashMap::new();
    for message in messages {
        let (Message::User { content, .. } | Message::Assistant { content, .. }) = message;
        for block in content {
            match block {
                ContentBlock::ToolUse { id, name, input } => {
                    order.push(id.clone());
                    uses.insert(id.clone(), (name.clone(), input.clone()));
                }
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } => {
                    let text = content
                        .iter()
                        .filter_map(|inner| match inner {
                            ContentBlock::Text { text } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    results.insert(tool_use_id.clone(), (is_error.unwrap_or(false), text));
                }
                _ => {}
            }
        }
    }
    order
        .into_iter()
        .filter_map(|id| {
            let (name, input) = uses.remove(&id)?;
            let (is_error, output) = results.remove(&id)?;
            Some(ToolCall {
                name,
                input,
                is_error,
                output,
            })
        })
        .collect()
}

pub(crate) fn last_assistant_before(messages: &[Message]) -> String {
    messages
        .iter()
        .rev()
        .skip_while(|message| kcoder_types::is_real_user_message(message))
        .find_map(|message| match message {
            Message::Assistant { content, .. } => {
                let text = content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<String>();
                (!text.trim().is_empty()).then_some(text)
            }
            Message::User { .. } => None,
        })
        .unwrap_or_default()
}

/// First words of a command, used to match a failed step against the
/// target's own instructions.
fn command_head(command: &str) -> String {
    command
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Inputs of one settle step, captured from the engine.
pub(crate) struct SettleContext<'a> {
    pub(crate) messages: &'a [Message],
    pub(crate) cwd: &'a Path,
    pub(crate) cancelled: bool,
    pub(crate) evidence_ttl_days: u32,
    pub(crate) procedure_enabled: bool,
    pub(crate) artifacts_enabled: bool,
    /// Skill body by skill name, for failed-step conflict attribution.
    pub(crate) skill_body: &'a dyn Fn(&str) -> Option<String>,
}

impl EvolutionRuntime {
    /// Close observation windows: a window that ends without a regenerate
    /// request counts as "not regenerated".
    pub(crate) fn close_windows(&self, closing: &[OpenUsage], cwd: &Path) {
        for usage in closing {
            if usage.regenerated || !usage.settled {
                continue;
            }
            let Some(store) = self.store(usage.scope, cwd) else {
                continue;
            };
            let mut item = observation(
                &usage.usage_id,
                SignalKind::Regenerated,
                "conversation",
                &["closed"],
            );
            item.metrics.occurred = Some(false);
            if let Err(error) = store.append_outcome(&item) {
                self.note_diagnostic(format!("window close not recorded: {error}"));
            }
        }
    }

    /// Close windows idle for longer than [`WINDOW_IDLE`] (or all windows).
    pub(crate) fn close_idle_windows(&self, cwd: &Path, all: bool) {
        let closing: Vec<OpenUsage> = {
            let mut state = self.lock_state();
            let (closing, open): (Vec<_>, Vec<_>) = state
                .open
                .drain(..)
                .partition(|usage| all || usage.last_activity.elapsed() >= WINDOW_IDLE);
            state.open = open;
            closing
        };
        self.close_windows(&closing, cwd);
    }

    /// A new user turn started: queue classification of the message that
    /// directly follows a usage's turn (local prefilter: window and
    /// adjacency only, no keyword lists).
    pub(crate) fn turn_started(&self, messages: &[Message], cwd: &Path, chat_enabled: bool) {
        self.close_idle_windows(cwd, false);
        let turn = turn_index(messages);
        let user_text = latest_user_text(messages).unwrap_or_default();
        let before_user = messages
            .iter()
            .rposition(kcoder_types::is_real_user_message)
            .map(|position| &messages[..position])
            .unwrap_or(messages);
        let previous_answer = last_assistant_before(before_user);
        let mut state = self.lock_state();
        let concurrency: BTreeMap<usize, usize> =
            state
                .open
                .iter()
                .fold(BTreeMap::new(), |mut counts, usage| {
                    *counts.entry(usage.turn_index).or_default() += 1;
                    counts
                });
        let mut queued = Vec::new();
        for usage in state.open.iter_mut() {
            usage.last_activity = Instant::now();
            if !chat_enabled
                || usage.classified
                || !usage.settled
                || usage.turn_index + 1 != turn
                || user_text.trim().is_empty()
            {
                continue;
            }
            usage.classified = true;
            queued.push(PendingClassification {
                usage_id: usage.usage_id.clone(),
                scope: usage.scope,
                user_text: redacted_snippet(&user_text, CLASSIFY_TEXT_BYTES),
                previous_answer: redacted_snippet(&previous_answer, CLASSIFY_TEXT_BYTES),
                overlay_text: usage
                    .overlay_text
                    .as_deref()
                    .map(|text| redacted_snippet(text, CLASSIFY_TEXT_BYTES)),
                concurrent: concurrency
                    .get(&usage.turn_index)
                    .copied()
                    .unwrap_or(1)
                    .saturating_sub(1),
            });
        }
        let persisted = queued.clone();
        state.pending.extend(queued);
        let overflow = state.pending.len().saturating_sub(256);
        state.pending.drain(..overflow);
        drop(state);
        // Survive restarts (see `maintenance`).
        self.persist_classifications(&persisted, cwd);
    }

    /// The main-thread turn settled (completed, failed or interrupted):
    /// record what the turn did for every usage it started.
    pub(crate) fn turn_settled(&self, context: SettleContext<'_>) {
        let turn = turn_index(context.messages);
        let settling: Vec<OpenUsage> = {
            let mut state = self.lock_state();
            let settling = state
                .open
                .iter()
                .filter(|usage| usage.turn_index == turn && !usage.settled)
                .cloned()
                .collect::<Vec<_>>();
            for usage in state.open.iter_mut() {
                if usage.turn_index == turn {
                    usage.settled = true;
                    usage.last_activity = Instant::now();
                }
            }
            settling
        };
        let turn_targets: Vec<_> = settling
            .iter()
            .map(|usage| usage.target_key.clone())
            .collect();
        for usage in &settling {
            let Some(store) = self.store(usage.scope, context.cwd) else {
                continue;
            };
            let start = usage
                .message_index
                .saturating_sub(1)
                .min(context.messages.len());
            let calls = tool_calls(&context.messages[start..]);
            let commands: Vec<&ToolCall> = calls
                .iter()
                .filter(|call| crate::tool_file_observation::is_shell_tool_name(&call.name))
                .collect();
            let mut written: Vec<PathBuf> = Vec::new();
            for call in calls.iter().filter(|call| {
                !call.is_error
                    && crate::tool_file_observation::is_direct_file_mutation_tool_name(&call.name)
            }) {
                for path in
                    crate::tool_file_observation::collect_touched_paths(&call.input, context.cwd)
                {
                    let path = context.cwd.join(path);
                    if !written.contains(&path) && written.len() < 16 {
                        written.push(path);
                    }
                }
            }
            let hints = ProfileHints {
                wrote_files: !written.is_empty(),
                ran_commands: !commands.is_empty(),
                text_only: written.is_empty() && commands.is_empty(),
            };
            let mut artifacts = Vec::new();
            let mut artifact_evidence = BTreeMap::new();
            if context.artifacts_enabled {
                for path in &written {
                    if let Some(baseline) = self.lock_state().artifacts.capture(
                        &store,
                        &usage.usage_id,
                        usage.scope,
                        path,
                        now_ms(),
                        context.evidence_ttl_days,
                    ) {
                        let display = path.display().to_string();
                        if let Some(evidence) = &baseline.evidence_ref {
                            artifact_evidence.insert(display.clone(), evidence.clone());
                        }
                        artifacts.push(ArtifactRef::File {
                            path: display,
                            content_hash: baseline.hash.clone(),
                        });
                    }
                }
            }
            let amendment = UsageAmendment {
                version: EVOLUTION_RECORD_VERSION,
                amendment_id: format!("am-{}", short_hash(&[&usage.usage_id, "settle"])),
                usage_id: usage.usage_id.clone(),
                profile_hints: hints,
                artifacts,
                artifact_evidence,
                concurrent_targets: turn_targets
                    .iter()
                    .filter(|key| **key != usage.target_key)
                    .cloned()
                    .collect(),
                recorded_at_ms: now_ms(),
            };
            if let Err(error) = store.append_usage_amendment(&amendment) {
                self.note_diagnostic(format!("usage amendment not written: {error}"));
            }
            let mut outcomes = Vec::new();
            if context.procedure_enabled && !commands.is_empty() {
                outcomes.push(self.procedure_observation(usage, &commands, &context, &store));
            }
            let mut terminal = observation(
                &usage.usage_id,
                SignalKind::TaskTerminal,
                "procedure",
                &["terminal"],
            );
            // Terminal state only: interrupted and unknown results are never
            // scored (plan section 7.2).
            terminal.metrics.extra.insert(
                if context.cancelled {
                    "interrupted"
                } else {
                    "completed"
                }
                .to_string(),
                1.0,
            );
            outcomes.push(terminal);
            for item in outcomes {
                if let Err(error) = store.append_outcome(&item) {
                    self.note_diagnostic(format!("outcome not written: {error}"));
                }
            }
        }
    }

    fn procedure_observation(
        &self,
        usage: &OpenUsage,
        commands: &[&ToolCall],
        context: &SettleContext<'_>,
        store: &kcoder_evolution::EvolutionStore,
    ) -> OutcomeObservation {
        let last = commands.last().expect("commands are not empty");
        let failures_before_success =
            commands.iter().filter(|call| call.is_error).count() - usize::from(last.is_error);
        let first_failure = commands.iter().find(|call| call.is_error);
        let verification = commands.iter().any(|call| {
            crate::verification_target::verification_target_from_tool_input(&call.name, &call.input)
                .is_some()
        });
        let mut item = observation(
            &usage.usage_id,
            if verification {
                SignalKind::Verification
            } else {
                SignalKind::ToolResult
            },
            "procedure",
            &["commands"],
        );
        item.metrics.success = Some(!last.is_error);
        item.metrics.retry_count = Some(failures_before_success as u32);
        if last.is_error {
            item.metrics.exit_code = None;
            if environment_failure(&last.output) {
                item.cause = Some(OutcomeCause::Environment);
            } else {
                item.cause = Some(OutcomeCause::Target);
            }
        }
        if let Some(failure) = first_failure {
            let command = failure
                .input
                .get("command")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            item.metrics.failed_step = Some(redacted_snippet(command, 200));
            let head = command_head(command);
            let from_target = !head.is_empty()
                && ((context.skill_body)(&usage.skill_name)
                    .is_some_and(|body| body.contains(&head))
                    || usage
                        .overlay_text
                        .as_deref()
                        .is_some_and(|text| text.contains(&head)));
            // A failed step that the target itself instructed is a conflict
            // event, unless the environment caused it.
            item.conflict =
                from_target && last.is_error && item.cause == Some(OutcomeCause::Target);
            let evidence = format!(
                "procedure failure: `{}`\n{}",
                redacted_snippet(command, 300),
                redacted_snippet(&failure.output, 1200)
            );
            item.evidence_ref = store
                .put_evidence(&evidence, now_ms(), context.evidence_ttl_days)
                .ok();
        }
        item
    }
}
