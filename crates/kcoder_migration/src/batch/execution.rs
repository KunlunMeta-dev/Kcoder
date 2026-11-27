//! Caller-owned execution control; stopping observation never grants replay authority.
use crate::history_jobs::HistoryImportEvent;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum BatchRunMode {
    Apply,
    Resume,
    Rollback,
}

pub struct BatchExecution<'a> {
    pub job_id: &'a str,
    pub plan_id: &'a str,
    pub request_id: &'a str,
    pub expected_sequence: u64,
    pub mode: BatchRunMode,
}

pub enum BatchRunEvent<'a> {
    Action {
        action_id: &'a str,
        index: usize,
        total: usize,
    },
    History {
        action_id: &'a str,
        event: HistoryImportEvent,
    },
    Checkpoint,
}
