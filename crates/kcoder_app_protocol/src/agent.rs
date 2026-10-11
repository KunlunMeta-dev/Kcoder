use crate::EventContext;
use serde::{Deserialize, Serialize};

/// An observer only. Subscribing never creates, resumes, or controls a worker.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentStreamSubscribeParams {
    pub thread_id: String,
    pub agent_id: String,
    pub subscription_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentStreamUnsubscribeParams {
    pub subscription_id: String,
}

/// Atomic public transcript snapshot and the cursor preceding future deltas.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStreamSnapshot {
    pub thread_id: String,
    pub agent_id: String,
    pub subscription_id: String,
    pub run_id: String,
    pub sequence: u64,
    pub active: bool,
    pub status: String,
    pub messages: Vec<crate::ThreadMessage>,
    pub truncated: bool,
    pub active_assistant_item_id: Option<String>,
    pub next_assistant_item: u64,
    /// Ordinary item/event payloads for arguments still being generated.
    pub pending_events: Vec<serde_json::Value>,
}

/// Same item notification method and payload as the ordinary conversation.
/// Its sequence belongs to this run, rather than the parent turn transport.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStreamEventParams {
    pub thread_id: String,
    pub agent_id: String,
    pub subscription_id: String,
    pub run_id: String,
    pub sequence: u64,
    pub occurred_at_ms: u64,
    pub method: String,
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentListParams {
    pub thread_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentLiveReadParams {
    pub thread_id: String,
    pub agent_id: String,
    #[serde(default)]
    pub previous_revision: Option<u64>,
}

/// Public presentation data only; private checkpoints and thinking are excluded.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLiveReadResult {
    pub thread_id: String,
    pub agent_id: String,
    pub active: bool,
    pub unchanged: bool,
    pub revision: Option<u64>,
    pub phase: Option<String>,
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<AgentPresentation>,
    #[serde(default)]
    pub retained_runs: usize,
    #[serde(default)]
    pub retained_run_limit: usize,
    #[serde(default)]
    pub capacity_warning: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_run: Option<kcoder_types::BackgroundRunKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<String>,
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    pub status: String,
    pub accepting_messages: bool,
    pub queue_depth: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPresentation {
    pub role: Option<String>,
    pub goal: String,
    pub directory: String,
    pub progress: Option<String>,
    pub can_stop: bool,
    /// Opaque profile/session/agent scope, not an authorization credential.
    pub journal_scope: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentListResult {
    pub thread_id: String,
    pub agents: Vec<AgentSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentArtifactReadParams {
    pub thread_id: String,
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<AgentArtifactKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tail: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentArtifactKind {
    Output,
    Transcript,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentArtifactReadResult {
    pub thread_id: String,
    pub agent_id: String,
    pub kind: AgentArtifactKind,
    pub path: String,
    pub name: String,
    pub content: String,
    pub size: u64,
    pub truncated: bool,
    pub revision: String,
    #[serde(default)]
    pub offset: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSteerParams {
    pub thread_id: String,
    pub agent_id: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSteerStatus {
    Applied,
    QueuedLive,
    QueuedPaused,
    QueuedBehindBlocked,
    Resuming,
    Finishing,
    Cancelled,
    Closed,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessageReadParams {
    pub thread_id: String,
    pub agent_id: String,
    pub client_message_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessageReadResult {
    pub thread_id: String,
    pub agent_id: String,
    pub client_message_id: String,
    pub receipt_epoch: u64,
    /// None proves only that this target has no retained receipt for the identity.
    /// It does not grant permission to silently retry with a different identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<AgentMessageReceipt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessagesListParams {
    pub thread_id: String,
    pub agent_id: String,
    #[serde(default)]
    pub offset: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessagesListResult {
    pub thread_id: String,
    pub agent_id: String,
    pub receipt_epoch: u64,
    pub retained_count: usize,
    pub retained_limit: usize,
    pub offset: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u32>,
    pub receipts: Vec<AgentMessageReceipt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessagesArchiveParams {
    pub thread_id: String,
    pub agent_id: String,
    pub expected_epoch: u64,
    pub confirmed_message_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessagesArchiveResult {
    pub thread_id: String,
    pub agent_id: String,
    pub receipt_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStopParams {
    pub thread_id: String,
    pub agent_id: String,
    pub expected_background_run: kcoder_types::BackgroundRunKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStopResult {
    pub thread_id: String,
    pub agent_id: String,
    pub expected_background_run: kcoder_types::BackgroundRunKey,
    pub stopped: bool,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessageReceipt {
    pub client_message_id: String,
    pub message_id: String,
    pub status: String,
    pub body_summary: String,
    pub accepted_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_run: Option<kcoder_types::BackgroundRunKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_background_run: Option<kcoder_types::BackgroundRunKey>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSteerResult {
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub status: AgentSteerStatus,
    pub queued: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_position: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSteerAppliedParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<kcoder_types::BackgroundEventIdentity>,
    #[serde(flatten)]
    pub context: EventContext,
    pub agent_id: String,
    pub message_id: String,
    pub queue_depth: usize,
    pub applied_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_steer_wire_types_use_camel_case_and_hide_message_from_applied_event() {
        let list = serde_json::to_value(AgentListResult {
            thread_id: "thread-1".to_string(),
            agents: vec![AgentSummary {
                presentation: None,
                retained_runs: 0,
                retained_run_limit: 256,
                capacity_warning: false,
                background_run: None,
                parent_tool_call_id: None,
                agent_id: "agent-1".to_string(),
                agent_name: Some("reviewer".to_string()),
                status: "running".to_string(),
                accepting_messages: true,
                queue_depth: 1,
                head_message_id: Some("msg-1".to_string()),
                head_status: Some("queued".to_string()),
                output_path: None,
                transcript_path: None,
            }],
        })
        .unwrap();
        assert_eq!(list["threadId"], "thread-1");
        assert_eq!(list["agents"][0]["headMessageId"], "msg-1");
        assert!(list["agents"][0].get("message").is_none());

        let params = AgentSteerParams {
            thread_id: "thread-1".to_string(),
            agent_id: "agent-1".to_string(),
            message: "change course".to_string(),
            client_message_id: Some("client-1".to_string()),
        };
        let value = serde_json::to_value(&params).unwrap();
        assert_eq!(value["threadId"], "thread-1");
        assert_eq!(value["clientMessageId"], "client-1");

        let applied = AgentSteerAppliedParams {
            identity: None,
            context: EventContext {
                server_id: "server-1".to_string(),
                thread_id: "thread-1".to_string(),
                turn_id: Some("turn-1".to_string()),
                sequence: 7,
            },
            agent_id: "agent-1".to_string(),
            message_id: "msg-1".to_string(),
            queue_depth: 0,
            applied_at_ms: 42,
            client_message_id: Some("client-1".to_string()),
        };
        let value = serde_json::to_value(applied).unwrap();
        assert_eq!(value["agentId"], "agent-1");
        assert!(value.get("message").is_none());
    }

    #[test]
    fn agent_artifact_read_wire_types_use_camel_case() {
        let params = AgentArtifactReadParams {
            thread_id: "thread-1".to_string(),
            agent_id: "agent-1".to_string(),
            kind: Some(AgentArtifactKind::Transcript),
            path: None,
            offset: None,
            limit: None,
            revision: None,
            tail: None,
        };
        let value = serde_json::to_value(&params).unwrap();
        assert_eq!(value["threadId"], "thread-1");
        assert_eq!(value["agentId"], "agent-1");
        assert_eq!(value["kind"], "transcript");
        assert!(value.get("path").is_none());

        let result = AgentArtifactReadResult {
            thread_id: "thread-1".to_string(),
            agent_id: "agent-1".to_string(),
            kind: AgentArtifactKind::Output,
            path: "C:/Users/x/.config/kcoder/projects/p/s/subagents/agent-1/output.md".to_string(),
            name: "output.md".to_string(),
            content: "# report".to_string(),
            size: 8,
            truncated: false,
            revision: "deadbeef".to_string(),
            offset: 0,
            next_offset: None,
            modified_at: Some(42),
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["kind"], "output");
        assert_eq!(value["truncated"], false);
        assert_eq!(value["revision"], "deadbeef");
    }

    #[test]
    fn legacy_artifact_request_and_paged_request_share_one_typed_contract() {
        let legacy: AgentArtifactReadParams = serde_json::from_value(
            serde_json::json!({"threadId":"parent", "agentId":"child", "kind":"transcript"}),
        )
        .unwrap();
        assert!(legacy.offset.is_none());
        assert!(legacy.limit.is_none());
        assert!(legacy.revision.is_none());
        let paged = AgentArtifactReadParams {
            offset: Some(65536),
            limit: Some(65536),
            revision: Some("snapshot".into()),
            ..legacy
        };
        let wire = serde_json::to_value(paged).unwrap();
        assert_eq!(wire["offset"], 65536);
        assert_eq!(wire["limit"], 65536);
        assert_eq!(wire["revision"], "snapshot");
    }

    #[test]
    fn legacy_command_receipt_does_not_infer_application_run() {
        let legacy = serde_json::json!({
            "clientMessageId": "cmd:0:identity", "messageId": "message-1",
            "status": "applied", "bodySummary": "adjust", "acceptedAtMs": 1,
            "appliedAtMs": 2,
            "backgroundRun": {"parentSessionId": "parent", "agentId": "child", "runId": "admitted"}
        });
        let mut receipt: AgentMessageReceipt = serde_json::from_value(legacy.clone()).unwrap();
        assert!(receipt.applied_background_run.is_none());
        assert_eq!(serde_json::to_value(&receipt).unwrap(), legacy);

        receipt.applied_background_run = Some(kcoder_types::BackgroundRunKey {
            parent_session_id: "parent".into(),
            agent_id: "child".into(),
            run_id: "resumed".into(),
        });
        let wire = serde_json::to_value(&receipt).unwrap();
        assert_eq!(wire["backgroundRun"]["runId"], "admitted");
        assert_eq!(wire["appliedBackgroundRun"]["runId"], "resumed");
        let restored: AgentMessageReceipt = serde_json::from_value(wire).unwrap();
        assert_eq!(restored, receipt);
    }

    #[test]
    fn command_archive_has_explicit_epoch_and_reviewed_server_identities() {
        let archive: AgentMessagesArchiveParams = serde_json::from_value(serde_json::json!({"threadId":"parent", "agentId":"child", "expectedEpoch":2, "confirmedMessageIds":["msg-1","msg-2"]})).unwrap();
        assert_eq!(archive.expected_epoch, 2);
        assert_eq!(archive.confirmed_message_ids, ["msg-1", "msg-2"]);
        let read = AgentMessageReadResult {
            thread_id: "parent".into(),
            agent_id: "child".into(),
            client_message_id: "cmd:2:identity".into(),
            receipt_epoch: 3,
            receipt: None,
        };
        let wire = serde_json::to_value(read).unwrap();
        assert_eq!(wire["receiptEpoch"], 3);
        assert!(wire.get("receipt").is_none());
    }
}
