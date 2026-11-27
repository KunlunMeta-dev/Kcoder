//! Resident-thread eviction and per-thread maintenance (manual compaction and
//! rollback) contracts.
//!
//! A resident app-server keeps a bounded number of thread runtimes. Evicting
//! an idle runtime never deletes the thread; it only stops being resident.
//! Clients that negotiated [`CAPABILITY_THREAD_RESIDENCY_V1`] are told about
//! the eviction and receive a typed [`THREAD_NOT_RESIDENT`] rejection instead
//! of a generic thread mismatch, so they can issue `thread/resume` and retry a
//! request that is safe to retry. The rejection always precedes any admission,
//! history write or side effect of the rejected request.
//!
//! Manual compaction and rollback run as owned background work of one thread.
//! While one runs, conflicting requests on that thread are rejected with
//! [`THREAD_MAINTENANCE_BUSY`] before admission; other threads and read-only
//! requests keep being served.
use serde::{Deserialize, Serialize};

/// Client opt-in for `thread/evicted` and the typed not-resident rejection.
pub const CAPABILITY_THREAD_RESIDENCY_V1: &str = "threadResidencyV1";
/// Client opt-in for `thread/maintenance` and the typed maintenance-busy rejection.
pub const CAPABILITY_THREAD_MAINTENANCE_V1: &str = "threadMaintenanceV1";
/// Client opt-in for addressing and cancelling one exact compaction.
pub const CAPABILITY_THREAD_MAINTENANCE_CANCEL_V1: &str = "threadMaintenanceCancelV1";
/// Notification: an idle resident runtime was evicted; the thread still exists.
pub const METHOD_THREAD_EVICTED: &str = "thread/evicted";
/// Notification: a per-thread maintenance operation changed state.
pub const METHOD_THREAD_MAINTENANCE: &str = "thread/maintenance";
/// Request cancellation of the addressed manual compaction.
pub const METHOD_THREAD_MAINTENANCE_CANCEL: &str = "thread/maintenance/cancel";
/// Structured error kind on a manual compaction cancelled before its commit.
pub const THREAD_COMPACTION_CANCELLED_KIND: &str = "thread_compaction_cancelled";
/// The thread exists but is not resident; nothing was admitted or written.
pub const THREAD_NOT_RESIDENT: i64 = -32027;
/// A maintenance operation of the same thread is running; nothing was admitted.
pub const THREAD_MAINTENANCE_BUSY: i64 = -32028;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum ThreadEvictionReason {
    /// The resident capacity was needed by another thread (least recently used idle runtime).
    Capacity,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadEvictedParams {
    #[cfg_attr(
        feature = "json-schema",
        schemars(length(min = 1, max = 128), regex(pattern = r"^[A-Za-z0-9_-]+$"))
    )]
    pub thread_id: String,
    pub reason: ThreadEvictionReason,
}

/// `error.data` of a [`THREAD_NOT_RESIDENT`] rejection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadNotResidentErrorDataV1 {
    #[cfg_attr(
        feature = "json-schema",
        schemars(length(min = 1, max = 128), regex(pattern = r"^[A-Za-z0-9_-]+$"))
    )]
    pub thread_id: String,
    pub reason: ThreadEvictionReason,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum ThreadMaintenanceOperation {
    Compact,
    Rollback,
}

impl ThreadMaintenanceOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Compact => "compact",
            Self::Rollback => "rollback",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum ThreadMaintenanceStatus {
    Started,
    Completed,
    Failed,
    /// Cancelled before its commit; nothing of this operation was written.
    Cancelled,
}

/// Payload of `thread/maintenance`. The terminal status is sent after the
/// request's own response, so the response remains the authoritative result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadMaintenanceParams {
    #[cfg_attr(
        feature = "json-schema",
        schemars(length(min = 1, max = 128), regex(pattern = r"^[A-Za-z0-9_-]+$"))
    )]
    pub thread_id: String,
    pub operation: ThreadMaintenanceOperation,
    pub status: ThreadMaintenanceStatus,
    /// Opaque identity of this compaction, projected only for opted-in clients.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = r"^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"
        ))
    )]
    pub maintenance_id: Option<String>,
}

/// Cancellation applies to the exact currently active compaction, if it matches.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadMaintenanceCancelParams {
    #[cfg_attr(
        feature = "json-schema",
        schemars(length(min = 1, max = 128), regex(pattern = r"^[A-Za-z0-9_-]+$"))
    )]
    pub thread_id: String,
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = r"^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"
        ))
    )]
    pub maintenance_id: String,
}

/// A cancellation request is a signal, not the compaction's terminal outcome.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadMaintenanceCancelResult {
    pub cancellation_requested: bool,
}

/// `error.data` of a [`THREAD_MAINTENANCE_BUSY`] rejection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadMaintenanceBusyErrorDataV1 {
    #[cfg_attr(
        feature = "json-schema",
        schemars(length(min = 1, max = 128), regex(pattern = r"^[A-Za-z0-9_-]+$"))
    )]
    pub thread_id: String,
    pub operation: ThreadMaintenanceOperation,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn residency_payloads_round_trip_and_reject_unknown_fields() {
        let evicted: ThreadEvictedParams =
            serde_json::from_value(serde_json::json!({"threadId":"t-1","reason":"capacity"}))
                .unwrap();
        assert_eq!(evicted.reason, ThreadEvictionReason::Capacity);
        assert!(
            serde_json::from_value::<ThreadNotResidentErrorDataV1>(
                serde_json::json!({"threadId":"t-1","reason":"capacity","path":"/x"})
            )
            .is_err()
        );
        let maintenance = ThreadMaintenanceParams {
            thread_id: "t-1".into(),
            operation: ThreadMaintenanceOperation::Compact,
            status: ThreadMaintenanceStatus::Cancelled,
            maintenance_id: None,
        };
        assert_eq!(
            serde_json::to_value(&maintenance).unwrap(),
            serde_json::json!({"threadId":"t-1","operation":"compact","status":"cancelled"})
        );
    }
}
