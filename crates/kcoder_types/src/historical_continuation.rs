//! Migration-owned continuation jobs do not authorize old operations or start a user turn.
use crate::{
    StudioWorkMode,
    historical_context::{
        HistoricalContextPolicy, HistoricalContextReport, HistoricalLocalAttachmentBinding,
        HistoricalModelProjectionReport,
    },
};
use serde::{Deserialize, Serialize};

/// Durable provenance for presentation, independent of the current model-context generation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalContinuationSource {
    pub operation_id: String,
    pub source_job_id: String,
    pub view_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalContinuationOptions {
    pub model: Option<String>,
    pub settings_template: Option<String>,
    pub studio_work_mode: StudioWorkMode,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub local_attachments: Vec<HistoricalLocalAttachmentBinding>,
}

#[cfg(test)]
mod compatibility_tests {
    use super::*;
    #[test]
    fn legacy_options_keep_the_same_serialization_and_empty_binding_identity() {
        let old = r#"{"model":null,"settingsTemplate":null,"studioWorkMode":"kcoder"}"#;
        let parsed: HistoricalContinuationOptions = serde_json::from_str(old).unwrap();
        assert!(parsed.local_attachments.is_empty());
        assert_eq!(serde_json::to_string(&parsed).unwrap(), old);
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum HistoricalContinuationStage {
    Planned,
    Preparing,
    Admitting,
    Publishing,
    Imported,
    Blocked,
    Cancelled,
    Failed,
    PublishUnknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoricalContinuationJob {
    pub job_id: String,
    pub source_job_id: String,
    pub view_id: String,
    pub policy: HistoricalContextPolicy,
    pub options: HistoricalContinuationOptions,
    pub sequence: u64,
    pub stage: HistoricalContinuationStage,
    pub thread_id: Option<String>,
    pub compilation: Option<HistoricalContextReport>,
    pub projection: Option<HistoricalModelProjectionReport>,
    pub processed_bytes: u64,
    pub failure_code: Option<String>,
    pub cancel_requested: bool,
    pub cancel_revision: u64,
}
