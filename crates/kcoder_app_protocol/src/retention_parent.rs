//! Private stdio authority transport. Types do not authorize a parent, execute
//! retention methods, or advertise a capability.
use crate::{RequestId, TrustedRetentionContextV1};
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use std::fmt;

pub const PRIVATE_RETENTION_FIELD_V1: &str = "kcoderPrivateRetention";

/// Non-secret facts supplied only by the OS-trusted process launcher. This is
/// a declaration, not proof of a parent process or remote account identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RetentionParentLaunchV1 {
    LocalOs,
    VerifiedAccount { principal_id: String, uid: u32 },
}

/// OS-parent startup wire, distinct from public configuration or RPC input.
pub const PRIVATE_RETENTION_PARENT_ENV_V1: &str = "KCODER_PRIVATE_RETENTION_PARENT_V1";
pub const PRIVATE_RETENTION_PARENT_JSON_LIMIT_V1: usize = 1024;

#[derive(Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ParentEnvironmentV1 {
    LocalOs {
        #[serde(deserialize_with = "version_one")]
        version: u8,
    },
    VerifiedAccount {
        #[serde(deserialize_with = "version_one")]
        version: u8,
        principal_id: String,
        uid: u32,
    },
}

/// Decode original JSON with the same raw duplicate-rejecting visitor as private
/// RPC frames. Never accept an already-parsed Value as launch evidence.
pub fn decode_private_retention_parent_environment(
    raw: &str,
) -> Result<RetentionParentLaunchV1, serde_json::Error> {
    if raw.len() > PRIVATE_RETENTION_PARENT_JSON_LIMIT_V1 {
        return Err(<serde_json::Error as de::Error>::custom(
            "private parent launch exceeds limit",
        ));
    }
    let unique = serde_json::from_str::<UniqueValue>(raw)?.0;
    match serde_json::from_value::<ParentEnvironmentV1>(unique)? {
        ParentEnvironmentV1::LocalOs { version: _version } => Ok(RetentionParentLaunchV1::LocalOs),
        ParentEnvironmentV1::VerifiedAccount {
            version: _version,
            principal_id,
            uid,
        } => {
            if principal_id.is_empty()
                || principal_id.len() > 256
                || principal_id.chars().any(char::is_control)
            {
                return Err(<serde_json::Error as de::Error>::custom(
                    "invalid private parent principal",
                ));
            }
            Ok(RetentionParentLaunchV1::VerifiedAccount { principal_id, uid })
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateRetentionExtensionV1 {
    #[serde(deserialize_with = "version_one")]
    pub version: u8,
    pub context: TrustedRetentionContextV1,
    /// Workspace V2's account tuple comes from the same trusted parent. It is
    /// not a client declaration or another authority channel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_account: Option<WorkspaceParentAccountV2>,
    /// Selected target registry identity, distinct from context.device_id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_target_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceParentAccountV2 {
    pub role: String,
    pub authorization_generation: String,
}

fn version_one<'de, D: Deserializer<'de>>(input: D) -> Result<u8, D::Error> {
    let version = u8::deserialize(input)?;
    if version != 1 {
        return Err(de::Error::custom("unsupported private retention version"));
    }
    Ok(version)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateRetentionRequestV1 {
    pub jsonrpc: String,
    pub id: RequestId,
    pub method: String,
    pub params: Value,
    #[serde(rename = "kcoderPrivateRetention")]
    pub private_retention: PrivateRetentionExtensionV1,
}

/// Decode from the original JSONL bytes: a pre-parsed Value cannot prove that
/// authority fields were unique. Ordinary RPC parsing is intentionally separate.
pub fn decode_private_retention_request(
    raw: &str,
) -> Result<PrivateRetentionRequestV1, serde_json::Error> {
    let unique = serde_json::from_str::<UniqueValue>(raw)?.0;
    let request: PrivateRetentionRequestV1 = serde_json::from_value(unique)?;
    if request.jsonrpc != "2.0" {
        return Err(<serde_json::Error as de::Error>::custom(
            "invalid private retention JSON-RPC version",
        ));
    }
    Ok(request)
}

struct UniqueValue(Value);

impl<'de> Deserialize<'de> for UniqueValue {
    fn deserialize<D: Deserializer<'de>>(input: D) -> Result<Self, D::Error> {
        input.deserialize_any(UniqueVisitor)
    }
}

struct UniqueVisitor;
impl<'de> Visitor<'de> for UniqueVisitor {
    type Value = UniqueValue;
    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("JSON with unique object fields")
    }
    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::Bool(value)))
    }
    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
        Ok(UniqueValue(value.into()))
    }
    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
        Ok(UniqueValue(value.into()))
    }
    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
        serde_json::Number::from_f64(value)
            .map(|number| UniqueValue(Value::Number(number)))
            .ok_or_else(|| E::custom("invalid JSON number"))
    }
    fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::String(value.to_owned())))
    }
    fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::String(value)))
    }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::Null))
    }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(UniqueValue(Value::Null))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element::<UniqueValue>()? {
            values.push(value.0);
        }
        Ok(UniqueValue(Value::Array(values)))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut object: A) -> Result<Self::Value, A::Error> {
        let mut values = Map::new();
        while let Some(key) = object.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(de::Error::custom("duplicate private JSON field"));
            }
            let value = object.next_value::<UniqueValue>()?;
            values.insert(key, value.0);
        }
        Ok(UniqueValue(Value::Object(values)))
    }
}
