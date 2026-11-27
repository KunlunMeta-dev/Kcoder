//! Provider call lease and observation contracts shared by native consumers.

use kcoder_types::Usage;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeModelRequestError {
    Denied,
    Unavailable,
    Deadline,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeModelRequestEnd {
    /// The provider sent its terminal marker; task success and money cost remain separate.
    MessageStop,
    /// The stream ended without a terminal marker; completion remains unconfirmed.
    Eof,
    /// The provider emitted an error event after the request may have been accepted.
    ProviderError,
    /// Transport or protocol decoding failed, possibly after partial output.
    StreamError,
    /// The owning stream was dropped, including cancellation before or after dispatch.
    Dropped,
    /// The owning run's absolute deadline expired.
    Deadline,
    /// A current authority check rejected the original admission.
    AdmissionChanged,
    /// Observed usage could not be persisted; keep the reservation for reconciliation.
    UsageAccountingFailed,
}
/// Actual normalized stream observation. MessageStop is a transport fact,
/// never proof of business completion or of a known money charge.
#[derive(Debug, Clone, PartialEq)]
pub struct NativeModelRequestSettlement {
    pub end: NativeModelRequestEnd,
    pub usage: Option<Usage>,
    /// MessageStart usage alone may be partial. Do not assume its output zero
    /// means the provider actually reported a zero final output.
    pub usage_from_delta: bool,
    pub request_dispatched: bool,
}

pub trait NativeModelRequestLease: Send {
    /// Persist the monotonic cumulative observed usage; no request is sent here.
    fn record_usage(&mut self, _usage: &Usage) -> Result<(), NativeModelRequestError> {
        Ok(())
    }
    /// Re-check revocation/actor/run authority without renewing an old grant.
    fn check_current(&self) -> Result<(), NativeModelRequestError> {
        Ok(())
    }
    /// Actual immutable run deadline; the Engine does not substitute RPC timeout.
    fn deadline(&self) -> Option<Instant> {
        None
    }
    /// Called once. Missing/partial usage, a dropped stream or uncertain send
    /// must not be treated as zero cost or an automatic refund. Errors leave
    /// the original real reservation available for authoritative reconciliation.
    fn finish(
        self: Box<Self>,
        settlement: NativeModelRequestSettlement,
    ) -> Result<(), NativeModelRequestError>;
}
