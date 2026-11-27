use super::*;
use crate::{event::EngineEvent, test_support::engine_builder::TestEngineBuilder};
use futures::StreamExt;
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_types::{ContentBlock, ContentDelta, Message, MessagesRequest, StreamEvent};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

struct OwnedProvider {
    calls: AtomicUsize,
    first_fails: bool,
    message_start: bool,
}
impl Provider for OwnedProvider {
    fn name(&self) -> &'static str {
        "owned-input-proof"
    }
    fn stream_messages(&self, _: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if call == 0 && self.first_fails {
            return Err(ApiErrorKind::Api {
                error_type: "invalid_request_error".into(),
                message: "owned fixture rejected before response".into(),
            });
        }
        let mut events = Vec::new();
        if self.message_start {
            events.push(Ok(StreamEvent::MessageStart {
                message: kcoder_types::StreamingMessage {
                    id: "owned-message".into(),
                    role: "assistant".into(),
                    content: Vec::new(),
                    model: "owned".into(),
                    stop_reason: None,
                    stop_sequence: None,
                    usage: None,
                },
            }));
        }
        events.extend([
            Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text {
                    text: String::new(),
                },
            }),
            Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta {
                    text: "owned response".into(),
                },
            }),
            Ok(StreamEvent::ContentBlockStop { index: 0 }),
            Ok(StreamEvent::MessageStop),
        ]);
        Ok(Box::pin(futures::stream::iter(events)))
    }
}

async fn check_two_real_provider_requests(first_fails: bool, message_start: bool) {
    let root = kcoder_config::create_private_temp_dir("continuous-handoff-response-proof").unwrap();
    let provider = Arc::new(OwnedProvider {
        calls: AtomicUsize::new(0),
        first_fails,
        message_start,
    });
    let settings = kcoder_config::Settings {
        max_retries: 0,
        ..Default::default()
    };
    let engine = TestEngineBuilder::new(root.path())
        .settings(settings)
        .provider(provider.clone())
        .build_with_profile_directory();
    engine
        .state
        .with_history_path(root.path().join("history.jsonl"));
    let owner = engine.state.inspection_lifecycle_identity();
    let pending = match engine
        .state
        .try_begin_user_input(&owner, Message::user_text("original owned input"))
    {
        kcoder_state::UserInputStart::Accepted(pending) => pending,
        _ => panic!("original input must be admitted"),
    };
    let committed = pending.wait_with_witness().await.unwrap();
    let (tx, rx) = oneshot::channel();
    scope_thread(engine.state.session_id(), tx, async {
        publish(&committed);
        assert_eq!(rx.await.unwrap().uuid(), committed.uuid());
        let first = engine.run_turn_stream(&kcoder_permissions::AutoAllowPrompt).collect::<Vec<_>>().await;
        assert_eq!(first.iter().any(|e| matches!(e, EngineEvent::AssistantMessageStarted)), !first_fails, "first events: {first:?}");
        assert_eq!(current_provider_request_includes(&committed), !first_fails,
            "only an actual first response may establish observation");
        // Simulate a repaired/compacted request after the first attempt. The
        // second actual Provider request no longer shares the original input.
        engine.state.set_messages(vec![Message::user_text("replacement owned input")]);
        let second = engine.run_turn_stream(&kcoder_permissions::AutoAllowPrompt).collect::<Vec<_>>().await;
        assert!(second.iter().any(|e| matches!(e, EngineEvent::AssistantMessageStarted)), "second events: {second:?}");
        assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
        assert_eq!(current_provider_request_includes(&committed), !first_fails,
            "only a response to a request carrying the original input establishes durable observation");
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn prior_response_with_original_survives_later_repaired_request() {
    for message_start in [false, true] {
        check_two_real_provider_requests(false, message_start).await;
    }
}

#[tokio::test(flavor = "current_thread")]
async fn earlier_failed_request_cannot_borrow_later_response_without_original() {
    for message_start in [false, true] {
        check_two_real_provider_requests(true, message_start).await;
    }
}

struct NoopTool;
#[async_trait::async_trait]
impl kcoder_tools::Tool for NoopTool {
    fn name(&self) -> String {
        "owned_noop".into()
    }
    fn description(&self) -> String {
        "Owned deterministic test tool".into()
    }
    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({"type":"object","properties":{}})
    }
    async fn call(
        &self,
        _: serde_json::Value,
        _: &kcoder_tools::ToolContext,
    ) -> Result<kcoder_tools::ToolOutput, kcoder_tools::ToolError> {
        Ok(kcoder_tools::ToolOutput::text("owned result"))
    }
}

struct TwoRequestProvider {
    input: std::sync::Mutex<Option<CommittedUserInput>>,
    included: std::sync::Mutex<Vec<bool>>,
}
impl Provider for TwoRequestProvider {
    fn name(&self) -> &'static str {
        "owned-two-request-proof"
    }
    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        let includes = self
            .input
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .is_shared_in(&request.messages);
        let mut observed = self.included.lock().unwrap();
        observed.push(includes);
        let first = observed.len() == 1;
        drop(observed);
        let events = if first {
            vec![
                Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::ToolUse {
                        id: "owned-call".into(),
                        name: "owned_noop".into(),
                        input: serde_json::json!({}),
                    },
                }),
                Ok(StreamEvent::ContentBlockStop { index: 0 }),
                Ok(StreamEvent::MessageStop),
            ]
        } else {
            vec![
                Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::Text {
                        text: String::new(),
                    },
                }),
                Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::TextDelta {
                        text: "owned response".into(),
                    },
                }),
                Ok(StreamEvent::ContentBlockStop { index: 0 }),
                Ok(StreamEvent::MessageStop),
            ]
        };
        Ok(Box::pin(futures::stream::iter(events)))
    }
}

#[tokio::test(flavor = "current_thread")]
async fn one_real_turn_preserves_prior_response_after_history_rewrite() {
    let root = kcoder_config::create_private_temp_dir("continuous-handoff-one-turn").unwrap();
    let provider = Arc::new(TwoRequestProvider {
        input: std::sync::Mutex::new(None),
        included: std::sync::Mutex::new(Vec::new()),
    });
    let mut settings = kcoder_config::Settings {
        max_retries: 0,
        permission_mode: kcoder_config::PermissionMode::Bypass,
        ..Default::default()
    };
    settings.model_capabilities.tools = true;
    let engine = TestEngineBuilder::new(root.path())
        .settings(settings)
        .provider(provider.clone())
        .tool_registry(kcoder_tools::ToolRegistry::new().register(NoopTool))
        .build_with_profile_directory();
    engine
        .state
        .with_history_path(root.path().join("history.jsonl"));
    let owner = engine.state.inspection_lifecycle_identity();
    let pending = match engine
        .state
        .try_begin_user_input(&owner, Message::user_text("original owned input"))
    {
        kcoder_state::UserInputStart::Accepted(pending) => pending,
        _ => panic!("original input must be admitted"),
    };
    let committed = pending.wait_with_witness().await.unwrap();
    *provider.input.lock().unwrap() = Some(committed.clone());
    let (tx, rx) = oneshot::channel();
    scope_thread(engine.state.session_id(), tx, async {
        publish(&committed);
        assert_eq!(rx.await.unwrap().uuid(), committed.uuid());
        let prompt = kcoder_permissions::AutoAllowPrompt;
        let mut stream = engine.run_turn_stream(&prompt);
        let mut starts = 0;
        while let Some(event) = stream.next().await {
            if matches!(event, EngineEvent::AssistantMessageStarted) {
                starts += 1;
                if starts == 1 {
                    assert!(current_provider_request_includes(&committed));
                    engine
                        .state
                        .set_messages(vec![Message::user_text("replacement owned input")]);
                }
            }
        }
        assert_eq!(starts, 2);
        assert_eq!(&*provider.included.lock().unwrap(), &[true, false]);
        assert!(current_provider_request_includes(&committed));
    })
    .await;
}
