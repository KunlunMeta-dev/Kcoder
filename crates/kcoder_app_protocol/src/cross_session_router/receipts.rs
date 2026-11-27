//! Private, body-free discovery facts. Every current receipt is read at its destination.
use super::*;
use kcoder_types::cross_session_messages::CrossSessionMessageReceiptListParams;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerRouterSourceListParamsV1 {
    pub source_thread_id: String,
    pub query: CrossSessionMessageReceiptListParams,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerRouterSourceListItemV1 {
    pub operation: PeerRouterOperationV1,
    /// Continues strictly after this candidate, including candidates later filtered by the caller.
    pub cursor: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerRouterSourceListResultV1 {
    pub items: Vec<PeerRouterSourceListItemV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub unconfirmed_count: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerRouterQueryOriginalDetailsResultV1 {
    pub receipt: Option<AgentMessageReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<u64>,
}
