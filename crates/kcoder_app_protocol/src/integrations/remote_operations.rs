//! Native original-operation management, negotiated independently of the read-only directory.
use serde::{Deserialize, Serialize};
pub const CAPABILITY_REMOTE_OPERATION_CONTROL_V1: &str = "remoteOperationControlV1";
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum RemoteOperationControlMethod {
    #[serde(rename = "integrations/remotes/listOperations")]
    List,
    #[serde(rename = "integrations/remotes/readOperation")]
    Read,
    #[serde(rename = "integrations/remotes/cancelOperation")]
    Cancel,
}
