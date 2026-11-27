//! Reviewed Agent adaptation is opt-in and independent of passive definition storage.
pub use kcoder_types::migration_agent::{
    ImportedAgentModel, MigrationAgentAdaptation, MigrationAgentCompatibility,
    MigrationAgentProblem,
};
use serde::{Deserialize, Serialize};
pub const CAPABILITY_MIGRATION_AGENT_ADAPTATION_V1: &str = "migrationAgentAdaptationV1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationAgentPreviewParams {
    pub job_id: String,
    pub item_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationAgentPreviewResult {
    pub job_id: String,
    pub item_id: String,
    pub compatibility: MigrationAgentCompatibility,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn legacy_asset_choices_do_not_enable_an_adapter_or_add_fields() {
        let old =
            json!({"kind":"asset","itemId":"i","targetName":"pending","enableAfterImport":false});
        let choice: crate::MigrationBatchChoice = serde_json::from_value(old.clone()).unwrap();
        assert_eq!(serde_json::to_value(choice).unwrap(), old);
        let adapted = json!({"kind":"asset","itemId":"i","targetName":"agent","enableAfterImport":false,
            "agentAdaptation":{"reviewedSourceSha256":"a".repeat(64),"model":{"kind":"target","provider":"p","model":"m"},"tools":["read"]}});
        let choice: crate::MigrationBatchChoice = serde_json::from_value(adapted.clone()).unwrap();
        assert_eq!(serde_json::to_value(choice).unwrap(), adapted);
        assert!(
            serde_json::from_value::<MigrationAgentPreviewParams>(
                json!({"jobId":"j","itemId":"i","profile":"other"})
            )
            .is_err()
        );
    }
}
