use kcoder_types::async_user_questions::{
    ASYNC_QUESTION_MAX_ANSWER_BYTES, ASYNC_QUESTION_MAX_ITEMS, ASYNC_QUESTION_MAX_OPTIONS,
    AsyncQuestionAnswerValue, AsyncQuestionRecord,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const CAPABILITY_ASYNC_USER_QUESTIONS_V1: &str = "asyncUserQuestionsV1";
/// The original task may have applied an async question operation, but its
/// response could not be confirmed. Reconcile the existing task state before retrying.
pub const ASYNC_QUESTION_RESULT_UNKNOWN: i64 = -32065;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AsyncQuestionListParams {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_terminal: Option<bool>,
}

impl AsyncQuestionListParams {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_identifier(&self.thread_id, "threadId")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AsyncQuestionAnswerParams {
    pub thread_id: String,
    pub question_id: String,
    pub submission_id: String,
    pub expected_revision: u64,
    pub answers: BTreeMap<String, AsyncQuestionAnswerValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub async_user_questions: Option<bool>,
}

impl AsyncQuestionAnswerParams {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_identifier(&self.thread_id, "threadId")?;
        validate_identifier(&self.question_id, "questionId")?;
        validate_identifier(&self.submission_id, "submissionId")?;
        if self.expected_revision == 0
            || self.answers.is_empty()
            || self.answers.len() > ASYNC_QUESTION_MAX_ITEMS
        {
            return Err("answer revision or item count is invalid");
        }
        let mut total = 0usize;
        for (item_id, answer) in &self.answers {
            validate_identifier(item_id, "itemId")?;
            if answer.selected_option_ids.len() > ASYNC_QUESTION_MAX_OPTIONS
                || answer
                    .text
                    .as_ref()
                    .is_some_and(|text| text.len() > ASYNC_QUESTION_MAX_ANSWER_BYTES)
            {
                return Err("answer exceeds its size limit");
            }
            let unique = answer
                .selected_option_ids
                .iter()
                .collect::<std::collections::BTreeSet<_>>();
            if unique.len() != answer.selected_option_ids.len()
                || answer
                    .selected_option_ids
                    .iter()
                    .any(|id| id.trim().is_empty() || id.len() > 256)
            {
                return Err("answer option identities are invalid");
            }
            total = total
                .saturating_add(item_id.len())
                .saturating_add(
                    answer
                        .selected_option_ids
                        .iter()
                        .map(String::len)
                        .sum::<usize>(),
                )
                .saturating_add(answer.text.as_ref().map_or(0, String::len));
        }
        if total > ASYNC_QUESTION_MAX_ANSWER_BYTES {
            return Err("answer exceeds its total size limit");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AsyncQuestionCancelParams {
    pub thread_id: String,
    pub question_id: String,
    pub expected_revision: u64,
}

impl AsyncQuestionCancelParams {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_identifier(&self.thread_id, "threadId")?;
        validate_identifier(&self.question_id, "questionId")?;
        if self.expected_revision == 0 {
            return Err("expectedRevision must be positive");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AsyncQuestionListResult {
    pub thread_id: String,
    pub questions: Vec<AsyncQuestionRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AsyncQuestionAnswerResult {
    pub thread_id: String,
    pub question: AsyncQuestionRecord,
    pub accepted: bool,
    pub duplicate: bool,
    /// The turn admitted by this answer RPC, if this call actually started one.
    /// Never return a historical turn here; a replay may start a new turn now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_turn: Option<crate::Turn>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AsyncQuestionCancelResult {
    pub thread_id: String,
    pub question: AsyncQuestionRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AsyncQuestionChangedNotification {
    pub thread_id: String,
    pub question: AsyncQuestionRecord,
}

fn validate_identifier(value: &str, field: &'static str) -> Result<(), &'static str> {
    if value.trim().is_empty() || value.len() > 256 {
        return Err(match field {
            "threadId" => "threadId is invalid",
            "questionId" => "questionId is invalid",
            "submissionId" => "submissionId is invalid",
            _ => "identifier is invalid",
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answer_params_keep_retry_identity_and_reject_duplicate_option_ids() {
        let mut params = AsyncQuestionAnswerParams {
            thread_id: "thread".into(),
            question_id: "question".into(),
            submission_id: "submission".into(),
            expected_revision: 1,
            answers: BTreeMap::from([(
                "item".into(),
                AsyncQuestionAnswerValue {
                    selected_option_ids: vec!["option".into()],
                    text: None,
                },
            )]),
            async_user_questions: None,
        };
        params.validate().unwrap();
        let value = serde_json::to_value(&params).unwrap();
        assert_eq!(value["submissionId"], "submission");
        assert_eq!(value["expectedRevision"], 1);

        params.answers.get_mut("item").unwrap().selected_option_ids =
            vec!["option".into(), "option".into()];
        assert!(params.validate().is_err());
    }

    #[test]
    fn changed_notification_carries_thread_owner_and_full_revisioned_question() {
        let notification = AsyncQuestionChangedNotification {
            thread_id: "thread".into(),
            question: AsyncQuestionRecord {
                question_id: "question".into(),
                request_id: "request".into(),
                thread_id: "thread".into(),
                source_turn_id: "turn".into(),
                tool_call_id: "tool".into(),
                revision: 3,
                created_at_ms: 1,
                status: kcoder_types::async_user_questions::AsyncQuestionStatus::Queued,
                questions: Vec::new(),
                answer: None,
                delivery_error: None,
            },
        };
        let value = serde_json::to_value(notification).unwrap();
        assert_eq!(value["threadId"], "thread");
        assert_eq!(value["question"]["revision"], 3);
        assert_eq!(value["question"]["status"], "queued");
    }
}
