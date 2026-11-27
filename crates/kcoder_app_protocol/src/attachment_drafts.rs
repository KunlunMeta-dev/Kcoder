//! Parent-mediated durable Composer uploads, separate from sent history and retention V1.
use serde::{Deserialize, Serialize};

pub const CAPABILITY_DURABLE_ATTACHMENT_DRAFTS_V1: &str = "durableAttachmentDraftsV1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentDraftRetainParams {
    pub thread_id: String,
    /// Injected by the trusted parent, never accepted from a Gateway client.
    pub owner_scope: String,
    pub paths: Vec<String>,
    /// A reconnect can recover existing records but cannot adopt arbitrary
    /// uploads owned by another virtual client on the parent connection.
    #[serde(default)]
    pub recover_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentDraftPath {
    pub source_path: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentDraftRetainResult {
    pub drafts: Vec<AttachmentDraftPath>,
}
