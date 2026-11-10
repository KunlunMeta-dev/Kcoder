//! Observations and explicit quota intent do not resume a job or expand filesystem authority.
pub use kcoder_types::migration_resource::{
    MigrationResourceBudgetView, MigrationResourceIncreaseReceipt, MigrationResourceLimits,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationResourceBudgetReadParams {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationResourceIncreaseParams {
    pub job_id: String,
    pub plan_id: String,
    pub request_id: String,
    pub expected_policy_revision: u64,
    pub limits: MigrationResourceLimits,
    #[serde(default)]
    pub confirm: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn budget_intent_requires_separate_confirmation_and_rejects_native_authority_fields() {
        let mut value = json!({"jobId":"job","planId":"plan","requestId":"original",
            "expectedPolicyRevision":0,"limits":{}});
        let params: MigrationResourceIncreaseParams =
            serde_json::from_value(value.clone()).unwrap();
        assert!(!params.confirm);
        value["owner"] = json!({"scope":"borrowed-profile"});
        assert!(serde_json::from_value::<MigrationResourceIncreaseParams>(value).is_err());
        assert!(
            serde_json::from_value::<MigrationResourceBudgetReadParams>(json!({
            "jobId":"job","path":"/another-profile"}))
            .is_err()
        );
    }

    #[test]
    fn budget_phase_cannot_claim_a_completed_allocation_without_usage_facts() {
        assert!(
            serde_json::from_value::<MigrationResourceBudgetView>(json!({
            "phase":"active","jobId":"job","limits":{},"policyRevision":0}))
            .is_err()
        );
        assert!(
            serde_json::from_value::<MigrationResourceBudgetView>(json!({
            "phase":"legacy_untracked","jobId":"job","usage":{
                "reservedBytes":0,"committedBytes":0,"reservedFiles":0,"committedFiles":0}}))
            .is_err()
        );
        let legacy: MigrationResourceBudgetView = serde_json::from_value(json!({
            "phase":"legacy_untracked","jobId":"job"}))
        .unwrap();
        assert!(legacy.usage().is_none());
    }
}
