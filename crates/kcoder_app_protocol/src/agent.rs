use crate::EventContext;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentListParams {
    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
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
            modified_at: Some(42),
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["kind"], "output");
        assert_eq!(value["truncated"], false);
        assert_eq!(value["revision"], "deadbeef");
    }
}
