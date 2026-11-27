//! Explicit relationship controls. These DTOs grant no execution or background use.
use kcoder_types::integrations::core::{IntegrationNullable, IntegrationRevisionRef};
use serde::{Deserialize, Serialize};

/// The task belongs to the actual current Native workspace, never a supplied path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum ConnectivityTaskBindingMutation {
    BindTask {
        #[serde(rename = "connectionId")]
        connection_id: String,
        #[serde(rename = "taskThreadId")]
        task_thread_id: String,
        #[serde(rename = "externalChatRef")]
        external_chat_ref: IntegrationRevisionRef,
        #[serde(rename = "expectedBindingRevision")]
        expected_binding_revision: IntegrationNullable<String>,
    },
    SwitchTask {
        #[serde(rename = "connectionId")]
        connection_id: String,
        #[serde(rename = "taskThreadId")]
        task_thread_id: String,
        #[serde(rename = "externalChatRef")]
        external_chat_ref: IntegrationRevisionRef,
        #[serde(rename = "expectedBindingRevision")]
        expected_binding_revision: String,
    },
    PrepareTaskRuntime {
        #[serde(rename = "connectionId")]
        connection_id: String,
        #[serde(rename = "taskThreadId")]
        task_thread_id: String,
        #[serde(rename = "bindingRef")]
        binding_ref: IntegrationRevisionRef,
    },
    UnbindTask {
        #[serde(rename = "connectionId")]
        connection_id: String,
        #[serde(rename = "taskThreadId")]
        task_thread_id: String,
        #[serde(rename = "bindingRef")]
        binding_ref: IntegrationRevisionRef,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityTaskBindingQuery {
    pub task_thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

/// Bounded read-only projection for tasks already visible in the current workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityTaskBindingSummaryQuery {
    pub task_thread_ids: Vec<String>,
}
