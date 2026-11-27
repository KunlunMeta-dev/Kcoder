//! Draft SSH peer facts. A decoded enrollment, key or signature grants no access.
use serde::{Deserialize, Serialize};

pub const PEER_SSH_ENROLLMENT_PURPOSE: &str = "kcoder.peer-message.ssh-enrollment.v1";
pub const PEER_SSH_CHALLENGE_PURPOSE: &str = "kcoder.peer-message.ssh-challenge.v1";
pub const PEER_SSH_NATIVE_FACT_DOMAIN: &[u8] = b"kcoder.peer-message.ssh-native-fact.v1\0";
pub const PEER_SSH_GATEWAY_FACT_DOMAIN: &[u8] = b"kcoder.peer-message.ssh-gateway-fact.v1\0";
pub const PEER_SSH_MAX_GENERATION: u64 = 9_007_199_254_740_991;
pub const PEER_SSH_AUTH_PREFIX: &str = "peerSsh/auth/";
pub const PEER_SSH_AUTH_OFFER: &str = "peerSsh/auth/offerV1";
pub const PEER_SSH_AUTH_NATIVE_PROOF: &str = "peerSsh/auth/nativeProofV1";
pub const PEER_SSH_AUTH_COMPLETE: &str = "peerSsh/auth/completeV1";
pub const PEER_SSH_AUTH_MAX_BYTES: usize = 16 * 1024;

/// Exact identity text, without normalization or filesystem interpretation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct PeerSshIdentityTextV1(String);
impl TryFrom<String> for PeerSshIdentityTextV1 {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.is_empty() || value.chars().count() > 256 || value.chars().any(char::is_control) {
            return Err("peer_ssh_invalid_identity_text");
        }
        Ok(Self(value))
    }
}
impl From<PeerSshIdentityTextV1> for String {
    fn from(value: PeerSshIdentityTextV1) -> Self {
        value.0
    }
}
impl PeerSshIdentityTextV1 {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A 256-bit nonce or digest; fresh nonce generation belongs to the host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct PeerSshNonceV1(String);
impl TryFrom<String> for PeerSshNonceV1 {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if !super::ssh_parent::valid_nonce(&value) {
            return Err("peer_ssh_invalid_nonce");
        }
        Ok(Self(value))
    }
}
impl From<PeerSshNonceV1> for String {
    fn from(value: PeerSshNonceV1) -> Self {
        value.0
    }
}
impl PeerSshNonceV1 {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Vec<u8>", into = "Vec<u8>")]
pub struct PeerSshSignatureV1(Vec<u8>);
impl TryFrom<Vec<u8>> for PeerSshSignatureV1 {
    type Error = &'static str;
    fn try_from(value: Vec<u8>) -> Result<Self, Self::Error> {
        if value.len() != 64 {
            return Err("peer_ssh_invalid_signature_length");
        }
        Ok(Self(value))
    }
}
impl From<PeerSshSignatureV1> for Vec<u8> {
    fn from(value: PeerSshSignatureV1) -> Self {
        value.0
    }
}
impl PeerSshSignatureV1 {
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum PeerSshEnrollmentPurposeV1 {
    #[serde(rename = "kcoder.peer-message.ssh-enrollment.v1")]
    Enrollment,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum PeerSshChallengePurposeV1 {
    #[serde(rename = "kcoder.peer-message.ssh-challenge.v1")]
    Challenge,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSshGatewayKeyV1 {
    pub gateway_id: PeerSshIdentityTextV1,
    pub public_key: [u8; 32],
    #[serde(deserialize_with = "generation")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(range(min = 1, max = 9_007_199_254_740_991u64))
    )]
    pub key_generation: u64,
}

/// Comparison data for one target. The host must separately prove its transport.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSshTargetBindingV1 {
    pub target_id: PeerSshIdentityTextV1,
    pub target_revision: PeerSshNonceV1,
    pub account_generation: PeerSshIdentityTextV1,
    pub ssh_host_key: PeerSshIdentityTextV1,
    pub ssh_user: PeerSshIdentityTextV1,
}

/// Physical Native profile/workspace observations, distinct from Gateway labels.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSshNativeProfileV1 {
    pub account_uid: u32,
    pub profile_identity: PeerSshIdentityTextV1,
    pub target_id: PeerSshIdentityTextV1,
    pub workspace_id: PeerSshIdentityTextV1,
    pub identity_epoch: PeerSshIdentityTextV1,
    pub public_key: [u8; 32],
}

/// Expected pin data only. Deserializing this record does not enroll either peer.
/// A future controlled transaction must establish, persist and revoke these pins.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSshEnrollmentV1 {
    #[serde(deserialize_with = "version_one")]
    #[cfg_attr(feature = "json-schema", schemars(range(min = 1, max = 1)))]
    pub version: u8,
    pub purpose: PeerSshEnrollmentPurposeV1,
    pub enrollment_id: PeerSshIdentityTextV1,
    #[serde(deserialize_with = "generation")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(range(min = 1, max = 9_007_199_254_740_991u64))
    )]
    pub generation: u64,
    pub gateway: PeerSshGatewayKeyV1,
    pub target: PeerSshTargetBindingV1,
    pub native: PeerSshNativeProfileV1,
}
impl PeerSshEnrollmentV1 {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1
            || !valid_generation(self.generation)
            || !valid_generation(self.gateway.key_generation)
        {
            return Err("peer_ssh_invalid_enrollment");
        }
        Ok(())
    }
}

/// A challenge offer has no execution or route authority, even with valid pins.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSshChallengeOfferV1 {
    #[serde(deserialize_with = "version_one")]
    #[cfg_attr(feature = "json-schema", schemars(range(min = 1, max = 1)))]
    pub version: u8,
    pub purpose: PeerSshChallengePurposeV1,
    pub enrollment_id: PeerSshIdentityTextV1,
    #[serde(deserialize_with = "generation")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(range(min = 1, max = 9_007_199_254_740_991u64))
    )]
    pub enrollment_generation: u64,
    pub native_nonce: PeerSshNonceV1,
    pub process_instance: PeerSshNonceV1,
}

/// Both signatures bind the complete expected scope and both fresh challenges.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSshChallengeClaimsV1 {
    #[serde(deserialize_with = "version_one")]
    #[cfg_attr(feature = "json-schema", schemars(range(min = 1, max = 1)))]
    pub version: u8,
    pub purpose: PeerSshChallengePurposeV1,
    pub enrollment: PeerSshEnrollmentV1,
    pub native_nonce: PeerSshNonceV1,
    pub gateway_nonce: PeerSshNonceV1,
    pub process_instance: PeerSshNonceV1,
}
impl PeerSshChallengeClaimsV1 {
    pub fn validate(&self) -> Result<(), &'static str> {
        self.enrollment.validate()?;
        if self.version != 1 || self.native_nonce == self.gateway_nonce {
            return Err("peer_ssh_invalid_challenge");
        }
        Ok(())
    }
    /// The exact domain plus ordered typed JSON; foreign-purpose bytes are never accepted.
    pub fn native_signing_bytes(&self) -> Result<Vec<u8>, serde_json::Error> {
        self.validate().map_err(serde::ser::Error::custom)?;
        let mut bytes = PEER_SSH_NATIVE_FACT_DOMAIN.to_vec();
        bytes.extend(serde_json::to_vec(self)?);
        Ok(bytes)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSshNativeProofV1 {
    pub claims: PeerSshChallengeClaimsV1,
    pub signature: PeerSshSignatureV1,
}
impl PeerSshNativeProofV1 {
    pub fn gateway_signing_bytes(&self) -> Result<Vec<u8>, serde_json::Error> {
        self.claims.validate().map_err(serde::ser::Error::custom)?;
        let mut bytes = PEER_SSH_GATEWAY_FACT_DOMAIN.to_vec();
        bytes.extend(serde_json::to_vec(self)?);
        Ok(bytes)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSshGatewayProofV1 {
    pub native: PeerSshNativeProofV1,
    pub signature: PeerSshSignatureV1,
}

/// An explicit OS-owner administration command, never an app-server route grant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum PeerSshPinCommandPurposeV1 {
    #[serde(rename = "kcoder.peer-message.ssh-pin-change.v1")]
    ExplicitChange,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSshPinCommandV1 {
    #[serde(deserialize_with = "version_one")]
    #[cfg_attr(feature = "json-schema", schemars(range(min = 1, max = 1)))]
    pub version: u8,
    pub purpose: PeerSshPinCommandPurposeV1,
    pub operation_id: PeerSshIdentityTextV1,
    #[serde(deserialize_with = "revision")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(range(min = 0, max = 9_007_199_254_740_991u64))
    )]
    pub expected_revision: u64,
    pub action: PeerSshPinActionV1,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PeerSshPinActionV1 {
    Authorize {
        enrollment: Box<PeerSshEnrollmentV1>,
    },
    Revoke {
        #[serde(rename = "enrollmentId")]
        enrollment_id: PeerSshIdentityTextV1,
        #[serde(rename = "expectedGeneration")]
        #[serde(deserialize_with = "generation")]
        #[cfg_attr(
            feature = "json-schema",
            schemars(range(min = 1, max = 9_007_199_254_740_991u64))
        )]
        expected_generation: u64,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum PeerSshPinStatusV1 {
    Pinned,
    Revoked,
}

/// A durable pin mutation receipt is not a routing or model-execution verdict.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSshPinReceiptV1 {
    #[serde(deserialize_with = "version_one")]
    #[cfg_attr(feature = "json-schema", schemars(range(min = 1, max = 1)))]
    pub version: u8,
    pub operation_id: PeerSshIdentityTextV1,
    pub enrollment_id: PeerSshIdentityTextV1,
    #[serde(deserialize_with = "generation")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(range(min = 1, max = 9_007_199_254_740_991u64))
    )]
    pub revision: u64,
    #[serde(deserialize_with = "generation")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(range(min = 1, max = 9_007_199_254_740_991u64))
    )]
    pub generation: u64,
    pub status: PeerSshPinStatusV1,
}

impl PeerSshPinCommandV1 {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1 || self.expected_revision > PEER_SSH_MAX_GENERATION {
            return Err("peer_ssh_invalid_pin_command");
        }
        match &self.action {
            PeerSshPinActionV1::Authorize { enrollment } => enrollment.validate(),
            PeerSshPinActionV1::Revoke {
                expected_generation,
                ..
            } if valid_generation(*expected_generation) => Ok(()),
            _ => Err("peer_ssh_invalid_pin_command"),
        }
    }
}

/// An OS-owner observation, not proof of a parent or permission to message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSshProfileObservationV1 {
    #[serde(deserialize_with = "version_one")]
    #[cfg_attr(feature = "json-schema", schemars(range(min = 1, max = 1)))]
    pub version: u8,
    pub native: PeerSshNativeProfileV1,
    #[serde(deserialize_with = "revision")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(range(min = 0, max = 9_007_199_254_740_991u64))
    )]
    pub pin_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSshPinReceiptReadV1 {
    #[serde(deserialize_with = "version_one")]
    #[cfg_attr(feature = "json-schema", schemars(range(min = 1, max = 1)))]
    pub version: u8,
    pub operation_id: PeerSshIdentityTextV1,
    pub receipt: Option<PeerSshPinReceiptV1>,
}

/// A local Gateway journal observation, never proof of a live Native connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum PeerSshGatewayPinStatusV1 {
    None,
    Pinned,
    Revoked,
    Revoking,
    SetupUnconfirmed,
    ScopeChanged,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum PeerSshGatewayProposalPhaseV1 {
    Proposed,
    Dispatching,
    SetupUnconfirmed,
    Completed,
    Discarded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum PeerSshGatewayProposalActionV1 {
    Authorize,
    Revoke,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSshGatewayProposalV1 {
    pub proposal_id: PeerSshIdentityTextV1,
    pub digest: PeerSshNonceV1,
    pub operation_id: PeerSshIdentityTextV1,
    pub phase: PeerSshGatewayProposalPhaseV1,
    pub action: PeerSshGatewayProposalActionV1,
    pub enrollment: PeerSshEnrollmentV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<PeerSshPinReceiptV1>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSshGatewayStatusV1 {
    pub configured: bool,
    pub pin_status: PeerSshGatewayPinStatusV1,
    #[serde(deserialize_with = "gateway_proposals")]
    #[cfg_attr(feature = "json-schema", schemars(length(max = 128)))]
    pub proposals: Vec<PeerSshGatewayProposalV1>,
}
fn gateway_proposals<'de, D: serde::Deserializer<'de>>(
    decoder: D,
) -> Result<Vec<PeerSshGatewayProposalV1>, D::Error> {
    let proposals = Vec::<PeerSshGatewayProposalV1>::deserialize(decoder)?;
    if proposals.len() > 128 {
        return Err(serde::de::Error::custom(
            "peer_ssh_gateway_proposal_capacity",
        ));
    }
    Ok(proposals)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSshAuthOfferParamsV1 {
    pub enrollment_id: PeerSshIdentityTextV1,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSshAuthNativeProofParamsV1 {
    pub claims: PeerSshChallengeClaimsV1,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSshAuthCompleteParamsV1 {
    pub proof: PeerSshGatewayProofV1,
}

/// A correlated acknowledgement on the same held stdio. Capability negotiation
/// still occurs in initialize after the Native connection verified both signatures.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSshAuthCompleteResultV1 {
    #[serde(deserialize_with = "version_one")]
    #[cfg_attr(feature = "json-schema", schemars(range(min = 1, max = 1)))]
    pub version: u8,
    pub enrollment_id: PeerSshIdentityTextV1,
    pub generation: u64,
    pub process_instance: PeerSshNonceV1,
}

/// Only the original bounded JSON frame may enter the pre-initialize decoder.
/// Its three methods exchange signature facts and never write a pin or a message.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PeerSshAuthRequestV1 {
    jsonrpc: String,
    pub id: crate::RequestId,
    pub method: String,
    params: Box<serde_json::value::RawValue>,
}
impl PeerSshAuthRequestV1 {
    pub fn decode(raw: &str) -> Result<Self, &'static str> {
        if raw.len() > PEER_SSH_AUTH_MAX_BYTES {
            return Err("peer_ssh_auth_frame_too_large");
        }
        let request: Self = serde_json::from_str(raw).map_err(|_| "peer_ssh_auth_frame_invalid")?;
        if request.jsonrpc != "2.0"
            || !matches!(
                request.method.as_str(),
                PEER_SSH_AUTH_OFFER | PEER_SSH_AUTH_NATIVE_PROOF | PEER_SSH_AUTH_COMPLETE
            )
        {
            return Err("peer_ssh_auth_frame_invalid");
        }
        Ok(request)
    }
    pub fn params<T: serde::de::DeserializeOwned>(&self) -> Result<T, &'static str> {
        serde_json::from_str(self.params.get()).map_err(|_| "peer_ssh_auth_params_invalid")
    }
}

fn valid_generation(value: u64) -> bool {
    (1..=PEER_SSH_MAX_GENERATION).contains(&value)
}
fn revision<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<u64, D::Error> {
    let value = u64::deserialize(decoder)?;
    if value <= PEER_SSH_MAX_GENERATION {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("peer_ssh_invalid_revision"))
    }
}
fn generation<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<u64, D::Error> {
    let value = u64::deserialize(decoder)?;
    if valid_generation(value) {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("peer_ssh_invalid_generation"))
    }
}
fn version_one<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<u8, D::Error> {
    let value = u8::deserialize(decoder)?;
    if value == 1 {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("peer_ssh_invalid_version"))
    }
}

#[cfg(feature = "json-schema")]
mod schema {
    use super::*;
    use schemars::{JsonSchema, r#gen::SchemaGenerator, schema::*};
    macro_rules! text_schema {
        ($ty:ty, $name:literal, $min:expr, $max:expr, $pattern:literal) => {
            impl JsonSchema for $ty {
                fn schema_name() -> String {
                    $name.into()
                }
                fn json_schema(_: &mut SchemaGenerator) -> Schema {
                    SchemaObject {
                        instance_type: Some(InstanceType::String.into()),
                        string: Some(Box::new(StringValidation {
                            min_length: Some($min),
                            max_length: Some($max),
                            pattern: Some($pattern.into()),
                        })),
                        ..Default::default()
                    }
                    .into()
                }
            }
        };
    }
    text_schema!(
        PeerSshIdentityTextV1,
        "PeerSshIdentityTextV1",
        1,
        256,
        "^[^\\u0000-\\u001f\\u007f-\\u009f]+$(?![\\s\\S])"
    );
    text_schema!(PeerSshNonceV1, "PeerSshNonceV1", 64, 64, "^[a-f0-9]{64}$");
    impl JsonSchema for PeerSshSignatureV1 {
        fn schema_name() -> String {
            "PeerSshSignatureV1".into()
        }
        fn json_schema(generator: &mut SchemaGenerator) -> Schema {
            SchemaObject {
                instance_type: Some(InstanceType::Array.into()),
                array: Some(Box::new(ArrayValidation {
                    items: Some(generator.subschema_for::<u8>().into()),
                    min_items: Some(64),
                    max_items: Some(64),
                    ..Default::default()
                })),
                ..Default::default()
            }
            .into()
        }
    }
}

#[cfg(test)]
mod tests;
