//! Shared validation for native turn-review records.

use crate::private_files::hex_sha256;
use anyhow::{Result, ensure};
use kcoder_app_protocol::{self as p, ReviewEvidenceState as State, ReviewToolOutcome as Outcome};
use kcoder_workspace_resources::managed_worktrees::valid_artifact_id;
use std::{collections::HashSet, ffi::OsStr};

pub const MAX_OBSERVATIONS: usize = 32;

pub fn review_identity(thread: &str, turn: &str, attempt: &str) -> String {
    hex_sha256(format!("review\0{thread}\0{turn}\0{attempt}").as_bytes())
}

pub fn valid_review_path(path: &str) -> bool {
    !path.is_empty() && path.len() <= 4096 && !path.contains('\0')
}

fn valid_time(time: u64) -> bool {
    time <= 8_640_000_000_000_000
}

pub fn validate_review(record: &p::TurnReviewEvidence, thread: &str) -> Result<()> {
    ensure!(
        record.version == 1 && record.thread_id == thread,
        "invalid review owner"
    );
    for id in [&record.thread_id, &record.turn_id, &record.attempt_id] {
        ensure!(
            !id.is_empty() && id.len() <= 512 && !id.chars().any(char::is_control),
            "invalid review identity"
        );
    }
    ensure!(
        record.evidence_id == review_identity(thread, &record.turn_id, &record.attempt_id),
        "review identity mismatch"
    );
    ensure!(
        record.observations.len() <= MAX_OBSERVATIONS,
        "review capacity exceeded"
    );
    let mut ordinals = HashSet::new();
    for entry in &record.observations {
        ensure!(
            ordinals.insert(entry.ordinal) && entry.ordinal > 0,
            "duplicate review ordinal"
        );
        ensure!(
            !entry.tool_call_id.is_empty()
                && entry.tool_call_id.len() <= 512
                && !entry.tool_name.is_empty()
                && entry.tool_name.len() <= 128,
            "invalid review tool identity"
        );
        ensure!(
            entry.command.as_ref().is_none_or(|v| v.len() <= 1024)
                && entry
                    .output_preview
                    .as_ref()
                    .is_none_or(|v| v.len() <= 2048),
            "review preview exceeds bounds"
        );
        ensure!(
            entry.execution_observed_at_ms.is_none_or(valid_time)
                && entry.result_observed_at_ms.is_none_or(valid_time),
            "invalid review time"
        );
        if entry.outcome == Outcome::Recorded {
            ensure!(
                entry.tool_failed.is_some() && entry.result_observed_at_ms.is_some(),
                "recorded tool has no receipt"
            );
        }
        if entry.outcome != Outcome::Recorded {
            ensure!(
                entry.process.is_none()
                    && entry.artifacts.is_empty()
                    && entry.validation.is_none()
                    && entry.tool_failed.is_none(),
                "unconfirmed tool has a result claim"
            );
        }
        if let Some(process) = &entry.process {
            ensure!(valid_review_path(&process.cwd), "invalid process scope");
        }
        ensure!(entry.artifacts.len() <= 32, "too many review artifacts");
        for artifact in &entry.artifacts {
            ensure!(
                valid_review_path(&artifact.path) && valid_artifact_id(&artifact.sha256),
                "invalid review artifact"
            );
        }
        if let Some(report) = &entry.validation {
            ensure!(
                !report.run_id.is_empty()
                    && report.run_id.len() <= 512
                    && valid_artifact_id(&report.declarations_sha256)
                    && valid_time(report.observed_at_ms)
                    && report.entries.len() <= 32,
                "invalid review validation"
            );
            for check in &report.entries {
                ensure!(
                    check.index < 32
                        && check.path.len() <= 4096
                        && check.sha256.as_ref().is_none_or(|s| valid_artifact_id(s))
                        && check.size_bytes.is_none_or(|n| n <= 9_007_199_254_740_991),
                    "invalid artifact check"
                );
            }
        }
    }
    Ok(())
}

pub const MAX_REVIEW_BYTES: usize = 128 * 1024;

pub fn review_for_history(mut record: p::TurnReviewEvidence) -> p::TurnReviewEvidence {
    if record.state == State::Collecting {
        record.state = State::Unknown;
        for entry in &mut record.observations {
            if entry.outcome == Outcome::Pending {
                entry.outcome = Outcome::Unknown;
            }
        }
    }
    record
}

pub fn decode_review(bytes: &[u8], thread: &str, name: &OsStr) -> Result<p::TurnReviewEvidence> {
    ensure!(
        bytes.len() <= MAX_REVIEW_BYTES,
        "review record exceeds budget"
    );
    let record: p::TurnReviewEvidence = serde_json::from_slice(bytes)?;
    validate_review(&record, thread)?;
    ensure!(
        name == OsStr::new(&format!("{}.json", record.evidence_id)),
        "review filename mismatch"
    );
    Ok(review_for_history(record))
}
