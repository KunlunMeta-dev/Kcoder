//! Finite UI control for async questions on a task already resumed on its owner.
use super::*;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelPeerTaskAsyncQuestion {
    pub scope: IntegrationScope,
    pub source_authority_epoch: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding_ref: Option<IntegrationRevisionRef>,
    pub operation: ChannelPeerTaskAsyncQuestionOperation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "method", content = "params", deny_unknown_fields)]
pub enum ChannelPeerTaskAsyncQuestionOperation {
    #[serde(rename = "asyncQuestion/list")]
    List(crate::AsyncQuestionListParams),
    #[serde(rename = "asyncQuestion/answer")]
    Answer(crate::AsyncQuestionAnswerParams),
    #[serde(rename = "asyncQuestion/cancel")]
    Cancel(crate::AsyncQuestionCancelParams),
}

impl ChannelPeerTaskAsyncQuestion {
    pub fn thread_id(&self) -> &str {
        self.operation.thread_id()
    }

    pub fn method(&self) -> &'static str {
        self.operation.method()
    }

    pub fn params(&self) -> Result<serde_json::Value, serde_json::Error> {
        self.operation.params()
    }

    pub fn validate(&self) -> Result<(), String> {
        self.scope.validate().map_err(|_| invalid())?;
        if let Some(binding) = &self.binding_ref {
            binding.validate().map_err(|_| invalid())?;
        }
        if self.source_authority_epoch == 0 {
            return Err(invalid());
        }
        self.operation.validate()
    }
}

impl ChannelPeerTaskAsyncQuestionOperation {
    pub fn thread_id(&self) -> &str {
        match self {
            Self::List(params) => &params.thread_id,
            Self::Answer(params) => &params.thread_id,
            Self::Cancel(params) => &params.thread_id,
        }
    }

    pub fn method(&self) -> &'static str {
        match self {
            Self::List(_) => crate::method::ASYNC_QUESTION_LIST,
            Self::Answer(_) => crate::method::ASYNC_QUESTION_ANSWER,
            Self::Cancel(_) => crate::method::ASYNC_QUESTION_CANCEL,
        }
    }

    pub fn params(&self) -> Result<serde_json::Value, serde_json::Error> {
        match self {
            Self::List(params) => serde_json::to_value(params),
            Self::Answer(params) => serde_json::to_value(params),
            Self::Cancel(params) => serde_json::to_value(params),
        }
    }

    fn validate(&self) -> Result<(), String> {
        let valid = match self {
            Self::List(params) => params.validate(),
            Self::Answer(params) => params.validate(),
            Self::Cancel(params) => params.validate(),
        };
        valid.map_err(|_| invalid())?;
        if matches!(self, Self::Answer(params) if params.async_user_questions == Some(false)) {
            return Err(invalid());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "operation", content = "result", rename_all = "snake_case")]
pub enum ChannelPeerTaskAsyncQuestionResult {
    List(crate::AsyncQuestionListResult),
    Answer(crate::AsyncQuestionAnswerResult),
    Cancel(crate::AsyncQuestionCancelResult),
}

impl ChannelPeerTaskAsyncQuestionResult {
    pub fn thread_id(&self) -> &str {
        match self {
            Self::List(result) => &result.thread_id,
            Self::Answer(result) => &result.thread_id,
            Self::Cancel(result) => &result.thread_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn request() -> ChannelPeerTaskAsyncQuestion {
        serde_json::from_value(serde_json::json!({
            "scope": {"accountId":"owner","targetId":"target","workspaceId":"workspace",
                "identityGeneration":"1","targetRevision":"1"},
            "sourceAuthorityEpoch":1,
            "bindingRef":{"id":"binding","revision":"4"},
            "operation":{"method":"asyncQuestion/list","params":{"threadId":"task","includeTerminal":true}}
        }))
        .unwrap()
    }

    #[test]
    fn finite_operations_keep_thread_and_do_not_accept_answer_authority_overrides() {
        let list = request();
        assert_eq!(list.method(), crate::method::ASYNC_QUESTION_LIST);
        assert_eq!(list.thread_id(), "task");
        assert!(list.validate().is_ok());

        let mut answer = request();
        answer.operation =
            ChannelPeerTaskAsyncQuestionOperation::Answer(crate::AsyncQuestionAnswerParams {
                thread_id: "task".into(),
                question_id: "question".into(),
                submission_id: "submission".into(),
                expected_revision: 1,
                answers: BTreeMap::new(),
                async_user_questions: Some(false),
            });
        assert!(answer.validate().is_err());
        if let ChannelPeerTaskAsyncQuestionOperation::Answer(params) = &mut answer.operation {
            params.async_user_questions = Some(true);
            params.answers.insert(
                "item".into(),
                kcoder_types::async_user_questions::AsyncQuestionAnswerValue {
                    selected_option_ids: vec!["option".into()],
                    text: None,
                },
            );
        }
        assert_eq!(answer.method(), crate::method::ASYNC_QUESTION_ANSWER);
        assert!(answer.validate().is_ok());

        let mut mismatched = request();
        mismatched.operation =
            ChannelPeerTaskAsyncQuestionOperation::Cancel(crate::AsyncQuestionCancelParams {
                thread_id: "other-task".into(),
                question_id: "question".into(),
                expected_revision: 1,
            });
        assert_eq!(mismatched.thread_id(), "other-task");
        assert!(mismatched.validate().is_ok());
    }
}
