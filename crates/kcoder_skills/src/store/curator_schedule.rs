//! Durable schedule state and cross-process run ownership for the automatic
//! skill curator.
//!
//! The schedule lives next to `.usage.json` in the skill root so every KCoder
//! process that opens the same store observes one last-run time. Reads are
//! lock-free because writes are atomic replacements; every write requires a
//! [`CuratorRunLease`], so only the owner of the run lock can advance the
//! schedule.

use super::layout::StoreLayout;
use super::lock::StoreLock;
use super::replace::{atomic_write, create_store_dir};
use super::{SkillStore, SkillStoreError};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;

pub const CURATOR_SCHEDULE_SCHEMA: &str = "kcoder.skill-curator-schedule/1";
/// The schedule is a single small JSON document; anything larger is not ours.
const MAX_CURATOR_SCHEDULE_BYTES: u64 = 64 * 1024;
const MAX_CURATOR_DETAIL_CHARS: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CuratorRunStatus {
    /// First observation of the store; no run has happened yet.
    Seeded,
    /// A run started. A process crash can leave this status behind; the OS
    /// lock, not this field, decides whether a run is still live.
    Running,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CuratorScheduleState {
    pub schema: String,
    /// Start of the most recent run, or the seed time before the first run.
    /// The next run is due one interval after this instant.
    pub last_run_at: DateTime<Utc>,
    pub status: CuratorRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    /// Bounded, secret-free outcome summary for diagnostics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl CuratorScheduleState {
    pub fn seeded(at: DateTime<Utc>) -> Self {
        Self {
            schema: CURATOR_SCHEDULE_SCHEMA.to_string(),
            last_run_at: at,
            status: CuratorRunStatus::Seeded,
            finished_at: None,
            job_id: None,
            detail: None,
        }
    }

    pub fn running(at: DateTime<Utc>, job_id: impl Into<String>) -> Self {
        Self {
            schema: CURATOR_SCHEDULE_SCHEMA.to_string(),
            last_run_at: at,
            status: CuratorRunStatus::Running,
            finished_at: None,
            job_id: Some(job_id.into()),
            detail: None,
        }
    }

    /// Record the terminal outcome of the run that `self` describes. The
    /// interval is still measured from the run's start.
    pub fn finished(mut self, at: DateTime<Utc>, succeeded: bool, detail: Option<&str>) -> Self {
        self.status = if succeeded {
            CuratorRunStatus::Succeeded
        } else {
            CuratorRunStatus::Failed
        };
        self.finished_at = Some(at);
        self.detail = detail.map(|detail| detail.chars().take(MAX_CURATOR_DETAIL_CHARS).collect());
        self
    }
}

/// Exclusive, non-blocking ownership of one curator run across processes.
/// Dropping the lease (or the owning process exiting) releases it.
pub struct CuratorRunLease {
    layout: StoreLayout,
    _lock: StoreLock,
}

impl std::fmt::Debug for CuratorRunLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CuratorRunLease")
            .field("root", &self.layout.root)
            .finish_non_exhaustive()
    }
}

impl CuratorRunLease {
    /// Atomically publish the schedule. Only the lease owner may write it.
    pub fn record(&self, state: &CuratorScheduleState) -> Result<(), SkillStoreError> {
        let bytes = serde_json::to_vec_pretty(state).map_err(|error| {
            SkillStoreError::serialization("serializing skill curator schedule", error)
        })?;
        atomic_write(&self.layout.curator_schedule(), &bytes, "curator-schedule")
    }

    /// Re-read the schedule while holding the lease, so a run that another
    /// owner finished between the caller's unlocked read and this lease is
    /// observed before deciding to run again.
    pub fn current(&self) -> Result<Option<CuratorScheduleState>, SkillStoreError> {
        read_schedule(&self.layout)
    }
}

impl SkillStore {
    /// Read the persisted curator schedule. Returns `Ok(None)` when the store
    /// or the schedule does not exist yet. A malformed document is reported as
    /// [`SkillStoreError::JournalCorrupt`] so the lease owner can re-seed it.
    pub fn curator_schedule(&self) -> Result<Option<CuratorScheduleState>, SkillStoreError> {
        read_schedule(&self.layout)
    }

    /// Try to take the cross-process curator run lease without waiting.
    /// Returns `Ok(None)` while another owner holds it.
    pub fn try_curator_run_lease(&self) -> Result<Option<CuratorRunLease>, SkillStoreError> {
        create_store_dir(&self.layout.root)?;
        Ok(
            StoreLock::try_curator_run(&self.layout)?.map(|lock| CuratorRunLease {
                layout: self.layout.clone(),
                _lock: lock,
            }),
        )
    }
}

fn read_schedule(layout: &StoreLayout) -> Result<Option<CuratorScheduleState>, SkillStoreError> {
    let path = layout.curator_schedule();
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(SkillStoreError::io(
                "inspecting skill curator schedule",
                error,
            ));
        }
    };
    if !metadata.file_type().is_file() {
        return Err(SkillStoreError::UnsupportedFileType(path));
    }
    if metadata.len() > MAX_CURATOR_SCHEDULE_BYTES {
        return Err(SkillStoreError::JournalCorrupt(format!(
            "skill curator schedule exceeds {MAX_CURATOR_SCHEDULE_BYTES} bytes"
        )));
    }
    let bytes = fs::read(&path)
        .map_err(|error| SkillStoreError::io("reading skill curator schedule", error))?;
    let state: CuratorScheduleState = serde_json::from_slice(&bytes).map_err(|error| {
        SkillStoreError::JournalCorrupt(format!("skill curator schedule is malformed: {error}"))
    })?;
    if state.schema != CURATOR_SCHEDULE_SCHEMA {
        return Err(SkillStoreError::JournalCorrupt(format!(
            "unsupported skill curator schedule schema '{}'",
            state.schema
        )));
    }
    Ok(Some(state))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store(temp: &TempDir) -> SkillStore {
        SkillStore::open(&temp.path().join("skills")).unwrap()
    }

    #[test]
    fn missing_schedule_reads_as_none_without_creating_the_store() {
        let temp = TempDir::new().unwrap();
        let store = store(&temp);
        assert_eq!(store.curator_schedule().unwrap(), None);
        assert!(!temp.path().join("skills").exists());
    }

    #[test]
    fn lease_owner_round_trips_schedule_across_store_handles() {
        let temp = TempDir::new().unwrap();
        let lease = store(&temp).try_curator_run_lease().unwrap().unwrap();
        let started = Utc::now();
        let running = CuratorScheduleState::running(started, "auto-curator-1");
        lease.record(&running).unwrap();
        let finished = running.finished(Utc::now(), false, Some(&"x".repeat(2_000)));
        lease.record(&finished).unwrap();
        drop(lease);

        // A second handle models a restarted process reading the same root.
        let reread = store(&temp).curator_schedule().unwrap().unwrap();
        assert_eq!(reread.status, CuratorRunStatus::Failed);
        assert_eq!(reread.last_run_at, started);
        assert_eq!(reread.job_id.as_deref(), Some("auto-curator-1"));
        assert_eq!(
            reread.detail.unwrap().chars().count(),
            MAX_CURATOR_DETAIL_CHARS
        );
        assert!(temp.path().join("skills/.curator-schedule.json").is_file());
    }

    #[test]
    fn run_lease_is_exclusive_until_released() {
        let temp = TempDir::new().unwrap();
        let first = store(&temp).try_curator_run_lease().unwrap().unwrap();
        assert!(store(&temp).try_curator_run_lease().unwrap().is_none());
        drop(first);
        assert!(store(&temp).try_curator_run_lease().unwrap().is_some());
    }

    #[test]
    fn malformed_or_foreign_schedule_is_reported_as_corrupt() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(".curator-schedule.json"), b"{not json").unwrap();
        assert!(matches!(
            store(&temp).curator_schedule(),
            Err(SkillStoreError::JournalCorrupt(_))
        ));
        fs::write(
            root.join(".curator-schedule.json"),
            serde_json::to_vec(&serde_json::json!({
                "schema": "other/9",
                "last_run_at": Utc::now(),
                "status": "seeded",
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(matches!(
            store(&temp).curator_schedule(),
            Err(SkillStoreError::JournalCorrupt(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_schedule_is_rejected() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        fs::create_dir_all(&root).unwrap();
        let target = temp.path().join("elsewhere.json");
        fs::write(&target, b"{}").unwrap();
        std::os::unix::fs::symlink(&target, root.join(".curator-schedule.json")).unwrap();
        assert!(matches!(
            store(&temp).curator_schedule(),
            Err(SkillStoreError::UnsupportedFileType(_))
        ));
    }
}
