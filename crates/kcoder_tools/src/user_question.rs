use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

/// A single option in a user-facing question.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionOption {
    /// Display text for the option (1-5 words).
    pub label: String,
    /// Explanation of what this option means.
    pub description: String,
    /// Optional preview content shown when the option is focused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

/// A single question to ask the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Question {
    /// The complete question text.
    pub question: String,
    /// Short label displayed as a chip/tag.
    pub header: String,
    /// Available choices (2-4 options).
    pub options: Vec<QuestionOption>,
    /// Whether multiple options may be selected.
    #[serde(default)]
    pub multi_select: bool,
}

/// Request to ask the user one or more questions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserQuestionRequest {
    /// Questions to ask (1-4).
    pub questions: Vec<Question>,
    /// Optional pre-filled answers.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub answers: HashMap<String, String>,
    /// Optional per-question annotations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<Value>,
}

/// Answer returned by the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserQuestionResponse {
    /// The questions that were asked.
    pub questions: Vec<Question>,
    /// Question text -> answer string (multi-select answers are comma-separated).
    pub answers: HashMap<String, String>,
    /// Optional per-question annotations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<Value>,
}

/// Backend that can present a question to the user and return the answer.
#[async_trait]
pub trait UserQuestioner: Send + Sync {
    /// A source-aware callback is currently available from this host.
    /// Legacy and non-interactive hosts remain closed to worker elicitation.
    fn supports_agent_binding(&self) -> bool {
        false
    }

    /// Capture the current real delegation context before asynchronous work is scheduled.
    /// This never invents a turn or restores an unavailable connection.
    fn snapshot_agent_host(&self) -> Option<Arc<dyn UserQuestioner>> {
        None
    }

    /// Bind a runtime origin and an authoritative task/run validator.
    /// Hosts without source-aware interactions keep their existing behavior.
    fn bind_agent(
        &self,
        _source: kcoder_types::SourceAgent,
        _validate: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Option<Arc<dyn UserQuestioner>> {
        None
    }

    /// Ask the user the given questions and return their answers.
    async fn ask(&self, request: UserQuestionRequest) -> Result<UserQuestionResponse, String>;
}

/// A no-op questioner that always fails.
#[derive(Debug, Clone, Copy, Default)]
pub struct DenyAllUserQuestioner;

#[async_trait]
impl UserQuestioner for DenyAllUserQuestioner {
    async fn ask(&self, _request: UserQuestionRequest) -> Result<UserQuestionResponse, String> {
        Err("interactive questions are not available in this environment".to_string())
    }
}
