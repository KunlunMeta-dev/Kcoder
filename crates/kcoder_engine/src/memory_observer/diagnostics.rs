use std::path::PathBuf;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MemoryObserverValidationFailureDiagnostics {
    pub issue_count: usize,
    pub first_issue_path: Option<String>,
    pub first_issue_message: Option<String>,
    pub occurred_at_epoch: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MemoryObserverWorkerDiagnostics {
    pub model_successes: u64,
    pub model_fallbacks: u64,
    pub model_provider_failures: u64,
    pub model_parse_failures: u64,
    pub model_validation_failures: u64,
    pub last_fallback_reason: Option<String>,
    pub last_fallback_at_epoch: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MemoryObserverEventLogDiagnostics {
    pub path: PathBuf,
    pub event_count: usize,
    pub last_event_type: Option<String>,
    pub last_event_at_epoch: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MemoryObserverRecoveryAuditDiagnostics {
    pub path: PathBuf,
    pub event_count: usize,
    pub malformed_event_count: usize,
    pub pending_enqueued: usize,
    pub pending_dequeued: usize,
    pub orphan_dequeue_count: usize,
    pub orphan_terminal_count: usize,
    pub dropped_queued_before_dequeue: usize,
    pub last_incomplete_event_type: Option<String>,
    pub last_incomplete_at_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct MemoryObserverRecoveryAuditItem {
    pub(super) event_type: String,
    pub(super) occurred_at_epoch: Option<u64>,
}

pub(super) fn latest_recovery_audit_item<'a>(
    items: impl Iterator<Item = &'a MemoryObserverRecoveryAuditItem>,
) -> Option<&'a MemoryObserverRecoveryAuditItem> {
    items.max_by_key(|item| item.occurred_at_epoch.unwrap_or(0))
}
