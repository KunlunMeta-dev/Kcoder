//! Native-only evidence projected from trusted tool receipts into existing turn artifacts.
use crate::{error_is_not_found, turn_file_capture::file_capture_now_ms, turn_observation_storage};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::{self as p, ReviewEvidenceState as State, ReviewToolOutcome as Outcome};
pub use kcoder_cli_storage::review_validation::{
    MAX_REVIEW_BYTES, decode_review, review_for_history, validate_review,
};
use kcoder_cli_storage::{
    review_validation::{
        MAX_OBSERVATIONS, review_identity as identity, valid_review_path as valid_path,
    },
    transcript_artifact_journal,
};
use kcoder_config::PrivateDirectory;
use kcoder_engine::{EngineEvent, QueryEngine};
use kcoder_workspace_resources::managed_worktrees::{valid_artifact_id, validate_thread_id};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::{ffi::OsStr, io::Read};

fn bounded(value: &str, max: usize, truncated: &mut bool) -> String {
    let mut end = value.len().min(max);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    *truncated |= end < value.len();
    value[..end].to_owned()
}

pub struct TurnReviewTracker {
    record: p::TurnReviewEvidence,
    storage: Option<turn_observation_storage::TurnObservationStorage>,
    owner: String,
    pending: HashMap<String, p::ReviewToolExecution>,
    next_ordinal: u32,
    ambiguous: HashSet<String>,
    ambiguous_overflow: bool,
    storage_failed: bool,
}

impl TurnReviewTracker {
    pub fn new(engine: &QueryEngine, owner: &kcoder_types::TurnAttemptIdentity) -> Self {
        Self {
            record: p::TurnReviewEvidence {
                version: 1,
                evidence_id: identity(&owner.thread_id, &owner.turn_id, &owner.attempt_id),
                thread_id: owner.thread_id.clone(),
                turn_id: owner.turn_id.clone(),
                attempt_id: owner.attempt_id.clone(),
                state: State::Collecting,
                observations: Vec::new(),
                omitted_count: 0,
            },
            storage: None,
            owner: engine.session_id(),
            pending: HashMap::new(),
            next_ordinal: 0,
            ambiguous: HashSet::new(),
            ambiguous_overflow: false,
            storage_failed: false,
        }
    }
    fn persist(&mut self, engine: &QueryEngine) {
        let result = (|| {
            validate_review(&self.record, &self.owner)?;
            if self.storage.is_none() {
                self.storage = Some(turn_observation_storage::TurnObservationStorage::open(
                    engine,
                    "turn-review-evidence",
                    transcript_artifact_journal::Kind::TurnReviewEvidence,
                )?);
            }
            self.storage
                .as_ref()
                .context("review storage unavailable")?
                .write(
                    &self.record.evidence_id,
                    &serde_json::to_vec(&self.record)?,
                    MAX_REVIEW_BYTES,
                )
        })();
        if let Err(error) = result {
            self.storage_failed = true;
            self.record.state = State::Unknown;
            tracing::warn!(%error, "native review evidence could not be persisted");
        }
    }
    fn entry(&mut self, id: &str, name: &str, command: Option<&str>) -> p::ReviewToolExecution {
        self.next_ordinal = self.next_ordinal.saturating_add(1);
        let mut truncated = false;
        p::ReviewToolExecution {
            ordinal: self.next_ordinal,
            tool_call_id: bounded(id, 512, &mut truncated),
            tool_name: bounded(name, 128, &mut truncated),
            command: command.map(|s| bounded(s, 1024, &mut truncated)),
            execution_observed_at_ms: None,
            result_observed_at_ms: None,
            outcome: Outcome::Pending,
            tool_failed: None,
            process: None,
            artifacts: Vec::new(),
            validation: None,
            output_preview: None,
            details_truncated: truncated,
        }
    }
    fn put(&mut self, mut entry: p::ReviewToolExecution) {
        while serde_json::to_vec(&entry).is_ok_and(|b| b.len() + 4096 > MAX_REVIEW_BYTES) {
            entry.details_truncated = true;
            if entry.output_preview.take().is_some() {
                continue;
            }
            if entry.command.take().is_some() {
                continue;
            }
            if !entry.artifacts.is_empty() {
                entry.artifacts.pop();
                continue;
            }
            if let Some(report) = &mut entry.validation
                && report.entries.len() > 1
            {
                report.entries.pop();
                continue;
            }
            break;
        }
        self.record
            .observations
            .retain(|old| old.ordinal != entry.ordinal);
        self.record.observations.push(entry);
        while self.record.observations.len() > MAX_OBSERVATIONS
            || serde_json::to_vec(&self.record).is_ok_and(|b| b.len() > MAX_REVIEW_BYTES)
        {
            let Some((index, _)) = self
                .record
                .observations
                .iter()
                .enumerate()
                .min_by_key(|(_, item)| review_priority(item))
            else {
                break;
            };
            self.record.observations.remove(index);
            self.record.omitted_count = self.record.omitted_count.saturating_add(1);
        }
    }
    pub fn observe(&mut self, engine: &QueryEngine, event: &EngineEvent) {
        match event {
            EngineEvent::ToolUseStarted { id, name, input } => {
                let entry = self.entry(id, name, input.get("command").and_then(Value::as_str));
                if let Some(mut previous) = self.pending.remove(id) {
                    if self.ambiguous.len() < 128 {
                        self.ambiguous.insert(id.clone());
                    } else {
                        self.ambiguous_overflow = true;
                    }
                    previous.outcome = Outcome::Unknown;
                    self.put(previous);
                }
                if self.pending.len() >= 128 {
                    self.record.omitted_count = self.record.omitted_count.saturating_add(1);
                    return;
                }
                self.pending.insert(id.clone(), entry.clone());
                if matches!(
                    name.to_ascii_lowercase().as_str(),
                    "bash"
                        | "powershell"
                        | "write"
                        | "edit"
                        | "apply_patch"
                        | "get_task_status"
                        | "agent"
                ) {
                    self.put(entry);
                    self.persist(engine);
                }
            }
            EngineEvent::ToolExecutionStarted { id, .. } => {
                if let Some(entry) = self.pending.get_mut(id) {
                    entry.execution_observed_at_ms = Some(file_capture_now_ms());
                }
            }
            EngineEvent::ToolDenied { id, name, reason } => {
                let mut entry = self
                    .pending
                    .remove(id)
                    .unwrap_or_else(|| self.entry(id, name, None));
                entry.outcome = Outcome::Denied;
                entry.result_observed_at_ms = Some(file_capture_now_ms());
                entry.output_preview = Some(bounded(reason, 2048, &mut entry.details_truncated));
                self.put(entry);
                self.persist(engine);
            }
            EngineEvent::ToolResult { id, name, output } => {
                let pending = self.pending.remove(id);
                if pending.is_none()
                    && output.is_error
                    && output.execution_metadata.is_empty()
                    && self.record.observations.iter().any(|entry| {
                        entry.tool_call_id == *id
                            && entry.tool_name == *name
                            && entry.outcome == Outcome::Denied
                    })
                {
                    // Engine publishes the denied receipt and its model-facing error separately.
                    return;
                }
                if self.ambiguous_overflow || self.ambiguous.contains(id) {
                    let mut entry = pending.unwrap_or_else(|| self.entry(id, name, None));
                    entry.outcome = Outcome::Unknown;
                    entry.result_observed_at_ms = Some(file_capture_now_ms());
                    self.put(entry);
                    self.persist(engine);
                    return;
                }

                if output.execution_metadata.iter().all(|m| {
                    !matches!(
                        m,
                        kcoder_tools::ToolExecutionMetadata::Process { .. }
                            | kcoder_tools::ToolExecutionMetadata::Artifact { .. }
                            | kcoder_tools::ToolExecutionMetadata::ArtifactValidation(_)
                    )
                }) && !output.is_error
                    && pending.as_ref().is_none_or(|p| {
                        !self
                            .record
                            .observations
                            .iter()
                            .any(|e| e.ordinal == p.ordinal)
                    })
                {
                    return;
                }
                let mut entry = pending.unwrap_or_else(|| self.entry(id, name, None));
                entry.outcome = Outcome::Recorded;
                entry.tool_failed = Some(output.is_error);
                entry.result_observed_at_ms = Some(file_capture_now_ms());
                let mut preview = String::new();
                for block in &output.content {
                    if let kcoder_types::ContentBlock::Text { text } = block {
                        if !preview.is_empty() && preview.len() < 2048 {
                            preview.push('\n');
                        }
                        preview.push_str(&bounded(
                            text,
                            2048 - preview.len(),
                            &mut entry.details_truncated,
                        ));
                    }
                }
                entry.output_preview = (!preview.is_empty()).then_some(preview);
                for metadata in &output.execution_metadata {
                    match metadata {
                        kcoder_tools::ToolExecutionMetadata::Process {
                            exit_code,
                            signal,
                            cwd,
                        } => {
                            let cwd = cwd.to_string_lossy().into_owned();
                            if valid_path(&cwd) {
                                entry.process = Some(p::ReviewProcess {
                                    exit_code: *exit_code,
                                    signal: *signal,
                                    cwd,
                                });
                            } else {
                                entry.details_truncated = true;
                            }
                        }
                        kcoder_tools::ToolExecutionMetadata::Artifact { path, sha256 } => {
                            let path = path.to_string_lossy().into_owned();
                            if valid_path(&path)
                                && valid_artifact_id(sha256)
                                && entry.artifacts.len() < 32
                            {
                                entry.artifacts.push(p::ReviewArtifact {
                                    path,
                                    sha256: sha256.clone(),
                                });
                            } else {
                                entry.details_truncated = true;
                            }
                        }
                        kcoder_tools::ToolExecutionMetadata::ArtifactValidation(report) => {
                            let mut ordered = report.entries.iter().collect::<Vec<_>>();
                            ordered.sort_by_key(|check| {
                                matches!(
                                    check.status,
                                    kcoder_state::ArtifactValidationStatus::Passed
                                        | kcoder_state::ArtifactValidationStatus::SkippedMissing
                                        | kcoder_state::ArtifactValidationStatus::Unavailable
                                )
                            });
                            let entries = ordered
                                .into_iter()
                                .take(32)
                                .filter_map(|check| {
                                    if check.index >= 32 {
                                        entry.details_truncated = true;
                                        return None;
                                    }
                                    Some(p::ReviewArtifactCheck {
                                        index: check.index as u32,
                                        path: bounded(
                                            &check.path,
                                            4096,
                                            &mut entry.details_truncated,
                                        ),
                                        status: check_status(check.status),
                                        size_bytes: check
                                            .size_bytes
                                            .filter(|n| *n <= 9_007_199_254_740_991),
                                        sha256: check.sha256.clone(),
                                    })
                                })
                                .collect();
                            entry.validation = Some(p::ReviewValidation {
                                run_id: report.run.run_id.clone(),
                                declarations_sha256: report.run.declarations_sha256.clone(),
                                observed_at_ms: report.observed_at_ms,
                                entries,
                            });
                            entry.details_truncated |= report.entries.len() > 32;
                        }
                        _ => {}
                    }
                }
                self.put(entry);
                self.persist(engine);
            }
            _ => {}
        }
    }
    pub fn settle(
        &mut self,
        engine: &QueryEngine,
        interrupted: bool,
    ) -> Option<p::TurnReviewEvidence> {
        if self.record.observations.is_empty() && self.record.omitted_count == 0 {
            return None;
        }
        for entry in &mut self.record.observations {
            if entry.outcome == Outcome::Pending {
                entry.outcome = Outcome::Unknown;
            }
        }
        self.record.state = if self.storage_failed {
            State::Unknown
        } else if interrupted {
            State::Interrupted
        } else if self.record.omitted_count > 0
            || self
                .record
                .observations
                .iter()
                .any(|e| e.details_truncated || e.outcome == Outcome::Unknown)
        {
            State::Partial
        } else {
            State::Settled
        };
        self.persist(engine);
        Some(self.record.clone())
    }
}

fn review_priority(entry: &p::ReviewToolExecution) -> u8 {
    if entry.validation.as_ref().is_some_and(|report| {
        report.entries.iter().any(|check| {
            !matches!(
                check.status,
                p::ReviewArtifactStatus::Passed
                    | p::ReviewArtifactStatus::SkippedMissing
                    | p::ReviewArtifactStatus::Unavailable
            )
        })
    }) {
        return 4;
    }
    if entry.tool_failed == Some(true)
        || matches!(entry.outcome, Outcome::Denied | Outcome::Unknown)
        || entry
            .process
            .as_ref()
            .is_some_and(|p| p.signal.is_some() || p.exit_code != Some(0))
    {
        return 3;
    }
    if entry.validation.is_some() {
        return 2;
    }
    if !entry.artifacts.is_empty() {
        return 1;
    }
    0
}

fn check_status(status: kcoder_state::ArtifactValidationStatus) -> p::ReviewArtifactStatus {
    use kcoder_state::ArtifactValidationStatus as A;
    use p::ReviewArtifactStatus as B;
    match status {
        A::Unchanged => B::Unchanged,
        A::Passed => B::Passed,
        A::SkippedMissing => B::SkippedMissing,
        A::Missing => B::Missing,
        A::Denied => B::Denied,
        A::InvalidPath => B::InvalidPath,
        A::NotRegular => B::NotRegular,
        A::TooSmall => B::TooSmall,
        A::ForbiddenContent => B::ForbiddenContent,
        A::TooLarge => B::TooLarge,
        A::ReadLimit => B::ReadLimit,
        A::Duplicate => B::Duplicate,
        A::Unavailable => B::Unavailable,
    }
}

pub fn load_turn_review_evidence(
    engine: &QueryEngine,
    thread: &str,
) -> Result<HashMap<String, p::TurnReviewEvidence>> {
    validate_thread_id(thread)?;
    let path = engine
        .session_storage_dir_for(thread)
        .join("turn-review-evidence");
    let directory = match PrivateDirectory::open_existing(&path) {
        Ok(d) => d,
        Err(e) if error_is_not_found(&e) => return Ok(HashMap::new()),
        Err(e) => return Err(e),
    };
    let mut records = HashMap::new();
    let mut total = 0usize;
    directory.visit_entry_names_bounded(10_000, |name| {
        if !name.to_str().is_some_and(|s| s.ends_with(".json")) {
            return Ok(());
        }
        let mut bytes = Vec::new();
        directory
            .open_regular_file(name)?
            .take(MAX_REVIEW_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        total = total
            .checked_add(bytes.len())
            .context("review byte overflow")?;
        ensure!(
            total <= turn_observation_storage::MAX_OBSERVATION_FAMILY_BYTES,
            "review family exceeds budget"
        );
        let record = decode_review(&bytes, thread, name)?;
        ensure!(
            records.insert(record.attempt_id.clone(), record).is_none(),
            "duplicate review attempt"
        );
        Ok(())
    })?;
    Ok(records)
}
