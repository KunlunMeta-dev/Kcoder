//! Data on an authenticated Native-owned channel, never a transport or budget grant.
use super::IntegrationScope;
use crate::{
    TurnAttemptIdentity,
    integrations::office::{OfficeArtifactManifest, OfficeArtifactRef, OfficeFileFormat},
};
use serde::{Deserialize, Serialize};

pub const NATIVE_REMOTE_CONTROL_VERSION: u32 = 1;
pub const NATIVE_REMOTE_CONTROL_METHOD: &str = "kcoder/nativeRemote/controlV1";
pub const NATIVE_REMOTE_MAX_CHUNK_BYTES: u64 = 192 * 1024;
const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum NativeRemoteTargetPlatformV1 {
    Linux,
    Windows,
}

/// An explicit reference into the existing selected-target registry. A name,
/// platform, host-key string or observed row cannot construct its native owner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteTargetRefV1 {
    pub target_id: String,
    pub target_revision: String,
    pub target_platform: NativeRemoteTargetPlatformV1,
    pub expected_native_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteRelayTargetRefV1 {
    pub registration_id: String,
    pub registration_revision: String,
    pub target: NativeRemoteTargetRefV1,
}

/// A closed wire copy of an actual turn identity; it is never a TurnAttemptStore
/// capability. Cross-host process IDs have no representation in this contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteTurnIdentityV1 {
    pub thread_id: String,
    pub turn_id: String,
    pub attempt_id: String,
}
impl From<&TurnAttemptIdentity> for NativeRemoteTurnIdentityV1 {
    fn from(value: &TurnAttemptIdentity) -> Self {
        Self {
            thread_id: value.thread_id.clone(),
            turn_id: value.turn_id.clone(),
            attempt_id: value.attempt_id.clone(),
        }
    }
}
impl NativeRemoteTurnIdentityV1 {
    fn validate(&self) -> Result<(), &'static str> {
        for value in [&self.thread_id, &self.turn_id, &self.attempt_id] {
            id(value)?;
        }
        Ok(())
    }
}

/// This receipt is data emitted by the actual receiving Accepted producer.
/// Only the authenticated endpoint adapter may turn it into a State observation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteAcceptedFactsV1 {
    pub identity: NativeRemoteTurnIdentityV1,
    pub accepted_input_sha256: String,
    pub accepted_receipt_sha256: String,
    pub receiver_settings_sha256: String,
    /// Actual Receiver-owned scope observed on the held channel. This is
    /// provenance only and cannot authorize a Receiver operation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receiver_scope: Option<IntegrationScope>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteChargeDataV1 {
    pub tokens: u64,
    pub model_calls: u64,
    pub run_millis: u64,
    /// Canonical decimal u64 text survives a Gateway without JS number rounding.
    /// None means unknown, never free. Source still derives/checks its own bound.
    pub cost_micros: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum NativeRemoteCallOutcomeV1 {
    Completed,
    Failed,
    Interrupted,
    OutcomeUnknown,
}

/// No Debug: frozen prompts/material chunks may contain private user content.
/// A bridge must validate its held target/account/installation owner before
/// decoding this data and again before an effect; this type provides none of it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteControlFrameV1 {
    pub version: u32,
    pub operation_id: String,
    pub request_id: String,
    pub endpoint_revision: String,
    pub endpoint_instance_id: String,
    pub source_accepted_sha256: String,
    pub message: NativeRemoteControlDataV1,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "method",
    content = "params",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NativeRemoteControlDataV1 {
    BindOriginal(NativeRemoteBindOriginalV1),
    ReceiverAccepted(NativeRemoteAcceptedFactsV1),
    ReserveModel(NativeRemoteReserveModelV1),
    DispatchModel(NativeRemoteCallRefV1),
    ObserveModel(NativeRemoteCallRefV1),
    FinishModel(NativeRemoteFinishModelV1),
    OfferMaterial(NativeRemoteMaterialOfferV1),
    MaterialChunk(NativeRemoteMaterialChunkV1),
    FinishMaterial(NativeRemoteContentRefV1),
    ObserveMaterial(NativeRemoteContentRefV1),
    ReadArtifactManifest(NativeRemoteAcceptedFactsV1),
    ReadArtifactChunk(NativeRemoteArtifactChunkReadV1),
    CloseOriginal(NativeRemoteAcceptedFactsV1),
    ObserveOriginal,
    CancelOriginal { expected_revision: u64 },
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteBindOriginalV1 {
    pub source_scope: IntegrationScope,
    pub source_attempt: NativeRemoteTurnIdentityV1,
    pub frozen_input_sha256: String,
    pub deadline_utc_ms: u64,
    pub prompt: String,
    pub allowed_output_formats: Vec<OfficeFileFormat>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub materials: Vec<NativeRemoteMaterialOfferV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteReserveModelV1 {
    pub receiver_accepted: NativeRemoteAcceptedFactsV1,
    pub native_call_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub model_configuration_revision: String,
    pub conservative_bound: NativeRemoteChargeDataV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteCallRefV1 {
    pub receiver_accepted: NativeRemoteAcceptedFactsV1,
    pub native_call_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteFinishModelV1 {
    pub call: NativeRemoteCallRefV1,
    pub outcome: NativeRemoteCallOutcomeV1,
    /// Actual Native Provider accounting only. Absence retains the original bound.
    pub actual_usage: Option<NativeRemoteChargeDataV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteContentRefV1 {
    pub source: OfficeArtifactRef,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteMaterialOfferV1 {
    pub content: NativeRemoteContentRefV1,
    pub filename: String,
    pub media_type: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteMaterialChunkV1 {
    pub content: NativeRemoteContentRefV1,
    pub offset: u64,
    pub chunk_sha256: String,
    pub bytes_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteArtifactChunkReadV1 {
    pub receiver_accepted: NativeRemoteAcceptedFactsV1,
    pub artifact: OfficeArtifactRef,
    pub manifest_sha256: String,
    pub offset: u64,
    pub maximum_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum NativeRemoteReceiptStateV1 {
    Received,
    Rejected,
    OutcomeUnknown,
    Unavailable,
}

/// A known receipt settles only the named private control request. It does not
/// prove a model ran, a task completed, or an artifact passed business checks.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteControlReplyV1 {
    pub version: u32,
    pub operation_id: String,
    pub request_id: String,
    pub endpoint_revision: String,
    pub endpoint_instance_id: String,
    pub state: NativeRemoteReceiptStateV1,
    pub data: NativeRemoteReceiptDataV1,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NativeRemoteReceiptDataV1 {
    /// Private ACP binding receipt only; this is not Receiver Accepted or a budget grant.
    OriginalBound {
        frozen_input_sha256: String,
        receiver_settings_sha256: String,
    },
    Receiver {
        accepted: NativeRemoteAcceptedFactsV1,
        outcome: Option<NativeRemoteCallOutcomeV1>,
        cleanup_confirmed: bool,
    },
    /// Emitted only by the original ACP process owner after an actual owned wait.
    /// Root exit and complete descendant cleanup remain separate observations.
    OwnerClosed {
        accepted: NativeRemoteAcceptedFactsV1,
        outcome: Option<NativeRemoteCallOutcomeV1>,
        backend_exited: bool,
        owner_tree_cleanup_confirmed: bool,
    },
    ModelCall {
        call: NativeRemoteCallRefV1,
        dispatched: bool,
        finished: bool,
        charged: NativeRemoteChargeDataV1,
    },
    Material {
        content: NativeRemoteContentRefV1,
        next_offset: u64,
        complete: bool,
    },
    ArtifactManifest {
        manifest: Box<OfficeArtifactManifest>,
    },
    ArtifactChunk {
        reference: OfficeArtifactRef,
        manifest_sha256: String,
        offset: u64,
        total_bytes: u64,
        bytes_base64: String,
        eof: bool,
    },
    Diagnostic {
        code: String,
    },
}

impl NativeRemoteControlFrameV1 {
    /// Shape validation only; never use this as authentication or authorization.
    pub fn validate_shape(&self) -> Result<(), &'static str> {
        if self.version != NATIVE_REMOTE_CONTROL_VERSION {
            return Err("REMOTE_CONTROL_VERSION_UNSUPPORTED");
        }
        for value in [
            &self.operation_id,
            &self.request_id,
            &self.endpoint_revision,
            &self.endpoint_instance_id,
        ] {
            id(value)?;
        }
        sha(&self.source_accepted_sha256)?;
        match &self.message {
            NativeRemoteControlDataV1::BindOriginal(value) => {
                value
                    .source_scope
                    .validate()
                    .map_err(|_| "REMOTE_CONTROL_SCOPE_INVALID")?;
                value.source_attempt.validate()?;
                sha(&value.frozen_input_sha256)?;
                if value.materials.len() > 8 {
                    return Err("REMOTE_CONTROL_MATERIAL_LIMIT");
                }
                let mut sources = std::collections::BTreeSet::new();
                let mut total = 0u64;
                for offer in &value.materials {
                    material_offer(offer)?;
                    if offer.content.source.revision != 1
                        || !sources.insert(offer.content.source.id.clone())
                    {
                        return Err("REMOTE_CONTROL_MATERIAL_IDENTITY_INVALID");
                    }
                    total = total
                        .checked_add(offer.content.bytes)
                        .ok_or("REMOTE_CONTROL_MATERIAL_LIMIT")?;
                }
                if total > 32 * 1024 * 1024 {
                    return Err("REMOTE_CONTROL_MATERIAL_LIMIT");
                }
                if value.deadline_utc_ms == 0
                    || value.deadline_utc_ms > MAX_SAFE_JSON_INTEGER
                    || value.prompt.is_empty()
                    || value.prompt.len() > 64 * 1024
                    || value.allowed_output_formats.len() > 6
                {
                    return Err("REMOTE_CONTROL_BIND_INVALID");
                }
            }
            NativeRemoteControlDataV1::ReceiverAccepted(value)
            | NativeRemoteControlDataV1::ReadArtifactManifest(value)
            | NativeRemoteControlDataV1::CloseOriginal(value) => accepted(value)?,
            NativeRemoteControlDataV1::ReserveModel(value) => {
                accepted(&value.receiver_accepted)?;
                id(&value.native_call_id)?;
                id(&value.provider_id)?;
                id(&value.model_id)?;
                id(&value.model_configuration_revision)?;
                charge(&value.conservative_bound)?;
                if value.conservative_bound.tokens == 0
                    || value.conservative_bound.model_calls != 1
                    || value.conservative_bound.run_millis == 0
                {
                    return Err("REMOTE_CONTROL_MODEL_BOUND_INVALID");
                }
            }
            NativeRemoteControlDataV1::DispatchModel(value)
            | NativeRemoteControlDataV1::ObserveModel(value) => call(value)?,
            NativeRemoteControlDataV1::FinishModel(value) => {
                call(&value.call)?;
                if let Some(usage) = &value.actual_usage {
                    charge(usage)?;
                }
            }
            NativeRemoteControlDataV1::OfferMaterial(value) => {
                material_offer(value)?;
            }
            NativeRemoteControlDataV1::MaterialChunk(value) => {
                content(&value.content)?;
                sha(&value.chunk_sha256)?;
                if value.offset > value.content.bytes
                    || value.bytes_base64.is_empty()
                    || value.bytes_base64.len() > 256 * 1024
                {
                    return Err("REMOTE_CONTROL_CHUNK_INVALID");
                }
            }
            NativeRemoteControlDataV1::FinishMaterial(value)
            | NativeRemoteControlDataV1::ObserveMaterial(value) => content(value)?,
            NativeRemoteControlDataV1::ReadArtifactChunk(value) => {
                accepted(&value.receiver_accepted)?;
                artifact(&value.artifact)?;
                sha(&value.manifest_sha256)?;
                if value.maximum_bytes == 0
                    || value.maximum_bytes > NATIVE_REMOTE_MAX_CHUNK_BYTES
                    || value.offset > 32 * 1024 * 1024
                {
                    return Err("REMOTE_CONTROL_CHUNK_INVALID");
                }
            }
            NativeRemoteControlDataV1::CancelOriginal { expected_revision } => {
                if *expected_revision > MAX_SAFE_JSON_INTEGER {
                    return Err("REMOTE_CONTROL_REVISION_INVALID");
                }
            }
            NativeRemoteControlDataV1::ObserveOriginal => {}
        }
        Ok(())
    }
}
fn id(value: &str) -> Result<(), &'static str> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        Err("REMOTE_CONTROL_ID_INVALID")
    } else {
        Ok(())
    }
}
fn sha(value: &str) -> Result<(), &'static str> {
    if value.len() != 64 || !value.bytes().all(|ch| ch.is_ascii_hexdigit()) {
        Err("REMOTE_CONTROL_SHA_INVALID")
    } else {
        Ok(())
    }
}
fn artifact(value: &OfficeArtifactRef) -> Result<(), &'static str> {
    id(&value.id)?;
    if value.revision == 0 {
        Err("REMOTE_CONTROL_REVISION_INVALID")
    } else {
        Ok(())
    }
}
fn content(value: &NativeRemoteContentRefV1) -> Result<(), &'static str> {
    artifact(&value.source)?;
    sha(&value.sha256)?;
    if value.bytes > 32 * 1024 * 1024 {
        Err("REMOTE_CONTROL_MATERIAL_LIMIT")
    } else {
        Ok(())
    }
}
fn material_offer(value: &NativeRemoteMaterialOfferV1) -> Result<(), &'static str> {
    content(&value.content)?;
    if value.filename.is_empty()
        || value.filename.len() > 1024
        || value.filename.chars().any(char::is_control)
        || value.media_type.is_empty()
        || value.media_type.len() > 256
    {
        return Err("REMOTE_CONTROL_MATERIAL_INVALID");
    }
    Ok(())
}
fn accepted(value: &NativeRemoteAcceptedFactsV1) -> Result<(), &'static str> {
    if let Some(scope) = &value.receiver_scope {
        scope
            .validate()
            .map_err(|_| "REMOTE_RECEIVER_SCOPE_INVALID")?;
    }
    value.identity.validate()?;
    sha(&value.accepted_input_sha256)?;
    sha(&value.accepted_receipt_sha256)?;
    sha(&value.receiver_settings_sha256)
}
fn call(value: &NativeRemoteCallRefV1) -> Result<(), &'static str> {
    accepted(&value.receiver_accepted)?;
    id(&value.native_call_id)
}
fn charge(value: &NativeRemoteChargeDataV1) -> Result<(), &'static str> {
    if value.tokens > 1_000_000 || value.model_calls > 1 || value.run_millis > 1_800_000 {
        return Err("REMOTE_CONTROL_CHARGE_INVALID");
    }
    if let Some(cost) = &value.cost_micros
        && (cost.is_empty()
            || (cost.len() > 1 && cost.starts_with('0'))
            || !cost.bytes().all(|ch| ch.is_ascii_digit())
            || cost.parse::<u64>().is_err())
    {
        return Err("REMOTE_CONTROL_COST_INVALID");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn frame() -> NativeRemoteControlFrameV1 {
        serde_json::from_value(json!({"version":1,"operationId":"original-operation","requestId":"original-request","endpointRevision":"actual-target-revision","endpointInstanceId":"actual-owned-connection-generation","sourceAcceptedSha256":"a".repeat(64),"message":{"method":"observe_original"}})).unwrap()
    }
    #[test]
    fn frozen_materials_keep_legacy_empty_shape_and_enforce_total_and_revision_identity() {
        let mut value = serde_json::to_value(frame()).unwrap();
        value["message"] = json!({"method":"bind_original","params":{
            "sourceScope":{"accountId":"actual-account","targetId":"actual-target","workspaceId":"actual-workspace",
                "identityGeneration":"actual-generation","targetRevision":"actual-revision"},
            "sourceAttempt":{"threadId":"original-thread","turnId":"original-turn","attemptId":"original-attempt"},
            "frozenInputSha256":"a".repeat(64),"deadlineUtcMs":1000,"prompt":"frozen input","allowedOutputFormats":[]}});
        let original: NativeRemoteControlFrameV1 = serde_json::from_value(value.clone()).unwrap();
        original.validate_shape().unwrap();
        assert!(
            serde_json::to_value(&original).unwrap()["message"]["params"]
                .get("materials")
                .is_none()
        );
        let offer = json!({"content":{"source":{"id":"owned-input","revision":1},"bytes":20*1024*1024,"sha256":"b".repeat(64)},"filename":"owned.txt","mediaType":"text/plain"});
        value["message"]["params"]["materials"] = json!([offer.clone()]);
        serde_json::from_value::<NativeRemoteControlFrameV1>(value.clone())
            .unwrap()
            .validate_shape()
            .unwrap();
        value["message"]["params"]["materials"] = json!([offer.clone(), offer.clone()]);
        assert!(
            serde_json::from_value::<NativeRemoteControlFrameV1>(value.clone())
                .unwrap()
                .validate_shape()
                .is_err()
        );
        value["message"]["params"]["materials"][1]["content"]["source"]["id"] =
            json!("second-owned-input");
        assert_eq!(
            serde_json::from_value::<NativeRemoteControlFrameV1>(value.clone())
                .unwrap()
                .validate_shape(),
            Err("REMOTE_CONTROL_MATERIAL_LIMIT")
        );
        value["message"]["params"]["materials"] = json!([offer]);
        value["message"]["params"]["materials"][0]["content"]["source"]["revision"] = json!(2);
        assert!(
            serde_json::from_value::<NativeRemoteControlFrameV1>(value)
                .unwrap()
                .validate_shape()
                .is_err()
        );
    }
    #[test]
    fn unknown_grants_credentials_and_cross_host_pid_fields_are_rejected() {
        for field in [
            "approved",
            "authority",
            "sourcePid",
            "receiverPid",
            "credential",
            "privateKey",
            "sourceProfilePath",
        ] {
            let mut data = serde_json::to_value(frame()).unwrap();
            data[field] = json!(true);
            assert!(serde_json::from_value::<NativeRemoteControlFrameV1>(data).is_err());
        }
    }
    #[test]
    fn unknown_version_and_missing_original_identity_never_validate() {
        let mut value = frame();
        value.validate_shape().unwrap();
        value.version = 2;
        assert!(value.validate_shape().is_err());
        value.version = 1;
        value.operation_id.clear();
        assert!(value.validate_shape().is_err());
    }
    #[test]
    fn private_receipt_identity_rejects_nested_pid_or_grant_fields() {
        let identity =
            json!({"threadId":"actual-thread","turnId":"actual-turn","attemptId":"actual-attempt"});
        for field in ["receiverPid", "approved", "sourceProfilePath"] {
            let mut changed = identity.clone();
            changed[field] = json!(true);
            assert!(serde_json::from_value::<NativeRemoteTurnIdentityV1>(changed).is_err());
        }
        let mut value = frame();
        value.endpoint_instance_id.clear();
        assert!(value.validate_shape().is_err());
    }
    #[test]
    fn legacy_accepted_observations_keep_their_original_shape_without_a_receiver_scope() {
        let value = json!({"identity":{"threadId":"actual-thread","turnId":"actual-turn","attemptId":"actual-attempt"},
            "acceptedInputSha256":"a".repeat(64),"acceptedReceiptSha256":"b".repeat(64),"receiverSettingsSha256":"c".repeat(64)});
        let facts: NativeRemoteAcceptedFactsV1 = serde_json::from_value(value.clone()).unwrap();
        assert!(facts.receiver_scope.is_none());
        accepted(&facts).unwrap();
        assert_eq!(serde_json::to_value(facts).unwrap(), value);
    }
    #[test]
    fn original_bound_receipt_is_correlated_data_without_receiver_or_budget_authority() {
        let receipt = NativeRemoteReceiptDataV1::OriginalBound {
            frozen_input_sha256: "a".repeat(64),
            receiver_settings_sha256: "b".repeat(64),
        };
        let mut value = serde_json::to_value(receipt).unwrap();
        assert_eq!(value["kind"], "original_bound");
        assert_eq!(value["frozenInputSha256"], "a".repeat(64));
        assert_eq!(value["receiverSettingsSha256"], "b".repeat(64));
        assert!(serde_json::from_value::<NativeRemoteReceiptDataV1>(value.clone()).is_ok());
        for field in [
            "approved",
            "receiverAccepted",
            "budgetGrant",
            "sourceProfilePath",
        ] {
            value[field] = json!(true);
            assert!(serde_json::from_value::<NativeRemoteReceiptDataV1>(value.clone()).is_err());
            value.as_object_mut().unwrap().remove(field);
        }
    }
    #[test]
    fn selected_ssh_target_requires_explicit_platform_and_native_pin_data() {
        let mut value = json!({"targetId":"explicit-target","targetRevision":"current-revision","expectedNativeSha256":"a".repeat(64)});
        assert!(serde_json::from_value::<NativeRemoteTargetRefV1>(value.clone()).is_err());
        value["targetPlatform"] = json!("windows");
        let target: NativeRemoteTargetRefV1 = serde_json::from_value(value).unwrap();
        assert_eq!(
            target.target_platform,
            NativeRemoteTargetPlatformV1::Windows
        );
    }
    #[test]
    fn private_model_cost_preserves_u64_exactly_and_unknown_is_not_zero() {
        let value = NativeRemoteChargeDataV1 {
            tokens: 5,
            model_calls: 1,
            run_millis: 1,
            cost_micros: Some(u64::MAX.to_string()),
        };
        charge(&value).unwrap();
        let json = serde_json::to_string(&value).unwrap();
        assert!(json.contains("\"18446744073709551615\""));
        for value in ["01", "-1", "18446744073709551616"] {
            assert!(
                charge(&NativeRemoteChargeDataV1 {
                    cost_micros: Some(value.into()),
                    ..DefaultCharge::value()
                })
                .is_err()
            );
        }
        let mut unknown = DefaultCharge::value();
        assert_eq!(unknown.cost_micros, None);
        unknown.cost_micros = Some("0".into());
        assert_ne!(
            serde_json::to_value(DefaultCharge::value()).unwrap(),
            serde_json::to_value(unknown).unwrap()
        );
    }
    struct DefaultCharge;
    impl DefaultCharge {
        fn value() -> NativeRemoteChargeDataV1 {
            NativeRemoteChargeDataV1 {
                tokens: 5,
                model_calls: 1,
                run_millis: 1,
                cost_micros: None,
            }
        }
    }
}

/// Locators on a current authenticated management channel. They grant no
/// execution, model reservation, namespace creation or caller authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteOriginalReadV1 {
    pub version: u32,
    pub request_id: String,
    pub operation_id: String,
    pub endpoint_instance_id: String,
    pub source_scope: IntegrationScope,
    pub receiver_accepted: NativeRemoteAcceptedFactsV1,
}
impl NativeRemoteOriginalReadV1 {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != NATIVE_REMOTE_CONTROL_VERSION {
            return Err("REMOTE_ORIGINAL_READ_VERSION_REQUIRED");
        }
        id(&self.request_id)?;
        id(&self.operation_id)?;
        id(&self.endpoint_instance_id)?;
        self.source_scope
            .validate()
            .map_err(|_| "REMOTE_ORIGINAL_READ_SCOPE_INVALID")?;
        self.receiver_accepted.identity.validate()?;
        for value in [
            &self.receiver_accepted.accepted_input_sha256,
            &self.receiver_accepted.accepted_receipt_sha256,
            &self.receiver_accepted.receiver_settings_sha256,
        ] {
            sha(value)?;
        }
        self.receiver_accepted
            .receiver_scope
            .as_ref()
            .ok_or("REMOTE_ORIGINAL_READ_SCOPE_REQUIRED")?
            .validate()
            .map_err(|_| "REMOTE_ORIGINAL_READ_SCOPE_INVALID")?;
        Ok(())
    }
}

/// Only canonical original TurnAttempt facts are returned. Missing usage and
/// cleanup evidence remain unknown; a terminal receipt cannot refund charges.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteOriginalReadReplyV1 {
    pub original: NativeRemoteOriginalReadV1,
    pub outcome: Option<NativeRemoteCallOutcomeV1>,
    pub finished_at_ms: Option<u64>,
}

#[cfg(test)]
mod original_read_tests {
    use super::*;
    use serde_json::json;

    fn request() -> serde_json::Value {
        let scope = json!({"accountId":"native-account","targetId":"native-target","workspaceId":"native-workspace",
            "identityGeneration":"original-generation","targetRevision":"a".repeat(64)});
        json!({"version":1,"requestId":"current-read","operationId":"original-operation",
            "endpointInstanceId":"original-endpoint","sourceScope":scope,
            "receiverAccepted":{"identity":{"threadId":"original-thread","turnId":"original-turn","attemptId":"original-attempt"},
                "acceptedInputSha256":"b".repeat(64),"acceptedReceiptSha256":"c".repeat(64),
                "receiverSettingsSha256":"a".repeat(64),"receiverScope":scope}})
    }

    #[test]
    fn original_read_locators_reject_execution_authority_and_missing_receiver_owner() {
        let value = request();
        serde_json::from_value::<NativeRemoteOriginalReadV1>(value.clone())
            .unwrap()
            .validate()
            .unwrap();
        for field in [
            "command",
            "profileDirectory",
            "reserveModel",
            "invoke",
            "authority",
            "pid",
        ] {
            let mut invalid = value.clone();
            invalid[field] = json!("not-a-read-capability");
            assert!(serde_json::from_value::<NativeRemoteOriginalReadV1>(invalid).is_err());
        }
        let mut no_owner = value;
        no_owner["receiverAccepted"]
            .as_object_mut()
            .unwrap()
            .remove("receiverScope");
        assert!(
            serde_json::from_value::<NativeRemoteOriginalReadV1>(no_owner)
                .unwrap()
                .validate()
                .is_err()
        );
    }

    #[test]
    fn original_read_preserves_exact_accepted_hash_and_refuses_unknown_versions_or_malformed_identity()
     {
        let value = request();
        let actual: NativeRemoteOriginalReadV1 = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(actual).unwrap(), value);
        for (path, replacement) in [("version", json!(2)), ("operationId", json!(""))] {
            let mut invalid = value.clone();
            invalid[path] = replacement;
            assert!(
                serde_json::from_value::<NativeRemoteOriginalReadV1>(invalid)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
        let mut invalid = value;
        invalid["receiverAccepted"]["acceptedReceiptSha256"] = json!("not-a-canonical-hash");
        assert!(
            serde_json::from_value::<NativeRemoteOriginalReadV1>(invalid)
                .unwrap()
                .validate()
                .is_err()
        );
    }
}
