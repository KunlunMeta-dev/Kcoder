//! Knowledge domain request payloads. Public envelopes remain in the shared core.
use kcoder_types::integrations::knowledge::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryListParams {
    #[serde(default)]
    pub after: Option<String>,
    #[serde(default = "include_candidates")]
    pub include_candidates: bool,
}
fn include_candidates() -> bool {
    true
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryReadParams {
    pub memory_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryProposeParams {
    pub proposal: MemoryProposal,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryReviewParams {
    pub memory_id: String,
    pub review: MemoryReview,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryEnableParams {
    pub memory_id: String,
    pub enabled: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryEditParams {
    pub memory_id: String,
    pub content: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationReadParams {
    pub owner: KnowledgeOwner,
    pub publication_id: String,
    #[serde(default)]
    pub version: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeRetrieveParams {
    pub owner: KnowledgeOwner,
    pub publication_id: String,
    pub version: u64,
    pub query: String,
    #[serde(default = "retrieval_limit")]
    pub limit: usize,
}
fn retrieval_limit() -> usize {
    8
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CitationReadParams {
    pub owner: KnowledgeOwner,
    pub publication_id: String,
    pub version: u64,
    pub source: PublicationSource,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgePublishParams {
    pub draft: PublicationDraft,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeRevokeParams {
    pub owner: KnowledgeOwner,
    pub publication_id: String,
    pub version: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscriptionSaveParams {
    pub draft: AutomationSubscriptionDraft,
    pub consent_ref: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscriptionEnableParams {
    pub subscription_id: String,
    pub enabled: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationRunReadParams {
    pub run_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationTriggerParams {
    pub subscription_id: String,
    pub subscription_revision: u64,
    pub trigger_id: String,
    pub trigger_facts: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryListResult {
    pub page: KnowledgePage<ReviewedMemory>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryReadResult {
    pub memory: ReviewedMemory,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationListResult {
    pub page: KnowledgePage<KnowledgePublication>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationReadResult {
    pub publication: KnowledgePublication,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeRetrieveResult {
    pub retrieval: KnowledgeRetrieval,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CitationReadResult {
    pub citation: PublishedKnowledgePage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscriptionListResult {
    pub page: KnowledgePage<AutomationSubscription>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscriptionReadResult {
    pub subscription: AutomationSubscription,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationRunListResult {
    pub page: KnowledgePage<AutomationRun>,
}

pub use kcoder_types::integrations::knowledge::AutomationQuarantinedEvent;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationQuarantineListResult {
    pub page: KnowledgePage<AutomationQuarantinedEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationRunReadResult {
    pub run: AutomationRun,
}

#[cfg(test)]
mod wire_tests;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeAdoptParams {
    pub owner: KnowledgeOwner,
    pub publication_id: String,
    pub version: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeAdoptionEnableParams {
    pub adoption_id: String,
    pub enabled: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeAdoptionResult {
    pub adoption: KnowledgeAdoption,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeAdoptionListResult {
    pub page: KnowledgePage<KnowledgeAdoption>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationTemplateListResult {
    pub templates: Vec<AutomationTemplate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationHistoryListResult {
    pub page: KnowledgePage<KnowledgePublicationSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationClaimListResult {
    pub page: KnowledgePage<AutomationArtifactClaim>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationSourcesReadParams {
    pub owner: KnowledgeOwner,
    pub publication_id: String,
    pub version: u64,
    pub after: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationSourcesReadResult {
    pub page: KnowledgePage<KnowledgeSourceObservation>,
}

/// Preview is observation only; no policy or subscription authority is serialized.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationPeriodBudgetPreview {
    pub configuration: AutomationPeriodBudget,
    pub current_window: AutomationBudgetWindow,
    pub effective_maximum_tokens: u64,
    pub effective_maximum_model_calls: u64,
    pub charged_tokens: u64,
    pub charged_model_calls: u64,
    pub unknown_cost_reservations: u32,
    pub active_tasks: u32,
    pub active_calls: u32,
    pub increases_apply_next_window: bool,
    pub creates_subscription: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscriptionPreviewResult {
    pub next_fire_at_ms: Option<u64>,
    pub workflow_id: String,
    pub workflow_version: u64,
    pub maximum_tokens: u64,
    pub maximum_runtime_seconds: u64,
    pub creates_subscription: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<kcoder_types::integrations::core::IntegrationModelSelectionIntent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period_budget: Option<AutomationPeriodBudgetPreview>,
}

pub use kcoder_types::integrations::knowledge::{
    AutomationConnectionEventSource, AutomationConnectionEventSourceState,
};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationConnectionEventSourceListResult {
    pub page: KnowledgePage<AutomationConnectionEventSource>,
}
