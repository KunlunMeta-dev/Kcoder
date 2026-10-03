use crate::ReplApp;
use kcoder_engine::QueryEngine;
use kcoder_memory::{
    Memory, MemoryObservation, MemorySource, MemorySummary, MemorySummarySearchOptions,
};
use kcoder_types::MessageRole;

use super::{SlashCommand, SlashResult};

#[derive(Default)]
pub(super) struct RememberCommand;

#[async_trait::async_trait]
impl SlashCommand for RememberCommand {
    fn needs_arguments(&self) -> bool {
        true
    }
    fn name(&self) -> &'static str {
        "/remember"
    }
    fn description(&self) -> &'static str {
        "Remember a fact."
    }
    fn usage(&self) -> &'static str {
        "/remember <fact>"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        if args.is_empty() {
            app.push_message(MessageRole::System, "Usage: /remember <fact to remember>");
            return SlashResult::Handled;
        }
        if let Err(e) = engine.memory_manager.remember_user(args) {
            app.push_message(MessageRole::System, format!("Failed to save memory: {}", e));
        } else {
            app.push_message(MessageRole::System, format!("Remembered: {}", args));
        }
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct MemoriesCommand;

#[async_trait::async_trait]
impl SlashCommand for MemoriesCommand {
    fn name(&self) -> &'static str {
        "/memories"
    }
    fn description(&self) -> &'static str {
        "List stored memories or show structured memory details."
    }
    fn usage(&self) -> &'static str {
        "/memories [status|<id>|<type#id>|summary <id>|hidden|hide <id>|restore <id>|import legacy]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let args = args.trim();
        if args.is_empty() {
            let text = memories_report(&engine.memory_manager);
            if text.is_empty() {
                app.push_message(MessageRole::System, "No memories stored.");
            } else {
                app.push_message(MessageRole::System, format!("Memories:\n{text}"));
            }
        } else if args.eq_ignore_ascii_case("status") {
            app.push_message(
                MessageRole::System,
                format!("Memory status:\n{}", memory_status_report(engine)),
            );
        } else if let Some(rest) = strip_memory_action(args, "import") {
            match memory_import_report(&engine.memory_manager, rest) {
                Ok(message) => app.push_message(MessageRole::System, message),
                Err(message) => app.push_message(MessageRole::System, message),
            }
        } else if let Some(rest) = strip_optional_memory_action(args, "hidden") {
            match hidden_memories_report(&engine.memory_manager, rest) {
                Ok(text) => app.push_message(MessageRole::System, text),
                Err(message) => app.push_message(MessageRole::System, message),
            }
        } else if let Some(rest) = strip_memory_action(args, "hide") {
            match memory_visibility_report(&engine.memory_manager, rest, true) {
                Ok(message) => app.push_message(MessageRole::System, message),
                Err(message) => app.push_message(MessageRole::System, message),
            }
        } else if let Some(rest) = strip_memory_action(args, "restore") {
            match memory_visibility_report(&engine.memory_manager, rest, false) {
                Ok(message) => app.push_message(MessageRole::System, message),
                Err(message) => app.push_message(MessageRole::System, message),
            }
        } else {
            match memory_detail_report(&engine.memory_manager, args) {
                Ok(Some(text)) => app.push_message(MessageRole::System, format!("Memory:\n{text}")),
                Ok(None) => {
                    let description = parse_memory_detail_query(args)
                        .ok()
                        .map(|query| query.description())
                        .unwrap_or_else(|| args.trim().to_string());
                    app.push_message(
                        MessageRole::System,
                        format!("No structured memory found for {description}."),
                    );
                }
                Err(message) => app.push_message(MessageRole::System, message),
            }
        }
        SlashResult::Handled
    }
}

fn memory_status_report(engine: &QueryEngine) -> String {
    let settings = engine.settings.read().unwrap();
    let observer_stats = engine.memory_observer_queue_stats();
    let worker_diagnostics = engine.memory_observer_worker_diagnostics();
    let event_log = engine.memory_observer_event_log_diagnostics();
    let recovery_audit = engine.memory_observer_recovery_audit();
    let observer_failure = engine.memory_observer_last_validation_failure();
    let structured_stats = engine.memory_manager.structured_memory_stats();
    let mut lines = vec![
        format!(
            "memory.structured_enabled: {}",
            settings.memory.structured_enabled
        ),
        format!(
            "memory.legacy_prompt_enabled: {}",
            settings.memory.legacy_prompt_enabled
        ),
        format!(
            "memory.private_by_default: {}",
            settings.memory.private_by_default
        ),
        format!(
            "memory.observer_mode: {}",
            settings.memory.observer_mode.as_str()
        ),
        format!(
            "memory.observer_queue_size: {}",
            settings.memory.observer_queue_size
        ),
        format!(
            "memory.observer_model: {}",
            settings.memory.observer_model.as_deref().unwrap_or("none")
        ),
    ];
    match structured_stats {
        Ok(stats) => {
            lines.push(format!(
                "memory.structured_store.available: {}",
                stats.available
            ));
            lines.push(format!(
                "memory.structured_store.observations_visible: {}",
                stats.observations_visible
            ));
            lines.push(format!(
                "memory.structured_store.observations_hidden: {}",
                stats.observations_hidden
            ));
            lines.push(format!(
                "memory.structured_store.summaries_visible: {}",
                stats.summaries_visible
            ));
            lines.push(format!(
                "memory.structured_store.summaries_hidden: {}",
                stats.summaries_hidden
            ));
        }
        Err(error) => {
            lines.push("memory.structured_store.available: error".to_string());
            lines.push(format!(
                "memory.structured_store.error: {}",
                compact_text(&error.to_string(), 160)
            ));
        }
    }
    lines.extend([
        format!(
            "memory.observer_queue.capacity: {}",
            observer_stats.capacity
        ),
        format!("memory.observer_queue.queued: {}", observer_stats.queued),
        format!(
            "memory.observer_queue.submitted: {}",
            observer_stats.submitted
        ),
        format!(
            "memory.observer_queue.enqueued: {}",
            observer_stats.enqueued
        ),
        format!("memory.observer_queue.drained: {}", observer_stats.drained),
        format!(
            "memory.observer_queue.overflowed: {}",
            observer_stats.overflowed
        ),
        format!(
            "memory.observer_queue.inline_fallbacks: {}",
            observer_stats.inline_fallbacks
        ),
        format!(
            "memory.observer_queue.dropped_newest: {}",
            observer_stats.dropped_newest
        ),
        format!(
            "memory.observer_queue.dropped_oldest: {}",
            observer_stats.dropped_oldest
        ),
        format!(
            "memory.observer.worker.model_successes: {}",
            worker_diagnostics.model_successes
        ),
        format!(
            "memory.observer.worker.model_fallbacks: {}",
            worker_diagnostics.model_fallbacks
        ),
        format!(
            "memory.observer.worker.model_provider_failures: {}",
            worker_diagnostics.model_provider_failures
        ),
        format!(
            "memory.observer.worker.model_parse_failures: {}",
            worker_diagnostics.model_parse_failures
        ),
        format!(
            "memory.observer.worker.model_validation_failures: {}",
            worker_diagnostics.model_validation_failures
        ),
        format!(
            "memory.observer.worker.last_fallback_reason: {}",
            worker_diagnostics
                .last_fallback_reason
                .as_deref()
                .unwrap_or("none")
        ),
        format!(
            "memory.observer.worker.last_fallback_at_epoch: {}",
            worker_diagnostics
                .last_fallback_at_epoch
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".to_string())
        ),
        format!(
            "memory.observer.event_log.path: {}",
            event_log.path.display()
        ),
        format!(
            "memory.observer.event_log.event_count: {}",
            event_log.event_count
        ),
        format!(
            "memory.observer.event_log.last_event_type: {}",
            event_log.last_event_type.as_deref().unwrap_or("none")
        ),
        format!(
            "memory.observer.event_log.last_event_at_epoch: {}",
            event_log
                .last_event_at_epoch
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".to_string())
        ),
        format!(
            "memory.observer.recovery_audit.event_count: {}",
            recovery_audit.event_count
        ),
        format!(
            "memory.observer.recovery_audit.malformed_event_count: {}",
            recovery_audit.malformed_event_count
        ),
        format!(
            "memory.observer.recovery_audit.pending_enqueued: {}",
            recovery_audit.pending_enqueued
        ),
        format!(
            "memory.observer.recovery_audit.pending_dequeued: {}",
            recovery_audit.pending_dequeued
        ),
        format!(
            "memory.observer.recovery_audit.orphan_dequeue_count: {}",
            recovery_audit.orphan_dequeue_count
        ),
        format!(
            "memory.observer.recovery_audit.orphan_terminal_count: {}",
            recovery_audit.orphan_terminal_count
        ),
        format!(
            "memory.observer.recovery_audit.dropped_queued_before_dequeue: {}",
            recovery_audit.dropped_queued_before_dequeue
        ),
        format!(
            "memory.observer.recovery_audit.last_incomplete_event_type: {}",
            recovery_audit
                .last_incomplete_event_type
                .as_deref()
                .unwrap_or("none")
        ),
        format!(
            "memory.observer.recovery_audit.last_incomplete_at_epoch: {}",
            recovery_audit
                .last_incomplete_at_epoch
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".to_string())
        ),
    ]);
    match observer_failure {
        Some(failure) => {
            lines.push(format!(
                "memory.observer.last_validation_failure.issue_count: {}",
                failure.issue_count
            ));
            lines.push(format!(
                "memory.observer.last_validation_failure.first_issue_path: {}",
                failure.first_issue_path.as_deref().unwrap_or("none")
            ));
            lines.push(format!(
                "memory.observer.last_validation_failure.first_issue_message: {}",
                failure.first_issue_message.as_deref().unwrap_or("none")
            ));
            lines.push(format!(
                "memory.observer.last_validation_failure.occurred_at_epoch: {}",
                failure.occurred_at_epoch
            ));
        }
        None => {
            lines.push("memory.observer.last_validation_failure.issue_count: 0".to_string());
            lines
                .push("memory.observer.last_validation_failure.first_issue_path: none".to_string());
            lines.push(
                "memory.observer.last_validation_failure.first_issue_message: none".to_string(),
            );
            lines.push(
                "memory.observer.last_validation_failure.occurred_at_epoch: none".to_string(),
            );
        }
    }
    lines.join("\n")
}

fn strip_optional_memory_action<'a>(args: &'a str, action: &str) -> Option<&'a str> {
    let mut parts = args.splitn(2, char::is_whitespace);
    let head = parts.next()?;
    head.eq_ignore_ascii_case(action)
        .then(|| parts.next().unwrap_or("").trim())
}

fn strip_memory_action<'a>(args: &'a str, action: &str) -> Option<&'a str> {
    let (head, tail) = args.split_once(char::is_whitespace)?;
    head.eq_ignore_ascii_case(action)
        .then_some(tail.trim())
        .filter(|tail| !tail.is_empty())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HiddenMemoryFilter {
    All,
    Observations,
    Summaries,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MemoryDetailKind {
    Observation,
    Summary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MemoryDetailQuery {
    kind: MemoryDetailKind,
    id: i64,
}

impl MemoryDetailQuery {
    fn description(self) -> String {
        match self.kind {
            MemoryDetailKind::Observation => format!("observation#{}", self.id),
            MemoryDetailKind::Summary => format!("summary#{}", self.id),
        }
    }
}

fn memory_detail_report(
    manager: &kcoder_memory::MemoryManager,
    args: &str,
) -> Result<Option<String>, String> {
    let query = parse_memory_detail_query(args)?;
    match query.kind {
        MemoryDetailKind::Observation => manager
            .get_structured_observation(query.id)
            .map_err(|error| format!("Failed to load structured observation: {error}"))
            .map(|observation| {
                observation.map(|observation| format_observation_detail(manager, &observation))
            }),
        MemoryDetailKind::Summary => manager
            .get_structured_summary(query.id)
            .map_err(|error| format!("Failed to load structured summary: {error}"))
            .map(|summary| summary.map(|summary| format_summary_detail(manager, &summary))),
    }
}

fn memory_visibility_report(
    manager: &kcoder_memory::MemoryManager,
    args: &str,
    hidden: bool,
) -> Result<String, String> {
    let query = parse_memory_detail_query(args)?;
    let updated = match (query.kind, hidden) {
        (MemoryDetailKind::Observation, true) => manager
            .hide_structured_observation(query.id)
            .map_err(|error| format!("Failed to hide structured observation: {error}"))?,
        (MemoryDetailKind::Observation, false) => manager
            .restore_structured_observation(query.id)
            .map_err(|error| format!("Failed to restore structured observation: {error}"))?,
        (MemoryDetailKind::Summary, true) => manager
            .hide_structured_summary(query.id)
            .map_err(|error| format!("Failed to hide structured summary: {error}"))?,
        (MemoryDetailKind::Summary, false) => manager
            .restore_structured_summary(query.id)
            .map_err(|error| format!("Failed to restore structured summary: {error}"))?,
    };
    if !updated {
        return Ok(format!(
            "No structured memory found for {}.",
            query.description()
        ));
    }
    let action = if hidden { "Hidden" } else { "Restored" };
    Ok(format!("{action} {}.", query.description()))
}

fn memory_import_report(
    manager: &kcoder_memory::MemoryManager,
    args: &str,
) -> Result<String, String> {
    if !args.trim().eq_ignore_ascii_case("legacy") {
        return Err("Usage: /memories import legacy".to_string());
    }
    let report = manager
        .import_legacy_memories()
        .map_err(|error| format!("Failed to import legacy memories: {error}"))?;
    Ok(format!(
        "Imported legacy memories: scanned={}, imported={}, skipped_existing={}, skipped_private={}.",
        report.scanned, report.imported, report.skipped_existing, report.skipped_private
    ))
}

fn hidden_memories_report(
    manager: &kcoder_memory::MemoryManager,
    args: &str,
) -> Result<String, String> {
    let filter = parse_hidden_memory_filter(args)?;
    let observations = if matches!(
        filter,
        HiddenMemoryFilter::All | HiddenMemoryFilter::Observations
    ) {
        manager
            .hidden_structured_observations(20)
            .map_err(|error| format!("Failed to load hidden structured observations: {error}"))?
    } else {
        Vec::new()
    };
    let summaries = if matches!(
        filter,
        HiddenMemoryFilter::All | HiddenMemoryFilter::Summaries
    ) {
        manager
            .hidden_structured_summaries(20)
            .map_err(|error| format!("Failed to load hidden structured summaries: {error}"))?
    } else {
        Vec::new()
    };
    let mut sections = Vec::new();
    if !observations.is_empty() {
        sections.push(format!(
            "Hidden structured observations:\n{}",
            observations
                .iter()
                .map(|observation| format_hidden_observation(manager, observation))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if !summaries.is_empty() {
        sections.push(format!(
            "Hidden structured summaries:\n{}",
            summaries
                .iter()
                .map(|summary| format_hidden_summary(manager, summary))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if sections.is_empty() {
        Ok("No hidden structured memories.".to_string())
    } else {
        Ok(format!("Hidden memories:\n{}", sections.join("\n\n")))
    }
}

fn parse_hidden_memory_filter(args: &str) -> Result<HiddenMemoryFilter, String> {
    let args = args.trim();
    if args.is_empty() {
        return Ok(HiddenMemoryFilter::All);
    }
    match args.to_ascii_lowercase().as_str() {
        "observation" | "observations" => Ok(HiddenMemoryFilter::Observations),
        "summary" | "summaries" => Ok(HiddenMemoryFilter::Summaries),
        _ => Err("Usage: /memories hidden [observation|summary]".to_string()),
    }
}

fn parse_memory_detail_query(args: &str) -> Result<MemoryDetailQuery, String> {
    let mut parts = args.split_whitespace().collect::<Vec<_>>();
    if parts
        .first()
        .is_some_and(|part| part.eq_ignore_ascii_case("show"))
    {
        parts.remove(0);
    }

    match parts.as_slice() {
        [token] => parse_memory_detail_token(token),
        [kind, id] => {
            let kind = parse_memory_detail_kind(kind)?;
            let id = parse_memory_detail_id(id)?;
            Ok(MemoryDetailQuery { kind, id })
        }
        _ => Err("Usage: /memories [<id>|<type#id>|summary <id>|observation <id>]".to_string()),
    }
}

fn parse_memory_detail_token(token: &str) -> Result<MemoryDetailQuery, String> {
    let token = token.trim().trim_start_matches('[').trim_end_matches(']');
    if let Some((kind, id)) = token.split_once('#') {
        let kind = parse_memory_detail_kind(kind)?;
        let id = parse_memory_detail_id(id)?;
        return Ok(MemoryDetailQuery { kind, id });
    }

    Ok(MemoryDetailQuery {
        kind: MemoryDetailKind::Observation,
        id: parse_memory_detail_id(token)?,
    })
}

fn parse_memory_detail_kind(kind: &str) -> Result<MemoryDetailKind, String> {
    let kind = kind.trim();
    if kind.eq_ignore_ascii_case("summary") {
        Ok(MemoryDetailKind::Summary)
    } else if kind.eq_ignore_ascii_case("observation") || !kind.is_empty() {
        Ok(MemoryDetailKind::Observation)
    } else {
        Err("Usage: /memories [<id>|<type#id>|summary <id>|observation <id>]".to_string())
    }
}

fn parse_memory_detail_id(id: &str) -> Result<i64, String> {
    let id = id.trim().parse::<i64>().map_err(|_| {
        "Memory id must be a positive integer. Usage: /memories [<id>|<type#id>|summary <id>]"
            .to_string()
    })?;
    if id <= 0 {
        return Err(
            "Memory id must be a positive integer. Usage: /memories [<id>|<type#id>|summary <id>]"
                .to_string(),
        );
    }
    Ok(id)
}

fn format_observation_detail(
    manager: &kcoder_memory::MemoryManager,
    observation: &MemoryObservation,
) -> String {
    let mut lines = vec![format!(
        "[{}#{}]",
        observation.observation_type, observation.id
    )];
    push_field(&mut lines, "session_id", &observation.session_id);
    push_field(&mut lines, "project_key", &observation.project_key);
    if let Some(prompt_number) = observation.prompt_number {
        push_field(&mut lines, "prompt_number", prompt_number);
    }
    push_field(&mut lines, "created_at_epoch", observation.created_at_epoch);
    push_optional_field(&mut lines, "title", observation.title.as_deref());
    push_optional_field(&mut lines, "subtitle", observation.subtitle.as_deref());
    push_optional_field(&mut lines, "narrative", observation.narrative.as_deref());
    push_list_field(&mut lines, "facts", &observation.facts);
    push_list_field(&mut lines, "concepts", &observation.concepts);
    push_list_field(&mut lines, "files_read", &observation.files_read);
    push_list_field(&mut lines, "files_modified", &observation.files_modified);
    push_optional_field(&mut lines, "tool_name", observation.tool_name.as_deref());
    push_optional_field(
        &mut lines,
        "tool_call_id",
        observation.tool_call_id.as_deref(),
    );
    push_field(&mut lines, "source", &observation.source);
    push_optional_field(
        &mut lines,
        "generated_by_model",
        observation.generated_by_model.as_deref(),
    );
    push_field(&mut lines, "content_hash", &observation.content_hash);
    push_source_details(manager, "observation", observation.id, &mut lines);
    lines.join("\n")
}

fn format_summary_detail(
    manager: &kcoder_memory::MemoryManager,
    summary: &MemorySummary,
) -> String {
    let mut lines = vec![format!("[summary#{}]", summary.id)];
    push_field(&mut lines, "session_id", &summary.session_id);
    push_field(&mut lines, "project_key", &summary.project_key);
    if let Some(prompt_number) = summary.prompt_number {
        push_field(&mut lines, "prompt_number", prompt_number);
    }
    push_field(&mut lines, "created_at_epoch", summary.created_at_epoch);
    push_optional_field(&mut lines, "request", summary.request.as_deref());
    push_optional_field(&mut lines, "investigated", summary.investigated.as_deref());
    push_optional_field(&mut lines, "learned", summary.learned.as_deref());
    push_optional_field(&mut lines, "completed", summary.completed.as_deref());
    push_optional_field(&mut lines, "next_steps", summary.next_steps.as_deref());
    push_optional_field(&mut lines, "notes", summary.notes.as_deref());
    push_source_details(manager, "summary", summary.id, &mut lines);
    lines.join("\n")
}

fn push_field(lines: &mut Vec<String>, key: &str, value: impl ToString) {
    lines.push(format!("{}: {}", key, value.to_string()));
}

fn push_optional_field(lines: &mut Vec<String>, key: &str, value: Option<&str>) {
    if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
        push_field(lines, key, compact_text(value, 500));
    }
}

fn push_list_field(lines: &mut Vec<String>, key: &str, values: &[String]) {
    if values.is_empty() {
        return;
    }
    lines.push(format!("{key}:"));
    for value in values {
        lines.push(format!("- {}", compact_text(value, 500)));
    }
}

fn push_source_details(
    manager: &kcoder_memory::MemoryManager,
    memory_kind: &str,
    memory_id: i64,
    lines: &mut Vec<String>,
) {
    let sources = manager
        .structured_sources_for_memory(memory_kind, memory_id)
        .unwrap_or_default();
    if sources.is_empty() {
        return;
    }
    lines.push("sources:".to_string());
    for source in sources {
        lines.push(format!("- {}", format_source_detail(&source)));
    }
}

fn format_source_detail(source: &MemorySource) -> String {
    let mut text = format_source(source);
    text.push_str(&format!(" at {}", source.created_at_epoch));
    let metadata = source.metadata_json.trim();
    if !metadata.is_empty() && metadata != "{}" {
        text.push_str(&format!(" metadata: {}", compact_text(metadata, 500)));
    }
    text
}

fn memories_report(manager: &kcoder_memory::MemoryManager) -> String {
    let observations = manager
        .search_structured_observations(None, 10)
        .unwrap_or_default();
    let summaries = manager
        .search_structured_summaries(
            None,
            MemorySummarySearchOptions {
                limit: Some(10),
                ..MemorySummarySearchOptions::default()
            },
        )
        .unwrap_or_default();
    let legacy = manager.all_memories();
    let mut sections = Vec::new();

    if !observations.is_empty() {
        sections.push(format!(
            "Structured observations:\n{}",
            observations
                .iter()
                .map(|observation| format_observation(manager, observation))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }

    if !summaries.is_empty() {
        sections.push(format!(
            "Structured summaries:\n{}",
            summaries
                .iter()
                .map(|summary| format_summary(manager, summary))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }

    if !legacy.is_empty() {
        sections.push(format!(
            "Legacy memories:\n{}",
            legacy
                .iter()
                .rev()
                .map(|memory| format_legacy_memory(manager, memory))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }

    sections.join("\n\n")
}

fn format_observation(
    manager: &kcoder_memory::MemoryManager,
    observation: &MemoryObservation,
) -> String {
    let title = observation
        .title
        .as_deref()
        .or(observation.narrative.as_deref())
        .or_else(|| observation.facts.first().map(String::as_str))
        .unwrap_or("structured observation");
    let mut line = format!(
        "- [{}#{}] {}",
        observation.observation_type,
        observation.id,
        compact_text(title, 140)
    );
    if let Some(source) = source_suffix(manager, "observation", observation.id) {
        line.push_str(&format!(" ({source})"));
    }
    line
}

fn format_summary(manager: &kcoder_memory::MemoryManager, summary: &MemorySummary) -> String {
    let body = summary
        .learned
        .as_deref()
        .or(summary.completed.as_deref())
        .or(summary.request.as_deref())
        .or(summary.notes.as_deref())
        .unwrap_or("structured summary");
    let mut line = format!("- [summary#{}] {}", summary.id, compact_text(body, 140));
    if let Some(source) = source_suffix(manager, "summary", summary.id) {
        line.push_str(&format!(" ({source})"));
    }
    line
}

fn format_hidden_observation(
    manager: &kcoder_memory::MemoryManager,
    observation: &MemoryObservation,
) -> String {
    let mut line = format_observation(manager, observation);
    if let Some(hidden_at) = observation.hidden_at_epoch {
        line.push_str(&format!(" (hidden_at: {hidden_at})"));
    }
    line
}

fn format_hidden_summary(
    manager: &kcoder_memory::MemoryManager,
    summary: &MemorySummary,
) -> String {
    let mut line = format_summary(manager, summary);
    if let Some(hidden_at) = summary.hidden_at_epoch {
        line.push_str(&format!(" (hidden_at: {hidden_at})"));
    }
    line
}

fn format_legacy_memory(manager: &kcoder_memory::MemoryManager, memory: &Memory) -> String {
    let mut line = format!(
        "- [{}] {}",
        memory.category,
        compact_text(&memory.fact, 140)
    );
    if let Ok(Some(status)) = manager.legacy_memory_import_status(memory) {
        if status.hidden {
            line.push_str(&format!(
                " (imported hidden as legacy_memory#{})",
                status.observation_id
            ));
        } else {
            line.push_str(&format!(
                " (imported as legacy_memory#{})",
                status.observation_id
            ));
        }
    }
    line
}

fn source_suffix(
    manager: &kcoder_memory::MemoryManager,
    memory_kind: &str,
    memory_id: i64,
) -> Option<String> {
    let sources = manager
        .structured_sources_for_memory(memory_kind, memory_id)
        .unwrap_or_default();
    let first = sources.first()?;
    let mut text = format_source(first);
    if sources.len() > 1 {
        text.push_str(&format!(" +{} source(s)", sources.len() - 1));
    }
    Some(text)
}

fn format_source(source: &MemorySource) -> String {
    match source.source_ref.as_deref() {
        Some(source_ref) if !source_ref.is_empty() => {
            format!(
                "source: {} {}",
                source.source_type,
                compact_text(source_ref, 60)
            )
        }
        _ => format!("source: {}", source.source_type),
    }
}

fn compact_text(text: &str, max_chars: usize) -> String {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= max_chars {
        return compact;
    }
    let kept = max_chars.saturating_sub(3);
    format!("{}...", compact.chars().take(kept).collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_api::Provider;
    use kcoder_config::{MemoryObserverMode, MemorySettings, Settings};
    use kcoder_memory::{
        MemoryObservationInput, MemorySourceInput, MemoryStore, MemorySummaryInput,
        StructuredMemoryStore,
    };
    use kcoder_permissions::PermissionEngine;
    use kcoder_skills::SkillRegistry;
    use kcoder_state::AppState;
    use kcoder_tools::ToolRegistry;
    use std::path::Path;
    use std::sync::Arc;

    #[derive(Debug)]
    struct EmptyProvider;

    impl Provider for EmptyProvider {
        fn name(&self) -> &'static str {
            "empty"
        }

        fn stream_messages(
            &self,
            _request: kcoder_types::MessagesRequest,
        ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
            Ok(Box::pin(futures::stream::empty()))
        }
    }

    fn test_engine_with_memory_manager(
        cwd: &Path,
        settings: Settings,
        memory_manager: kcoder_memory::MemoryManager,
    ) -> QueryEngine {
        QueryEngine::new(
            Arc::new(EmptyProvider),
            AppState::new(cwd),
            ToolRegistry::new(),
            PermissionEngine::from_settings(&settings),
            settings,
            memory_manager,
            SkillRegistry::load(cwd).unwrap(),
            Arc::new(kcoder_tools::DenyAllUserQuestioner),
            cwd.to_path_buf(),
        )
    }

    #[tokio::test]
    async fn memories_status_command_shows_observer_diagnostics() {
        let tmp = tempfile::tempdir().unwrap();
        let settings = Settings {
            memory: MemorySettings {
                observer_mode: MemoryObserverMode::Model,
                observer_queue_size: 7,
                observer_model: Some("observer-mini".to_string()),
                ..MemorySettings::default()
            },
            ..Settings::default()
        };
        let memory_manager = kcoder_memory::MemoryManager::global_only(MemoryStore::empty())
            .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a");
        let engine = test_engine_with_memory_manager(tmp.path(), settings, memory_manager);
        engine
            .memory_manager
            .save_structured_observation(MemoryObservationInput {
                session_id: engine.session_id(),
                project_key: String::new(),
                prompt_number: Some(1),
                observation_type: "file_change".to_string(),
                title: Some("visible observation".to_string()),
                subtitle: None,
                narrative: Some("visible observation".to_string()),
                facts: Vec::new(),
                concepts: Vec::new(),
                files_read: Vec::new(),
                files_modified: vec!["src/lib.rs".to_string()],
                tool_name: Some("write".to_string()),
                tool_call_id: Some("tool-visible".to_string()),
                source: "tool_event".to_string(),
                generated_by_model: None,
                created_at_epoch: 1_000,
                content_hash: None,
            })
            .unwrap()
            .unwrap();
        let hidden_observation_id = engine
            .memory_manager
            .save_structured_observation(MemoryObservationInput {
                session_id: engine.session_id(),
                project_key: String::new(),
                prompt_number: Some(1),
                observation_type: "file_change".to_string(),
                title: Some("hidden observation".to_string()),
                subtitle: None,
                narrative: Some("hidden observation".to_string()),
                facts: Vec::new(),
                concepts: Vec::new(),
                files_read: Vec::new(),
                files_modified: vec!["hidden.rs".to_string()],
                tool_name: Some("write".to_string()),
                tool_call_id: Some("tool-hidden".to_string()),
                source: "tool_event".to_string(),
                generated_by_model: None,
                created_at_epoch: 1_001,
                content_hash: None,
            })
            .unwrap()
            .unwrap();
        engine
            .memory_manager
            .hide_structured_observation(hidden_observation_id)
            .unwrap();
        engine
            .memory_manager
            .save_structured_summary(MemorySummaryInput {
                session_id: engine.session_id(),
                project_key: String::new(),
                prompt_number: Some(1),
                request: Some("visible summary".to_string()),
                investigated: None,
                learned: Some("visible summary".to_string()),
                completed: None,
                next_steps: None,
                notes: None,
                created_at_epoch: 1_002,
            })
            .unwrap()
            .unwrap();
        let hidden_summary_id = engine
            .memory_manager
            .save_structured_summary(MemorySummaryInput {
                session_id: engine.session_id(),
                project_key: String::new(),
                prompt_number: Some(1),
                request: Some("hidden summary".to_string()),
                investigated: None,
                learned: Some("hidden summary".to_string()),
                completed: None,
                next_steps: None,
                notes: None,
                created_at_epoch: 1_003,
            })
            .unwrap()
            .unwrap();
        engine
            .memory_manager
            .hide_structured_summary(hidden_summary_id)
            .unwrap();
        let mut app = ReplApp::default();

        let result = MemoriesCommand.run("status", &mut app, &engine).await;

        assert_eq!(result, SlashResult::Handled);
        assert_eq!(app.messages.len(), 1);
        let text = &app.messages[0].text;
        assert!(text.starts_with("Memory status:\n"));
        assert!(text.contains("memory.observer_mode: model"));
        assert!(text.contains("memory.observer_queue_size: 7"));
        assert!(text.contains("memory.observer_model: observer-mini"));
        assert!(text.contains("memory.structured_store.available: true"));
        assert!(text.contains("memory.structured_store.observations_visible: 1"));
        assert!(text.contains("memory.structured_store.observations_hidden: 1"));
        assert!(text.contains("memory.structured_store.summaries_visible: 1"));
        assert!(text.contains("memory.structured_store.summaries_hidden: 1"));
        assert!(text.contains("memory.observer_queue.capacity: 7"));
        assert!(text.contains("memory.observer.worker.model_successes: 0"));
        assert!(text.contains("memory.observer.worker.last_fallback_reason: none"));
        assert!(text.contains("memory.observer.event_log.path: "));
        assert!(text.contains("memory.observer.event_log.event_count: 0"));
        assert!(text.contains("memory.observer.event_log.last_event_type: none"));
        assert!(text.contains("memory.observer.recovery_audit.event_count: 0"));
        assert!(text.contains("memory.observer.recovery_audit.pending_enqueued: 0"));
        assert!(text.contains("memory.observer.recovery_audit.pending_dequeued: 0"));
        assert!(text.contains("memory.observer.recovery_audit.last_incomplete_event_type: none"));
        assert!(text.contains("memory.observer.last_validation_failure.issue_count: 0"));
    }

    #[test]
    fn memories_report_lists_structured_and_legacy_memories() {
        let tmp = tempfile::tempdir().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        global
            .add("project", "legacy memory still visible", "manual")
            .unwrap();
        let manager = kcoder_memory::MemoryManager::global_only(global)
            .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a");
        let observation_id = manager
            .save_structured_observation(MemoryObservationInput {
                session_id: "session-1".to_string(),
                project_key: String::new(),
                prompt_number: Some(1),
                observation_type: "file_change".to_string(),
                title: Some("Tool changed src/lib.rs".to_string()),
                subtitle: None,
                narrative: Some("Tool changed src/lib.rs".to_string()),
                facts: Vec::new(),
                concepts: vec!["tool-event".to_string()],
                files_read: Vec::new(),
                files_modified: vec!["src/lib.rs".to_string()],
                tool_name: Some("write".to_string()),
                tool_call_id: Some("tool-1".to_string()),
                source: "tool_event".to_string(),
                generated_by_model: None,
                created_at_epoch: 1_000,
                content_hash: None,
            })
            .unwrap()
            .unwrap();
        manager
            .save_structured_source(MemorySourceInput {
                memory_kind: "observation".to_string(),
                memory_id: observation_id,
                source_type: "tool_call".to_string(),
                source_ref: Some("tool-1".to_string()),
                metadata_json: "{}".to_string(),
                created_at_epoch: 1_001,
            })
            .unwrap()
            .unwrap();
        let summary_id = manager
            .save_structured_summary(MemorySummaryInput {
                session_id: "session-1".to_string(),
                project_key: String::new(),
                prompt_number: Some(1),
                request: Some("context compaction".to_string()),
                investigated: None,
                learned: Some("summary learned important context".to_string()),
                completed: None,
                next_steps: None,
                notes: None,
                created_at_epoch: 1_002,
            })
            .unwrap()
            .unwrap();
        manager
            .save_structured_source(MemorySourceInput {
                memory_kind: "summary".to_string(),
                memory_id: summary_id,
                source_type: "compaction".to_string(),
                source_ref: Some("session-1".to_string()),
                metadata_json: "{}".to_string(),
                created_at_epoch: 1_003,
            })
            .unwrap()
            .unwrap();

        let report = memories_report(&manager);

        assert!(report.contains("Structured observations:"));
        assert!(report.contains("[file_change#"));
        assert!(report.contains("source: tool_call tool-1"));
        assert!(report.contains("Structured summaries:"));
        assert!(report.contains("[summary#"));
        assert!(report.contains("source: compaction session-1"));
        assert!(report.contains("Legacy memories:"));
        assert!(report.contains("[project] legacy memory still visible"));
    }

    #[test]
    fn memories_import_report_imports_legacy_memories_once() {
        let tmp = tempfile::tempdir().unwrap();
        let global = MemoryStore::with_path(tmp.path().join("memories.json"));
        global
            .add("project", "legacy migration fact", "manual")
            .unwrap();
        let manager = kcoder_memory::MemoryManager::global_only(global)
            .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a");

        let report = memory_import_report(&manager, "legacy").unwrap();

        assert!(report.contains("scanned=1"));
        assert!(report.contains("imported=1"));
        let memories = memories_report(&manager);
        assert!(memories.contains("[legacy_memory#"));
        assert!(memories.contains("legacy migration fact"));
        assert!(memories.contains("imported as legacy_memory#"));

        let second = memory_import_report(&manager, "legacy").unwrap();

        assert!(second.contains("imported=0"));
        assert!(second.contains("skipped_existing=1"));
        let legacy = manager.all_memories();
        let status = manager
            .legacy_memory_import_status(&legacy[0])
            .unwrap()
            .unwrap();
        manager
            .hide_structured_observation(status.observation_id)
            .unwrap();
        assert!(memories_report(&manager).contains("imported hidden as legacy_memory#"));
        assert!(memory_import_report(&manager, "unknown").is_err());
    }

    #[test]
    fn memories_detail_report_shows_structured_observation_by_label() {
        let tmp = tempfile::tempdir().unwrap();
        let manager = kcoder_memory::MemoryManager::global_only(MemoryStore::with_path(
            tmp.path().join("memories.json"),
        ))
        .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a");
        let observation_id = manager
            .save_structured_observation(MemoryObservationInput {
                session_id: "session-1".to_string(),
                project_key: String::new(),
                prompt_number: Some(3),
                observation_type: "file_change".to_string(),
                title: Some("Tool changed src/lib.rs".to_string()),
                subtitle: Some("write succeeded".to_string()),
                narrative: Some("The write tool updated the memory command.".to_string()),
                facts: vec!["detail view should show facts".to_string()],
                concepts: vec!["tool-event".to_string(), "memory-management".to_string()],
                files_read: vec!["src/lib.rs".to_string()],
                files_modified: vec!["src/lib.rs".to_string()],
                tool_name: Some("write".to_string()),
                tool_call_id: Some("tool-1".to_string()),
                source: "tool_event".to_string(),
                generated_by_model: None,
                created_at_epoch: 1_000,
                content_hash: None,
            })
            .unwrap()
            .unwrap();
        manager
            .save_structured_source(MemorySourceInput {
                memory_kind: "observation".to_string(),
                memory_id: observation_id,
                source_type: "tool_call".to_string(),
                source_ref: Some("tool-1".to_string()),
                metadata_json: r#"{"path":"src/lib.rs"}"#.to_string(),
                created_at_epoch: 1_001,
            })
            .unwrap()
            .unwrap();

        let report = memory_detail_report(&manager, &format!("[file_change#{observation_id}]"))
            .unwrap()
            .unwrap();

        assert!(report.contains(&format!("[file_change#{observation_id}]")));
        assert!(report.contains("prompt_number: 3"));
        assert!(report.contains("title: Tool changed src/lib.rs"));
        assert!(report.contains("- detail view should show facts"));
        assert!(report.contains("- memory-management"));
        assert!(report.contains("tool_call_id: tool-1"));
        assert!(report.contains("sources:"));
        assert!(report.contains(r#"metadata: {"path":"src/lib.rs"}"#));
    }

    #[test]
    fn memories_detail_report_shows_structured_summary_by_kind_and_id() {
        let tmp = tempfile::tempdir().unwrap();
        let manager = kcoder_memory::MemoryManager::global_only(MemoryStore::with_path(
            tmp.path().join("memories.json"),
        ))
        .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a");
        let summary_id = manager
            .save_structured_summary(MemorySummaryInput {
                session_id: "session-1".to_string(),
                project_key: String::new(),
                prompt_number: Some(5),
                request: Some("summarize memory progress".to_string()),
                investigated: Some("checked /memories command".to_string()),
                learned: Some("detail views can use existing manager getters".to_string()),
                completed: Some("added REPL detail formatting".to_string()),
                next_steps: Some("consider delete support".to_string()),
                notes: None,
                created_at_epoch: 2_000,
            })
            .unwrap()
            .unwrap();
        manager
            .save_structured_source(MemorySourceInput {
                memory_kind: "summary".to_string(),
                memory_id: summary_id,
                source_type: "compaction".to_string(),
                source_ref: Some("session-1".to_string()),
                metadata_json: "{}".to_string(),
                created_at_epoch: 2_001,
            })
            .unwrap()
            .unwrap();

        let report = memory_detail_report(&manager, &format!("summary {summary_id}"))
            .unwrap()
            .unwrap();

        assert!(report.contains(&format!("[summary#{summary_id}]")));
        assert!(report.contains("prompt_number: 5"));
        assert!(report.contains("request: summarize memory progress"));
        assert!(report.contains("learned: detail views can use existing manager getters"));
        assert!(report.contains("next_steps: consider delete support"));
        assert!(report.contains("source: compaction session-1 at 2001"));
    }

    #[test]
    fn memories_visibility_report_hides_and_restores_structured_memories() {
        let tmp = tempfile::tempdir().unwrap();
        let manager = kcoder_memory::MemoryManager::global_only(MemoryStore::with_path(
            tmp.path().join("memories.json"),
        ))
        .with_structured_store(StructuredMemoryStore::in_memory().unwrap(), "project-a");
        let observation_id = manager
            .save_structured_observation(MemoryObservationInput {
                session_id: "session-1".to_string(),
                project_key: String::new(),
                prompt_number: Some(1),
                observation_type: "file_change".to_string(),
                title: Some("Hide this observation".to_string()),
                subtitle: None,
                narrative: Some("Hidden observations should leave default views.".to_string()),
                facts: Vec::new(),
                concepts: vec!["memory-management".to_string()],
                files_read: Vec::new(),
                files_modified: vec!["src/lib.rs".to_string()],
                tool_name: Some("write".to_string()),
                tool_call_id: Some("tool-1".to_string()),
                source: "tool_event".to_string(),
                generated_by_model: None,
                created_at_epoch: 1_000,
                content_hash: None,
            })
            .unwrap()
            .unwrap();
        let summary_id = manager
            .save_structured_summary(MemorySummaryInput {
                session_id: "session-1".to_string(),
                project_key: String::new(),
                prompt_number: Some(1),
                request: Some("hide this summary".to_string()),
                investigated: None,
                learned: Some("hidden summaries should leave default views".to_string()),
                completed: None,
                next_steps: None,
                notes: None,
                created_at_epoch: 1_001,
            })
            .unwrap()
            .unwrap();

        let hidden =
            memory_visibility_report(&manager, &format!("file_change#{observation_id}"), true)
                .unwrap();
        assert_eq!(hidden, format!("Hidden observation#{observation_id}."));
        assert!(
            memory_detail_report(&manager, &observation_id.to_string())
                .unwrap()
                .is_none()
        );
        assert!(!memories_report(&manager).contains("Hide this observation"));
        let hidden_report = hidden_memories_report(&manager, "").unwrap();
        assert!(hidden_report.contains("Hidden structured observations:"));
        assert!(hidden_report.contains(&format!("[file_change#{observation_id}]")));
        assert!(hidden_report.contains("hidden_at:"));
        let hidden_observations = hidden_memories_report(&manager, "observations").unwrap();
        assert!(hidden_observations.contains("Hide this observation"));
        assert!(!hidden_observations.contains("Hidden structured summaries:"));

        let restored =
            memory_visibility_report(&manager, &format!("observation {observation_id}"), false)
                .unwrap();
        assert_eq!(restored, format!("Restored observation#{observation_id}."));
        assert!(memories_report(&manager).contains("Hide this observation"));

        let hidden_summary =
            memory_visibility_report(&manager, &format!("summary {summary_id}"), true).unwrap();
        assert_eq!(hidden_summary, format!("Hidden summary#{summary_id}."));
        assert!(!memories_report(&manager).contains("hidden summaries should leave default views"));
        let hidden_summaries = hidden_memories_report(&manager, "summary").unwrap();
        assert!(hidden_summaries.contains("Hidden structured summaries:"));
        assert!(hidden_summaries.contains(&format!("[summary#{summary_id}]")));
        assert!(hidden_summaries.contains("hidden summaries should leave default views"));
        assert!(!hidden_summaries.contains("Hidden structured observations:"));

        let restored_summary =
            memory_visibility_report(&manager, &format!("summary#{summary_id}"), false).unwrap();
        assert_eq!(restored_summary, format!("Restored summary#{summary_id}."));
        assert!(memories_report(&manager).contains("hidden summaries should leave default views"));
        assert_eq!(
            hidden_memories_report(&manager, "").unwrap(),
            "No hidden structured memories."
        );
    }

    #[test]
    fn memories_detail_query_parses_common_id_forms() {
        assert_eq!(
            parse_hidden_memory_filter("").unwrap(),
            HiddenMemoryFilter::All
        );
        assert_eq!(
            parse_hidden_memory_filter("observations").unwrap(),
            HiddenMemoryFilter::Observations
        );
        assert_eq!(
            parse_hidden_memory_filter("summary").unwrap(),
            HiddenMemoryFilter::Summaries
        );
        assert!(parse_hidden_memory_filter("legacy").is_err());
        assert_eq!(
            parse_memory_detail_query("7").unwrap(),
            MemoryDetailQuery {
                kind: MemoryDetailKind::Observation,
                id: 7,
            }
        );
        assert_eq!(
            parse_memory_detail_query("show [summary#8]").unwrap(),
            MemoryDetailQuery {
                kind: MemoryDetailKind::Summary,
                id: 8,
            }
        );
        assert_eq!(
            parse_memory_detail_query("file_change#9").unwrap(),
            MemoryDetailQuery {
                kind: MemoryDetailKind::Observation,
                id: 9,
            }
        );
        assert!(parse_memory_detail_query("summary 0").is_err());
        assert!(parse_memory_detail_query("summary nope").is_err());
    }

    #[test]
    fn memories_report_is_empty_when_no_memory_exists() {
        let manager = kcoder_memory::MemoryManager::global_only(MemoryStore::empty());

        assert!(memories_report(&manager).is_empty());
    }
}
