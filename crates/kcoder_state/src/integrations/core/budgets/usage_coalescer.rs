//! Coalesces streaming usage observations into bounded ledger writes.
//!
//! Invariant: the persisted `charged` hold of an unconfirmed reservation always
//! covers every usage this process has observed for it. Whenever an observation
//! would exceed that hold, the caller must persist it before continuing, so
//! other admissions (in any process) never see less than the observed usage.
//! Observations still covered by the hold are informational and are persisted
//! only at a token delta, at an interval, and by the mandatory terminal write.
//!
//! Crash semantics: observations that were coalesced but not yet persisted are
//! lost on crash. They were already covered by the persisted hold, and an
//! unconfirmed reservation keeps that hold (never less than its estimate)
//! until an authoritative terminal write, so recovery over-counts rather than
//! under-counts.
use super::*;
use std::time::{Duration, Instant};

/// Flush thresholds for covered (non-mandatory) streaming observations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BudgetUsageFlushPolicy {
    pub interval: Duration,
    pub token_delta: u64,
    /// Optional writes per reservation. Mandatory and terminal writes are not
    /// limited here; this keeps streams inside the per-reservation update cap.
    pub max_optional_writes: u32,
}
impl Default for BudgetUsageFlushPolicy {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(2),
            token_delta: 8192,
            max_optional_writes: 24,
        }
    }
}

/// What the caller must do with the latest observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetUsageFlush {
    /// The observation exceeds the persisted hold: persist before continuing.
    Required,
    /// A threshold was reached; persisting keeps observers current.
    Threshold,
    /// Covered by the persisted hold; keep it in memory.
    Deferred,
}

#[derive(Debug, Clone)]
pub struct NativeBudgetUsageCoalescer {
    policy: BudgetUsageFlushPolicy,
    persisted: BudgetCharge,
    last_flush: Instant,
    optional_writes: u32,
    pending: bool,
}

impl NativeBudgetUsageCoalescer {
    pub fn new(
        receipt: &BudgetReservationReceipt,
        policy: BudgetUsageFlushPolicy,
        now: Instant,
    ) -> Self {
        Self {
            policy,
            persisted: receipt.known_usage.clone(),
            last_flush: now,
            optional_writes: 0,
            pending: false,
        }
    }

    /// Classify one observation against the current persisted receipt.
    pub fn observe(
        &mut self,
        receipt: &BudgetReservationReceipt,
        observed: &BudgetCharge,
        now: Instant,
    ) -> BudgetUsageFlush {
        if !receipt.execution_confirmed_terminal && !receipt.charged.covers(observed) {
            self.pending = true;
            return BudgetUsageFlush::Required;
        }
        let changed = observed.tokens != self.persisted.tokens
            || observed.model_calls != self.persisted.model_calls
            || observed.cost_micros != self.persisted.cost_micros;
        if !changed {
            return BudgetUsageFlush::Deferred;
        }
        self.pending = true;
        if self.optional_writes < self.policy.max_optional_writes
            && (observed.tokens.saturating_sub(self.persisted.tokens) >= self.policy.token_delta
                || now.saturating_duration_since(self.last_flush) >= self.policy.interval)
        {
            BudgetUsageFlush::Threshold
        } else {
            BudgetUsageFlush::Deferred
        }
    }

    /// Record that `observed` was durably written for `kind`.
    pub fn persisted(&mut self, kind: BudgetUsageFlush, observed: &BudgetCharge, now: Instant) {
        if kind == BudgetUsageFlush::Threshold {
            self.optional_writes = self.optional_writes.saturating_add(1);
        }
        self.persisted = observed.clone();
        self.last_flush = now;
        self.pending = false;
    }

    /// Observations held only in memory. The terminal write must cover them.
    pub fn has_pending(&self) -> bool {
        self.pending
    }
}
