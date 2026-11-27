use crate::{
    EngineEvent, QueryEngine,
    test_support::{engine_builder::TestEngineBuilder, owned_case},
};
use futures::StreamExt;
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_config::{PermissionMode, Settings};
use kcoder_tools::{FileWriteTool, ToolRegistry};
use kcoder_types::{
    ContentBlock, ContentDelta, Message, MessageDeltaFields, MessagesRequest,
    ProviderResponseLimits, StreamEvent,
};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Clone, Copy, Debug)]
enum Failure {
    Truncated,
    Malformed,
    InvalidEscape,
    ToolLimit,
    TotalLimit,
    TokenLimitOpen,
    Cancel,
    Deadline,
    Repeated,
    RepeatedMalformed,
    Duplicate,
    FullWriteLimit,
}
#[derive(Debug)]
struct RecoveryProvider {
    failure: Failure,
    root: PathBuf,
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
}
impl Provider for RecoveryProvider {
    fn name(&self) -> &'static str {
        "owned-write-argument-recovery"
    }
    fn response_limits(&self) -> ProviderResponseLimits {
        match self.failure {
            Failure::Truncated
            | Failure::Malformed
            | Failure::InvalidEscape
            | Failure::TokenLimitOpen
            | Failure::Cancel
            | Failure::Deadline
            | Failure::Repeated
            | Failure::RepeatedMalformed
            | Failure::Duplicate
            | Failure::FullWriteLimit => ProviderResponseLimits::default(),
            Failure::ToolLimit => ProviderResponseLimits {
                tool_arguments_bytes: 128,
                total_decoded_bytes: 4096,
                ..Default::default()
            },
            Failure::TotalLimit => ProviderResponseLimits {
                tool_arguments_bytes: 128,
                total_decoded_bytes: 128,
                ..Default::default()
            },
        }
    }
    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        let mut requests = self.requests.lock().unwrap();
        let call = requests.len();
        requests.push(request);
        drop(requests);
        let events = match call {
            0 => failed_response(self.failure),
            1 if matches!(self.failure, Failure::Repeated) => failed_response(Failure::Truncated),
            1 if matches!(self.failure, Failure::RepeatedMalformed) => {
                failed_response(Failure::Malformed)
            }
            1 => {
                assert!(
                    !self.root.join("result.txt").exists(),
                    "the rejected write must have no file effect"
                );
                assert!(!self.root.join("must-not-run.txt").exists());
                let input =
                    serde_json::json!({"file_path":"result.txt","content":"small scaffold"});
                vec![
                    start(0, "write-good"),
                    delta(0, input.to_string()),
                    StreamEvent::ContentBlockStop { index: 0 },
                    StreamEvent::MessageStop,
                ]
            }
            2 => vec![
                StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::Text {
                        text: "WRITE_ARGUMENT_RECOVERED".into(),
                    },
                },
                StreamEvent::ContentBlockStop { index: 0 },
                StreamEvent::MessageStop,
            ],
            _ => panic!("unbounded tool regeneration: {call}"),
        };
        let wait = call == 0 && matches!(self.failure, Failure::Cancel | Failure::Deadline);
        Ok(Box::pin(async_stream::stream! {
            for event in events { yield Ok(event); }
            if wait { std::future::pending::<()>().await; }
        }))
    }
}
fn start(index: usize, id: &str) -> StreamEvent {
    StreamEvent::ContentBlockStart {
        index,
        content_block: ContentBlock::ToolUse {
            id: id.into(),
            name: "write".into(),
            input: serde_json::json!({}),
        },
    }
}
fn delta(index: usize, value: String) -> StreamEvent {
    StreamEvent::ContentBlockDelta {
        index,
        delta: ContentDelta::InputJsonDelta {
            partial_json: value,
        },
    }
}
fn failed_response(failure: Failure) -> Vec<StreamEvent> {
    let mut events = Vec::new();
    let index = if matches!(failure, Failure::TotalLimit) {
        events.extend([
            StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text {
                    text: "T".repeat(64),
                },
            },
            StreamEvent::ContentBlockStop { index: 0 },
        ]);
        1
    } else {
        0
    };
    events.push(start(index, "write-bad"));
    events.push(delta(
        index,
        r#"{"file_path":"result.txt","content":""#.into(),
    ));
    match failure {
        Failure::Malformed | Failure::RepeatedMalformed | Failure::InvalidEscape => {
            let partial = if matches!(failure, Failure::InvalidEscape) {
                r#"{"file_path":"result.txt","content":"PRIVATE_PARTIAL_MUST_NOT_ENTER_HISTORY\q"}"#
            } else {
                r#"{"file_path":"result.txt" "content":"PRIVATE_PARTIAL_MUST_NOT_ENTER_HISTORY"}"#
            };
            let error = serde_json::from_str::<serde_json::Value>(partial).unwrap_err();
            assert!(error.is_syntax() && !error.is_eof());
            let split = partial.len() / 2;
            events = vec![
                start(0, "write-sibling"),
                delta(
                    0,
                    serde_json::json!({"file_path":"must-not-run.txt","content":"unexecuted"})
                        .to_string(),
                ),
                StreamEvent::ContentBlockStop { index: 0 },
                start(1, "write-bad"),
                delta(1, partial[..split].into()),
                delta(1, partial[split..].into()),
                StreamEvent::ContentBlockStop { index: 1 },
                StreamEvent::MessageStop,
            ];
        }
        Failure::Truncated => {
            events.push(delta(
                index,
                "PRIVATE_PARTIAL_MUST_NOT_ENTER_HISTORY".into(),
            ));
            events.push(StreamEvent::ContentBlockStop { index });
            events.push(StreamEvent::MessageDelta {
                delta: MessageDeltaFields {
                    stop_reason: Some("max_tokens".into()),
                    stop_sequence: None,
                    usage: None,
                },
            });
            events.push(StreamEvent::MessageStop);
        }
        Failure::ToolLimit => events.push(delta(index, "X".repeat(256))),
        Failure::TotalLimit => events.push(delta(index, "X".repeat(60))),
        Failure::TokenLimitOpen => {
            events.push(StreamEvent::MessageDelta {
                delta: MessageDeltaFields {
                    stop_reason: Some("max_tokens".into()),
                    stop_sequence: None,
                    usage: None,
                },
            });
            events.push(StreamEvent::MessageStop);
        }
        Failure::Cancel | Failure::Deadline => {}
        Failure::Repeated => {
            events.push(delta(
                index,
                "PRIVATE_PARTIAL_MUST_NOT_ENTER_HISTORY".into(),
            ));
            events.push(StreamEvent::ContentBlockStop { index });
        }
        Failure::Duplicate => {
            // The first complete sibling and the truncated call use the same ID.
            events = vec![
                start(0, "write-bad"),
                delta(
                    0,
                    serde_json::json!({"file_path":"must-not-run.txt","content":"unexecuted"})
                        .to_string(),
                ),
                StreamEvent::ContentBlockStop { index: 0 },
                start(1, "write-bad"),
                delta(1, r#"{"file_path":"result.txt","content":""#.into()),
                StreamEvent::ContentBlockStop { index: 1 },
            ];
        }
        Failure::FullWriteLimit => {
            let input = serde_json::json!({"file_path":"result.txt","content":"x".repeat(kcoder_tools::write::MAX_WRITE_CONTENT_BYTES + 1)});
            events = vec![
                start(0, "write-too-large"),
                delta(0, input.to_string()),
                StreamEvent::ContentBlockStop { index: 0 },
                StreamEvent::MessageStop,
            ];
        }
    }
    events
}
fn fixture(
    root: &Path,
    failure: Failure,
    retries: usize,
) -> (QueryEngine, Arc<Mutex<Vec<MessagesRequest>>>) {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mut settings = Settings {
        permission_mode: PermissionMode::Bypass,
        max_retries: retries,
        retry_base_delay_ms: 0,
        ..Default::default()
    };
    if matches!(failure, Failure::Deadline) {
        settings.recovery.provider.total_timeout_ms = Some(100);
    }
    let engine = TestEngineBuilder::new(root)
        .owned_test_fixture()
        .provider(Arc::new(RecoveryProvider {
            failure,
            root: root.into(),
            requests: requests.clone(),
        }))
        .settings(settings)
        .tool_registry(ToolRegistry::new().register(FileWriteTool))
        .build_with_profile_directory();
    engine.state.add_message(Message::user_text(
        "Write the requested artifact in small complete steps.",
    ));
    (engine, requests)
}
async fn run(failure: Failure, retries: usize) {
    let root = owned_case::owned_tempdir();
    let (engine, requests) = fixture(root.path(), failure, retries);
    let mut events = Vec::new();
    let mut stream = engine.run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 4);
    while let Some(event) = stream.next().await {
        if matches!(failure, Failure::Cancel)
            && matches!(event, EngineEvent::ToolInputPreview { .. })
        {
            engine.cancel_token().cancel();
        }
        events.push(event);
    }
    drop(stream);
    assert!(events.iter().any(|event| matches!(event, EngineEvent::ToolDenied { id, reason, .. } if id == "write-bad" && (reason.to_lowercase().contains("not executed") || matches!(failure, Failure::Duplicate) && reason.contains("ambiguous")))),
        "the incomplete write needs a definite pre-dispatch terminal event, not TUI unknown: {events:?}");
    assert!(!engine.state.messages().iter().any(|message| matches!(message, Message::Assistant { content, .. } if content.iter().any(|block| matches!(block, ContentBlock::ToolUse { id, .. } if id == "write-bad")))));
    assert!(
        !serde_json::to_string(&engine.state.messages())
            .unwrap()
            .contains("PRIVATE_PARTIAL_MUST_NOT_ENTER_HISTORY")
    );
    assert!(!root.path().join("must-not-run.txt").exists());
    let requests = requests.lock().unwrap();
    if matches!(
        failure,
        Failure::Repeated | Failure::RepeatedMalformed | Failure::Duplicate
    ) {
        assert_eq!(
            requests.len(),
            if matches!(failure, Failure::Repeated | Failure::RepeatedMalformed) {
                2
            } else {
                1
            }
        );
        assert!(!root.path().join("result.txt").exists());
        assert!(!root.path().join("must-not-run.txt").exists());
        assert!(
            events
                .iter()
                .any(|event| matches!(event, EngineEvent::ProviderFailed { .. }))
        );
    } else if matches!(failure, Failure::Cancel | Failure::Deadline) {
        assert_eq!(requests.len(), 1);
        assert!(!root.path().join("result.txt").exists());
        if matches!(failure, Failure::Cancel) {
            assert!(events.iter().any(|event| matches!(event, EngineEvent::StreamAborted { reason } if reason == "cancelled by user")));
        } else {
            assert!(events.iter().any(
                |event| matches!(event, EngineEvent::Error(text) if text.contains("deadline"))
            ));
        }
    } else if retries == 0 {
        assert_eq!(requests.len(), 1);
        assert!(!root.path().join("result.txt").exists());
        assert!(
            events
                .iter()
                .any(|event| matches!(event, EngineEvent::ProviderFailed { .. }))
        );
    } else {
        assert_eq!(
            requests.len(),
            3,
            "the same turn should regenerate one small call then finish"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("result.txt")).unwrap(),
            "small scaffold"
        );
        assert!(events.iter().any(|event| matches!(event, EngineEvent::AssistantTextDelta(text) if text == "WRITE_ARGUMENT_RECOVERED")));
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, EngineEvent::ProviderFailed { .. }))
        );
        assert_eq!(requests[0].model, requests[1].model);
        let repair = serde_json::to_string(&requests[1].messages).unwrap();
        if matches!(failure, Failure::Malformed | Failure::InvalidEscape) {
            assert!(repair.contains("invalid") && repair.contains("JSON"));
        }
        assert!(
            repair.contains(&kcoder_tools::write::MAX_WRITE_CONTENT_BYTES.to_string())
                && repair.contains("replaces the entire file")
                && repair.contains("small"),
            "feedback must describe the real write contract and chunk strategy"
        );
    }
}
macro_rules! owned_test {
    ($name:ident) => {
        #[test]
        fn $name() {
            owned_case::run_owned_case(
                concat!(module_path!(), "::write_recovery_dispatcher"),
                stringify!($name),
            );
        }
    };
}
owned_test!(max_tokens_write_is_settled_and_regenerated_with_small_complete_input);
owned_test!(malformed_tool_json_is_rejected_then_regenerated);
owned_test!(invalid_json_escape_is_rejected_then_regenerated);
owned_test!(malformed_tool_json_stops_at_configured_budget);
owned_test!(malformed_tool_json_respects_disabled_retries);
owned_test!(actual_tool_argument_budget_is_settled_and_regenerated);
owned_test!(actual_total_response_budget_is_settled_and_regenerated);
owned_test!(disabled_retry_budget_still_settles_the_incomplete_write);
owned_test!(explicit_max_tokens_with_open_block_regenerates_without_guessing_json);
owned_test!(cancellation_settles_the_undispatched_write_without_retry);
owned_test!(deadline_settles_the_undispatched_write_without_retry);
owned_test!(exhausted_regeneration_still_settles_the_next_incomplete_call);
owned_test!(duplicate_tool_ids_reject_regeneration_without_any_write);
owned_test!(full_write_limit_with_native_guard);
owned_test!(malformed_tool_json_with_native_guard);
#[test]
#[ignore = "owned dispatcher, invoked by each exact parent regression"]
fn write_recovery_dispatcher() {
    let case = owned_case::owned_case();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        match case.as_str() {
            "malformed_tool_json_is_rejected_then_regenerated" => run(Failure::Malformed, 2).await,
            "invalid_json_escape_is_rejected_then_regenerated" => {
                run(Failure::InvalidEscape, 2).await
            }
            "malformed_tool_json_stops_at_configured_budget" => {
                run(Failure::RepeatedMalformed, 1).await
            }
            "malformed_tool_json_respects_disabled_retries" => run(Failure::Malformed, 0).await,
            "max_tokens_write_is_settled_and_regenerated_with_small_complete_input" => {
                run(Failure::Truncated, 2).await
            }
            "actual_tool_argument_budget_is_settled_and_regenerated" => {
                run(Failure::ToolLimit, 2).await
            }
            "actual_total_response_budget_is_settled_and_regenerated" => {
                run(Failure::TotalLimit, 2).await
            }
            "disabled_retry_budget_still_settles_the_incomplete_write" => {
                run(Failure::Truncated, 0).await
            }
            "explicit_max_tokens_with_open_block_regenerates_without_guessing_json" => {
                run(Failure::TokenLimitOpen, 2).await
            }
            "cancellation_settles_the_undispatched_write_without_retry" => {
                run(Failure::Cancel, 2).await
            }
            "deadline_settles_the_undispatched_write_without_retry" => {
                run(Failure::Deadline, 2).await
            }
            "exhausted_regeneration_still_settles_the_next_incomplete_call" => {
                run(Failure::Repeated, 1).await
            }
            "duplicate_tool_ids_reject_regeneration_without_any_write" => {
                run(Failure::Duplicate, 2).await
            }
            "full_write_limit_with_native_guard" => {
                recovery_with_native_guard(Failure::FullWriteLimit, 0).await
            }
            "malformed_tool_json_with_native_guard" => {
                recovery_with_native_guard(Failure::Malformed, 2).await
            }
            other => panic!("unknown owned write recovery case: {other}"),
        }
    });
}

struct AcceptedWriteAuthority {
    state: kcoder_state::AppState,
    identity: kcoder_types::TurnAttemptIdentity,
    store: kcoder_state::turn_attempt_store::TurnAttemptStore,
}
impl AcceptedWriteAuthority {
    fn verify(
        &self,
        witness: &crate::integrations::core::NativeToolExecutionWitness,
    ) -> Result<(), crate::integrations::core::NativeToolAuthorizationError> {
        use crate::integrations::core::NativeToolAuthorizationError as Error;
        if !witness.matches_state(&self.state)
            || witness.attempt() != Some(&self.identity)
            || witness.parent().is_some()
        {
            return Err(Error::Denied);
        }
        if !self
            .store
            .load(&self.identity)
            .map_err(|_| Error::Unavailable)?
            .is_some_and(|record| {
                record.status == kcoder_types::TurnAttemptStatus::Accepted
                    && record.completion.is_none()
            })
        {
            return Err(Error::Unavailable);
        }
        Ok(())
    }
}
#[async_trait::async_trait]
impl crate::integrations::core::NativeToolAuthorization for AcceptedWriteAuthority {
    async fn authorize_provider(
        &self,
        execution: &crate::integrations::core::NativeToolExecutionWitness,
    ) -> Result<(), crate::integrations::core::NativeToolAuthorizationError> {
        self.verify(execution)
    }
    async fn authorize_event(
        &self,
        frame: &crate::integrations::core::NativeEngineEventFrame,
    ) -> Result<(), crate::integrations::core::NativeToolAuthorizationError> {
        self.verify(frame.execution())?;
        if frame.has_tool_identity() && frame.tool().is_none() {
            return Err(crate::integrations::core::NativeToolAuthorizationError::Denied);
        }
        Ok(())
    }
    async fn authorize(
        &self,
        request: &crate::integrations::core::NativeToolAuthorizationRequest<'_>,
    ) -> Result<(), crate::integrations::core::NativeToolAuthorizationError> {
        use crate::integrations::core::NativeToolAuthorizationError as Error;
        self.verify(request.execution.ok_or(Error::Unavailable)?)?;
        if request.tool_name != "write"
            || request.without_sandbox
            || request
                .emitter
                .and_then(|witness| witness.downcast_tool::<FileWriteTool>())
                .is_none()
        {
            return Err(Error::Denied);
        }
        Ok(())
    }
}
async fn recovery_with_native_guard(failure: Failure, retries: usize) {
    use crate::integrations::core::NativeToolAuthorization;
    use kcoder_state::turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore};
    let root = owned_case::owned_tempdir();
    let (engine, requests) = fixture(root.path(), failure, retries);
    let identity = kcoder_types::TurnAttemptIdentity {
        thread_id: engine.session_id(),
        turn_id: "owned-write-turn".into(),
        attempt_id: "owned-write-attempt".into(),
    };
    let store = TurnAttemptStore::open(
        &engine.session_storage_dir_for(&engine.session_id()),
        &engine.session_id(),
    )
    .unwrap();
    store
        .begin(TurnAttemptRecord {
            client_presentation: None,
            version: 1,
            identity: identity.clone(),
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: 1,
            input_context_hash: "b".repeat(64),
            request_fingerprint: None,
            retained_input: None,
            status: kcoder_types::TurnAttemptStatus::Accepted,
            completion: None,
        })
        .unwrap();
    let authority = Arc::new(AcceptedWriteAuthority {
        state: engine.state.clone(),
        identity: identity.clone(),
        store,
    });
    let engine = engine
        .with_native_tool_authorization(authority.clone())
        .with_native_tool_ceiling(&["write".into()])
        .unwrap();
    let events = engine
        .state
        .history_attempt_scope(identity)
        .unwrap()
        .run(async {
            let mut stream = engine
                .run_native_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 4);
            let mut events = Vec::new();
            while let Some(frame) = stream.next().await {
                authority.authorize_event(&frame).await.unwrap();
                events.push(frame.into_event());
            }
            events
        })
        .await;
    assert_eq!(
        requests.lock().unwrap().len(),
        3,
        "a rejected input must be fed back before a corrected call and final answer"
    );
    if matches!(failure, Failure::FullWriteLimit) {
        assert!(events.iter().any(|event| matches!(event, EngineEvent::ToolResult { id, output, .. } if id == "write-too-large" && output.is_error)));
    } else {
        assert!(
            events.iter().any(
                |event| matches!(event, EngineEvent::ToolDenied { id, .. } if id == "write-bad")
            )
        );
        assert!(events.iter().any(|event| matches!(event, EngineEvent::ToolResult { id, output, .. } if id == "write-sibling" && output.is_error)));
        assert!(
            !serde_json::to_string(&requests.lock().unwrap()[1].messages)
                .unwrap()
                .contains("PRIVATE_PARTIAL_MUST_NOT_ENTER_HISTORY")
        );
    }
    assert!(!root.path().join("must-not-run.txt").exists());
    assert!(events.iter().any(|event| matches!(event, EngineEvent::ToolResult { id, output, .. } if id == "write-good" && !output.is_error)));
    assert!(events.iter().any(|event| matches!(event, EngineEvent::AssistantTextDelta(text) if text == "WRITE_ARGUMENT_RECOVERED")));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::ProviderFailed { .. }))
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("result.txt")).unwrap(),
        "small scaffold"
    );
}
