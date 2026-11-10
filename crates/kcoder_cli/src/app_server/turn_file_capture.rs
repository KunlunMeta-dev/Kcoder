//! Durable capture observations. These records never authorize a workspace write.
use crate::{error_is_not_found, turn_observation_storage};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::{
    TurnFileCaptureLimitation as Limitation, TurnFileCaptureState as State, TurnFileChangesCapture,
};
use kcoder_cli_storage::transcript_artifact_journal;
use kcoder_config::PrivateDirectory;
use kcoder_engine::QueryEngine;
use kcoder_workspace_resources::managed_worktrees::validate_thread_id;
pub use kcoder_workspace_resources::snapshots::file_capture_now_ms;
use kcoder_workspace_resources::snapshots::{FinalizedTurnFileCapture, GitTreeSnapshot};
use std::collections::HashMap;
use std::{ffi::OsStr, io::Read};

use kcoder_cli_storage::file_capture_validation::capture_identity as identity;
pub use kcoder_cli_storage::file_capture_validation::{
    MAX_CAPTURE_RECORD_BYTES, decode_file_capture, file_capture_for_history, validate_file_capture,
};

pub struct TurnFileCaptureTracker {
    pub record: TurnFileChangesCapture,
    storage: Option<turn_observation_storage::TurnObservationStorage>,
    storage_failed: bool,
    owner_thread: String,
}

impl TurnFileCaptureTracker {
    pub fn new(
        engine: &QueryEngine,
        owner: &kcoder_types::TurnAttemptIdentity,
        enabled: bool,
    ) -> Self {
        let owner_thread = engine.session_id();
        let storage = turn_observation_storage::TurnObservationStorage::open(
            engine,
            "turn-file-captures",
            transcript_artifact_journal::Kind::TurnFileCaptures,
        )
        .ok();
        let mut tracker = Self {
            record: TurnFileChangesCapture {
                version: 1,
                capture_id: identity(&owner.thread_id, &owner.turn_id, &owner.attempt_id),
                thread_id: owner.thread_id.clone(),
                turn_id: owner.turn_id.clone(),
                attempt_id: owner.attempt_id.clone(),
                state: if enabled {
                    State::Capturing
                } else {
                    State::Disabled
                },
                base: None,
                head: None,
                limitations: Vec::new(),
                artifact_id: None,
            },
            storage_failed: storage.is_none(),
            storage,
            owner_thread,
        };
        tracker.persist();
        tracker
    }

    fn persist(&mut self) {
        let result = (|| {
            validate_file_capture(&self.record, &self.owner_thread)?;
            let bytes = serde_json::to_vec(&self.record)?;
            self.storage
                .as_ref()
                .context("capture storage is busy")?
                .write(
                    &self.record.capture_id,
                    &bytes,
                    MAX_CAPTURE_RECORD_BYTES as usize,
                )
        })();
        if let Err(error) = result {
            self.storage_failed = true;
            self.record.state = State::Unknown;
            self.limit(Limitation::StorageUnavailable);
            tracing::warn!(%error, capture_id = %self.record.capture_id, "capture observation could not be persisted");
        }
    }

    pub fn limit(&mut self, reason: Limitation) {
        if !self.record.limitations.contains(&reason) {
            self.record.limitations.push(reason);
        }
    }

    pub fn baseline(&mut self, snapshot: &GitTreeSnapshot) {
        self.record.base = Some(snapshot.capture_window.clone());
        if snapshot.has_exclusions {
            self.limit(Limitation::PolicyExclusions);
        }
        self.persist();
    }

    pub fn failed(&mut self) {
        self.record.state = State::Failed;
        self.limit(Limitation::CaptureFailed);
    }

    pub fn finalized(&mut self, result: &FinalizedTurnFileCapture) {
        self.record.head = Some(result.head.clone());
        self.record.artifact_id = result
            .artifact
            .as_ref()
            .map(|artifact| artifact.artifact_id.clone());
        if result.has_exclusions {
            self.limit(Limitation::PolicyExclusions);
        }
        self.record.state = if result.artifact.is_some() {
            State::Changed
        } else {
            State::Unchanged
        };
    }

    pub fn settle(
        &mut self,
        cancelled: bool,
        background_uncertain: bool,
    ) -> TurnFileChangesCapture {
        if self.record.state != State::Disabled {
            if background_uncertain {
                self.limit(Limitation::IncompleteWriters);
            }
            if cancelled {
                self.record.state = State::Cancelled;
                self.limit(Limitation::IncompleteWriters);
            } else if matches!(self.record.state, State::Changed | State::Unchanged)
                && !self.record.limitations.is_empty()
            {
                self.record.state = State::Partial;
            } else if self.record.state == State::Capturing {
                self.record.state = State::Unknown;
                self.limit(Limitation::CaptureIncomplete);
            }
        }
        if self.storage_failed {
            self.record.state = State::Unknown;
        }
        self.persist();
        self.record.clone()
    }
}

pub fn load_turn_file_captures(
    engine: &QueryEngine,
    thread: &str,
) -> Result<HashMap<String, TurnFileChangesCapture>> {
    validate_thread_id(thread)?;
    let path = engine
        .session_storage_dir_for(thread)
        .join("turn-file-captures");
    let directory = match PrivateDirectory::open_existing(&path) {
        Ok(directory) => directory,
        Err(error) if error_is_not_found(&error) => return Ok(HashMap::new()),
        Err(error) => return Err(error),
    };
    let mut result = HashMap::new();
    let mut total = 0usize;
    directory.visit_entry_names_bounded(10_000, |name| {
        if !name.to_str().is_some_and(|name| name.ends_with(".json")) {
            return Ok(());
        }
        let mut bytes = Vec::new();
        directory
            .open_regular_file(name)?
            .take(MAX_CAPTURE_RECORD_BYTES + 1)
            .read_to_end(&mut bytes)?;
        total = total
            .checked_add(bytes.len())
            .context("capture byte overflow")?;
        ensure!(
            total <= turn_observation_storage::MAX_OBSERVATION_FAMILY_BYTES,
            "capture family exceeds budget"
        );
        let capture = decode_file_capture(&bytes, thread, name)?;
        ensure!(
            result.insert(capture.attempt_id.clone(), capture).is_none(),
            "duplicate capture attempt"
        );
        Ok(())
    })?;
    Ok(result)
}
