//! Installation-authenticated administrative facts. None of these types are a
//! public method/capability or authority derived from a revoked client session.
use crate::{RequestId, retention_parent::UniqueValue};
use serde::{Deserialize, Serialize};

pub const PRIVATE_RETENTION_REVOKE_METHOD_V1: &str = "attachment/retention/deviceRevoked";
pub const PRIVATE_RETENTION_VERIFIER_ENV_V1: &str = "KCODER_PRIVATE_RETENTION_VERIFIER_V1";
pub const RETENTION_REVOCATION_STATEMENT_DOMAIN_V1: &str = "kcoder.retention.device-revocation.v1";
pub const RETENTION_REVOCATION_REQUEST_DOMAIN_V1: &str =
    "kcoder.retention.device-revocation-request.v1";

/// Secret startup material. Deliberately has no Debug/Serialize implementation.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateRetentionVerifierV1 {
    pub version: u8,
    pub gateway_namespace_id: String,
    pub key: String,
}
pub fn decode_private_retention_verifier(
    raw: &str,
) -> Result<PrivateRetentionVerifierV1, serde_json::Error> {
    use serde::de::Error;
    let value = serde_json::from_str::<UniqueValue>(raw)?.0;
    let verifier: PrivateRetentionVerifierV1 = serde_json::from_value(value)?;
    if verifier.version != 1 || !sha(&verifier.gateway_namespace_id) || !sha(&verifier.key) {
        return Err(serde_json::Error::custom(
            "invalid private retention verifier",
        ));
    }
    Ok(verifier)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceRevocationStatementV1 {
    pub version: u8,
    pub gateway_namespace_id: String,
    pub device_id: String,
    pub authorization_generation: String,
    pub revocation_id: String,
    pub revoked_at: u64,
}

/// The route is registered by the trusted Gateway before allocation. It carries
/// no credentials and cannot choose the account root of the launched process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalRetentionRouteV1 {
    pub version: u8,
    pub route_id: String,
    pub target_id: String,
    pub target_fingerprint: String,
    pub workspace_path: String,
    pub workspace_selection: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateDeviceRevocationV1 {
    pub statement: DeviceRevocationStatementV1,
    pub statement_sha256: String,
    pub route: LocalRetentionRouteV1,
    pub authenticator: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateDeviceRevocationRequestV1 {
    pub jsonrpc: String,
    pub id: RequestId,
    pub method: String,
    pub params: PrivateDeviceRevocationV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceRevocationProgressV1 {
    pub version: u8,
    pub revocation_id: String,
    pub route_id: String,
    pub complete: bool,
}

fn atom(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
fn sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

impl DeviceRevocationStatementV1 {
    pub fn validate(&self) -> bool {
        self.version == 1
            && sha(&self.gateway_namespace_id)
            && [
                &self.device_id,
                &self.authorization_generation,
                &self.revocation_id,
            ]
            .into_iter()
            .all(|s| atom(s))
            && self.revoked_at <= 9_007_199_254_740_991
    }
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, serde_json::Error> {
        serde_json::to_vec(&(
            RETENTION_REVOCATION_STATEMENT_DOMAIN_V1,
            self.version,
            &self.gateway_namespace_id,
            &self.device_id,
            &self.authorization_generation,
            &self.revocation_id,
            self.revoked_at,
        ))
    }
}
impl LocalRetentionRouteV1 {
    pub fn validate(&self) -> bool {
        self.version == 1
            && sha(&self.route_id)
            && atom(&self.target_id)
            && sha(&self.target_fingerprint)
            && !self.workspace_path.is_empty()
            && self.workspace_path.len() <= 4096
            && self.workspace_path.starts_with('/')
            && !self.workspace_path.chars().any(char::is_control)
            && self.workspace_selection.as_ref().is_none_or(|s| {
                s.len() <= 4096 && s.starts_with('/') && !s.chars().any(char::is_control)
            })
    }
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, serde_json::Error> {
        serde_json::to_vec(&(
            "kcoder.retention.local-route.v1",
            self.version,
            &self.target_id,
            &self.target_fingerprint,
            &self.workspace_path,
            &self.workspace_selection,
        ))
    }
}
impl PrivateDeviceRevocationV1 {
    pub fn validate(&self) -> bool {
        self.statement.validate()
            && self.route.validate()
            && sha(&self.statement_sha256)
            && sha(&self.authenticator)
    }
    pub fn authenticated_bytes(&self) -> Result<Vec<u8>, serde_json::Error> {
        serde_json::to_vec(&(
            RETENTION_REVOCATION_REQUEST_DOMAIN_V1,
            &self.statement_sha256,
            &self.route.route_id,
            self.route.version,
            &self.route.target_id,
            &self.route.target_fingerprint,
            &self.route.workspace_path,
            &self.route.workspace_selection,
        ))
    }
}

pub fn decode_private_device_revocation(
    raw: &str,
) -> Result<PrivateDeviceRevocationRequestV1, serde_json::Error> {
    use serde::de::Error;
    let value = serde_json::from_str::<UniqueValue>(raw)?.0;
    let request: PrivateDeviceRevocationRequestV1 = serde_json::from_value(value)?;
    if request.jsonrpc != "2.0"
        || request.method != PRIVATE_RETENTION_REVOKE_METHOD_V1
        || !request.params.validate()
    {
        return Err(serde_json::Error::custom(
            "invalid private revocation request",
        ));
    }
    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn administrative_revocation_is_strict_and_not_a_public_method() {
        let params = PrivateDeviceRevocationV1 {
            statement: DeviceRevocationStatementV1 {
                version: 1,
                gateway_namespace_id: "a".repeat(64),
                device_id: "device-one".into(),
                authorization_generation: "auth-epoch-one".into(),
                revocation_id: "revoke-one".into(),
                revoked_at: 123,
            },
            statement_sha256: "b".repeat(64),
            route: LocalRetentionRouteV1 {
                version: 1,
                route_id: "c".repeat(64),
                target_id: "local".into(),
                target_fingerprint: "d".repeat(64),
                workspace_path: "/owned/workspace".into(),
                workspace_selection: None,
            },
            authenticator: "e".repeat(64),
        };
        let frame = serde_json::json!({"jsonrpc":"2.0","id":1,"method":PRIVATE_RETENTION_REVOKE_METHOD_V1,"params":params}).to_string();
        assert!(decode_private_device_revocation(&frame).is_ok());
        assert!(!crate::is_attachment_retention_method(
            PRIVATE_RETENTION_REVOKE_METHOD_V1
        ));
        for broken in [
            frame.replace("\"id\":1,", ""),
            frame.replace("\"id\":1", "\"id\":null"),
            frame.replace("\"version\":1", "\"version\":1,\"version\":1"),
            frame.replace("\"params\":{", "\"params\":{\"authority\":true,"),
        ] {
            assert!(decode_private_device_revocation(&broken).is_err());
        }
        let mut bad = params;
        bad.statement.device_id = "x".repeat(257);
        assert!(!bad.validate());
    }
}
