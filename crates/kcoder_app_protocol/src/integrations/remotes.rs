//! Gateway-owned read-only remote catalog; does not delegate or probe a runner.
use serde::{Deserialize, Serialize};
/// Inbound bridge only; this does not declare a running session or outbound delegation.
pub const CAPABILITY_ACP_INBOUND_V1: &str = "acpInboundV1";
pub const CAPABILITY_REMOTE_CATALOG_V1: &str = "remoteCapabilityCatalogV1";
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum RemoteCapabilityCatalogMethod {
    #[serde(rename = "runtime.remotes.readCatalog")]
    ReadCatalog,
}
