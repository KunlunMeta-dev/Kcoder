//! Source-owned outgoing receipt discovery. Only a destination observation can confirm status.
use super::{AgentMessageMode, AgentMessageReceipt, AgentMessageStatus, valid_agent_message_id};
use crate::session_address::SessionAddressV1;
use serde::{Deserialize, Serialize};

pub const MAX_RECEIPT_LIST_BYTES: usize = 112 * 1024;
const MAX_WIRE_TIME: u64 = (1 << 53) - 1;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CrossSessionMessageReceiptListParams {
    /// Optional exact, case-sensitive destination threadId. Copy threadId from ListSessions.
    /// Omit to search messages sent by your current session to any destination.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_thread_id: Option<String>,
    /// Optional current receipt status. queued is awaiting delivery, delivering is in progress,
    /// applied is appended to the recipient's history. rejected, expired and unknown are also valid.
    /// An unreachable destination has unconfirmed observations and cannot match a status filter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<AgentMessageStatus>,
    /// Inclusive lower bound on message creation time, in Unix milliseconds (UTC). Omit for no lower bound.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_after_ms: Option<u64>,
    /// Exclusive upper bound on message creation time, in Unix milliseconds (UTC). Must exceed createdAfterMs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_before_ms: Option<u64>,
    /// Maximum matches for this call, an integer from 1 to 256. Default 10. You may change it between pages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "json-schema", schemars(range(min = 1, max = 256)))]
    pub limit: Option<usize>,
    /// On continuation copy nextCursor exactly and repeat the original target/status/time filters.
    /// Start without cursor to change filters or refresh. A short or empty page can still have a nextCursor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}
impl CrossSessionMessageReceiptListParams {
    pub fn page_size(&self) -> usize {
        self.limit.unwrap_or(10)
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if self
            .target_thread_id
            .as_deref()
            .is_some_and(|id| !valid_agent_message_id(id))
        {
            return Err("targetThreadId must be an exact destination thread ID");
        }
        if !(1..=256).contains(&self.page_size()) {
            return Err("limit must be an integer from 1 to 256");
        }
        if [self.created_after_ms, self.created_before_ms]
            .into_iter()
            .flatten()
            .any(|t| t > MAX_WIRE_TIME)
            || self
                .created_after_ms
                .zip(self.created_before_ms)
                .is_some_and(|(after, before)| after >= before)
        {
            return Err(
                "use safe Unix millisecond timestamps with createdAfterMs < createdBeforeMs",
            );
        }
        if self
            .cursor
            .as_deref()
            .is_some_and(|v| v.is_empty() || v.len() > 2048 || v.chars().any(char::is_control))
        {
            return Err("cursor must be the exact nextCursor from this search, up to 2048 bytes");
        }
        Ok(())
    }

    pub fn matches(&self, row: &CrossSessionMessageReceiptListEntry) -> bool {
        let needs_observation = self.status.is_some()
            || self.created_after_ms.is_some()
            || self.created_before_ms.is_some();
        (!needs_observation || row.confirmation == ReceiptConfirmation::Confirmed)
            && self
                .target_thread_id
                .as_ref()
                .is_none_or(|id| id == &row.target_address.thread_id)
            && self
                .status
                .is_none_or(|s| row.receipt.as_ref().is_some_and(|r| r.status == s))
            && self
                .created_after_ms
                .is_none_or(|t| row.created_at_ms.is_some_and(|created| created >= t))
            && self
                .created_before_ms
                .is_none_or(|t| row.created_at_ms.is_some_and(|created| created < t))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ReceiptConfirmation {
    Confirmed,
    Missing,
    Unconfirmed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CrossSessionMessageReceiptListEntry {
    pub client_message_id: String,
    pub target_address: SessionAddressV1,
    pub mode: AgentMessageMode,
    pub confirmation: ReceiptConfirmation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<AgentMessageReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CrossSessionMessageReceiptListResult {
    pub items: Vec<CrossSessionMessageReceiptListEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    /// Count of candidate observations on this page that could not be verified.
    pub unconfirmed_count: u32,
}

impl CrossSessionMessageReceiptListResult {
    pub fn validate(
        &self,
        query: &CrossSessionMessageReceiptListParams,
        source_thread: &str,
        source: Option<&SessionAddressV1>,
    ) -> Result<(), &'static str> {
        let mut original_ids = std::collections::HashSet::new();
        let valid = self.items.len() <= query.page_size()
            && self.next_cursor.as_deref().is_none_or(|v| {
                !v.is_empty() && v.len() <= 2048 && !v.chars().any(char::is_control)
            })
            && self.items.iter().all(|row| {
                original_ids.insert(&row.client_message_id)
                    && valid_agent_message_id(&row.client_message_id)
                    && row
                        .reason_code
                        .as_deref()
                        .is_none_or(valid_agent_message_id)
                    && [row.created_at_ms, row.expires_at_ms]
                        .into_iter()
                        .flatten()
                        .all(|t| t <= MAX_WIRE_TIME)
                    && row
                        .created_at_ms
                        .zip(row.expires_at_ms)
                        .is_none_or(|(created, expires)| created <= expires)
                    && row.target_address.validate().is_ok()
                    && query.matches(row)
                    && match (&row.confirmation, &row.receipt) {
                        (ReceiptConfirmation::Confirmed, Some(r)) => {
                            valid_agent_message_id(&r.message_id)
                                && r.revision > 0
                                && r.reason_code.as_deref().is_none_or(valid_agent_message_id)
                                && r.reply_to_message_id
                                    .as_deref()
                                    .is_none_or(valid_agent_message_id)
                                && r.client_message_id == row.client_message_id
                                && r.target_thread_id == row.target_address.thread_id
                                && r.target_address.as_ref() == Some(&row.target_address)
                                && r.source_address.as_ref().is_some_and(|s| {
                                    s.validate().is_ok()
                                        && s.thread_id == source_thread
                                        && source.is_none_or(|expected| expected == s)
                                })
                        }
                        (ReceiptConfirmation::Missing | ReceiptConfirmation::Unconfirmed, None) => {
                            row.created_at_ms.is_none() && row.expires_at_ms.is_none()
                        }
                        _ => false,
                    }
            });
        if valid {
            Ok(())
        } else {
            Err("peer_message_receipt_list_invalid_result")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn outbound_filters_reject_forged_scope_and_use_inclusive_exclusive_time() {
        for value in [
            json!({"sourceThreadId":"peer"}),
            json!({"workspaceId":"elsewhere"}),
            json!({"status":"read"}),
        ] {
            assert!(serde_json::from_value::<CrossSessionMessageReceiptListParams>(value).is_err());
        }
        for value in [
            json!({"limit":0}),
            json!({"limit":257}),
            json!({"createdAfterMs":10,"createdBeforeMs":10}),
            json!({"createdBeforeMs":9007199254740992_u64}),
            json!({"targetThreadId":" invalid "}),
        ] {
            let parsed = serde_json::from_value::<CrossSessionMessageReceiptListParams>(value);
            assert!(parsed.is_err() || parsed.unwrap().validate().is_err());
        }
        let query: CrossSessionMessageReceiptListParams =
            serde_json::from_value(json!({"createdAfterMs":10,"createdBeforeMs":20})).unwrap();
        assert_eq!(query.page_size(), 10);
        let mut row = CrossSessionMessageReceiptListEntry {
            client_message_id: "original".into(),
            target_address: SessionAddressV1 {
                target_id: "native".into(),
                workspace_id: "workspace".into(),
                thread_id: "peer".into(),
            },
            mode: AgentMessageMode::EnqueueOnly,
            confirmation: ReceiptConfirmation::Unconfirmed,
            receipt: None,
            created_at_ms: None,
            expires_at_ms: None,
            reason_code: None,
        };
        assert!(!query.matches(&row));
        row.confirmation = ReceiptConfirmation::Confirmed;
        row.created_at_ms = Some(10);
        assert!(query.matches(&row));
        row.created_at_ms = Some(20);
        assert!(!query.matches(&row));
    }
}
