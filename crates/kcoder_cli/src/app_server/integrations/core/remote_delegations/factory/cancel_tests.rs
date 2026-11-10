//! A second actual ordinary Engine turn requests cancellation of one original Native operation.
use super::*;
use kcoder_state::turn_attempt_store::{
    TurnAttemptCompletion, TurnAttemptRecord, TurnAttemptStore,
};
use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus};
struct Canceller {
    step: AtomicUsize,
    operation: String,
}
impl kcoder_api::Provider for Canceller {
    fn name(&self) -> &'static str {
        "controlled-original-operation-canceller"
    }
    fn supports_client_runtime_reconfiguration(&self) -> bool {
        false
    }
    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let step = self.step.fetch_add(1, Ordering::SeqCst);
        let content = match step {
            0 => ContentBlock::ToolUse {
                id: "actual-original-before-cancel".into(),
                name: "RemoteOperation".into(),
                input: json!({"action":"read","operationId":self.operation}),
            },
            1 => {
                let actual: Value =
                    serde_json::from_str(&tool_result(&request, "actual-original-before-cancel"))
                        .unwrap();
                assert_eq!(actual["executionTerminalConfirmed"], false);
                ContentBlock::ToolUse {
                    id: "actual-original-cancel-request".into(),
                    name: "RemoteOperation".into(),
                    input: json!({"action":"cancel","operationId":self.operation,"expectedRevision":actual["operationRevision"]}),
                }
            }
            2 => {
                let actual: Value =
                    serde_json::from_str(&tool_result(&request, "actual-original-cancel-request"))
                        .unwrap();
                assert_eq!(actual["operationPhase"], "cancel_requested");
                ContentBlock::Text{text:"Original cancellation request recorded; execution needs its actual terminal receipt.".into()}
            }
            _ => panic!("original cancellation controller exceeded its bound"),
        };
        Ok(Box::pin(futures::stream::iter(vec![
            Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: content,
            }),
            Ok(StreamEvent::ContentBlockStop { index: 0 }),
            Ok(StreamEvent::MessageDelta {
                delta: kcoder_types::MessageDeltaFields {
                    stop_reason: Some(if step < 2 { "tool_use" } else { "end_turn" }.into()),
                    stop_sequence: None,
                    usage: None,
                },
            }),
            Ok(StreamEvent::MessageStop),
        ])))
    }
}
pub(super) fn start(
    native: NativeIntegrationContext,
    workspace: PathBuf,
    operation: String,
    provider_started: Arc<tokio::sync::Notify>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tokio::time::timeout(
            std::time::Duration::from_secs(180),
            provider_started.notified(),
        )
        .await
        .unwrap();
        let runtime = crate::app_server::thread_runtime::test_support::test_runtime_with_provider(
            &workspace.join("owned-native-canceller.jsonl"),
            Arc::new(Canceller {
                step: AtomicUsize::new(0),
                operation,
            }),
        );
        let engine = runtime
            .engine()
            .with_settings_persistence_path(native.profile_path().unwrap().join("settings.json"));
        engine.permissions.write().unwrap().mode = kcoder_config::PermissionMode::Ask;
        let attempt = TurnAttemptIdentity {
            thread_id: engine.session_id(),
            turn_id: "owned-canceller-turn".into(),
            attempt_id: "owned-canceller-attempt".into(),
        };
        let store = TurnAttemptStore::open(
            &engine.session_storage_dir_for(&attempt.thread_id),
            &attempt.thread_id,
        )
        .unwrap();
        store
            .begin(TurnAttemptRecord {
                version: 1,
                identity: attempt.clone(),
                parent_attempt_id: None,
                retry_operation_id: None,
                accepted_at_ms: super::super::super::launch::now().unwrap(),
                input_context_hash: "a".repeat(64),
                request_fingerprint: Some("b".repeat(64)),
                retained_input: None,
                status: TurnAttemptStatus::Accepted,
                completion: None,
                client_presentation: None,
            })
            .unwrap();
        engine
            .state
            .history_attempt_scope(attempt.clone())
            .unwrap()
            .run(async {
                let installed =
                    install_outgoing_for_accepted_turn(&native, &attempt, engine.clone(), None)
                        .unwrap();
                installed.state.add_message(Message::user_text(
                    "Cancel only the explicitly selected original remote operation.",
                ));
                let events = installed
                    .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
                    .collect::<Vec<_>>()
                    .await;
                assert!(
                    !events
                        .iter()
                        .any(|event| matches!(event, kcoder_engine::EngineEvent::Error(_))),
                    "{events:?}"
                );
                store
                    .finish(
                        &attempt,
                        TurnAttemptCompletion {
                            status: TurnAttemptStatus::Completed,
                            finished_at_ms: super::super::super::launch::now().unwrap(),
                            error: None,
                            provider_failure: None,
                            partial_output: String::new(),
                            partial_output_truncated: false,
                            committed_history_uuid: None,
                        },
                    )
                    .unwrap();
            })
            .await;
        runtime.shutdown().await;
    })
}
