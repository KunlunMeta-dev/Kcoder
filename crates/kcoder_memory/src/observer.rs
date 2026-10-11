use crate::{
    sanitize_memory_text,
    sqlite::{MemoryObservationInput, MemorySummaryInput},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};

pub const MEMORY_OBSERVER_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryObserverSanitizationOptions {
    pub private_by_default: bool,
    pub private_file_paths: bool,
    pub private_verification_targets: bool,
    pub record_prompt_placeholders: bool,
}

impl Default for MemoryObserverSanitizationOptions {
    fn default() -> Self {
        Self {
            private_by_default: false,
            private_file_paths: false,
            private_verification_targets: false,
            record_prompt_placeholders: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryObserverEventBundle {
    pub schema_version: u32,
    pub session_id: String,
    pub project_key: String,
    pub prompt_number: Option<u64>,
    pub prompt: Option<MemoryObserverPrompt>,
    pub events: Vec<MemoryObserverEvent>,
    pub sanitization: MemoryObserverSanitizationAudit,
}

impl MemoryObserverEventBundle {
    pub fn new(
        session_id: impl Into<String>,
        project_key: impl Into<String>,
        prompt_number: Option<u64>,
        prompt_text: Option<&str>,
        options: MemoryObserverSanitizationOptions,
    ) -> Self {
        let mut sanitization = MemoryObserverSanitizationAudit::from_options(&options);
        let prompt = sanitize_prompt(prompt_text, &options, &mut sanitization);
        Self {
            schema_version: MEMORY_OBSERVER_SCHEMA_VERSION,
            session_id: session_id.into(),
            project_key: project_key.into(),
            prompt_number,
            prompt,
            events: Vec::new(),
            sanitization,
        }
    }

    pub fn add_file_change_event(
        &mut self,
        event_id: impl Into<String>,
        tool_name: impl Into<String>,
        files_modified: &[String],
        truncated: bool,
    ) {
        let file_count = files_modified.len();
        let files_modified = if self.sanitization.private_file_paths {
            self.sanitization.omit("events.file_change.files_modified");
            self.sanitization
                .count("events.file_change.files_modified", file_count);
            Vec::new()
        } else {
            sanitize_vec(files_modified)
        };
        self.events.push(MemoryObserverEvent {
            event_id: event_id.into(),
            event_type: MemoryObserverEventType::FileChange,
            tool_name: Some(tool_name.into()),
            file_change: Some(MemoryObserverFileChange {
                files_modified,
                files_modified_count: file_count,
                truncated,
            }),
            verification: None,
            recovery: None,
            compaction_summary: None,
        });
    }

    pub fn add_verification_passed_event(
        &mut self,
        event_id: impl Into<String>,
        tool_name: impl Into<String>,
        label: impl Into<String>,
        command: Option<&str>,
    ) {
        let command = if self.sanitization.private_by_default {
            if command.is_some() {
                self.sanitization.omit("events.verification.command");
            }
            None
        } else {
            sanitize_optional_str(command)
        };
        self.events.push(MemoryObserverEvent {
            event_id: event_id.into(),
            event_type: MemoryObserverEventType::VerificationPassed,
            tool_name: Some(tool_name.into()),
            file_change: None,
            verification: Some(MemoryObserverVerification {
                label: sanitize_memory_text(&label.into()).unwrap_or_default(),
                command,
            }),
            recovery: None,
            compaction_summary: None,
        });
    }

    pub fn add_failure_recovery_event(
        &mut self,
        event_id: impl Into<String>,
        tool_name: impl Into<String>,
        failed_attempts: usize,
        input_preview: Option<&str>,
    ) {
        let input_preview = if self.sanitization.private_by_default {
            if input_preview.is_some() {
                self.sanitization
                    .omit("events.failure_recovered.input_preview");
            }
            None
        } else {
            sanitize_optional_str(input_preview)
        };
        self.events.push(MemoryObserverEvent {
            event_id: event_id.into(),
            event_type: MemoryObserverEventType::FailureRecovered,
            tool_name: Some(tool_name.into()),
            file_change: None,
            verification: None,
            recovery: Some(MemoryObserverRecovery {
                recovery_kind: "same_input".to_string(),
                target: None,
                failed_attempts,
                input_preview,
                failed_command_preview: None,
                passing_command: None,
            }),
            compaction_summary: None,
        });
    }

    pub fn add_verification_target_recovery_event(
        &mut self,
        event_id: impl Into<String>,
        tool_name: impl Into<String>,
        target: impl Into<String>,
        failed_attempts: usize,
        failed_command_preview: Option<&str>,
        passing_command: Option<&str>,
    ) {
        let target = target.into();
        let (target, failed_command_preview, passing_command) =
            if self.sanitization.private_verification_targets {
                self.sanitization
                    .omit("events.failure_recovered.verification_target");
                if failed_command_preview.is_some() {
                    self.sanitization
                        .omit("events.failure_recovered.failed_command_preview");
                }
                if passing_command.is_some() {
                    self.sanitization
                        .omit("events.failure_recovered.passing_command");
                }
                (None, None, None)
            } else if self.sanitization.private_by_default {
                if failed_command_preview.is_some() {
                    self.sanitization
                        .omit("events.failure_recovered.failed_command_preview");
                }
                if passing_command.is_some() {
                    self.sanitization
                        .omit("events.failure_recovered.passing_command");
                }
                (sanitize_memory_text(&target), None, None)
            } else {
                (
                    sanitize_memory_text(&target),
                    sanitize_optional_str(failed_command_preview),
                    sanitize_optional_str(passing_command),
                )
            };
        self.events.push(MemoryObserverEvent {
            event_id: event_id.into(),
            event_type: MemoryObserverEventType::FailureRecovered,
            tool_name: Some(tool_name.into()),
            file_change: None,
            verification: None,
            recovery: Some(MemoryObserverRecovery {
                recovery_kind: "verification_target".to_string(),
                target,
                failed_attempts,
                input_preview: None,
                failed_command_preview,
                passing_command,
            }),
            compaction_summary: None,
        });
    }

    pub fn add_compaction_summary_event(
        &mut self,
        event_id: impl Into<String>,
        summary: MemoryObserverCompactionSummary,
    ) {
        self.events.push(MemoryObserverEvent {
            event_id: event_id.into(),
            event_type: MemoryObserverEventType::CompactionSummary,
            tool_name: None,
            file_change: None,
            verification: None,
            recovery: None,
            compaction_summary: Some(summary.sanitized()),
        });
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryObserverPrompt {
    pub text: Option<String>,
    pub omitted: bool,
    pub char_count: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryObserverSanitizationAudit {
    pub private_by_default: bool,
    pub private_file_paths: bool,
    pub private_verification_targets: bool,
    pub record_prompt_placeholders: bool,
    pub omitted_fields: Vec<String>,
    pub counted_fields: Vec<MemoryObserverCountedField>,
}

impl MemoryObserverSanitizationAudit {
    fn from_options(options: &MemoryObserverSanitizationOptions) -> Self {
        Self {
            private_by_default: options.private_by_default,
            private_file_paths: options.private_file_paths,
            private_verification_targets: options.private_verification_targets,
            record_prompt_placeholders: options.record_prompt_placeholders,
            omitted_fields: Vec::new(),
            counted_fields: Vec::new(),
        }
    }

    fn omit(&mut self, field: &str) {
        if !self.omitted_fields.iter().any(|existing| existing == field) {
            self.omitted_fields.push(field.to_string());
        }
    }

    fn count(&mut self, field: &str, count: usize) {
        if !self
            .counted_fields
            .iter()
            .any(|existing| existing.field == field)
        {
            self.counted_fields.push(MemoryObserverCountedField {
                field: field.to_string(),
                count,
            });
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryObserverCountedField {
    pub field: String,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryObserverEventType {
    FileChange,
    VerificationPassed,
    FailureRecovered,
    CompactionSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryObserverEvent {
    pub event_id: String,
    pub event_type: MemoryObserverEventType,
    pub tool_name: Option<String>,
    pub file_change: Option<MemoryObserverFileChange>,
    pub verification: Option<MemoryObserverVerification>,
    pub recovery: Option<MemoryObserverRecovery>,
    pub compaction_summary: Option<MemoryObserverCompactionSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryObserverFileChange {
    pub files_modified: Vec<String>,
    pub files_modified_count: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryObserverVerification {
    pub label: String,
    pub command: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryObserverRecovery {
    pub recovery_kind: String,
    pub target: Option<String>,
    pub failed_attempts: usize,
    pub input_preview: Option<String>,
    pub failed_command_preview: Option<String>,
    pub passing_command: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryObserverCompactionSummary {
    pub pre_compact_tokens: usize,
    pub post_compact_tokens: usize,
    pub request: Option<String>,
    pub investigated: Option<String>,
    pub learned: Option<String>,
    pub completed: Option<String>,
    pub next_steps: Option<String>,
    pub notes: Option<String>,
}

impl MemoryObserverCompactionSummary {
    fn sanitized(mut self) -> Self {
        self.request = sanitize_optional_string(self.request);
        self.investigated = sanitize_optional_string(self.investigated);
        self.learned = sanitize_optional_string(self.learned);
        self.completed = sanitize_optional_string(self.completed);
        self.next_steps = sanitize_optional_string(self.next_steps);
        self.notes = sanitize_optional_string(self.notes);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryObserverDraft {
    pub observation_candidates: Vec<MemoryObserverObservationCandidate>,
    pub summary_candidates: Vec<MemoryObserverSummaryCandidate>,
    pub skip_reasons: Vec<MemoryObserverSkipReason>,
    pub audit: MemoryObserverDraftAudit,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryObserverObservationCandidate {
    pub source_event_ids: Vec<String>,
    pub observation_type: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub narrative: Option<String>,
    pub facts: Vec<String>,
    pub concepts: Vec<String>,
    pub files_read: Vec<String>,
    pub files_modified: Vec<String>,
    pub confidence: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryObserverSummaryCandidate {
    pub source_event_ids: Vec<String>,
    pub request: Option<String>,
    pub investigated: Option<String>,
    pub learned: Option<String>,
    pub completed: Option<String>,
    pub next_steps: Option<String>,
    pub notes: Option<String>,
    pub confidence: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryObserverSkipReason {
    pub source_event_ids: Vec<String>,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryObserverDraftAudit {
    pub model: Option<String>,
    pub generated_at_epoch: Option<u64>,
    pub privacy_notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryObserverDraftValidationIssue {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryObserverQueueOverflowPolicy {
    #[default]
    InlineFallback,
    DropNewest,
    DropOldest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryObserverQueueConfig {
    pub capacity: usize,
    pub overflow_policy: MemoryObserverQueueOverflowPolicy,
}

impl Default for MemoryObserverQueueConfig {
    fn default() -> Self {
        Self {
            capacity: 128,
            overflow_policy: MemoryObserverQueueOverflowPolicy::InlineFallback,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryObserverQueueStats {
    pub capacity: usize,
    pub queued: usize,
    pub submitted: u64,
    pub enqueued: u64,
    pub drained: u64,
    pub overflowed: u64,
    pub inline_fallbacks: u64,
    pub dropped_newest: u64,
    pub dropped_oldest: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MemoryObserverQueueSubmitResult {
    Queued,
    InlineFallback(MemoryObserverEventBundle),
    DroppedNewest(MemoryObserverEventBundle),
    DroppedOldest(MemoryObserverEventBundle),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryObserverQueue {
    config: MemoryObserverQueueConfig,
    queue: VecDeque<MemoryObserverEventBundle>,
    stats: MemoryObserverQueueStats,
}

impl MemoryObserverQueue {
    pub fn new(capacity: usize) -> Self {
        Self::with_config(MemoryObserverQueueConfig {
            capacity,
            ..MemoryObserverQueueConfig::default()
        })
    }

    pub fn with_config(mut config: MemoryObserverQueueConfig) -> Self {
        config.capacity = config.capacity.max(1);
        Self {
            stats: MemoryObserverQueueStats {
                capacity: config.capacity,
                ..MemoryObserverQueueStats::default()
            },
            config,
            queue: VecDeque::new(),
        }
    }

    pub fn capacity(&self) -> usize {
        self.config.capacity
    }

    pub fn len(&self) -> usize {
        self.queue.len()
    }

    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    pub fn stats(&self) -> MemoryObserverQueueStats {
        let mut stats = self.stats.clone();
        stats.queued = self.queue.len();
        stats
    }

    pub fn submit(&mut self, bundle: MemoryObserverEventBundle) -> MemoryObserverQueueSubmitResult {
        self.stats.submitted = self.stats.submitted.saturating_add(1);
        if self.queue.len() < self.config.capacity {
            self.queue.push_back(bundle);
            self.stats.enqueued = self.stats.enqueued.saturating_add(1);
            self.update_queued_stat();
            return MemoryObserverQueueSubmitResult::Queued;
        }

        self.stats.overflowed = self.stats.overflowed.saturating_add(1);
        match self.config.overflow_policy {
            MemoryObserverQueueOverflowPolicy::InlineFallback => {
                self.stats.inline_fallbacks = self.stats.inline_fallbacks.saturating_add(1);
                MemoryObserverQueueSubmitResult::InlineFallback(bundle)
            }
            MemoryObserverQueueOverflowPolicy::DropNewest => {
                self.stats.dropped_newest = self.stats.dropped_newest.saturating_add(1);
                MemoryObserverQueueSubmitResult::DroppedNewest(bundle)
            }
            MemoryObserverQueueOverflowPolicy::DropOldest => {
                let dropped = self.queue.pop_front().unwrap_or_else(|| bundle.clone());
                self.queue.push_back(bundle);
                self.stats.dropped_oldest = self.stats.dropped_oldest.saturating_add(1);
                self.stats.enqueued = self.stats.enqueued.saturating_add(1);
                self.update_queued_stat();
                MemoryObserverQueueSubmitResult::DroppedOldest(dropped)
            }
        }
    }

    pub fn drain_next(&mut self) -> Option<MemoryObserverEventBundle> {
        let bundle = self.queue.pop_front()?;
        self.stats.drained = self.stats.drained.saturating_add(1);
        self.update_queued_stat();
        Some(bundle)
    }

    pub fn drain_all(&mut self) -> Vec<MemoryObserverEventBundle> {
        let bundles = self.queue.drain(..).collect::<Vec<_>>();
        self.stats.drained = self
            .stats
            .drained
            .saturating_add(u64::try_from(bundles.len()).unwrap_or(u64::MAX));
        self.update_queued_stat();
        bundles
    }

    fn update_queued_stat(&mut self) {
        self.stats.queued = self.queue.len();
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryObserverStructuredWrites {
    pub observations: Vec<MemoryObserverObservationWrite>,
    pub summaries: Vec<MemoryObserverSummaryWrite>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryObserverObservationWrite {
    pub input: MemoryObservationInput,
    pub source_type: String,
    pub source_ref: Option<String>,
    pub source_metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryObserverSummaryWrite {
    pub input: MemorySummaryInput,
    pub source_type: String,
    pub source_ref: Option<String>,
    pub source_metadata: Value,
}

pub fn memory_observer_output_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": [
            "observation_candidates",
            "summary_candidates",
            "skip_reasons",
            "audit"
        ],
        "properties": {
            "observation_candidates": {
                "type": "array",
                "items": observation_candidate_schema()
            },
            "summary_candidates": {
                "type": "array",
                "items": summary_candidate_schema()
            },
            "skip_reasons": {
                "type": "array",
                "items": skip_reason_schema()
            },
            "audit": {
                "type": "object",
                "additionalProperties": false,
                "required": ["model", "generated_at_epoch", "privacy_notes"],
                "properties": {
                    "model": nullable_string_schema(),
                    "generated_at_epoch": nullable_integer_schema(),
                    "privacy_notes": string_array_schema()
                }
            }
        }
    })
}

pub fn deterministic_memory_observer_draft(
    bundle: &MemoryObserverEventBundle,
) -> MemoryObserverDraft {
    let mut draft = MemoryObserverDraft {
        observation_candidates: Vec::new(),
        summary_candidates: Vec::new(),
        skip_reasons: Vec::new(),
        audit: MemoryObserverDraftAudit {
            model: None,
            generated_at_epoch: None,
            privacy_notes: privacy_notes_for_bundle(bundle),
        },
    };

    for event in &bundle.events {
        match event.event_type {
            MemoryObserverEventType::FileChange => {
                match deterministic_file_change_candidate(event) {
                    Some(candidate) => draft.observation_candidates.push(candidate),
                    None => draft.skip_reasons.push(skip_reason(
                        event,
                        "file change event had no modified files",
                    )),
                }
            }
            MemoryObserverEventType::VerificationPassed => {
                match deterministic_verification_candidate(event) {
                    Some(candidate) => draft.observation_candidates.push(candidate),
                    None => draft
                        .skip_reasons
                        .push(skip_reason(event, "verification event had no label")),
                }
            }
            MemoryObserverEventType::FailureRecovered => {
                match deterministic_recovery_candidate(event) {
                    Some(candidate) => draft.observation_candidates.push(candidate),
                    None => draft.skip_reasons.push(skip_reason(
                        event,
                        "failure recovery event had no recovery payload",
                    )),
                }
            }
            MemoryObserverEventType::CompactionSummary => {
                match deterministic_summary_candidate(event) {
                    Some(candidate) => draft.summary_candidates.push(candidate),
                    None => draft.skip_reasons.push(skip_reason(
                        event,
                        "compaction event had no summary payload",
                    )),
                }
            }
        }
    }

    draft
}

pub fn validate_memory_observer_draft(
    bundle: &MemoryObserverEventBundle,
    draft: &MemoryObserverDraft,
) -> Result<(), Vec<MemoryObserverDraftValidationIssue>> {
    let issues = memory_observer_draft_validation_issues(bundle, draft);
    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

pub fn memory_observer_draft_validation_issues(
    bundle: &MemoryObserverEventBundle,
    draft: &MemoryObserverDraft,
) -> Vec<MemoryObserverDraftValidationIssue> {
    let mut issues = Vec::new();
    let event_ids = bundle
        .events
        .iter()
        .map(|event| event.event_id.as_str())
        .collect::<HashSet<_>>();
    let events = bundle
        .events
        .iter()
        .map(|event| (event.event_id.as_str(), event))
        .collect::<HashMap<_, _>>();

    for (index, candidate) in draft.observation_candidates.iter().enumerate() {
        let path = format!("observation_candidates[{index}]");
        validate_source_event_ids(&mut issues, &path, &candidate.source_event_ids, &event_ids);
        validate_confidence(
            &mut issues,
            &format!("{path}.confidence"),
            candidate.confidence,
        );
        validate_required_text(
            &mut issues,
            &format!("{path}.observation_type"),
            &candidate.observation_type,
        );
        validate_required_text(&mut issues, &format!("{path}.title"), &candidate.title);
        validate_observation_privacy(&mut issues, &path, candidate, &events, bundle);
    }

    for (index, candidate) in draft.summary_candidates.iter().enumerate() {
        let path = format!("summary_candidates[{index}]");
        validate_source_event_ids(&mut issues, &path, &candidate.source_event_ids, &event_ids);
        validate_confidence(
            &mut issues,
            &format!("{path}.confidence"),
            candidate.confidence,
        );
        if [
            &candidate.request,
            &candidate.investigated,
            &candidate.learned,
            &candidate.completed,
            &candidate.next_steps,
            &candidate.notes,
        ]
        .iter()
        .all(|value| optional_text_is_empty(value))
        {
            issues.push(MemoryObserverDraftValidationIssue {
                path,
                message: "summary candidate must include at least one summary field".to_string(),
            });
        }
    }

    for (index, skip) in draft.skip_reasons.iter().enumerate() {
        let path = format!("skip_reasons[{index}]");
        validate_source_event_ids(&mut issues, &path, &skip.source_event_ids, &event_ids);
        validate_required_text(&mut issues, &format!("{path}.reason"), &skip.reason);
    }

    issues
}

pub fn memory_observer_draft_to_structured_writes(
    bundle: &MemoryObserverEventBundle,
    draft: &MemoryObserverDraft,
    created_at_epoch: u64,
    generated_by_model: Option<String>,
) -> MemoryObserverStructuredWrites {
    let observations = draft
        .observation_candidates
        .iter()
        .map(|candidate| {
            let source_event = first_source_event(bundle, &candidate.source_event_ids);
            MemoryObserverObservationWrite {
                input: MemoryObservationInput {
                    session_id: bundle.session_id.clone(),
                    project_key: bundle.project_key.clone(),
                    prompt_number: bundle.prompt_number,
                    observation_type: candidate.observation_type.clone(),
                    title: Some(candidate.title.clone()),
                    subtitle: candidate.subtitle.clone(),
                    narrative: candidate.narrative.clone(),
                    facts: candidate.facts.clone(),
                    concepts: candidate.concepts.clone(),
                    files_read: candidate.files_read.clone(),
                    files_modified: candidate.files_modified.clone(),
                    tool_name: source_event.and_then(|event| event.tool_name.clone()),
                    tool_call_id: first_source_ref(&candidate.source_event_ids),
                    source: source_for_event(source_event).to_string(),
                    generated_by_model: generated_by_model.clone(),
                    created_at_epoch,
                    content_hash: None,
                },
                source_type: source_type_for_event(source_event).to_string(),
                source_ref: first_source_ref(&candidate.source_event_ids),
                source_metadata: observation_source_metadata(
                    bundle,
                    draft,
                    candidate,
                    source_event,
                ),
            }
        })
        .collect();

    let summaries = draft
        .summary_candidates
        .iter()
        .map(|candidate| {
            let source_event = first_source_event(bundle, &candidate.source_event_ids);
            MemoryObserverSummaryWrite {
                input: MemorySummaryInput {
                    session_id: bundle.session_id.clone(),
                    project_key: bundle.project_key.clone(),
                    prompt_number: bundle.prompt_number,
                    request: candidate.request.clone(),
                    investigated: candidate.investigated.clone(),
                    learned: candidate.learned.clone(),
                    completed: candidate.completed.clone(),
                    next_steps: candidate.next_steps.clone(),
                    notes: candidate.notes.clone(),
                    created_at_epoch,
                },
                source_type: source_type_for_event(source_event).to_string(),
                source_ref: first_source_ref(&candidate.source_event_ids),
                source_metadata: summary_source_metadata(bundle, draft, candidate, source_event),
            }
        })
        .collect();

    MemoryObserverStructuredWrites {
        observations,
        summaries,
    }
}

fn validate_source_event_ids(
    issues: &mut Vec<MemoryObserverDraftValidationIssue>,
    path: &str,
    source_event_ids: &[String],
    event_ids: &HashSet<&str>,
) {
    if source_event_ids.is_empty() {
        issues.push(MemoryObserverDraftValidationIssue {
            path: format!("{path}.source_event_ids"),
            message: "source_event_ids must not be empty".to_string(),
        });
        return;
    }
    for (index, event_id) in source_event_ids.iter().enumerate() {
        if !event_ids.contains(event_id.as_str()) {
            issues.push(MemoryObserverDraftValidationIssue {
                path: format!("{path}.source_event_ids[{index}]"),
                message: format!("source event id `{event_id}` is not present in bundle"),
            });
        }
    }
}

fn validate_confidence(
    issues: &mut Vec<MemoryObserverDraftValidationIssue>,
    path: &str,
    confidence: f64,
) {
    if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
        issues.push(MemoryObserverDraftValidationIssue {
            path: path.to_string(),
            message: "confidence must be a finite number between 0.0 and 1.0".to_string(),
        });
    }
}

fn validate_required_text(
    issues: &mut Vec<MemoryObserverDraftValidationIssue>,
    path: &str,
    text: &str,
) {
    if text.trim().is_empty() {
        issues.push(MemoryObserverDraftValidationIssue {
            path: path.to_string(),
            message: "field must not be empty".to_string(),
        });
    }
}

fn validate_observation_privacy(
    issues: &mut Vec<MemoryObserverDraftValidationIssue>,
    path: &str,
    candidate: &MemoryObserverObservationCandidate,
    events: &HashMap<&str, &MemoryObserverEvent>,
    bundle: &MemoryObserverEventBundle,
) {
    for event_id in &candidate.source_event_ids {
        let Some(event) = events.get(event_id.as_str()) else {
            continue;
        };
        match event.event_type {
            MemoryObserverEventType::FileChange => {
                if bundle.sanitization.private_file_paths
                    && (!candidate.files_modified.is_empty() || !candidate.files_read.is_empty())
                {
                    issues.push(MemoryObserverDraftValidationIssue {
                        path: format!("{path}.files_modified"),
                        message: "private file path mode forbids file paths in draft candidates"
                            .to_string(),
                    });
                }
            }
            MemoryObserverEventType::VerificationPassed => {
                if bundle.sanitization.private_by_default
                    && event
                        .verification
                        .as_ref()
                        .is_some_and(|verification| verification.command.is_none())
                    && observation_text(candidate).contains("Passing command:")
                {
                    issues.push(MemoryObserverDraftValidationIssue {
                        path: path.to_string(),
                        message:
                            "private-by-default verification draft must not include command text"
                                .to_string(),
                    });
                }
            }
            MemoryObserverEventType::FailureRecovered => {
                validate_recovery_privacy(issues, path, candidate, event, bundle);
            }
            MemoryObserverEventType::CompactionSummary => {}
        }
    }
}

fn validate_recovery_privacy(
    issues: &mut Vec<MemoryObserverDraftValidationIssue>,
    path: &str,
    candidate: &MemoryObserverObservationCandidate,
    event: &MemoryObserverEvent,
    bundle: &MemoryObserverEventBundle,
) {
    let Some(recovery) = &event.recovery else {
        return;
    };
    let candidate_text = observation_text(candidate);
    if bundle.sanitization.private_by_default
        && recovery.recovery_kind == "same_input"
        && recovery.input_preview.is_none()
        && candidate_text.contains("Input preview:")
    {
        issues.push(MemoryObserverDraftValidationIssue {
            path: path.to_string(),
            message: "private-by-default recovery draft must not include input preview".to_string(),
        });
    }
    if bundle.sanitization.private_verification_targets
        && recovery.recovery_kind == "verification_target"
        && recovery.target.is_none()
    {
        if candidate.title.trim() != "Verification target recovered" {
            issues.push(MemoryObserverDraftValidationIssue {
                path: format!("{path}.title"),
                message: "private verification target draft must use the generic recovery title"
                    .to_string(),
            });
        }
        for forbidden in [
            "Verification target `",
            "Last failed command:",
            "Passing command:",
        ] {
            if candidate_text.contains(forbidden) {
                issues.push(MemoryObserverDraftValidationIssue {
                    path: path.to_string(),
                    message: format!(
                        "private verification target draft must not include `{forbidden}`"
                    ),
                });
            }
        }
    }
}

fn observation_text(candidate: &MemoryObserverObservationCandidate) -> String {
    let mut parts = Vec::new();
    parts.push(candidate.title.as_str());
    if let Some(subtitle) = &candidate.subtitle {
        parts.push(subtitle.as_str());
    }
    if let Some(narrative) = &candidate.narrative {
        parts.push(narrative.as_str());
    }
    for fact in &candidate.facts {
        parts.push(fact.as_str());
    }
    for concept in &candidate.concepts {
        parts.push(concept.as_str());
    }
    parts.join("\n")
}

fn optional_text_is_empty(text: &Option<String>) -> bool {
    text.as_deref().is_none_or(|text| text.trim().is_empty())
}

fn deterministic_file_change_candidate(
    event: &MemoryObserverEvent,
) -> Option<MemoryObserverObservationCandidate> {
    let file_change = event.file_change.as_ref()?;
    if file_change.files_modified_count == 0 {
        return None;
    }
    let tool_name = event.tool_name.as_deref().unwrap_or("tool");
    let file_count = file_change.files_modified_count;
    let title = format!("Tool `{tool_name}` modified {file_count} file(s)");
    let narrative = if file_change.files_modified.is_empty() && file_change.truncated {
        format!("Tool `{tool_name}` modified at least {file_count} file(s).")
    } else if file_change.files_modified.is_empty() {
        format!("Tool `{tool_name}` modified {file_count} file(s).")
    } else if file_change.truncated {
        format!(
            "Tool `{tool_name}` modified at least {file_count} file(s): {}",
            file_change.files_modified.join(", ")
        )
    } else {
        format!(
            "Tool `{tool_name}` modified {file_count} file(s): {}",
            file_change.files_modified.join(", ")
        )
    };
    Some(MemoryObserverObservationCandidate {
        source_event_ids: vec![event.event_id.clone()],
        observation_type: "file_change".to_string(),
        title,
        subtitle: None,
        narrative: Some(narrative.clone()),
        facts: vec![narrative],
        concepts: vec!["tool-event".to_string(), "file-change".to_string()],
        files_read: Vec::new(),
        files_modified: file_change.files_modified.clone(),
        confidence: 1.0,
    })
}

fn deterministic_verification_candidate(
    event: &MemoryObserverEvent,
) -> Option<MemoryObserverObservationCandidate> {
    let verification = event.verification.as_ref()?;
    if verification.label.trim().is_empty() {
        return None;
    }
    let title = format!("Verification passed: {}", verification.label);
    let narrative = match verification.command.as_deref() {
        Some(command) if !command.trim().is_empty() => {
            format!("Verification command succeeded: {}", command.trim())
        }
        _ => format!("Verification command succeeded: {}", verification.label),
    };
    Some(MemoryObserverObservationCandidate {
        source_event_ids: vec![event.event_id.clone()],
        observation_type: "verification_passed".to_string(),
        title,
        subtitle: None,
        narrative: Some(narrative.clone()),
        facts: vec![narrative],
        concepts: vec!["tool-event".to_string(), "verification".to_string()],
        files_read: Vec::new(),
        files_modified: Vec::new(),
        confidence: 1.0,
    })
}

fn deterministic_recovery_candidate(
    event: &MemoryObserverEvent,
) -> Option<MemoryObserverObservationCandidate> {
    let recovery = event.recovery.as_ref()?;
    match recovery.recovery_kind.as_str() {
        "same_input" => Some(deterministic_same_input_recovery_candidate(event, recovery)),
        "verification_target" => Some(deterministic_verification_target_candidate(event, recovery)),
        _ => None,
    }
}

fn deterministic_same_input_recovery_candidate(
    event: &MemoryObserverEvent,
    recovery: &MemoryObserverRecovery,
) -> MemoryObserverObservationCandidate {
    let tool_name = event.tool_name.as_deref().unwrap_or("tool");
    let title = format!("Tool `{tool_name}` recovered after prior failure");
    let narrative = match recovery.input_preview.as_deref() {
        Some(preview) if !preview.trim().is_empty() => format!(
            "Tool `{tool_name}` succeeded after {} prior failed attempt(s) with the same input. Input preview: {}",
            recovery.failed_attempts,
            preview.trim()
        ),
        _ => format!(
            "Tool `{tool_name}` succeeded after {} prior failed attempt(s) with the same input.",
            recovery.failed_attempts
        ),
    };
    MemoryObserverObservationCandidate {
        source_event_ids: vec![event.event_id.clone()],
        observation_type: "failure_recovered".to_string(),
        title,
        subtitle: None,
        narrative: Some(narrative.clone()),
        facts: vec![narrative],
        concepts: vec![
            "tool-event".to_string(),
            "failure-recovery".to_string(),
            "gotcha".to_string(),
        ],
        files_read: Vec::new(),
        files_modified: Vec::new(),
        confidence: 1.0,
    }
}

fn deterministic_verification_target_candidate(
    event: &MemoryObserverEvent,
    recovery: &MemoryObserverRecovery,
) -> MemoryObserverObservationCandidate {
    let title = match recovery.target.as_deref() {
        Some(target) if !target.trim().is_empty() => {
            format!("Verification target recovered: {}", target.trim())
        }
        _ => "Verification target recovered".to_string(),
    };
    let narrative = match (
        recovery.target.as_deref(),
        recovery.failed_command_preview.as_deref(),
        recovery.passing_command.as_deref(),
    ) {
        (Some(target), Some(failed), Some(passing))
            if !target.trim().is_empty()
                && !failed.trim().is_empty()
                && !passing.trim().is_empty() =>
        {
            format!(
                "Verification target `{}` succeeded after {} prior failed attempt(s). Last failed command: {}. Passing command: {}",
                target.trim(),
                recovery.failed_attempts,
                failed.trim(),
                passing.trim()
            )
        }
        (Some(target), _, _) if !target.trim().is_empty() => format!(
            "Verification target `{}` succeeded after {} prior failed attempt(s).",
            target.trim(),
            recovery.failed_attempts
        ),
        _ => format!(
            "A verification target succeeded after {} prior failed attempt(s).",
            recovery.failed_attempts
        ),
    };
    MemoryObserverObservationCandidate {
        source_event_ids: vec![event.event_id.clone()],
        observation_type: "failure_recovered".to_string(),
        title,
        subtitle: None,
        narrative: Some(narrative.clone()),
        facts: vec![narrative],
        concepts: vec![
            "tool-event".to_string(),
            "failure-recovery".to_string(),
            "verification-target".to_string(),
            "gotcha".to_string(),
        ],
        files_read: Vec::new(),
        files_modified: Vec::new(),
        confidence: 1.0,
    }
}

fn deterministic_summary_candidate(
    event: &MemoryObserverEvent,
) -> Option<MemoryObserverSummaryCandidate> {
    let summary = event.compaction_summary.as_ref()?;
    Some(MemoryObserverSummaryCandidate {
        source_event_ids: vec![event.event_id.clone()],
        request: summary.request.clone(),
        investigated: summary.investigated.clone(),
        learned: summary.learned.clone(),
        completed: summary.completed.clone(),
        next_steps: summary.next_steps.clone(),
        notes: summary.notes.clone(),
        confidence: 1.0,
    })
}

fn skip_reason(event: &MemoryObserverEvent, reason: &str) -> MemoryObserverSkipReason {
    MemoryObserverSkipReason {
        source_event_ids: vec![event.event_id.clone()],
        reason: reason.to_string(),
    }
}

fn privacy_notes_for_bundle(bundle: &MemoryObserverEventBundle) -> Vec<String> {
    let mut notes = Vec::new();
    for field in &bundle.sanitization.omitted_fields {
        notes.push(format!("omitted {field}"));
    }
    for counted in &bundle.sanitization.counted_fields {
        notes.push(format!("counted {} as {}", counted.field, counted.count));
    }
    notes
}

fn first_source_event<'a>(
    bundle: &'a MemoryObserverEventBundle,
    source_event_ids: &[String],
) -> Option<&'a MemoryObserverEvent> {
    let first = source_event_ids.first()?;
    bundle.events.iter().find(|event| &event.event_id == first)
}

fn first_source_ref(source_event_ids: &[String]) -> Option<String> {
    source_event_ids.first().cloned()
}

fn source_for_event(source_event: Option<&MemoryObserverEvent>) -> &'static str {
    match source_event.map(|event| &event.event_type) {
        Some(MemoryObserverEventType::CompactionSummary) => "compaction",
        Some(_) => "tool_event",
        None => "observer_draft",
    }
}

fn source_type_for_event(source_event: Option<&MemoryObserverEvent>) -> &'static str {
    match source_event.map(|event| &event.event_type) {
        Some(MemoryObserverEventType::CompactionSummary) => "compaction",
        Some(_) => "tool_call",
        None => "observer_draft",
    }
}

fn observation_source_metadata(
    bundle: &MemoryObserverEventBundle,
    draft: &MemoryObserverDraft,
    candidate: &MemoryObserverObservationCandidate,
    source_event: Option<&MemoryObserverEvent>,
) -> Value {
    let mut metadata = serde_json::Map::new();
    insert_common_source_metadata(&mut metadata, bundle, draft, &candidate.source_event_ids);
    metadata.insert(
        "observation_type".to_string(),
        Value::String(candidate.observation_type.clone()),
    );
    metadata.insert("confidence".to_string(), json!(candidate.confidence));

    if let Some(tool_name) = source_event.and_then(|event| event.tool_name.as_deref()) {
        metadata.insert(
            "tool_name".to_string(),
            Value::String(tool_name.to_string()),
        );
    }

    match source_event.map(|event| &event.event_type) {
        Some(MemoryObserverEventType::FileChange) => {
            if candidate.files_modified.is_empty() {
                if let Some(count) = source_event
                    .and_then(|event| event.file_change.as_ref())
                    .map(|file_change| file_change.files_modified_count)
                {
                    metadata.insert("files_modified_count".to_string(), json!(count));
                }
            } else {
                metadata.insert(
                    "files_modified".to_string(),
                    json!(candidate.files_modified),
                );
            }
            if let Some(truncated) = source_event
                .and_then(|event| event.file_change.as_ref())
                .map(|file_change| file_change.truncated)
            {
                metadata.insert("truncated".to_string(), Value::Bool(truncated));
            }
        }
        Some(MemoryObserverEventType::VerificationPassed) => {
            if let Some(verification) = source_event.and_then(|event| event.verification.as_ref()) {
                metadata.insert(
                    "verification_label".to_string(),
                    Value::String(verification.label.clone()),
                );
                if let Some(command) = &verification.command {
                    metadata.insert("command".to_string(), Value::String(command.clone()));
                }
            }
        }
        Some(MemoryObserverEventType::FailureRecovered) => {
            if let Some(recovery) = source_event.and_then(|event| event.recovery.as_ref()) {
                metadata.insert(
                    "recovery_kind".to_string(),
                    Value::String(recovery.recovery_kind.clone()),
                );
                metadata.insert(
                    "failed_attempts".to_string(),
                    json!(recovery.failed_attempts),
                );
                if let Some(target) = &recovery.target {
                    metadata.insert(
                        "verification_target".to_string(),
                        Value::String(target.clone()),
                    );
                }
                if let Some(input_preview) = &recovery.input_preview {
                    metadata.insert(
                        "input_preview".to_string(),
                        Value::String(input_preview.clone()),
                    );
                }
                if let Some(failed) = &recovery.failed_command_preview {
                    metadata.insert(
                        "failed_command_preview".to_string(),
                        Value::String(failed.clone()),
                    );
                }
                if let Some(passing) = &recovery.passing_command {
                    metadata.insert(
                        "passing_command".to_string(),
                        Value::String(passing.clone()),
                    );
                }
            }
        }
        _ => {}
    }

    Value::Object(metadata)
}

fn summary_source_metadata(
    bundle: &MemoryObserverEventBundle,
    draft: &MemoryObserverDraft,
    candidate: &MemoryObserverSummaryCandidate,
    source_event: Option<&MemoryObserverEvent>,
) -> Value {
    let mut metadata = serde_json::Map::new();
    insert_common_source_metadata(&mut metadata, bundle, draft, &candidate.source_event_ids);
    metadata.insert("confidence".to_string(), json!(candidate.confidence));
    if let Some(summary) = source_event.and_then(|event| event.compaction_summary.as_ref()) {
        metadata.insert(
            "pre_compact_tokens".to_string(),
            json!(summary.pre_compact_tokens),
        );
        metadata.insert(
            "post_compact_tokens".to_string(),
            json!(summary.post_compact_tokens),
        );
    }
    Value::Object(metadata)
}

fn insert_common_source_metadata(
    metadata: &mut serde_json::Map<String, Value>,
    bundle: &MemoryObserverEventBundle,
    draft: &MemoryObserverDraft,
    source_event_ids: &[String],
) {
    metadata.insert(
        "observer_schema_version".to_string(),
        json!(bundle.schema_version),
    );
    metadata.insert("source_event_ids".to_string(), json!(source_event_ids));
    if !draft.audit.privacy_notes.is_empty() {
        metadata.insert(
            "privacy_notes".to_string(),
            json!(draft.audit.privacy_notes),
        );
    }
    if let Some(model) = &draft.audit.model {
        metadata.insert("observer_model".to_string(), Value::String(model.clone()));
    }
    if let Some(generated_at_epoch) = draft.audit.generated_at_epoch {
        metadata.insert(
            "observer_generated_at_epoch".to_string(),
            json!(generated_at_epoch),
        );
    }
}

fn sanitize_prompt(
    prompt_text: Option<&str>,
    options: &MemoryObserverSanitizationOptions,
    audit: &mut MemoryObserverSanitizationAudit,
) -> Option<MemoryObserverPrompt> {
    let prompt_text = prompt_text?;
    if options.private_by_default && !options.record_prompt_placeholders {
        audit.omit("prompt.text");
        return None;
    }
    if options.private_by_default {
        audit.omit("prompt.text");
        return Some(MemoryObserverPrompt {
            text: None,
            omitted: true,
            char_count: Some(prompt_text.chars().count()),
        });
    }
    sanitize_memory_text(prompt_text).map(|text| MemoryObserverPrompt {
        text: Some(text),
        omitted: false,
        char_count: None,
    })
}

fn sanitize_vec(values: &[String]) -> Vec<String> {
    values
        .iter()
        .filter_map(|value| sanitize_memory_text(value))
        .collect()
}

fn sanitize_optional_str(value: Option<&str>) -> Option<String> {
    value.and_then(sanitize_memory_text)
}

fn sanitize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| sanitize_memory_text(&value))
}

fn observation_candidate_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": [
            "source_event_ids",
            "observation_type",
            "title",
            "subtitle",
            "narrative",
            "facts",
            "concepts",
            "files_read",
            "files_modified",
            "confidence"
        ],
        "properties": {
            "source_event_ids": string_array_schema(),
            "observation_type": {"type": "string"},
            "title": {"type": "string"},
            "subtitle": nullable_string_schema(),
            "narrative": nullable_string_schema(),
            "facts": string_array_schema(),
            "concepts": string_array_schema(),
            "files_read": string_array_schema(),
            "files_modified": string_array_schema(),
            "confidence": confidence_schema()
        }
    })
}

fn summary_candidate_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": [
            "source_event_ids",
            "request",
            "investigated",
            "learned",
            "completed",
            "next_steps",
            "notes",
            "confidence"
        ],
        "properties": {
            "source_event_ids": string_array_schema(),
            "request": nullable_string_schema(),
            "investigated": nullable_string_schema(),
            "learned": nullable_string_schema(),
            "completed": nullable_string_schema(),
            "next_steps": nullable_string_schema(),
            "notes": nullable_string_schema(),
            "confidence": confidence_schema()
        }
    })
}

fn skip_reason_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["source_event_ids", "reason"],
        "properties": {
            "source_event_ids": string_array_schema(),
            "reason": {"type": "string"}
        }
    })
}

fn string_array_schema() -> Value {
    json!({
        "type": "array",
        "items": {"type": "string"}
    })
}

fn nullable_string_schema() -> Value {
    json!({
        "type": ["string", "null"]
    })
}

fn nullable_integer_schema() -> Value {
    json!({
        "type": ["integer", "null"],
        "minimum": 0
    })
}

fn confidence_schema() -> Value {
    json!({
        "type": "number",
        "minimum": 0.0,
        "maximum": 1.0
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue_bundle(event_id: &str) -> MemoryObserverEventBundle {
        let mut bundle = MemoryObserverEventBundle::new(
            "session-a",
            "project-a",
            Some(1),
            None,
            MemoryObserverSanitizationOptions::default(),
        );
        bundle.add_file_change_event(event_id, "write", &[format!("{event_id}.rs")], false);
        bundle
    }

    #[test]
    fn observer_bundle_omits_private_prompt_paths_and_targets() {
        let mut bundle = MemoryObserverEventBundle::new(
            "session-a",
            "project-a",
            Some(7),
            Some("deploy with secret-token"),
            MemoryObserverSanitizationOptions {
                private_by_default: true,
                private_file_paths: true,
                private_verification_targets: true,
                record_prompt_placeholders: false,
            },
        );

        bundle.add_file_change_event(
            "tool-write",
            "write",
            &["secret/path.rs".to_string()],
            false,
        );
        bundle.add_verification_target_recovery_event(
            "tool-test",
            "bash",
            "cargo test secret_target",
            2,
            Some("cargo test secret_target -- --exact"),
            Some("cargo test secret_target"),
        );

        let serialized = serde_json::to_string(&bundle).unwrap();
        assert!(!serialized.contains("secret-token"));
        assert!(!serialized.contains("secret/path.rs"));
        assert!(!serialized.contains("secret_target"));
        assert!(bundle.prompt.is_none());
        assert!(
            bundle
                .sanitization
                .omitted_fields
                .contains(&"prompt.text".to_string())
        );
        assert!(
            bundle
                .sanitization
                .omitted_fields
                .contains(&"events.file_change.files_modified".to_string())
        );
        assert!(bundle.sanitization.counted_fields.iter().any(|field| {
            field.field == "events.file_change.files_modified" && field.count == 1
        }));

        let file_change = bundle.events[0].file_change.as_ref().unwrap();
        assert!(file_change.files_modified.is_empty());
        assert_eq!(file_change.files_modified_count, 1);

        let recovery = bundle.events[1].recovery.as_ref().unwrap();
        assert_eq!(recovery.recovery_kind, "verification_target");
        assert_eq!(recovery.failed_attempts, 2);
        assert!(recovery.target.is_none());
        assert!(recovery.failed_command_preview.is_none());
        assert!(recovery.passing_command.is_none());
    }

    #[test]
    fn observer_bundle_preserves_allowed_context_and_strips_private_tags() {
        let mut bundle = MemoryObserverEventBundle::new(
            "session-a",
            "project-a",
            Some(1),
            Some("implement parser <private>token</private>"),
            MemoryObserverSanitizationOptions::default(),
        );

        bundle.add_file_change_event(
            "tool-write",
            "write",
            &[
                "src/lib.rs".to_string(),
                "<private>secret.rs</private>".to_string(),
            ],
            true,
        );
        bundle.add_verification_passed_event(
            "tool-test",
            "bash",
            "cargo test",
            Some("cargo test <private>--token secret</private>"),
        );

        let serialized = serde_json::to_string(&bundle).unwrap();
        assert!(serialized.contains("implement parser"));
        assert!(serialized.contains("src/lib.rs"));
        assert!(serialized.contains("cargo test"));
        assert!(!serialized.contains("token"));
        assert!(!serialized.contains("secret.rs"));
        assert_eq!(
            bundle.events[0]
                .file_change
                .as_ref()
                .unwrap()
                .files_modified_count,
            2
        );
    }

    #[test]
    fn observer_output_schema_requires_candidates_skip_reasons_and_audit() {
        let schema = memory_observer_output_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);
        let required = schema["required"].as_array().unwrap();
        for field in [
            "observation_candidates",
            "summary_candidates",
            "skip_reasons",
            "audit",
        ] {
            assert!(required.iter().any(|value| value == field));
            assert!(schema["properties"].get(field).is_some());
        }
        let observation = &schema["properties"]["observation_candidates"]["items"];
        assert_eq!(observation["additionalProperties"], false);
        assert!(
            observation["required"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value == "confidence")
        );
    }

    #[test]
    fn deterministic_draft_converts_private_file_change_without_paths() {
        let mut bundle = MemoryObserverEventBundle::new(
            "session-a",
            "project-a",
            Some(1),
            None,
            MemoryObserverSanitizationOptions {
                private_file_paths: true,
                ..MemoryObserverSanitizationOptions::default()
            },
        );
        bundle.add_file_change_event(
            "tool-write",
            "write",
            &["secret/path.rs".to_string()],
            false,
        );

        let draft = deterministic_memory_observer_draft(&bundle);

        assert_eq!(draft.observation_candidates.len(), 1);
        let candidate = &draft.observation_candidates[0];
        assert_eq!(candidate.observation_type, "file_change");
        assert_eq!(candidate.title, "Tool `write` modified 1 file(s)");
        assert_eq!(
            candidate.narrative.as_deref(),
            Some("Tool `write` modified 1 file(s).")
        );
        assert!(candidate.files_modified.is_empty());
        assert!(
            draft
                .audit
                .privacy_notes
                .contains(&"omitted events.file_change.files_modified".to_string())
        );
        let serialized = serde_json::to_string(&draft).unwrap();
        assert!(!serialized.contains("secret/path.rs"));
    }

    #[test]
    fn deterministic_draft_converts_verification_target_recovery_without_target() {
        let mut bundle = MemoryObserverEventBundle::new(
            "session-a",
            "project-a",
            Some(1),
            None,
            MemoryObserverSanitizationOptions {
                private_verification_targets: true,
                ..MemoryObserverSanitizationOptions::default()
            },
        );
        bundle.add_verification_target_recovery_event(
            "tool-test",
            "bash",
            "cargo test secret_target",
            3,
            Some("cargo test secret_target -- --exact"),
            Some("cargo test secret_target"),
        );

        let draft = deterministic_memory_observer_draft(&bundle);

        assert_eq!(draft.observation_candidates.len(), 1);
        let candidate = &draft.observation_candidates[0];
        assert_eq!(candidate.observation_type, "failure_recovered");
        assert_eq!(candidate.title, "Verification target recovered");
        assert_eq!(
            candidate.narrative.as_deref(),
            Some("A verification target succeeded after 3 prior failed attempt(s).")
        );
        assert!(
            candidate
                .concepts
                .contains(&"verification-target".to_string())
        );
        let serialized = serde_json::to_string(&draft).unwrap();
        assert!(!serialized.contains("secret_target"));
    }

    #[test]
    fn deterministic_draft_converts_sanitized_compaction_summary() {
        let mut bundle = MemoryObserverEventBundle::new(
            "session-a",
            "project-a",
            Some(3),
            None,
            MemoryObserverSanitizationOptions::default(),
        );
        bundle.add_compaction_summary_event(
            "compact-1",
            MemoryObserverCompactionSummary {
                pre_compact_tokens: 1200,
                post_compact_tokens: 400,
                request: Some("fix parser".to_string()),
                investigated: Some("checked <private>secret file</private> stack".to_string()),
                learned: Some("parser keeps state".to_string()),
                completed: Some("added tests".to_string()),
                next_steps: None,
                notes: Some("<private>token</private>".to_string()),
            },
        );

        let draft = deterministic_memory_observer_draft(&bundle);

        assert_eq!(draft.summary_candidates.len(), 1);
        let summary = &draft.summary_candidates[0];
        assert_eq!(summary.source_event_ids, vec!["compact-1"]);
        assert_eq!(summary.request.as_deref(), Some("fix parser"));
        assert_eq!(summary.investigated.as_deref(), Some("checked stack"));
        assert_eq!(summary.notes, None);
        let serialized = serde_json::to_string(&draft).unwrap();
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("token"));
    }

    #[test]
    fn adapter_maps_file_change_draft_to_structured_observation_write() {
        let mut bundle = MemoryObserverEventBundle::new(
            "session-a",
            "project-a",
            Some(2),
            None,
            MemoryObserverSanitizationOptions::default(),
        );
        bundle.add_file_change_event("tool-write", "write", &["src/lib.rs".to_string()], false);
        let draft = deterministic_memory_observer_draft(&bundle);

        let writes =
            memory_observer_draft_to_structured_writes(&bundle, &draft, 1234, Some("det".into()));

        assert_eq!(writes.observations.len(), 1);
        assert!(writes.summaries.is_empty());
        let write = &writes.observations[0];
        assert_eq!(write.input.session_id, "session-a");
        assert_eq!(write.input.project_key, "project-a");
        assert_eq!(write.input.prompt_number, Some(2));
        assert_eq!(write.input.observation_type, "file_change");
        assert_eq!(write.input.tool_name.as_deref(), Some("write"));
        assert_eq!(write.input.tool_call_id.as_deref(), Some("tool-write"));
        assert_eq!(write.input.source, "tool_event");
        assert_eq!(write.input.generated_by_model.as_deref(), Some("det"));
        assert_eq!(write.source_type, "tool_call");
        assert_eq!(write.source_ref.as_deref(), Some("tool-write"));
        assert_eq!(write.source_metadata["tool_name"], "write");
        assert_eq!(write.source_metadata["observation_type"], "file_change");
        assert_eq!(write.source_metadata["files_modified"][0], "src/lib.rs");
    }

    #[test]
    fn adapter_preserves_private_verification_target_omission_in_metadata() {
        let mut bundle = MemoryObserverEventBundle::new(
            "session-a",
            "project-a",
            Some(1),
            None,
            MemoryObserverSanitizationOptions {
                private_verification_targets: true,
                ..MemoryObserverSanitizationOptions::default()
            },
        );
        bundle.add_verification_target_recovery_event(
            "tool-test",
            "bash",
            "cargo test secret_target",
            3,
            Some("cargo test secret_target -- --exact"),
            Some("cargo test secret_target"),
        );
        let draft = deterministic_memory_observer_draft(&bundle);

        let writes = memory_observer_draft_to_structured_writes(&bundle, &draft, 1234, None);

        let write = &writes.observations[0];
        assert_eq!(
            write.input.title.as_deref(),
            Some("Verification target recovered")
        );
        assert_eq!(
            write.source_metadata["recovery_kind"],
            "verification_target"
        );
        assert_eq!(write.source_metadata["failed_attempts"], 3);
        assert!(write.source_metadata.get("verification_target").is_none());
        let serialized = serde_json::to_string(&writes).unwrap();
        assert!(!serialized.contains("secret_target"));
    }

    #[test]
    fn adapter_maps_summary_draft_to_structured_summary_write() {
        let mut bundle = MemoryObserverEventBundle::new(
            "session-a",
            "project-a",
            Some(3),
            None,
            MemoryObserverSanitizationOptions::default(),
        );
        bundle.add_compaction_summary_event(
            "session-a",
            MemoryObserverCompactionSummary {
                pre_compact_tokens: 1200,
                post_compact_tokens: 400,
                request: Some("context compaction".to_string()),
                investigated: None,
                learned: Some("kept core facts".to_string()),
                completed: Some("Compacted conversation from 1200 to 400 tokens.".to_string()),
                next_steps: None,
                notes: None,
            },
        );
        let draft = deterministic_memory_observer_draft(&bundle);

        let writes = memory_observer_draft_to_structured_writes(&bundle, &draft, 5678, None);

        assert!(writes.observations.is_empty());
        assert_eq!(writes.summaries.len(), 1);
        let write = &writes.summaries[0];
        assert_eq!(write.input.session_id, "session-a");
        assert_eq!(write.input.project_key, "project-a");
        assert_eq!(write.input.prompt_number, Some(3));
        assert_eq!(write.input.learned.as_deref(), Some("kept core facts"));
        assert_eq!(write.input.created_at_epoch, 5678);
        assert_eq!(write.source_type, "compaction");
        assert_eq!(write.source_ref.as_deref(), Some("session-a"));
        assert_eq!(write.source_metadata["pre_compact_tokens"], 1200);
        assert_eq!(write.source_metadata["post_compact_tokens"], 400);
    }

    #[test]
    fn validation_accepts_deterministic_observer_draft() {
        let mut bundle = MemoryObserverEventBundle::new(
            "session-a",
            "project-a",
            Some(2),
            None,
            MemoryObserverSanitizationOptions::default(),
        );
        bundle.add_file_change_event("tool-write", "write", &["src/lib.rs".to_string()], false);
        bundle.add_verification_passed_event("tool-test", "bash", "cargo test", Some("cargo test"));

        let draft = deterministic_memory_observer_draft(&bundle);

        assert_eq!(validate_memory_observer_draft(&bundle, &draft), Ok(()));
    }

    #[test]
    fn validation_rejects_unknown_event_id_bad_confidence_and_empty_required_fields() {
        let mut bundle = MemoryObserverEventBundle::new(
            "session-a",
            "project-a",
            Some(2),
            None,
            MemoryObserverSanitizationOptions::default(),
        );
        bundle.add_file_change_event("tool-write", "write", &["src/lib.rs".to_string()], false);
        let draft = MemoryObserverDraft {
            observation_candidates: vec![MemoryObserverObservationCandidate {
                source_event_ids: vec!["missing-event".to_string()],
                observation_type: "".to_string(),
                title: " ".to_string(),
                subtitle: None,
                narrative: None,
                facts: Vec::new(),
                concepts: Vec::new(),
                files_read: Vec::new(),
                files_modified: Vec::new(),
                confidence: 1.2,
            }],
            summary_candidates: vec![MemoryObserverSummaryCandidate {
                source_event_ids: Vec::new(),
                request: None,
                investigated: None,
                learned: None,
                completed: None,
                next_steps: None,
                notes: None,
                confidence: f64::NAN,
            }],
            skip_reasons: vec![MemoryObserverSkipReason {
                source_event_ids: vec!["missing-event".to_string()],
                reason: "".to_string(),
            }],
            audit: MemoryObserverDraftAudit {
                model: Some("test-observer".to_string()),
                generated_at_epoch: Some(123),
                privacy_notes: Vec::new(),
            },
        };

        let issues = memory_observer_draft_validation_issues(&bundle, &draft);

        assert!(
            issues
                .iter()
                .any(|issue| issue.message.contains("source event id `missing-event`"))
        );
        assert!(
            issues
                .iter()
                .any(|issue| issue.message.contains("confidence must be a finite number"))
        );
        assert!(
            issues
                .iter()
                .any(|issue| issue.path == "observation_candidates[0].title")
        );
        assert!(
            issues
                .iter()
                .any(|issue| issue.message.contains("summary candidate must include"))
        );
        assert!(
            issues
                .iter()
                .any(|issue| issue.path == "skip_reasons[0].reason")
        );
    }

    #[test]
    fn validation_rejects_private_file_paths_reintroduced_in_draft() {
        let mut bundle = MemoryObserverEventBundle::new(
            "session-a",
            "project-a",
            Some(1),
            None,
            MemoryObserverSanitizationOptions {
                private_file_paths: true,
                ..MemoryObserverSanitizationOptions::default()
            },
        );
        bundle.add_file_change_event(
            "tool-write",
            "write",
            &["secret/path.rs".to_string()],
            false,
        );
        let mut draft = deterministic_memory_observer_draft(&bundle);
        draft.observation_candidates[0]
            .files_modified
            .push("secret/path.rs".to_string());

        let issues = memory_observer_draft_validation_issues(&bundle, &draft);

        assert!(issues.iter().any(|issue| {
            issue
                .message
                .contains("private file path mode forbids file paths")
        }));
    }

    #[test]
    fn validation_rejects_private_verification_target_reintroduced_in_draft() {
        let mut bundle = MemoryObserverEventBundle::new(
            "session-a",
            "project-a",
            Some(1),
            None,
            MemoryObserverSanitizationOptions {
                private_verification_targets: true,
                ..MemoryObserverSanitizationOptions::default()
            },
        );
        bundle.add_verification_target_recovery_event(
            "tool-test",
            "bash",
            "cargo test secret_target",
            3,
            Some("cargo test secret_target -- --exact"),
            Some("cargo test secret_target"),
        );
        let mut draft = deterministic_memory_observer_draft(&bundle);
        draft.observation_candidates[0].title =
            "Verification target recovered: cargo test secret_target".to_string();
        draft.observation_candidates[0].narrative = Some(
            "Verification target `cargo test secret_target` succeeded. Passing command: cargo test secret_target"
                .to_string(),
        );

        let issues = memory_observer_draft_validation_issues(&bundle, &draft);

        assert!(
            issues
                .iter()
                .any(|issue| issue.message.contains("generic recovery title"))
        );
        assert!(
            issues
                .iter()
                .any(|issue| issue.message.contains("Verification target `"))
        );
        assert!(
            issues
                .iter()
                .any(|issue| issue.message.contains("Passing command:"))
        );
    }

    #[test]
    fn observer_queue_enqueues_and_drains_fifo() {
        let mut queue = MemoryObserverQueue::new(2);

        assert_eq!(
            queue.submit(queue_bundle("first")),
            MemoryObserverQueueSubmitResult::Queued
        );
        assert_eq!(
            queue.submit(queue_bundle("second")),
            MemoryObserverQueueSubmitResult::Queued
        );

        let stats = queue.stats();
        assert_eq!(stats.capacity, 2);
        assert_eq!(stats.queued, 2);
        assert_eq!(stats.submitted, 2);
        assert_eq!(stats.enqueued, 2);

        let first = queue.drain_next().unwrap();
        let second = queue.drain_next().unwrap();
        assert_eq!(first.events[0].event_id, "first");
        assert_eq!(second.events[0].event_id, "second");
        assert!(queue.is_empty());
        assert_eq!(queue.stats().drained, 2);
    }

    #[test]
    fn observer_queue_inline_fallback_when_full() {
        let mut queue = MemoryObserverQueue::with_config(MemoryObserverQueueConfig {
            capacity: 1,
            overflow_policy: MemoryObserverQueueOverflowPolicy::InlineFallback,
        });

        assert_eq!(
            queue.submit(queue_bundle("queued")),
            MemoryObserverQueueSubmitResult::Queued
        );
        let result = queue.submit(queue_bundle("inline"));

        match result {
            MemoryObserverQueueSubmitResult::InlineFallback(bundle) => {
                assert_eq!(bundle.events[0].event_id, "inline");
            }
            other => panic!("expected inline fallback, got {other:?}"),
        }
        assert_eq!(queue.len(), 1);
        assert_eq!(queue.stats().overflowed, 1);
        assert_eq!(queue.stats().inline_fallbacks, 1);
        assert_eq!(queue.drain_next().unwrap().events[0].event_id, "queued");
    }

    #[test]
    fn observer_queue_drop_newest_when_full() {
        let mut queue = MemoryObserverQueue::with_config(MemoryObserverQueueConfig {
            capacity: 1,
            overflow_policy: MemoryObserverQueueOverflowPolicy::DropNewest,
        });

        assert_eq!(
            queue.submit(queue_bundle("kept")),
            MemoryObserverQueueSubmitResult::Queued
        );
        let result = queue.submit(queue_bundle("dropped"));

        match result {
            MemoryObserverQueueSubmitResult::DroppedNewest(bundle) => {
                assert_eq!(bundle.events[0].event_id, "dropped");
            }
            other => panic!("expected dropped newest, got {other:?}"),
        }
        assert_eq!(queue.stats().dropped_newest, 1);
        assert_eq!(queue.drain_next().unwrap().events[0].event_id, "kept");
    }

    #[test]
    fn observer_queue_drop_oldest_when_full() {
        let mut queue = MemoryObserverQueue::with_config(MemoryObserverQueueConfig {
            capacity: 1,
            overflow_policy: MemoryObserverQueueOverflowPolicy::DropOldest,
        });

        assert_eq!(
            queue.submit(queue_bundle("old")),
            MemoryObserverQueueSubmitResult::Queued
        );
        let result = queue.submit(queue_bundle("new"));

        match result {
            MemoryObserverQueueSubmitResult::DroppedOldest(bundle) => {
                assert_eq!(bundle.events[0].event_id, "old");
            }
            other => panic!("expected dropped oldest, got {other:?}"),
        }
        assert_eq!(queue.stats().dropped_oldest, 1);
        assert_eq!(queue.drain_next().unwrap().events[0].event_id, "new");
    }

    #[test]
    fn observer_queue_drain_all_updates_stats() {
        let mut queue = MemoryObserverQueue::new(4);
        for event_id in ["one", "two", "three"] {
            assert_eq!(
                queue.submit(queue_bundle(event_id)),
                MemoryObserverQueueSubmitResult::Queued
            );
        }

        let drained = queue.drain_all();

        assert_eq!(
            drained
                .iter()
                .map(|bundle| bundle.events[0].event_id.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "two", "three"]
        );
        assert!(queue.is_empty());
        assert_eq!(queue.stats().drained, 3);
        assert_eq!(queue.stats().queued, 0);
    }
}
