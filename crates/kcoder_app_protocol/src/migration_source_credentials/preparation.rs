//! Read-only recovery of the exact native prepare intent, never publication evidence.
use super::MigrationSourceCredentialConsent;
use crate::MigrationSourceSessionParams;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialPreparationReadParams {
    #[serde(deserialize_with = "crate::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub request_id: String,
    pub target: MigrationSourceSessionParams,
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(pattern = "^mig-[0-9a-f]{32}$"))
    )]
    pub job_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationSourceCredentialPreparationPhase {
    NotStarted,
    Pending,
    Prepared,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(untagged)]
pub enum MigrationSourceCredentialPreparationPlan {
    Known(String),
    Unknown(()),
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(untagged)]
pub enum MigrationSourceCredentialPreparationOffers {
    Known(#[cfg_attr(feature = "json-schema", schemars(length(min = 1, max = 16)))] Vec<String>),
    Unknown(()),
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(untagged)]
pub enum MigrationSourceCredentialPreparationSequence {
    Known(
        #[serde(deserialize_with = "super::safe_counter")]
        #[cfg_attr(feature = "json-schema", schemars(range(max = 9007199254740991_u64)))]
        u64,
    ),
    Unknown(()),
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(untagged)]
pub enum MigrationSourceCredentialPreparationConsent {
    Known(MigrationSourceCredentialConsent),
    Unknown(()),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialPreparationResult {
    pub request_id: String,
    pub job_id: String,
    #[serde(deserialize_with = "super::safe_counter")]
    #[cfg_attr(feature = "json-schema", schemars(range(max = 9007199254740991_u64)))]
    pub sequence: u64,
    pub phase: MigrationSourceCredentialPreparationPhase,
    pub original_plan_id: MigrationSourceCredentialPreparationPlan,
    pub plan_id: MigrationSourceCredentialPreparationPlan,
    pub offer_ids: MigrationSourceCredentialPreparationOffers,
    pub expected_sequence: MigrationSourceCredentialPreparationSequence,
    pub consent: MigrationSourceCredentialPreparationConsent,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialPreparationReadParamsV1 {
    pub job_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn prepare_status_requires_explicit_unknowns_and_never_accepts_private_values() {
        let unknown = json!({"requestId":"owned","jobId":"owned","sequence":0,"phase":"unknown",
            "originalPlanId":null,"planId":null,"offerIds":null,"expectedSequence":null,"consent":null});
        assert!(
            serde_json::from_value::<MigrationSourceCredentialPreparationResult>(unknown.clone())
                .is_ok()
        );
        for field in [
            "originalPlanId",
            "planId",
            "offerIds",
            "expectedSequence",
            "consent",
        ] {
            let mut changed = unknown.clone();
            changed.as_object_mut().unwrap().remove(field);
            assert!(
                serde_json::from_value::<MigrationSourceCredentialPreparationResult>(changed)
                    .is_err()
            );
        }
        let mut changed = unknown;
        changed["privateValue"] = json!("SYNTHETIC_NEVER_PUBLIC");
        assert!(
            serde_json::from_value::<MigrationSourceCredentialPreparationResult>(changed).is_err()
        );
    }
}
