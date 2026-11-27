use super::MemoryReviewStore;
use crate::{
    MemoryManager, MemoryObserverDraft, MemoryObserverEventBundle,
    deterministic_memory_observer_draft, validate_memory_observer_draft,
};
use anyhow::{Result, ensure};
use kcoder_types::integrations::knowledge::{
    MemoryOrigin, MemoryProposal, MemoryProvenance, ReviewedMemory,
};

/// Host-owned extraction budget. Disabled by default; it never starts a model itself.
#[derive(Debug, Clone, Default)]
pub struct MemoryMaintenanceLimits {
    pub enabled: bool,
    pub allow_model_output: bool,
    pub maximum_candidates: usize,
    pub maximum_input_bytes: usize,
    pub maximum_tokens: u64,
}
/// Receipt supplied by the existing authorized Engine, not by model/RPC arguments.
#[derive(Debug, Clone)]
pub struct CompletedMemoryExtraction {
    pub native_operation_id: String,
    pub selected_model_id: String,
    pub tokens_used: u64,
}
impl MemoryReviewStore {
    /// Imports an actual visible native observation without treating its claims as verified.
    pub fn propose_existing_observation(
        &self,
        manager: &MemoryManager,
        native_project_key: &str,
        observation_id: i64,
        operation: &str,
        now_ms: u64,
    ) -> Result<ReviewedMemory> {
        let observation = manager
            .get_structured_observation(observation_id)?
            .ok_or_else(|| anyhow::anyhow!("MEMORY_SOURCE_UNAVAILABLE"))?;
        ensure!(
            observation.project_key == native_project_key && observation.hidden_at_epoch.is_none(),
            "MEMORY_SOURCE_DENIED"
        );
        let mut parts = Vec::new();
        if let Some(text) = observation.narrative
            && !text.trim().is_empty()
        {
            parts.push(text);
        }
        parts.extend(observation.facts);
        let content = parts.join("\n");
        self.propose(
            operation,
            MemoryProposal {
                title: observation
                    .title
                    .unwrap_or_else(|| observation.observation_type.clone()),
                content,
                category: observation.observation_type,
                origin: MemoryOrigin::ExistingObservation,
                provenance: vec![MemoryProvenance {
                    kind: "native_observation".into(),
                    source_id: observation.id.to_string(),
                    source_revision: observation.content_hash,
                    description: "Existing native observation; source claims require review".into(),
                }],
                valid_until_ms: None,
            },
            now_ms,
        )
    }
    /// Deterministic Observer extraction remains an explicit host opt-in and creates candidates only.
    pub fn stage_deterministic_candidates(
        &self,
        native_project_key: &str,
        bundle: &MemoryObserverEventBundle,
        limits: &MemoryMaintenanceLimits,
        operation: &str,
        now_ms: u64,
    ) -> Result<Vec<ReviewedMemory>> {
        let draft = deterministic_memory_observer_draft(bundle);
        self.stage_observer_candidates(
            native_project_key,
            bundle,
            &draft,
            limits,
            None,
            operation,
            now_ms,
        )
    }
    /// Applies validated output from an already completed native extraction. No provider is called.
    #[allow(clippy::too_many_arguments)]
    pub fn stage_observer_candidates(
        &self,
        native_project_key: &str,
        bundle: &MemoryObserverEventBundle,
        draft: &MemoryObserverDraft,
        limits: &MemoryMaintenanceLimits,
        extraction: Option<&CompletedMemoryExtraction>,
        operation: &str,
        now_ms: u64,
    ) -> Result<Vec<ReviewedMemory>> {
        ensure!(limits.enabled, "MEMORY_MAINTENANCE_DISABLED");
        ensure!(
            bundle.project_key == native_project_key,
            "MEMORY_SOURCE_DENIED"
        );
        ensure!(
            !operation.is_empty() && operation.len() <= 180,
            "MEMORY_INVALID_OPERATION"
        );
        ensure!(
            limits.maximum_candidates > 0
                && limits.maximum_candidates <= 32
                && limits.maximum_input_bytes > 0
                && serde_json::to_vec(bundle)?.len() <= limits.maximum_input_bytes.min(512 * 1024),
            "MEMORY_MAINTENANCE_BUDGET_EXCEEDED"
        );
        if let Some(model) = draft.audit.model.as_ref() {
            let receipt =
                extraction.ok_or_else(|| anyhow::anyhow!("MEMORY_EXTRACTION_RECEIPT_REQUIRED"))?;
            ensure!(
                limits.allow_model_output
                    && limits.maximum_tokens > 0
                    && receipt.tokens_used <= limits.maximum_tokens
                    && receipt.selected_model_id == *model
                    && !receipt.native_operation_id.is_empty(),
                "MEMORY_EXTRACTION_RECEIPT_MISMATCH"
            );
        } else {
            ensure!(
                extraction.is_none() && *draft == deterministic_memory_observer_draft(bundle),
                "MEMORY_EXTRACTION_RECEIPT_MISMATCH"
            );
        }
        validate_memory_observer_draft(bundle, draft)
            .map_err(|_| anyhow::anyhow!("MEMORY_CANDIDATE_VALIDATION_FAILED"))?;
        ensure!(
            draft.observation_candidates.len() <= limits.maximum_candidates,
            "MEMORY_MAINTENANCE_BUDGET_EXCEEDED"
        );
        // Only append new candidates. Existing confirmed or manually edited records are never updated.
        let mut proposals = Vec::new();
        for candidate in &draft.observation_candidates {
            let content = candidate
                .narrative
                .iter()
                .cloned()
                .chain(candidate.facts.iter().cloned())
                .collect::<Vec<_>>()
                .join("\n");
            let provenance = candidate
                .source_event_ids
                .iter()
                .map(|event| MemoryProvenance {
                    kind: "native_observer_event".into(),
                    source_id: format!("{}/{}", bundle.session_id, event),
                    source_revision: format!("observer-v{}-{}", bundle.schema_version, operation),
                    description:
                        "Validated Observer source reference; candidate is not a verified fact"
                            .into(),
                })
                .collect();
            proposals.push(MemoryProposal {
                title: candidate.title.clone(),
                content,
                category: candidate.observation_type.clone(),
                origin: MemoryOrigin::Observer,
                provenance,
                valid_until_ms: None,
            });
        }
        self.propose_candidates(operation, proposals, now_ms)
    }
}

#[cfg(test)]
mod tests;
