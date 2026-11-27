//! Private authenticated-parent transfer lane. These declarations confer no authority.
use crate::{RequestId, RetentionPrincipalV1, retention_parent::UniqueValue};
use serde::{Deserialize, Serialize, de::Error};
use serde_json::Value;

pub const MIGRATION_SOURCE_INTERNAL_PREFIX: &str = "migration/sourceTransfer/internal/";
pub const MIGRATION_SOURCE_INTERNAL_CAPABILITY: &str = "migrationSourceTransferInternalV1";
pub const MIGRATION_SOURCE_PARENT_LAUNCH_CAPABILITY: &str = "migrationSourceTransferParentLaunchV1";
pub const MIGRATION_SOURCE_TARGET_RECOVERY_CAPABILITY: &str =
    "migrationSourceTransferTargetRecoveryV1";
pub const PRIVATE_MIGRATION_SOURCE_FIELD: &str = "kcoderPrivateMigrationSource";
pub const MIGRATION_SOURCE_ATTEMPT_CAPABILITY: &str = "migrationSourceTransferAttemptsV1";
pub const MIGRATION_SOURCE_ASSET_IDENTITY_CAPABILITY: &str =
    "migrationSourceTransferAssetIdentityV1";
pub const MIGRATION_SOURCE_UPLOADED_CAPABILITY: &str = "migrationSourceTransferUploadedV1";
pub const MIGRATION_SOURCE_DEFINITIONS_CAPABILITY: &str = "migrationSourceTransferDefinitionsV1";
pub const MIGRATION_SOURCE_PROJECTS_CAPABILITY: &str = "migrationSourceTransferProjectsV1";
pub const MIGRATION_SOURCE_MEMORY_CAPABILITY: &str = "migrationSourceTransferMemoryV1";
pub const MIGRATION_SOURCE_ADOPTION_CAPABILITY: &str = "migrationSourceTransferAdoptionV1";
pub const MIGRATION_SOURCE_FRAME_LIMIT: usize = 2 * 1024 * 1024;

pub fn migration_source_internal_operation(method: &str) -> Option<&str> {
    let operation = method.strip_prefix(MIGRATION_SOURCE_INTERNAL_PREFIX)?;
    matches!(
        operation,
        "identity"
            | "peer/accept"
            | "peer/recover-target"
            | "source/prepare"
            | "source/capture"
            | "source/manifest"
            | "source/chunk"
            | "source/state"
            | "source/intent"
            | "source/cancel"
            | "source/resume"
            | "target/grant"
            | "target/begin"
            | "target/part/read"
            | "target/part/write"
            | "target/finish"
            | "target/receipt"
            | "target/state"
            | "target/summary"
            | "target/cancel"
            | "target/resume"
            | "target/attempt/read"
            | "target/attempt/claim"
            | "target/attempt/release"
            | "target/received/read"
            | "target/adoption/prepare"
            | "target/adoption/read"
            | "target/adoption/resume"
            | "target/adoption/cancel"
            | "source/private/seal"
            | "source/private/read"
            | "source/private/observe"
            | "source/private/cancel"
            | "source/private/resume"
            | "target/private/candidates"
            | "target/private/offer"
            | "target/private/read"
            | "target/private/accept"
            | "target/private/cancel"
            | "target/private/resume"
            | "target/private/prepare-status"
            | "target/private/prepare"
            | "target/private/release"
    )
    .then_some(operation)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MigrationSourceRoleV1 {
    Source,
    Target,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceAuthorityV1 {
    pub instance_id: String,
    pub account_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceEndpointV1 {
    pub authority: MigrationSourceAuthorityV1,
    pub target_fingerprint: String,
    pub principal: RetentionPrincipalV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateMigrationSourceProofV1 {
    pub version: u8,
    pub request_id: String,
    pub source: MigrationSourceEndpointV1,
    pub target: MigrationSourceEndpointV1,
}
impl PrivateMigrationSourceProofV1 {
    pub fn valid(&self) -> bool {
        self.version == 1
            && canonical_transfer_uuid(&self.request_id)
            && self.source.valid()
            && self.target.valid()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MigrationSourceSelectionV1 {
    Projects {
        #[serde(rename = "catalogId")]
        catalog_id: String,
        #[serde(rename = "sourceHandle")]
        source_handle: String,
    },
    Instructions {
        #[serde(
            rename = "captureId",
            deserialize_with = "super::migration_source_session::session_identity"
        )]
        #[cfg_attr(
            feature = "json-schema",
            schemars(regex(
                pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            ))
        )]
        capture_id: String,
    },
    Plugin {
        #[serde(rename = "candidateId")]
        candidate_id: String,
    },
    Configuration {
        #[serde(rename = "sourceId")]
        source_id: String,
    },
    Assets {
        #[serde(rename = "sourceId")]
        source_id: String,
    },
    History {
        #[serde(rename = "catalogId")]
        catalog_id: String,
        #[serde(rename = "sourceHandle")]
        source_handle: String,
    },
}
impl MigrationSourceSelectionV1 {
    pub fn valid(&self) -> bool {
        match self {
            Self::Instructions { capture_id } => crate::canonical_transfer_uuid(capture_id),
            Self::Projects {
                catalog_id,
                source_handle,
            } => atom(catalog_id) && atom(source_handle),
            Self::Plugin { candidate_id } => atom(candidate_id),
            Self::Configuration { source_id } | Self::Assets { source_id } => atom(source_id),
            Self::History {
                catalog_id,
                source_handle,
            } => atom(catalog_id) && atom(source_handle),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourcePeerAcceptV1 {
    pub request_id: String,
    pub role: MigrationSourceRoleV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceTargetRecoverV1 {
    pub request_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MigrationSourceAttemptKindV1 {
    Run,
    Finish,
    TargetResume,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceAttemptClaimV1 {
    pub attempt_id: String,
    pub kind: MigrationSourceAttemptKindV1,
    pub call_digest: String,
    pub selection_digest: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceAttemptReadV1 {
    pub attempt_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceAttemptReleaseV1 {
    pub attempt_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceReceivedReadV1 {
    #[serde(default, skip_serializing_if = "is_false")]
    pub include_projects: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub include_instructions: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub include_plugins: bool,
    pub manifest_sha256: String,
    pub page_index: u32,
}
fn is_false(value: &bool) -> bool {
    !*value
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceAdoptionPrepareV1 {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub instruction_mappings: Vec<crate::MigrationSourceInstructionMapping>,
    pub adoption_id: String,
    pub manifest_sha256: String,
    pub selections: Vec<crate::MigrationSourceAdoptionSelection>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceAdoptionReadV1 {
    pub adoption_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceAdoptionResumeV1 {
    pub adoption_id: String,
    pub expected_control: crate::MigrationSourceAdoptionControl,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceAdoptionCancelV1 {
    pub adoption_id: String,
    pub command_id: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateMigrationSourceRequestV1 {
    pub jsonrpc: String,
    pub id: RequestId,
    pub method: String,
    pub params: Value,
    #[serde(
        default,
        rename = "kcoderPrivateMigrationSource",
        skip_serializing_if = "Option::is_none"
    )]
    pub private_source: Option<PrivateMigrationSourceProofV1>,
}

/// Decode the original frame before routing; JSON.parse-style projection loses duplicate keys.
pub fn decode_private_migration_source_request(
    raw: &str,
) -> Result<PrivateMigrationSourceRequestV1, serde_json::Error> {
    let reject = || serde_json::Error::custom("invalid private migration source request");
    if raw.len() > MIGRATION_SOURCE_FRAME_LIMIT {
        return Err(reject());
    }
    let unique = serde_json::from_str::<UniqueValue>(raw)?.0;
    let request: PrivateMigrationSourceRequestV1 = serde_json::from_value(unique)?;
    if request.jsonrpc != "2.0" || !request.params.is_object() {
        return Err(reject());
    }
    let operation = migration_source_internal_operation(&request.method).ok_or_else(reject)?;
    if operation == "peer/accept" {
        let params: MigrationSourcePeerAcceptV1 = serde_json::from_value(request.params.clone())?;
        let proof = request.private_source.as_ref().ok_or_else(reject)?;
        if !proof.valid() || proof.request_id != params.request_id {
            return Err(reject());
        }
    } else if request.private_source.is_some() {
        return Err(reject());
    }
    if operation == "peer/recover-target" {
        let params: MigrationSourceTargetRecoverV1 =
            serde_json::from_value(request.params.clone())?;
        if !canonical_transfer_uuid(&params.request_id) {
            return Err(reject());
        }
    }
    Ok(request)
}

impl MigrationSourceEndpointV1 {
    fn valid(&self) -> bool {
        canonical_transfer_uuid(&self.authority.instance_id)
            && self.authority.account_id.len() == 64
            && self
                .authority
                .account_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            && atom(&self.target_fingerprint)
            && match &self.principal {
                RetentionPrincipalV1::LocalOs => true,
                RetentionPrincipalV1::VerifiedAccount { principal_id } => atom(principal_id),
            }
    }
}
pub fn canonical_transfer_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}
fn atom(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn frame() -> Value {
        let id = "01234567-89ab-cdef-0123-456789abcdef";
        let endpoint = json!({"authority":{"instanceId":id,"accountId":"a".repeat(64)},"targetFingerprint":"owned-target","principal":{"kind":"localOs"}});
        json!({"jsonrpc":"2.0","id":1,"method":format!("{MIGRATION_SOURCE_INTERNAL_PREFIX}peer/accept"),
            "params":{"requestId":id,"role":"target"},
            "kcoderPrivateMigrationSource":{"version":1,"requestId":id,"source":endpoint,"target":endpoint}})
    }
    #[test]
    fn private_peer_context_is_unique_bounded_and_correlated() {
        let frame = frame();
        assert!(decode_private_migration_source_request(&frame.to_string()).is_ok());
        for duplicate in [
            "\"requestId\":\"forged\",\"requestId\":",
            "\"requestId\":\"forged\",\"request\\u0049d\":",
        ] {
            let raw = frame.to_string().replacen("\"requestId\":", duplicate, 1);
            assert!(decode_private_migration_source_request(&raw).is_err());
        }
        let mut wrong = frame.clone();
        wrong["params"]["requestId"] = json!("11234567-89ab-cdef-0123-456789abcdef");
        assert!(decode_private_migration_source_request(&wrong.to_string()).is_err());
        let mut extra = frame.clone();
        extra["params"]["path"] = json!("untrusted-path");
        assert!(decode_private_migration_source_request(&extra.to_string()).is_err());
        let mut notification = frame;
        notification.as_object_mut().unwrap().remove("id");
        assert!(decode_private_migration_source_request(&notification.to_string()).is_err());
    }
    #[test]
    fn private_proof_cannot_be_reused_on_another_internal_operation() {
        let mut frame = frame();
        frame["method"] = json!(format!("{MIGRATION_SOURCE_INTERNAL_PREFIX}source/state"));
        assert!(decode_private_migration_source_request(&frame.to_string()).is_err());
        frame
            .as_object_mut()
            .unwrap()
            .remove(PRIVATE_MIGRATION_SOURCE_FIELD);
        assert!(decode_private_migration_source_request(&frame.to_string()).is_ok());
        frame["method"] = json!(format!("{MIGRATION_SOURCE_INTERNAL_PREFIX}arbitrary"));
        assert!(decode_private_migration_source_request(&frame.to_string()).is_err());
    }
    #[test]
    fn target_recovery_accepts_only_a_fixed_request_without_caller_authorities_or_proof() {
        let request = "01234567-89ab-cdef-0123-456789abcdef";
        let mut value = json!({"jsonrpc":"2.0","id":7,
            "method":format!("{MIGRATION_SOURCE_INTERNAL_PREFIX}peer/recover-target"),
            "params":{"requestId":request}});
        assert!(decode_private_migration_source_request(&value.to_string()).is_ok());
        for field in [
            "source",
            "sourceAuthority",
            "targetAuthority",
            "role",
            "path",
            "peerRef",
        ] {
            let mut invalid = value.clone();
            invalid["params"][field] = json!("caller-controlled");
            assert!(decode_private_migration_source_request(&invalid.to_string()).is_err());
        }
        value[PRIVATE_MIGRATION_SOURCE_FIELD] = frame()[PRIVATE_MIGRATION_SOURCE_FIELD].clone();
        assert!(decode_private_migration_source_request(&value.to_string()).is_err());
    }
}
