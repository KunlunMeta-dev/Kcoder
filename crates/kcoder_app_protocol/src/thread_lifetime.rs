//! Explicit task attachment and session survival; attachment is not ownership.
pub use kcoder_types::session_lifetime::{SessionLifetimeMode, SessionLifetimeSetting};
use serde::{Deserialize, Serialize};

pub const CAPABILITY_SESSION_LIFETIME_V1: &str = "sessionLifetimeV1";
pub const METHOD_THREAD_LIFETIME_READ: &str = "thread/lifetime/read";
pub const METHOD_THREAD_LIFETIME_SET: &str = "thread/lifetime/set";
pub const METHOD_THREAD_ATTACH: &str = "thread/attach";
pub const METHOD_THREAD_DETACH: &str = "thread/detach";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadLifetimeReadParams {
    pub thread_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadLifetimeSetParams {
    pub thread_id: String,
    pub expected_revision: u64,
    pub mode: SessionLifetimeMode,
}

/// The trusted client transport assigns the slot and connection incarnation.
/// Both are scoped to that transport's authenticated owner by the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadAttachParams {
    pub thread_id: String,
    pub client_id: String,
    pub generation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadLifetimeResult {
    pub thread_id: String,
    pub setting: SessionLifetimeSetting,
    pub attached_clients: u32,
    pub reconnect_grace_ms: u64,
    pub background_authorized: bool,
    /// Absence means that the lifetime gate permits admission, not tool access.
    pub paused_reason: Option<String>,
}
