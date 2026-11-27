use super::KnowledgeOwner;
use crate::CronSchedule;
use crate::integrations::core::IntegrationModelSelectionIntent;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[path = "automation/application_sources.rs"]
mod application_sources;
pub use application_sources::{
    AutomationApplicationSelectionParams, AutomationApplicationSelectionReceipt,
};

#[path = "automation/period_budget.rs"]
mod period_budget;
pub use period_budget::{AutomationBudgetWindow, AutomationPeriodBudget};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationSubscriptionDraft {
    pub id: String,
    pub title: String,
    pub workflow_id: String,
    pub workflow_version: u64,
    /// Only an explicitly saved selection can authorize AUTO candidate resolution.
    /// Missing legacy intent remains InheritCurrent and serializes unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<IntegrationModelSelectionIntent>,
    pub inputs: Value,
    pub schedule: Option<CronSchedule>,
    pub event_source: Option<String>,
    pub maximum_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period_budget: Option<AutomationPeriodBudget>,
    pub maximum_runtime_seconds: u64,
    pub delivery: AutomationDestination,
}
impl AutomationSubscriptionDraft {
    pub fn effective_model_selection(&self) -> IntegrationModelSelectionIntent {
        self.model_selection
            .clone()
            .unwrap_or(IntegrationModelSelectionIntent::InheritCurrent)
    }
}

#[cfg(test)]
#[path = "automation/selection_tests.rs"]
mod selection_tests;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AutomationDestination {
    Studio,
    Channel {
        #[serde(rename = "destinationRef")]
        destination_ref: String,
        #[serde(rename = "destinationRevision")]
        destination_revision: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationSubscription {
    pub owner: KnowledgeOwner,
    pub revision: u64,
    pub enabled: bool,
    pub draft: AutomationSubscriptionDraft,
    pub consent_ref: String,
    pub next_fire_at_ms: Option<u64>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum AutomationRunStatus {
    Preparing,
    Accepted,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum AutomationDeliveryStatus {
    NotReady,
    StudioAvailable,
    Pending,
    Accepted,
    Failed,
    Cancelled,
    Unknown,
    Unavailable,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationRun {
    pub id: String,
    #[serde(default)]
    pub title: String,
    pub owner: KnowledgeOwner,
    pub subscription_id: String,
    pub subscription_revision: u64,
    pub trigger_id: String,
    pub native_operation_id: String,
    pub native_thread_id: Option<String>,
    pub native_turn_id: Option<String>,
    /// Read-only projection from the original private Native acceptance. Older
    /// runs without that receipt retain None; manifests never supply this ID.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_task_id: Option<String>,
    pub status: AutomationRunStatus,
    pub delivery_status: AutomationDeliveryStatus,
    pub artifact_refs: Vec<String>,
    pub output: Option<String>,
    pub delivery_id: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub error_code: Option<String>,
}

/// Read-only projection of an original quarantined ingress fact, never a retry request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationQuarantinedEvent {
    pub id: String,
    pub subscription_id: String,
    pub subscription_revision: u64,
    pub source_ref: String,
    pub event_id: String,
    pub occurred_at_ms: u64,
    pub reason_code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationTemplate {
    pub id: String,
    pub title: String,
    pub description: String,
    pub workflow_id: String,
    pub workflow_version: u64,
    pub input_schema: Value,
    pub suggested_schedule: CronSchedule,
    pub maximum_tokens: u64,
    pub maximum_runtime_seconds: u64,
    pub acceptance_criteria: Vec<String>,
}

/// Actual native export completion, separate from preparing a lease or clicking a link.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationArtifactClaim {
    pub owner: KnowledgeOwner,
    pub run_id: String,
    pub native_operation_id: String,
    pub manifest_ref: crate::integrations::core::IntegrationEntityRef,
    pub export_id: String,
    pub bytes: u64,
    pub sha256: String,
    pub completed_at_ms: u64,
}

/// Metadata from an actual native connection event source; selecting it grants no execution authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationConnectionEventSource {
    pub source_ref: String,
    pub connection_id: String,
    pub platform: crate::integrations::connectivity::MessagingPlatform,
    pub received_at_ms: u64,
    pub state: AutomationConnectionEventSourceState,
    pub reason_code: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum AutomationConnectionEventSourceState {
    Available,
    Unavailable,
}
