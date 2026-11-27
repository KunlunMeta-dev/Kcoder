//! Source observation is separate from target custody and grants no execution authority.
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialSourceReadParams {
    pub locator: super::MigrationSourceCredentialLocator,
    pub source: crate::MigrationSourceSessionParams,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialObserveParamsV1 {
    pub request_id: String,
    pub offer_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationSourceCredentialSourceObservationV1 {
    pub control: crate::MigrationSourceTransferControl,
    pub writer_running: bool,
}
