use anyhow::{Result, ensure};
use kcoder_memory::{
    MemoryObserverDraft, MemoryObserverEventBundle,
    integrations::knowledge::{
        CompletedMemoryExtraction, MemoryMaintenanceLimits, MemoryReviewStore,
    },
};
use kcoder_types::{
    Usage,
    integrations::{
        core::{IntegrationRuntimeReadTaskParams, IntegrationScope},
        knowledge::KnowledgeOwner,
    },
};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObserverExtractionKind {
    Deterministic,
    Model,
}
#[derive(Debug, Clone)]
pub struct ObserverExtractionRequest {
    pub kind: ObserverExtractionKind,
    pub requested_model_id: Option<String>,
    pub requested_maximum_output_tokens: u32,
    pub input_bytes: usize,
}
/// Resolved from the original accepted task and source events, never the latest thread turn.
#[derive(Debug, Clone)]
pub struct ObserverNativeOrigin {
    pub scope: IntegrationScope,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub task_id: Option<String>,
    pub operation_id: String,
    pub project_key: String,
    pub policy_revision: String,
    pub configuration_revision: String,
}
/// Native evidence is not deserializable and does not grant authority by field contents alone.
#[derive(Debug, Clone)]
pub struct ObserverExtractionPermit {
    pub origin: ObserverNativeOrigin,
    pub kind: ObserverExtractionKind,
    pub selected_model_id: Option<String>,
    pub maximum_total_tokens: u64,
    pub maximum_output_tokens: u32,
    pub maximum_input_bytes: usize,
    pub maximum_candidates: usize,
    pub maximum_runtime_ms: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObserverExtractionOutcome {
    Validated,
    ProviderFailed,
    ParseFailed,
    ValidationFailed,
    BudgetExceeded,
    Abandoned,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObserverUsageEvidence {
    NotStarted,
    Unreported,
    Partial,
    Reported,
}
#[derive(Debug, Clone)]
pub struct ObserverExtractionReceipt {
    pub operation_id: String,
    pub provider_started: bool,
    pub requested_model_id: Option<String>,
    pub actual_model_id: Option<String>,
    /// None is unreported, never a fabricated zero-token usage snapshot.
    pub usage: Option<Usage>,
    pub usage_evidence: ObserverUsageEvidence,
    pub started_at_ms: u64,
    pub finished_at_ms: u64,
    pub outcome: ObserverExtractionOutcome,
}
/// All policy/model/source decisions remain in the current native host authority.
pub trait CuratedMemoryObserverSink: Send + Sync {
    fn authorize(
        &self,
        bundle: &MemoryObserverEventBundle,
        request: &ObserverExtractionRequest,
    ) -> Result<ObserverExtractionPermit>;
    fn revalidate(
        &self,
        permit: &ObserverExtractionPermit,
        bundle: &MemoryObserverEventBundle,
    ) -> Result<()>;
    /// Account the original attempt even if its source permission was later revoked.
    fn record_attempt(
        &self,
        permit: &ObserverExtractionPermit,
        receipt: &ObserverExtractionReceipt,
    ) -> Result<()>;
    fn stage_candidates(
        &self,
        permit: &ObserverExtractionPermit,
        bundle: &MemoryObserverEventBundle,
        draft: &MemoryObserverDraft,
        receipt: &ObserverExtractionReceipt,
    ) -> Result<usize>;
}
/// Implement by the native task/source/model budget services. Scope alone is not authorization.
pub trait CuratedMemoryObserverAuthority: Send + Sync {
    fn authorize(
        &self,
        bundle: &MemoryObserverEventBundle,
        request: &ObserverExtractionRequest,
    ) -> Result<ObserverExtractionPermit>;
    fn revalidate(
        &self,
        permit: &ObserverExtractionPermit,
        bundle: &MemoryObserverEventBundle,
    ) -> Result<()>;
    fn record_attempt(
        &self,
        permit: &ObserverExtractionPermit,
        receipt: &ObserverExtractionReceipt,
    ) -> Result<()>;
}
/// Concrete store-backed review sink. It never calls a Provider or writes the legacy recall store.
pub struct CuratedMemoryReviewBridge {
    store: Arc<MemoryReviewStore>,
    authority: Arc<dyn CuratedMemoryObserverAuthority>,
}
impl CuratedMemoryReviewBridge {
    pub fn new(
        store: Arc<MemoryReviewStore>,
        authority: Arc<dyn CuratedMemoryObserverAuthority>,
    ) -> Self {
        Self { store, authority }
    }
    fn validate_binding(
        &self,
        permit: &ObserverExtractionPermit,
        bundle: &MemoryObserverEventBundle,
    ) -> Result<()> {
        permit.origin.scope.validate()?;
        ensure!(
            KnowledgeOwner::from(&permit.origin.scope) == *self.store.owner(),
            "MEMORY_SCOPE_MISMATCH"
        );
        ensure!(
            permit.origin.thread_id == bundle.session_id
                && permit.origin.project_key == bundle.project_key,
            "MEMORY_SOURCE_DENIED"
        );
        IntegrationRuntimeReadTaskParams {
            thread_id: Some(permit.origin.thread_id.clone()),
            turn_id: permit.origin.turn_id.clone(),
            task_id: permit.origin.task_id.clone(),
        }
        .validate()?;
        ensure!(
            !permit.origin.operation_id.is_empty()
                && permit.origin.operation_id.len() <= 180
                && !permit.origin.policy_revision.is_empty()
                && !permit.origin.configuration_revision.is_empty(),
            "MEMORY_OBSERVER_PERMIT_INVALID"
        );
        ensure!(
            (1..=32).contains(&permit.maximum_candidates)
                && permit.maximum_input_bytes > 0
                && permit.maximum_input_bytes <= 512 * 1024
                && permit.maximum_runtime_ms > 0
                && permit.maximum_runtime_ms <= 60000,
            "MEMORY_MAINTENANCE_BUDGET_EXCEEDED"
        );
        Ok(())
    }
}
impl CuratedMemoryObserverSink for CuratedMemoryReviewBridge {
    fn authorize(
        &self,
        bundle: &MemoryObserverEventBundle,
        request: &ObserverExtractionRequest,
    ) -> Result<ObserverExtractionPermit> {
        let permit = self.authority.authorize(bundle, request)?;
        self.validate_binding(&permit, bundle)?;
        ensure!(
            permit.kind == request.kind && permit.selected_model_id == request.requested_model_id,
            "MEMORY_OBSERVER_PERMIT_INVALID"
        );
        ensure!(
            request.input_bytes <= permit.maximum_input_bytes,
            "MEMORY_MAINTENANCE_BUDGET_EXCEEDED"
        );
        if request.kind == ObserverExtractionKind::Model {
            ensure!(
                permit
                    .selected_model_id
                    .as_ref()
                    .is_some_and(|model| !model.trim().is_empty() && model.len() <= 256),
                "MEMORY_OBSERVER_PERMIT_INVALID"
            );
            ensure!(
                permit.maximum_total_tokens > 0
                    && permit.maximum_output_tokens > 0
                    && permit.maximum_output_tokens <= request.requested_maximum_output_tokens,
                "MEMORY_MAINTENANCE_BUDGET_EXCEEDED"
            );
        }
        self.authority.revalidate(&permit, bundle)?;
        Ok(permit)
    }
    fn revalidate(
        &self,
        permit: &ObserverExtractionPermit,
        bundle: &MemoryObserverEventBundle,
    ) -> Result<()> {
        self.validate_binding(permit, bundle)?;
        self.authority.revalidate(permit, bundle)
    }
    fn record_attempt(
        &self,
        permit: &ObserverExtractionPermit,
        receipt: &ObserverExtractionReceipt,
    ) -> Result<()> {
        ensure!(
            receipt.operation_id == permit.origin.operation_id
                && receipt.requested_model_id == permit.selected_model_id,
            "MEMORY_EXTRACTION_RECEIPT_MISMATCH"
        );
        let consistent = match receipt.usage_evidence {
            ObserverUsageEvidence::NotStarted => {
                !receipt.provider_started && receipt.usage.is_none()
            }
            ObserverUsageEvidence::Unreported => {
                receipt.provider_started && receipt.usage.is_none()
            }
            ObserverUsageEvidence::Partial | ObserverUsageEvidence::Reported => {
                receipt.provider_started && receipt.usage.is_some()
            }
        };
        ensure!(consistent, "MEMORY_EXTRACTION_RECEIPT_MISMATCH");
        self.authority.record_attempt(permit, receipt)
    }
    fn stage_candidates(
        &self,
        permit: &ObserverExtractionPermit,
        bundle: &MemoryObserverEventBundle,
        draft: &MemoryObserverDraft,
        receipt: &ObserverExtractionReceipt,
    ) -> Result<usize> {
        self.revalidate(permit, bundle)?;
        ensure!(
            receipt.operation_id == permit.origin.operation_id
                && receipt.outcome == ObserverExtractionOutcome::Validated,
            "MEMORY_EXTRACTION_RECEIPT_MISMATCH"
        );
        let limits = MemoryMaintenanceLimits {
            enabled: true,
            allow_model_output: permit.kind == ObserverExtractionKind::Model,
            maximum_candidates: permit.maximum_candidates,
            maximum_input_bytes: permit.maximum_input_bytes,
            maximum_tokens: permit.maximum_total_tokens,
        };
        let extraction = if permit.kind == ObserverExtractionKind::Model {
            let usage = receipt
                .usage
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("MEMORY_USAGE_UNCONFIRMED"))?;
            ensure!(
                receipt.provider_started,
                "MEMORY_EXTRACTION_RECEIPT_MISMATCH"
            );
            Some(CompletedMemoryExtraction {
                native_operation_id: receipt.operation_id.clone(),
                selected_model_id: permit
                    .selected_model_id
                    .clone()
                    .ok_or_else(|| anyhow::anyhow!("MEMORY_EXTRACTION_RECEIPT_MISMATCH"))?,
                tokens_used: crate::UsageAccumulator::usage_total(usage),
            })
        } else {
            ensure!(
                !receipt.provider_started && receipt.usage.is_none(),
                "MEMORY_EXTRACTION_RECEIPT_MISMATCH"
            );
            None
        };
        let candidates = self.store.stage_observer_candidates(
            &permit.origin.project_key,
            bundle,
            draft,
            &limits,
            extraction.as_ref(),
            &permit.origin.operation_id,
            receipt.finished_at_ms,
        )?;
        self.revalidate(permit, bundle)
            .map_err(|_| anyhow::anyhow!("MEMORY_CANDIDATE_WRITE_UNCONFIRMED"))?;
        Ok(candidates.len())
    }
}

#[cfg(test)]
mod tests;
