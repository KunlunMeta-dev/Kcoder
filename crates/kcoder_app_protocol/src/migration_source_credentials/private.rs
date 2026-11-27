//! Typed private-lane envelopes. None of these values supply authentication.
use super::{MigrationSourceCredentialConsent, MigrationSourceCredentialSelector};
use crate::{MigrationSourceAuthorityV1, MigrationSourceTransferControl};
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialDestinationV1 {
    pub authority: MigrationSourceAuthorityV1,
    pub grant_id: String,
    pub scope: String,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MigrationSourceCredentialPolicyV1 {
    Auto,
    File,
    Keyring,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MigrationSourceCredentialSelectionV1 {
    Provider {
        source_name: String,
        selector: MigrationSourceCredentialSelector,
        target_name: String,
        endpoint: String,
        api_format: String,
    },
    Mcp {
        source_name: String,
        fields: Vec<kcoder_types::migration::MigrationMcpPrivateField>,
        target_name: String,
        definition_sha256: String,
    },
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialContextV1 {
    pub version: u32,
    pub request_id: String,
    pub offer_id: String,
    pub source: MigrationSourceAuthorityV1,
    pub destination: MigrationSourceCredentialDestinationV1,
    pub manifest_sha256: String,
    pub entry_id: String,
    pub source_identity: String,
    pub source_binding_revision: String,
    pub target_profile_identity: String,
    pub target_policy: MigrationSourceCredentialPolicyV1,
    pub selections: Vec<MigrationSourceCredentialSelectionV1>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialOfferDataV1 {
    pub context: MigrationSourceCredentialContextV1,
    pub suite: String,
    pub public_key: String,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialEnvelopeV1 {
    pub version: u32,
    pub offer_id: String,
    pub offer_sha256: String,
    pub encapsulated_key: String,
    pub ciphertext: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialOfferParamsV1 {
    pub offer_id: String,
    pub manifest_sha256: String,
    pub entry_id: String,
    pub selections: Vec<MigrationSourceCredentialSelectionV1>,
    pub consent: MigrationSourceCredentialConsent,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialSealParamsV1 {
    pub offer: MigrationSourceCredentialOfferDataV1,
    pub consent: MigrationSourceCredentialConsent,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialAcceptParamsV1 {
    pub offer_id: String,
    pub envelope: MigrationSourceCredentialEnvelopeV1,
    pub consent: MigrationSourceCredentialConsent,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialReadParamsV1 {
    pub offer_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialCancelParamsV1 {
    pub offer_id: String,
    pub command_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialResumeParamsV1 {
    pub offer_id: String,
    pub expected_sequence: u64,
    pub cancel_watermark: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialPrepareParamsV1 {
    pub offer_id: String,
    pub job_id: String,
    pub expected_sequence: u64,
    pub consent: MigrationSourceCredentialConsent,
    #[serde(default, deserialize_with = "super::bundle::additional")]
    pub additional_offers: Option<Vec<String>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialReleaseParamsV1 {
    pub offer_id: String,
    pub job_id: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationSourceCredentialCustodyV1 {
    pub offer: MigrationSourceCredentialOfferDataV1,
    pub envelope: Option<MigrationSourceCredentialEnvelopeV1>,
    pub control: MigrationSourceTransferControl,
    pub writer_running: bool,
    pub received: bool,
    pub key_released: bool,
}
