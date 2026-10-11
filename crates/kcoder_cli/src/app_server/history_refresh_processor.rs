use super::QueryEngine;
use super::tracked_history_list::{BuildPhase, BuildProgress, StepBudget, TrackedHistoryList};
use anyhow::{Result, ensure};
use kcoder_app_protocol::{
    ThreadHistoryRefreshParams, ThreadHistoryRefreshResult, ThreadHistoryRefreshStatus,
};

/// One connection-owned rebuild. Disconnect/cancel drops the builder's file lock.
#[derive(Default)]
pub(super) struct HistoryRefreshProcessor {
    builder: TrackedHistoryList,
    cursor: Option<String>,
    last_response: Option<ThreadHistoryRefreshResult>,
}

impl HistoryRefreshProcessor {
    pub(super) fn is_active(&self) -> bool {
        self.cursor.is_some()
    }

    pub(super) fn process(
        &mut self,
        engine: &QueryEngine,
        params: ThreadHistoryRefreshParams,
    ) -> Result<ThreadHistoryRefreshResult> {
        ensure!(
            !params.cancel || params.cursor.is_some(),
            "cancelling history refresh requires its cursor"
        );
        let progress = if let Some(cursor) = params.cursor {
            ensure!(
                self.cursor.as_ref() == Some(&cursor),
                "invalid or expired history refresh cursor"
            );
            self.cursor = None;
            if params.cancel {
                self.builder.cancel();
                let mut response = self
                    .last_response
                    .take()
                    .expect("active cursor has progress");
                response.status = ThreadHistoryRefreshStatus::Cancelled;
                response.next_cursor = None;
                return Ok(response);
            }
            self.builder.step(engine, StepBudget::default())
        } else {
            ensure!(
                params.acknowledge_external_writers,
                "index activation requires acknowledging that manual and unsupported old-writer edits need explicit refresh"
            );
            self.builder.cancel();
            self.cursor = None;
            self.last_response = None;
            self.builder.begin(engine, true)
        };
        match progress {
            Ok(progress) => Ok(self.response(progress)),
            Err(error) => {
                self.builder.cancel();
                self.last_response = None;
                Err(error)
            }
        }
    }

    fn response(&mut self, progress: BuildProgress) -> ThreadHistoryRefreshResult {
        let status = match progress.phase {
            BuildPhase::Building => {
                // Opaque routing identity, not an authentication credential.
                use std::hash::{BuildHasher, RandomState};
                use std::sync::atomic::{AtomicU64, Ordering};
                static NEXT_CURSOR: AtomicU64 = AtomicU64::new(0);
                let sequence = NEXT_CURSOR.fetch_add(1, Ordering::Relaxed);
                let nonce = RandomState::new().hash_one((std::process::id(), sequence));
                self.cursor = Some(format!("{nonce:016x}-{sequence:016x}"));
                ThreadHistoryRefreshStatus::Building
            }
            BuildPhase::Ready => {
                self.builder.cancel();
                self.cursor = None;
                ThreadHistoryRefreshStatus::Ready
            }
            BuildPhase::Incomplete => {
                self.builder.cancel();
                self.cursor = None;
                ThreadHistoryRefreshStatus::Incomplete
            }
        };
        let response = ThreadHistoryRefreshResult {
            status,
            next_cursor: self.cursor.clone(),
            examined_entries: progress.examined_entries,
            indexed_sessions: progress.indexed_sessions,
            issue_count: progress.issue_count,
            issues: progress.issues,
        };
        self.last_response = Some(response.clone());
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_processor_requires_consent_and_rejects_foreign_cursor_without_mutation() {
        let temp = tempfile::tempdir().unwrap();
        let engine = super::super::tests::catalog_list_test_engine(temp.path());
        let mut processor = HistoryRefreshProcessor::default();
        assert!(
            processor
                .process(&engine, ThreadHistoryRefreshParams::default())
                .is_err()
        );
        assert!(
            processor
                .process(
                    &engine,
                    ThreadHistoryRefreshParams {
                        cursor: Some("foreign".into()),
                        acknowledge_external_writers: true,
                        cancel: false,
                    }
                )
                .is_err()
        );
        assert!(processor.cursor.is_none());
        assert!(
            !engine
                .client_storage_root()
                .join("history-list-index")
                .exists()
        );
    }

    #[test]
    fn refresh_processor_cursor_is_owned_one_shot_and_cancel_releases_builder() {
        let workspace = tempfile::tempdir().unwrap();
        let history = tempfile::tempdir().unwrap();
        let engine = super::super::tests::catalog_list_test_engine(workspace.path());
        engine.state.with_history_path(
            history
                .path()
                .join(format!("{}.jsonl", engine.session_id())),
        );
        engine
            .state
            .add_message(kcoder_types::Message::user_text("indexed prompt"));
        engine.state.save_history().unwrap();
        let start = || ThreadHistoryRefreshParams {
            acknowledge_external_writers: true,
            ..Default::default()
        };
        let mut owner = HistoryRefreshProcessor::default();
        let first = owner.process(&engine, start()).unwrap();
        assert_eq!(first.status, ThreadHistoryRefreshStatus::Building);
        let cursor = first.next_cursor.unwrap();
        let mut foreign = HistoryRefreshProcessor::default();
        assert!(
            foreign
                .process(
                    &engine,
                    ThreadHistoryRefreshParams {
                        cursor: Some(cursor.clone()),
                        ..Default::default()
                    }
                )
                .is_err()
        );
        assert!(
            owner
                .process(&engine, ThreadHistoryRefreshParams::default())
                .is_err()
        );
        let cancelled = owner
            .process(
                &engine,
                ThreadHistoryRefreshParams {
                    cursor: Some(cursor.clone()),
                    cancel: true,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(cancelled.status, ThreadHistoryRefreshStatus::Cancelled);
        assert!(cancelled.next_cursor.is_none());
        assert!(
            owner
                .process(
                    &engine,
                    ThreadHistoryRefreshParams {
                        cursor: Some(cursor),
                        ..Default::default()
                    }
                )
                .is_err()
        );
        let mut response = owner.process(&engine, start()).unwrap();
        for _ in 0..32 {
            let Some(cursor) = response.next_cursor.clone() else {
                break;
            };
            response = owner
                .process(
                    &engine,
                    ThreadHistoryRefreshParams {
                        cursor: Some(cursor.clone()),
                        ..Default::default()
                    },
                )
                .unwrap();
            assert!(
                owner
                    .process(
                        &engine,
                        ThreadHistoryRefreshParams {
                            cursor: Some(cursor),
                            ..Default::default()
                        }
                    )
                    .is_err()
            );
        }
        assert_eq!(response.status, ThreadHistoryRefreshStatus::Ready);
        assert_eq!(response.indexed_sessions, 1);
        assert_eq!(response.issue_count, 0);
    }
}
