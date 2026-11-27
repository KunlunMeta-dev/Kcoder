//! Reinterpreting immutable evidence creates a separate normal history job.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryReinterpretPreviewParams {
    pub source_job_id: String,
}

pub type MigrationHistoryReinterpretPreviewResult =
    kcoder_types::history_reinterpretation::HistoryReinterpretationPreview;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryReinterpretCreateParams {
    /// Canonical UUID selected before the request; a lost reply keeps this identity.
    pub request_id: String,
    pub source_job_id: String,
    pub expected_source_sequence: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpretation_requests_cannot_supply_storage_or_parser_authority() {
        let value = serde_json::json!({
            "requestId":"da0825d9-ae04-40da-b110-73d08f6a3116",
            "sourceJobId":"e5c76262-667d-454a-9445-8c17c8865675",
            "expectedSourceSequence":9
        });
        assert!(
            serde_json::from_value::<MigrationHistoryReinterpretCreateParams>(value.clone())
                .is_ok()
        );
        for (key, extra) in [
            ("path", serde_json::json!("/other/account")),
            ("archiveId", serde_json::json!("forged")),
            ("parserRevision", serde_json::json!("foreign-records/0")),
            ("owner", serde_json::json!("other-account")),
        ] {
            let mut forged = value.clone();
            forged[key] = extra;
            assert!(
                serde_json::from_value::<MigrationHistoryReinterpretCreateParams>(forged).is_err()
            );
        }
        assert!(
            serde_json::from_value::<MigrationHistoryReinterpretPreviewParams>(serde_json::json!({
                "sourceJobId":"id", "repair":true
            }))
            .is_err()
        );
    }
}
