//! Pending authorization is persisted atomically with the existing binding.
use super::*;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativeTaskCapabilityScopeControlPhase {
    PendingBoundary,
    Applied,
    Rejected,
    OutcomeUnknown,
    Superseded,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeTaskCapabilityScopeControlReceipt {
    pub(crate) operation_id: String,
    pub(crate) intent_sha256: String,
    pub(crate) authorization: NativeTaskCapabilityScopeAuthorizationReceipt,
    pub(crate) previous: IntegrationTaskCapabilityScopeSnapshot,
    pub(crate) requested: IntegrationTaskCapabilityScopeSnapshot,
    pub(crate) phase: NativeTaskCapabilityScopeControlPhase,
    pub(crate) applied_revision: Option<u64>,
    pub(crate) reason_code: Option<String>,
}
