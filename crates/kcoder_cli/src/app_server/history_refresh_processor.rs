use crate::tracked_history_list::{
    BuildPhase, BuildProgress, StepBudget, TrackedHistoryHost, TrackedHistoryList,
};
use anyhow::{Result, ensure};
use kcoder_app_protocol::{
    ThreadHistoryRefreshParams, ThreadHistoryRefreshResult, ThreadHistoryRefreshStatus,
};

/// One connection-owned rebuild. Disconnect/cancel drops the builder's file lock.
#[derive(Default)]
pub struct HistoryRefreshProcessor {
    builder: TrackedHistoryList,
    cursor: Option<String>,
    last_response: Option<ThreadHistoryRefreshResult>,
}

impl HistoryRefreshProcessor {
    pub fn is_active(&self) -> bool {
        self.cursor.is_some()
    }

    pub fn process(
        &mut self,
        host: &dyn TrackedHistoryHost,
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
            self.builder.step(host, StepBudget::default())
        } else {
            ensure!(
                params.acknowledge_external_writers,
                "index activation requires acknowledging that manual and unsupported old-writer edits need explicit refresh"
            );
            self.builder.cancel();
            self.cursor = None;
            self.last_response = None;
            self.builder.begin(host, true)
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
