//! Bounded, best-effort recovery diagnostics, never conversation or usage authority.

use crate::diagnostic_capture::{
    Completion,
    target::{FrozenTarget, Target},
};
use crate::diagnostic_writer::DiagnosticPermit;
use crate::{AppState, DiagnosticWriter};
use serde::Serialize;
use std::sync::Arc;

const MAX_RECORDS: usize = 64;
const MAX_BYTES: usize = 16 * 1024;
const HISTORY_LIMIT: usize = 30;

fn owns_file(name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    let Some(stem) = name.strip_suffix(".json") else {
        return false;
    };
    let Some((timestamp, id)) = stem.split_once('-') else {
        return false;
    };
    timestamp.len() == 20
        && timestamp.bytes().all(|byte| byte.is_ascii_digit())
        && uuid::Uuid::parse_str(id)
            .is_ok_and(|uuid| uuid.get_version_num() == 4 && uuid.to_string() == id)
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryDecision {
    Invoke,
    RetryWait,
    Compact,
    DowngradeThinking,
    NeedsHuman,
    Stop,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryOutcome {
    Success,
    Failed,
    WaitCompleted,
    ReasoningDisabled,
    Cancelled,
    BudgetRejected,
    PolicyRejected,
    CompactSucceeded,
    CompactNoop,
    CompactFailed,
    DeadlineExceeded,
    Abandoned,
}

#[derive(Clone, Copy, Serialize)]
struct Record {
    invocation: u64,
    decision: RecoveryDecision,
    outcome: RecoveryOutcome,
}

#[derive(Serialize)]
struct Payload {
    version: u8,
    request_id: uuid::Uuid,
    records: Vec<Record>,
    dropped_records: u64,
}

/// One logical main request, including retries and request rebuilds after compaction.
pub struct RecoveryCapture {
    payload: Payload,
    pending: Option<(u64, RecoveryDecision)>,
    target: Option<Target>,
    permit: Option<DiagnosticPermit>,
    completion: Option<Arc<Completion>>,
    writer: DiagnosticWriter,
}

// Field order releases retained payload and private-directory ownership before scope completion,
// including queue rejection and unwinding before a job starts.
struct Job {
    payload: Payload,
    target: Target,
    _completion: Option<Arc<Completion>>,
    timestamp: u64,
}

impl Job {
    fn write(self) -> anyhow::Result<()> {
        let content = serde_json::to_vec(&self.payload)?;
        anyhow::ensure!(
            content.len() <= MAX_BYTES,
            "recovery diagnostic byte limit exceeded"
        );
        self.target.write_named(
            &content,
            &format!("{:020}-{}.json", self.timestamp, self.payload.request_id),
            HISTORY_LIMIT,
            owns_file,
        )
    }
}

impl AppState {
    pub async fn begin_recovery_record(&self) -> RecoveryCapture {
        let (writer, owner, completion) = self.begin_diagnostic_scope();
        let mut capture = RecoveryCapture {
            payload: Payload {
                version: 1,
                request_id: uuid::Uuid::new_v4(),
                records: Vec::new(),
                dropped_records: 0,
            },
            pending: None,
            target: None,
            permit: None,
            completion: Some(completion.clone()),
            writer: writer.clone(),
        };
        let Some(frozen) = FrozenTarget::snapshot_recovery(self, owner) else {
            return capture;
        };
        // Reserve both the serialized output and the fixed record allocation before preparing.
        let Some(permit) = writer.try_reserve(
            MAX_BYTES + MAX_RECORDS * std::mem::size_of::<Record>() + frozen.retained_bytes(),
        ) else {
            return capture;
        };
        let prepared = tokio::task::spawn_blocking(move || {
            let target = frozen.open_recovery();
            (target, permit, completion)
        })
        .await;
        if let Ok((Ok(target), permit, _completion)) = prepared {
            capture.target = Some(target);
            capture.permit = Some(permit);
            capture.payload.records = Vec::with_capacity(MAX_RECORDS);
        } else {
            writer.note_dropped();
        }
        capture
    }
}

impl RecoveryCapture {
    pub fn begin(&mut self, invocation: u64, decision: RecoveryDecision) {
        if self.pending.is_some() {
            self.complete(RecoveryOutcome::Abandoned);
        }
        self.pending = Some((invocation, decision));
    }

    pub fn complete(&mut self, outcome: RecoveryOutcome) {
        let Some((invocation, decision)) = self.pending.take() else {
            return;
        };
        if self.permit.is_none() {
            return;
        }
        if self.payload.records.len() == MAX_RECORDS {
            if self.payload.dropped_records == 0 {
                self.writer.note_dropped();
            }
            self.payload.dropped_records = self.payload.dropped_records.saturating_add(1);
        } else {
            self.payload.records.push(Record {
                invocation,
                decision,
                outcome,
            });
        }
    }
}

impl Drop for RecoveryCapture {
    fn drop(&mut self) {
        if self.pending.is_none() && self.payload.records.is_empty() {
            self.begin(0, RecoveryDecision::Stop);
        }
        self.complete(RecoveryOutcome::Abandoned);
        let (Some(target), Some(permit)) = (self.target.take(), self.permit.take()) else {
            return;
        };
        let payload = std::mem::replace(
            &mut self.payload,
            Payload {
                version: 1,
                request_id: uuid::Uuid::nil(),
                records: Vec::new(),
                dropped_records: 0,
            },
        );
        let job = Job {
            payload,
            target,
            _completion: self.completion.take(),
            timestamp: crate::now_millis(),
        };
        permit.submit(Box::new(move || job.write()));
    }
}

#[cfg(test)]
mod tests {
    use crate::*;
    use std::time::{Duration, Instant};

    #[tokio::test]
    async fn recovery_record_is_bounded_and_drop_is_explicit() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path());
        state.with_llm_request_history_dir(tmp.path(), "session");
        let mut capture = state.begin_recovery_record().await;
        capture.begin(1, RecoveryDecision::Invoke);
        drop(capture);
        assert!(
            state
                .flush_diagnostics_until(Instant::now() + Duration::from_secs(2))
                .await
        );
        let paths: Vec<_> = std::fs::read_dir(tmp.path().join("recovery"))
            .unwrap()
            .collect();
        assert_eq!(paths.len(), 1);
        let bytes = std::fs::read(paths[0].as_ref().unwrap().path()).unwrap();
        let record: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(record["records"][0]["outcome"], "abandoned");
        assert_eq!(record["records"][0]["invocation"], 1);
        assert!(bytes.len() <= 16 * 1024);
    }

    async fn flush(state: &AppState) {
        assert!(
            state
                .flush_diagnostics_until(Instant::now() + Duration::from_secs(3))
                .await
        );
    }

    fn read_records(dir: &std::path::Path) -> Vec<serde_json::Value> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter(|entry| super::owns_file(&entry.as_ref().unwrap().file_name()))
            .map(|entry| {
                let bytes = std::fs::read(entry.unwrap().path()).unwrap();
                assert!(bytes.len() <= super::MAX_BYTES);
                serde_json::from_slice(&bytes).unwrap()
            })
            .collect()
    }

    #[tokio::test]
    async fn count_and_retention_are_independent_from_llm_history() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path());
        state.with_llm_request_history_dir(tmp.path(), "session");
        std::fs::write(tmp.path().join("llm-preserved.json"), b"{}").unwrap();
        std::fs::create_dir(tmp.path().join("recovery")).unwrap();
        std::fs::write(tmp.path().join("recovery/foreign.json"), b"preserved").unwrap();
        for _ in 0..31 {
            let mut capture = state.begin_recovery_record().await;
            for invocation in 1..101 {
                capture.begin(invocation, RecoveryDecision::Invoke);
                capture.complete(RecoveryOutcome::Success);
            }
            drop(capture);
            flush(&state).await;
        }
        let records = read_records(&tmp.path().join("recovery"));
        assert_eq!(records.len(), 30);
        for record in records {
            assert_eq!(record["records"].as_array().unwrap().len(), 64);
            assert_eq!(record["dropped_records"], 36);
        }
        assert!(tmp.path().join("llm-preserved.json").exists());
        assert_eq!(
            std::fs::read(tmp.path().join("recovery/foreign.json")).unwrap(),
            b"preserved"
        );
        assert_eq!(state.diagnostic_writer().stats().dropped, 31);
    }

    #[tokio::test]
    async fn no_target_missing_root_and_rejected_queue_do_not_create_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path());
        drop(state.begin_recovery_record().await);
        flush(&state).await;
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
        state.with_llm_request_history_dir(tmp.path().join("missing"), "session");
        drop(state.begin_recovery_record().await);
        flush(&state).await;
        assert!(!tmp.path().join("missing").exists());
        state.with_llm_request_history_dir(tmp.path(), "session");
        let writer = DiagnosticWriter::with_limits(0, 0);
        state.set_diagnostic_context(writer.clone(), None);
        drop(state.begin_recovery_record().await);
        flush(&state).await;
        assert_eq!(writer.stats().dropped, 1);
        assert!(!tmp.path().join("recovery").exists());
    }

    #[tokio::test]
    async fn pending_capture_participates_in_scope_flush_and_closed_submit_drops() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path());
        state.with_llm_request_history_dir(tmp.path(), "session");
        let mut capture = state.begin_recovery_record().await;
        capture.begin(1, RecoveryDecision::Invoke);
        assert!(!state.flush_diagnostics_until(Instant::now()).await);
        let writer = state.diagnostic_writer();
        writer.close();
        drop(capture);
        flush(&state).await;
        assert_eq!(writer.stats().reserved_jobs, 0);
        assert_eq!(writer.stats().dropped, 1);
        assert!(read_records(&tmp.path().join("recovery")).is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn root_and_final_directory_replacements_never_redirect_captured_target() {
        for replace_root in [true, false] {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path().join("root");
            std::fs::create_dir(&root).unwrap();
            let state = AppState::new(tmp.path());
            state.with_llm_request_history_dir(&root, "session");
            let mut capture = state.begin_recovery_record().await;
            capture.begin(1, RecoveryDecision::Invoke);
            let replaced = if replace_root {
                root.clone()
            } else {
                root.join("recovery")
            };
            let old = tmp.path().join("old");
            std::fs::rename(&replaced, &old).unwrap();
            std::fs::create_dir(&replaced).unwrap();
            drop(capture);
            flush(&state).await;
            assert_eq!(std::fs::read_dir(&replaced).unwrap().count(), 0);
            let old_records = if replace_root {
                old.join("recovery")
            } else {
                old
            };
            assert_eq!(read_records(&old_records).len(), 1);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_recovery_child_is_rejected_without_touching_destination() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), tmp.path().join("recovery")).unwrap();
        let state = AppState::new(tmp.path());
        state.with_llm_request_history_dir(tmp.path(), "session");
        drop(state.begin_recovery_record().await);
        flush(&state).await;
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
        assert_eq!(state.diagnostic_writer().stats().reserved_jobs, 0);
    }
}
