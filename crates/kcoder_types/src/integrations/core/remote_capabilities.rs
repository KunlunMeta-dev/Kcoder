//! Read-only remote capability observations. None of these rows grants execution.
use super::{IntegrationEntityRef, IntegrationOwner};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum RemoteCapabilityObservationState {
    Unknown,
    Advertised,
    Observed,
    Unavailable,
    Denied,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum RemoteCapabilityTransport {
    Local,
    Ssh,
    Relay,
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteCapabilitySchemaRef {
    pub name: String,
    pub protocol_version: String,
    /// A local public contract reference is not a remote-producer schema hash.
    pub producer_revision: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteCapabilityBoundary {
    pub resource: Option<IntegrationEntityRef>,
    pub location: String,
    pub authorization: String,
    pub allowed_models: String,
    pub budget: String,
    pub tools: String,
    pub confirmation: String,
    pub input_transfer: String,
    pub result_transfer: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteCapabilityEntry {
    pub id: String,
    pub capability: String,
    pub purpose: String,
    pub target_id: String,
    pub transport: RemoteCapabilityTransport,
    pub protocol: String,
    pub protocol_version: Option<String>,
    pub implementation_version: Option<String>,
    pub state: RemoteCapabilityObservationState,
    pub business_state: RemoteCapabilityObservationState,
    pub identity_state: RemoteCapabilityObservationState,
    pub native_owner: Option<IntegrationOwner>,
    pub schemas: Vec<RemoteCapabilitySchemaRef>,
    pub boundary: RemoteCapabilityBoundary,
    pub observed_at: Option<String>,
    pub reason_code: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteCapabilityCatalogReadParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteCapabilityCatalog {
    pub snapshot_id: String,
    pub entries: Vec<RemoteCapabilityEntry>,
    pub next_cursor: Option<String>,
    pub total: Option<u32>,
    pub observed_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_catalog_read_is_closed_and_cursor_remains_optional() {
        let empty: RemoteCapabilityCatalogReadParams = serde_json::from_str("{}").unwrap();
        assert_eq!(serde_json::to_value(empty).unwrap(), serde_json::json!({}));
        assert!(
            serde_json::from_value::<RemoteCapabilityCatalogReadParams>(
                serde_json::json!({"cursor": "owned", "execute": true})
            )
            .is_err()
        );
    }

    #[test]
    fn remote_catalog_preserves_unknown_and_unverified_producer_revision() {
        let catalog = RemoteCapabilityCatalog {
            snapshot_id: "snapshot-owned".into(),
            entries: Vec::new(),
            next_cursor: None,
            total: None,
            observed_at: "2026-10-25T00:00:00.000Z".into(),
        };
        let value = serde_json::to_value(catalog).unwrap();
        assert!(value["total"].is_null());
        assert!(value["nextCursor"].is_null());
        assert_eq!(
            serde_json::to_value(RemoteCapabilityObservationState::Unknown).unwrap(),
            "unknown"
        );
        assert!(serde_json::from_str::<RemoteCapabilityObservationState>("\"ready\"").is_err());
        let schema: RemoteCapabilitySchemaRef = serde_json::from_value(serde_json::json!({
            "name": "IntegrationScope", "protocolVersion": "2026-07-27", "producerRevision": null
        }))
        .unwrap();
        assert_eq!(schema.producer_revision, None);
    }
}
