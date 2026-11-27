//! Private cross-session queue foundation, not a dispatch or authorization service.
//!
//! The host must independently authenticate the source and recheck current access
//! before admission and delivery. No API here writes native history or claims an
//! applied message: that requires a future history-bound commit protocol.
mod store;
pub(crate) use store::PeerDeliveryCommitIdentity;
pub use store::{
    COLD_WAKE_DEFERRED_REASONS, ColdWakeIdleHint, ColdWakeIdleObservation,
    CrossSessionDeliveryLease, CrossSessionMessageMaintenance, CrossSessionMessageObservationStamp,
    CrossSessionMessageRecord, CrossSessionMessageStore, CrossSessionReceiptBinding,
    OriginalReceiptQuery, PendingColdWake,
};

#[cfg(test)]
mod tests;
