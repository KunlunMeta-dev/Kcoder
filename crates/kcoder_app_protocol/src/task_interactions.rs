//! UI projections of exact original parent interactions; selectors never grant reply authority.
use crate::{InteractionStatusKindV1, InteractionStatusReadParamsV1};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskInteractionReferenceV1 {
    pub attempt_id: String,
    pub selector: InteractionStatusReadParamsV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskInteractionOptionV1 {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskInteractionQuestionV1 {
    pub id: String,
    pub header: String,
    pub question: String,
    pub is_other: bool,
    /// Omitted legacy questions retain their original single-choice wire shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multi_select: Option<bool>,
    pub options: Vec<TaskInteractionOptionV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum TaskInteractionApprovalKindV1 {
    Command,
    FileChange,
    Permission,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskInteractionApprovalV1 {
    pub kind: TaskInteractionApprovalKindV1,
    pub subject: Option<String>,
    pub input: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskInteractionPresentationV1 {
    pub questions: Vec<TaskInteractionQuestionV1>,
    pub approval: Option<TaskInteractionApprovalV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum TaskInteractionStateV1 {
    Pending,
    ResponsePending,
    Resolved,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum TaskInteractionObservationStateV1 {
    Observed,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskInteractionItemV1 {
    pub reference: TaskInteractionReferenceV1,
    pub state: TaskInteractionStateV1,
    pub presentation: TaskInteractionPresentationV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskInteractionSnapshotV1 {
    pub schema_version: u32,
    pub thread_id: String,
    /// Observed means original native selectors were checked, not complete business success.
    pub observation_state: TaskInteractionObservationStateV1,
    pub items: Vec<TaskInteractionItemV1>,
    /// A verified original request needs its normal conversation presentation.
    /// This flag conveys no text or permission to answer that request here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_view_required: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskInteractionAnswerV1 {
    pub answers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskInteractionRespondParamsV1 {
    pub reference: TaskInteractionReferenceV1,
    pub answers: BTreeMap<String, TaskInteractionAnswerV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskInteractionRespondResultV1 {
    pub reference: TaskInteractionReferenceV1,
    /// A sent response stays response_pending until the original native receipt resolves it.
    pub state: TaskInteractionStateV1,
}

impl TaskInteractionReferenceV1 {
    pub fn validate(&self) -> Result<(), &'static str> {
        self.selector.validate()?;
        if self.attempt_id.is_empty() || self.attempt_id.len() > 256 {
            return Err("original accepted attempt is required");
        }
        Ok(())
    }
}
impl TaskInteractionSnapshotV1 {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != 1
            || self.thread_id.is_empty()
            || self.thread_id.len() > 256
            || self.items.len() > 32
        {
            return Err("bounded original interaction observation is required");
        }
        let mut references = std::collections::BTreeSet::new();
        for item in &self.items {
            item.reference.validate()?;
            let selector = &item.reference.selector;
            if selector.thread_id != self.thread_id
                || !references.insert((selector.app_server_epoch.as_str(), selector.request_id))
                || item.presentation.questions.is_empty()
                || item.presentation.questions.len() > 8
                || (selector.kind == InteractionStatusKindV1::Approval)
                    != item.presentation.approval.is_some()
            {
                return Err("original interaction identity or presentation mismatch");
            }
            for question in &item.presentation.questions {
                if question.id.is_empty()
                    || question.id.len() > 256
                    || question.header.len() > 4096
                    || question.question.len() > 65536
                    || question.options.len() > 16
                    || question
                        .options
                        .iter()
                        .any(|option| option.label.len() > 4096 || option.description.len() > 16384)
                {
                    return Err("interaction presentation exceeds its bound");
                }
            }
            if item.presentation.approval.as_ref().is_some_and(|value| {
                value.subject.as_ref().is_some_and(|s| s.len() > 65536)
                    || value.input.as_ref().is_some_and(|s| s.len() > 65536)
                    || value.reason.as_ref().is_some_and(|s| s.len() > 65536)
            }) {
                return Err("approval presentation exceeds its bound");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selectors_keep_native_epoch_and_reject_invented_authority_fields() {
        let reference = TaskInteractionReferenceV1 {
            attempt_id: "actual-attempt".into(),
            selector: InteractionStatusReadParamsV1 {
                server_id: "native-server".into(),
                thread_id: "thread".into(),
                turn_id: "turn".into(),
                request_id: 2000001,
                app_server_epoch: "epoch".into(),
                kind: InteractionStatusKindV1::Question,
                question_id: Some("question-2000001".into()),
                approval_id: None,
            },
        };
        reference.validate().unwrap();
        let mut value = serde_json::to_value(reference).unwrap();
        value["authorized"] = serde_json::json!(true);
        assert!(serde_json::from_value::<TaskInteractionReferenceV1>(value).is_err());
    }
    #[test]
    fn omitted_multiselect_remains_omitted_and_true_keeps_multiple_answer_values() {
        let legacy = serde_json::json!({"id":"q","header":"Choice","question":"Pick","isOther":false,"options":[]});
        let question: TaskInteractionQuestionV1 = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(question.multi_select, None);
        assert_eq!(serde_json::to_value(question).unwrap(), legacy);
        let mut multiple = legacy;
        multiple["multiSelect"] = serde_json::json!(true);
        let question: TaskInteractionQuestionV1 = serde_json::from_value(multiple.clone()).unwrap();
        assert_eq!(question.multi_select, Some(true));
        assert_eq!(serde_json::to_value(question).unwrap(), multiple);
        let answer: TaskInteractionAnswerV1 =
            serde_json::from_value(serde_json::json!({"answers":["A","B"]})).unwrap();
        assert_eq!(answer.answers, vec!["A", "B"]);
        let snapshot = serde_json::json!({"schemaVersion":1,"threadId":"thread","observationState":"unknown","items":[]});
        let parsed: TaskInteractionSnapshotV1 = serde_json::from_value(snapshot.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), snapshot);
    }
}
