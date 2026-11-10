use crate::{
    LifecycleHookResult, Tool, ToolContext, ToolError, ToolOutput, clean_schema, coerce_input,
    parse_input, validate_input_against_schema,
};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

/// Register a question for a later ordinary user reply without blocking this turn.
#[derive(Debug, Default)]
pub struct AskUserQuestionAsyncTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AskUserQuestionAsyncInput {
    /// Questions to register. Must be a JSON array with 1-4 question objects.
    pub questions: Vec<AsyncQuestionInput>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AsyncQuestionInput {
    /// A single clear sentence that identifies the unresolved user decision.
    pub question: String,
    /// Short UI chip label, preferably 1-3 words and 12 or fewer characters.
    pub header: String,
    /// Two to four concrete choices. The UI supplies its own free-text option.
    pub options: Vec<AsyncQuestionOptionInput>,
    /// Whether the user may select more than one option.
    #[serde(default)]
    pub multi_select: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AsyncQuestionOptionInput {
    /// Short user-facing option label.
    pub label: String,
    /// One sentence explaining the choice's impact or trade-off.
    pub description: String,
}

fn append_lifecycle_messages(output: &mut ToolOutput, result: &LifecycleHookResult) {
    for (text, is_error) in &result.messages {
        let level = if *is_error { "error" } else { "message" };
        output.content.push(kcoder_types::ContentBlock::Text {
            text: format!("[hook:Elicitation:{level}] {text}"),
        });
    }
}

fn blocked_hook_error(result: &LifecycleHookResult) -> ToolError {
    ToolError::Execution(format!(
        "Elicitation hook blocked asynchronous user question registration: {}",
        result.block_reason()
    ))
}

fn input_error(detail: impl std::fmt::Display) -> ToolError {
    ToolError::InvalidInput(format!(
        "{detail}\nExpected shape: {{\"questions\":[{{\"question\":\"...\",\"header\":\"short_label\",\"options\":[{{\"label\":\"Option A\",\"description\":\"What happens if selected\"}},{{\"label\":\"Option B\",\"description\":\"What happens if selected\"}}],\"multi_select\":false}}]}}"
    ))
}

#[async_trait]
impl Tool for AskUserQuestionAsyncTool {
    fn name(&self) -> String {
        "AskUserQuestionAsync".to_string()
    }

    fn description(&self) -> String {
        "Register one or more user questions for a later ordinary user message, then continue immediately. This is non-blocking: accepted=true means the target session durably recorded the question, not that the user answered or authorized an action. Continue independent work; pause only actions whose correctness depends on the answer. Never use this to request permission or approval, and never sleep or wait for its answer. Use it only when this client exposes the tool and the unresolved decision materially affects the work. Input is one JSON object: {\"questions\":[{\"question\":\"...\",\"header\":\"short_label\",\"options\":[{\"label\":\"Option A\",\"description\":\"What happens if selected\"},{\"label\":\"Option B\",\"description\":\"What happens if selected\"}],\"multi_select\":false}]}. Questions is always an array; each options field has 2-4 option objects. The client supplies a free-text alternative."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(AskUserQuestionAsyncInput))
    }

    fn is_read_only(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let schema = self.input_schema();
        let mut input = input;
        coerce_input(&mut input, &schema);
        validate_input_against_schema(&input, &schema).map_err(input_error)?;
        let input: AskUserQuestionAsyncInput = parse_input(&input).map_err(input_error)?;
        validate_questions(&input.questions)?;

        let questioner = ctx
            .user_questioner
            .as_ref()
            .ok_or_else(|| ToolError::Execution("async user questioner is unavailable".into()))?;
        if !questioner.supports_async_user_questions() {
            return Err(ToolError::Execution(
                "this host does not support asynchronous user questions".into(),
            ));
        }

        // Capture the owner before checking the original turn's task. A stale
        // ToolContext must not borrow the lifecycle of a successor session.
        let owner = ctx.state.inspection_lifecycle_identity();
        let source_turn_id = ctx
            .native_web_source_identity
            .as_ref()
            .filter(|identity| identity.thread_id == ctx.state.session_id())
            .map(|identity| identity.turn_id.clone())
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                ToolError::Execution(
                    "the current turn identity is unavailable; question was not registered".into(),
                )
            })?;
        let tool_call_id = ctx
            .tool_call_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                ToolError::Execution(
                    "the current tool call identity is unavailable; question was not registered"
                        .into(),
                )
            })?
            .to_string();
        let request = kcoder_types::async_user_questions::AsyncQuestionRequest {
            source_turn_id,
            tool_call_id,
            questions: input
                .questions
                .into_iter()
                .map(
                    |question| kcoder_types::async_user_questions::AsyncQuestionItemDraft {
                        header: question.header,
                        question: question.question,
                        options: question
                            .options
                            .into_iter()
                            .map(|option| {
                                kcoder_types::async_user_questions::AsyncQuestionOptionDraft {
                                    label: option.label,
                                    description: option.description,
                                }
                            })
                            .collect(),
                        multi_select: question.multi_select,
                    },
                )
                .collect(),
        };

        // Hooks can yield to cancellation or session replacement. Registration
        // must retain the lifecycle checked against the original turn above.
        let elicitation = ctx
            .emit_lifecycle_hook(
                "Elicitation",
                "AskUserQuestionAsync",
                serde_json::json!({
                    "request": request.clone(),
                    "source": "AskUserQuestionAsync",
                }),
            )
            .await?;
        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }
        if elicitation.should_block() {
            return Err(blocked_hook_error(&elicitation));
        }

        let accepted = questioner
            .register_async_user_question(&ctx.state, &owner, request)
            .await
            .map_err(|error| {
                ToolError::Execution(format!(
                    "failed to durably register asynchronous user question: {error}"
                ))
            })?;
        if !accepted.accepted {
            return Err(ToolError::Execution(
                "the target did not durably accept the asynchronous user question".into(),
            ));
        }

        let mut output = ToolOutput::text(
            serde_json::json!({
                "accepted": true,
                "questionId": accepted.question.question_id,
            })
            .to_string(),
        );
        append_lifecycle_messages(&mut output, &elicitation);
        Ok(output)
    }
}

fn validate_questions(questions: &[AsyncQuestionInput]) -> Result<(), ToolError> {
    if questions.is_empty() || questions.len() > 4 {
        return Err(input_error(format!(
            "$.questions: expected 1-4 question objects, but got {}",
            questions.len()
        )));
    }
    for (question_index, question) in questions.iter().enumerate() {
        if question.question.trim().is_empty() {
            return Err(input_error(format!(
                "$.questions[{question_index}].question: question text cannot be empty"
            )));
        }
        if question.header.trim().is_empty() {
            return Err(input_error(format!(
                "$.questions[{question_index}].header: header cannot be empty"
            )));
        }
        if !(2..=4).contains(&question.options.len()) {
            return Err(input_error(format!(
                "$.questions[{question_index}].options: expected 2-4 option objects, but got {}",
                question.options.len()
            )));
        }
        for (option_index, option) in question.options.iter().enumerate() {
            if option.label.trim().is_empty() {
                return Err(input_error(format!(
                    "$.questions[{question_index}].options[{option_index}].label: label cannot be empty"
                )));
            }
            if option.description.trim().is_empty() {
                return Err(input_error(format!(
                    "$.questions[{question_index}].options[{option_index}].description: description cannot be empty"
                )));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::user_question::UserQuestioner;
    use kcoder_state::AppState;
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct StateQuestioner {
        calls: Arc<Mutex<usize>>,
    }

    #[async_trait]
    impl UserQuestioner for StateQuestioner {
        fn supports_async_user_questions(&self) -> bool {
            true
        }

        async fn register_async_user_question(
            &self,
            state: &AppState,
            owner: &kcoder_state::AppStateLifecycleIdentity,
            request: kcoder_types::async_user_questions::AsyncQuestionRequest,
        ) -> Result<kcoder_types::async_user_questions::AsyncQuestionAccepted, String> {
            *self.calls.lock().unwrap() += 1;
            state
                .register_async_question(owner, request)
                .map_err(|error| error.to_string())
        }

        async fn ask(
            &self,
            _request: crate::user_question::UserQuestionRequest,
        ) -> Result<crate::user_question::UserQuestionResponse, String> {
            Err("synchronous question flow must not be used".into())
        }
    }

    fn input() -> Value {
        serde_json::json!({
            "questions": [{
                "question": "Which implementation should be used?",
                "header": "Approach",
                "options": [
                    {"label": "A", "description": "Use the first implementation."},
                    {"label": "B", "description": "Use the second implementation."}
                ],
                "multi_select": false
            }]
        })
    }

    fn context(state: &AppState, questioner: Arc<dyn UserQuestioner>) -> ToolContext {
        let identity = kcoder_types::TurnAttemptIdentity {
            thread_id: state.session_id(),
            turn_id: "actual-turn-7".into(),
            attempt_id: "actual-attempt-2".into(),
        };
        ToolContext::new(state.clone())
            .with_user_questioner(questioner)
            .with_tool_call_id("provider-call-44")
            .with_native_web_source_identity(Some(identity))
    }

    fn output_json(output: &ToolOutput) -> Value {
        let Some(kcoder_types::ContentBlock::Text { text }) = output.content.first() else {
            panic!("async question tool should return JSON text");
        };
        serde_json::from_str(text).unwrap()
    }

    #[tokio::test]
    async fn async_question_is_durably_registered_and_same_call_is_idempotent() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        state.with_history_path(root.path().join("session.jsonl"));
        let backend = StateQuestioner {
            calls: Arc::new(Mutex::new(0)),
        };
        let ctx = context(&state, Arc::new(backend.clone()));

        let first = AskUserQuestionAsyncTool.call(input(), &ctx).await.unwrap();
        let second = AskUserQuestionAsyncTool.call(input(), &ctx).await.unwrap();
        let first = output_json(&first);
        let second = output_json(&second);

        assert_eq!(first["accepted"], true);
        assert_eq!(first["questionId"], second["questionId"]);
        assert_eq!(*backend.calls.lock().unwrap(), 2);
    }

    #[tokio::test]
    async fn async_question_requires_actual_turn_and_call_identity() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        state.with_history_path(root.path().join("session.jsonl"));
        let backend = Arc::new(StateQuestioner {
            calls: Arc::new(Mutex::new(0)),
        });
        let no_call_id = ToolContext::new(state.clone())
            .with_user_questioner(backend.clone())
            .with_native_web_source_identity(Some(kcoder_types::TurnAttemptIdentity {
                thread_id: state.session_id(),
                turn_id: "actual-turn-7".into(),
                attempt_id: "actual-attempt-2".into(),
            }));
        assert!(
            AskUserQuestionAsyncTool
                .call(input(), &no_call_id)
                .await
                .is_err()
        );

        let no_turn = ToolContext::new(state.clone())
            .with_user_questioner(backend.clone())
            .with_tool_call_id("provider-call-44");
        assert!(
            AskUserQuestionAsyncTool
                .call(input(), &no_turn)
                .await
                .is_err()
        );
        assert_eq!(*backend.calls.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn async_question_rejects_a_context_from_the_previous_session() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        state.with_history_path(root.path().join("original.jsonl"));
        let backend = Arc::new(StateQuestioner {
            calls: Arc::new(Mutex::new(0)),
        });
        let ctx = context(&state, backend.clone());
        let original_thread_id = state.session_id();

        // A queued tool can retain its original turn identity after State moves
        // to a successor session. It must not register there using a new owner.
        state.start_new_session().unwrap();
        state.with_history_path(root.path().join("successor.jsonl"));
        assert_ne!(state.session_id(), original_thread_id);
        let result = AskUserQuestionAsyncTool.call(input(), &ctx).await;
        assert!(
            result.is_err(),
            "an old turn registered a question in its successor"
        );
        assert_eq!(*backend.calls.lock().unwrap(), 0);
        let owner = state.inspection_lifecycle_identity();
        assert!(state.list_async_questions(&owner, true).unwrap().is_empty());
    }

    struct PausedElicitation {
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }

    #[async_trait]
    impl crate::LifecycleHookEmitter for PausedElicitation {
        async fn emit(&self, event: &str, _query: String, _data: Value) -> LifecycleHookResult {
            assert_eq!(event, "Elicitation");
            self.entered.notify_one();
            self.release.notified().await;
            LifecycleHookResult::default()
        }
    }

    #[tokio::test]
    async fn async_question_rejects_cancellation_or_session_replacement_during_elicitation() {
        for replace_session in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let state = AppState::new(root.path());
            state.with_history_path(root.path().join("session.jsonl"));
            let backend = Arc::new(StateQuestioner {
                calls: Arc::new(Mutex::new(0)),
            });
            let hook = Arc::new(PausedElicitation {
                entered: tokio::sync::Notify::new(),
                release: tokio::sync::Notify::new(),
            });
            let cancel = tokio_util::sync::CancellationToken::new();
            let ctx = context(&state, backend.clone())
                .with_abort_token(cancel.clone())
                .with_lifecycle_hooks(hook.clone());
            let registration =
                tokio::spawn(async move { AskUserQuestionAsyncTool.call(input(), &ctx).await });
            hook.entered.notified().await;
            if replace_session {
                state.start_new_session().unwrap();
            } else {
                cancel.cancel();
            }
            hook.release.notify_one();
            let result = registration.await.unwrap();
            assert!(
                result.is_err(),
                "stale registration succeeded (replace_session={replace_session})"
            );
            let owner = state.inspection_lifecycle_identity();
            assert!(state.list_async_questions(&owner, true).unwrap().is_empty());
            if !replace_session {
                assert!(matches!(result, Err(ToolError::Aborted)));
                assert_eq!(*backend.calls.lock().unwrap(), 0);
            }
        }
    }
}
