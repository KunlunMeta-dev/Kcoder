//! Durable asynchronous user-question contracts shared by tools, State and app-server clients.

use crate::Message;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const ASYNC_QUESTION_MAX_ITEMS: usize = 8;
pub const ASYNC_QUESTION_MAX_OPTIONS: usize = 16;
pub const ASYNC_QUESTION_MAX_RECORDS: usize = 512;
pub const ASYNC_QUESTION_MAX_REQUEST_BYTES: usize = 64 * 1024;
pub const ASYNC_QUESTION_MAX_ANSWER_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AsyncQuestionOptionDraft {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AsyncQuestionItemDraft {
    pub header: String,
    pub question: String,
    pub options: Vec<AsyncQuestionOptionDraft>,
    pub multi_select: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AsyncQuestionRequest {
    pub source_turn_id: String,
    pub tool_call_id: String,
    pub questions: Vec<AsyncQuestionItemDraft>,
}

impl AsyncQuestionRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.source_turn_id.trim().is_empty()
            || self.source_turn_id.len() > 256
            || self.tool_call_id.trim().is_empty()
            || self.tool_call_id.len() > 256
            || self.questions.is_empty()
            || self.questions.len() > ASYNC_QUESTION_MAX_ITEMS
        {
            return Err("async question identity or item count is invalid");
        }
        let mut total_bytes = 0usize;
        for item in &self.questions {
            if item.header.trim().is_empty()
                || item.header.len() > 256
                || item.question.trim().is_empty()
                || item.question.len() > 16 * 1024
                || item.options.len() > ASYNC_QUESTION_MAX_OPTIONS
                || item.options.iter().any(|option| {
                    option.label.trim().is_empty()
                        || option.label.len() > 256
                        || option.description.len() > 2 * 1024
                })
            {
                return Err("async question content exceeds its limit");
            }
            total_bytes = total_bytes
                .saturating_add(item.header.len())
                .saturating_add(item.question.len())
                .saturating_add(item.options.iter().fold(0usize, |total, option| {
                    total
                        .saturating_add(option.label.len())
                        .saturating_add(option.description.len())
                }));
        }
        if total_bytes > ASYNC_QUESTION_MAX_REQUEST_BYTES {
            return Err("async question request exceeds its total size limit");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AsyncQuestionOption {
    pub id: String,
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AsyncQuestionItem {
    pub id: String,
    pub header: String,
    pub question: String,
    pub options: Vec<AsyncQuestionOption>,
    pub multi_select: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum AsyncQuestionStatus {
    Pending,
    AnswerSaved,
    Queued,
    ContextApplied,
    DeliveryFailed,
    DeliveryUnknown,
    Cancelled,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AsyncQuestionAnswerValue {
    #[serde(default)]
    pub selected_option_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AsyncQuestionAnswerRecord {
    pub submission_id: String,
    pub answers: BTreeMap<String, AsyncQuestionAnswerValue>,
    pub accepted_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AsyncQuestionRecord {
    pub question_id: String,
    pub request_id: String,
    pub thread_id: String,
    pub source_turn_id: String,
    pub tool_call_id: String,
    pub revision: u64,
    pub created_at_ms: u64,
    pub status: AsyncQuestionStatus,
    pub questions: Vec<AsyncQuestionItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<AsyncQuestionAnswerRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AsyncQuestionAccepted {
    pub accepted: bool,
    pub question: AsyncQuestionRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AsyncQuestionAnswerReceipt {
    /// True when this submission won or is an exact retry of the winning submission.
    pub accepted: bool,
    pub duplicate: bool,
    pub question: AsyncQuestionRecord,
}

/// A claimed outbox delivery uses a deterministic transcript UUID and the original answer text.
#[derive(Debug, Clone)]
pub struct AsyncQuestionDeliveryClaim {
    pub question_id: String,
    pub submission_id: String,
    pub claim_id: String,
    pub message_id: String,
    pub revision: u64,
    pub message: Message,
}
