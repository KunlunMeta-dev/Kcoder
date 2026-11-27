//! Per-request declaration validation; history labels and shared brokers are not authority.
use super::*;
use kcoder_types::{ClientPresentationV1, StudioWorkMode};

/// Every Studio entry uses the bound task policy, without inheriting a renderer
/// or another input's interaction capabilities from a resident Engine clone.
pub(super) fn execution_engine(engine: &QueryEngine) -> QueryEngine {
    engine
        .clone()
        .with_studio_work_mode(Some(engine.state.studio_work_mode()))
        .with_client_presentation(None)
        .with_client_questions_supported(false)
        .with_async_user_questions_supported(false)
}

pub(super) fn validate(
    state: &ConnectionState,
    declaration: Option<&ClientPresentationV1>,
    bound_mode: Option<StudioWorkMode>,
) -> Result<Option<ClientPresentationV1>> {
    let Some(value) = declaration else {
        return Ok(None);
    };
    ensure!(
        value.version == 1,
        "Unsupported clientPresentation version; expected 1"
    );
    ensure!(
        state.studio_work_modes_v1,
        "studioWorkModesV1 negotiation is required"
    );
    if value.inline_widgets {
        ensure!(
            state.inline_widgets_v1,
            "inlineWidgetsV1 negotiation is required"
        );
    }
    if value.isolated_widgets {
        ensure!(
            value.inline_widgets && state.isolated_widgets_v1,
            "isolatedWidgetsV1 negotiation and inline widgets are required"
        );
    }
    let requested = value.studio_work_mode.unwrap_or_default();
    if let Some(bound) = bound_mode {
        ensure!(
            bound == requested,
            "clientPresentation.studioWorkMode does not match this conversation; create a new conversation to switch modes"
        );
    }
    ensure!(
        !value.isolated_widgets || requested == StudioWorkMode::Kworker,
        "Isolated widgets require kworker mode"
    );
    Ok(Some(value.clone()))
}

pub(super) fn validate_creation(
    state: &ConnectionState,
    mode: Option<StudioWorkMode>,
) -> Result<()> {
    ensure!(
        mode.is_none() || state.studio_work_modes_v1,
        "studioWorkModesV1 negotiation is required"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn automatic_execution_uses_the_bound_mode_without_inheriting_client_authority() {
        let root = tempfile::tempdir().unwrap();
        let runtime = thread_runtime::test_support::test_runtime(
            "context",
            &root.path().join("history.jsonl"),
        );
        let resident = runtime
            .engine()
            .with_turn_tools(kcoder_tools::default_registry());
        resident
            .state
            .set_studio_work_mode_before_first_message(StudioWorkMode::Kworker)
            .unwrap();
        let state = ConnectionState {
            client_questions: true,
            ..Default::default()
        };
        let foreground = state.configure_turn_engine(&resident, CancellationToken::new());
        let background = execution_engine(&resident).with_client_questions_supported(true);
        assert_eq!(
            background.effective_studio_work_mode(),
            StudioWorkMode::Kworker
        );
        assert_eq!(
            foreground.effective_tool_catalog().await,
            background.effective_tool_catalog().await
        );
        assert!(
            background
                .active_tool_registry()
                .get("tool_search")
                .is_some()
        );
        assert!(background.active_tool_registry().get("read").is_some());
        resident
            .settings
            .write()
            .unwrap()
            .tools
            .disabled
            .push("read".into());
        assert!(
            execution_engine(&resident)
                .active_tool_registry()
                .get("read")
                .is_none()
        );

        let rich = resident
            .clone()
            .with_client_presentation(Some(ClientPresentationV1 {
                version: 1,
                studio_work_mode: Some(StudioWorkMode::Kworker),
                inline_widgets: true,
                isolated_widgets: true,
            }))
            .with_client_questions_supported(true)
            .with_async_user_questions_supported(true);
        let automatic = execution_engine(&rich);
        assert!(!automatic.inline_widgets_enabled());
        assert!(!automatic.isolated_widgets_enabled());
        assert!(automatic.client_presentation_snapshot().is_none());
        assert!(
            automatic
                .active_tool_registry()
                .get("AskUserQuestion")
                .is_none()
        );
        assert!(
            automatic
                .active_tool_registry()
                .get("AskUserQuestionAsync")
                .is_none()
        );
        assert_eq!(
            resident.effective_studio_work_mode(),
            StudioWorkMode::Kcoder
        );
        runtime.shutdown().await;
    }

    struct QuestionOnce(std::sync::atomic::AtomicBool);
    impl kcoder_api::Provider for QuestionOnce {
        fn name(&self) -> &'static str {
            "automatic-question-fixture"
        }
        fn stream_messages(
            &self,
            _: kcoder_types::MessagesRequest,
        ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
            let mut events = Vec::new();
            if !self.0.swap(true, Ordering::SeqCst) {
                events.push(kcoder_types::StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: kcoder_types::ContentBlock::ToolUse {
                        id: "automatic-question-call".into(), name: "AskUserQuestionAsync".into(),
                        input: json!({"questions":[{"header":"Choice", "question":"Which approach?",
                            "options":[{"label":"A","description":"First"},{"label":"B","description":"Second"}], "multi_select":false}]}),
                    },
                });
                events.push(kcoder_types::StreamEvent::ContentBlockStop { index: 0 });
            }
            events.push(kcoder_types::StreamEvent::MessageStop);
            Ok(Box::pin(futures::stream::iter(events.into_iter().map(Ok))))
        }
    }

    #[tokio::test]
    async fn automatic_execution_keeps_async_questions_only_for_the_live_original_input() {
        let root = tempfile::tempdir().unwrap();
        let runtime = thread_runtime::test_support::test_runtime_with_provider(
            &root.path().join("history.jsonl"),
            Arc::new(QuestionOnce(std::sync::atomic::AtomicBool::new(false))),
        );
        let resident = runtime.engine().with_turn_tools(
            kcoder_tools::ToolRegistry::new().register(kcoder_tools::AskUserQuestionAsyncTool),
        );
        resident.settings.write().unwrap().tools.disabled.clear();
        let state = ConnectionState {
            async_user_questions_v1: true,
            ..Default::default()
        };
        let (outbound, mut receiver) = mpsc::channel(8);
        let source =
            input_lifetime::ClientInputLifetime::capture(&state, &outbound, true, None).unwrap();
        let mut automatic = execution_engine(&resident)
            .with_async_user_questions_supported(source.interaction_capabilities().1);
        automatic.set_user_questioner(Arc::new(AppServerQuestioner {
            source_guard: Some(source.question_guard()),
            outbound_tx: outbound,
            pending: Arc::new(StdMutex::new(HashMap::new())),
            receipts: Arc::new(StdMutex::new(InteractionReceipts::default())),
            next_id: Arc::new(AtomicU64::new(1)),
            context: Arc::new(StdMutex::new(Some(QuestionContext {
                server_id: "automatic-test".into(),
                thread_id: resident.session_id(),
                turn_id: "automatic-turn".into(),
            }))),
        }));
        assert!(
            automatic
                .active_tool_registry()
                .get("AskUserQuestionAsync")
                .is_some()
        );
        automatic
            .state
            .add_message(kcoder_types::Message::user_text(
                "Continue independent work and ask asynchronously",
            ));
        let mut stream = automatic
            .run_turn_stream_for_turn(&kcoder_permissions::AutoAllowPrompt, "automatic-turn");
        let mut tool_succeeded = false;
        while let Some(event) =
            tokio::time::timeout(std::time::Duration::from_secs(10), stream.next())
                .await
                .expect("automatic turn timed out")
        {
            if let EngineEvent::ToolResult { output, .. } = event {
                assert!(
                    !output.is_error,
                    "actual asynchronous registration must succeed: {output:?}"
                );
                tool_succeeded = true;
            }
        }
        assert!(tool_succeeded);
        let questions = automatic
            .state
            .list_async_questions(&automatic.state.inspection_lifecycle_identity(), false)
            .unwrap();
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].source_turn_id, "automatic-turn");
        let change = tokio::time::timeout(std::time::Duration::from_secs(1), receiver.recv())
            .await
            .expect("question notification timed out")
            .unwrap();
        assert_eq!(
            change["method"],
            kcoder_app_protocol::method::ASYNC_QUESTION_CHANGED
        );
        state.input_ended.cancel();
        assert!(
            automatic
                .active_tool_registry()
                .get("AskUserQuestionAsync")
                .is_none()
        );
        let offline = execution_engine(&automatic)
            .with_async_user_questions_supported(source.interaction_capabilities().1);
        assert!(
            offline
                .active_tool_registry()
                .get("AskUserQuestionAsync")
                .is_none()
        );
        runtime.shutdown().await;
    }

    #[test]
    fn coding_managed_widgets_require_current_negotiation_and_never_allow_isolated_widgets() {
        let coding = ClientPresentationV1 {
            version: 1,
            studio_work_mode: Some(StudioWorkMode::Kcoder),
            inline_widgets: true,
            isolated_widgets: false,
        };
        let mut state = ConnectionState::default();
        assert!(validate(&state, Some(&coding), Some(StudioWorkMode::Kcoder)).is_err());
        state.studio_work_modes_v1 = true;
        assert!(validate(&state, Some(&coding), Some(StudioWorkMode::Kcoder)).is_err());
        state.inline_widgets_v1 = true;
        assert!(validate(&state, Some(&coding), Some(StudioWorkMode::Kcoder)).is_ok());
        assert!(validate(&state, Some(&coding), Some(StudioWorkMode::Kworker)).is_err());
        let isolated = ClientPresentationV1 {
            isolated_widgets: true,
            ..coding.clone()
        };
        assert!(validate(&state, Some(&isolated), Some(StudioWorkMode::Kcoder)).is_err());
        state.isolated_widgets_v1 = true;
        assert!(validate(&state, Some(&isolated), Some(StudioWorkMode::Kcoder)).is_err());
        let worker = ClientPresentationV1 {
            studio_work_mode: Some(StudioWorkMode::Kworker),
            ..isolated.clone()
        };
        assert!(validate(&state, Some(&worker), Some(StudioWorkMode::Kworker)).is_ok());
        assert!(
            validate(
                &state,
                Some(&ClientPresentationV1 {
                    inline_widgets: false,
                    ..worker
                }),
                Some(StudioWorkMode::Kworker)
            )
            .is_err()
        );
        assert!(
            validate(
                &state,
                Some(&ClientPresentationV1 {
                    studio_work_mode: None,
                    ..coding.clone()
                }),
                Some(StudioWorkMode::Kcoder)
            )
            .is_ok()
        );
        assert!(
            validate(
                &state,
                Some(&ClientPresentationV1 {
                    version: 2,
                    ..coding
                }),
                Some(StudioWorkMode::Kcoder)
            )
            .is_err()
        );
    }

    #[test]
    fn presentation_requires_current_declaration_capabilities_and_matching_binding() {
        let value = ClientPresentationV1 {
            version: 1,
            studio_work_mode: Some(StudioWorkMode::Kworker),
            inline_widgets: true,
            isolated_widgets: false,
        };
        let mut state = ConnectionState::default();
        assert!(validate(&state, Some(&value), Some(StudioWorkMode::Kworker)).is_err());
        assert!(
            validate(&state, None, Some(StudioWorkMode::Kworker))
                .unwrap()
                .is_none()
        );
        state.studio_work_modes_v1 = true;
        assert!(validate(&state, Some(&value), Some(StudioWorkMode::Kworker)).is_err());
        state.inline_widgets_v1 = true;
        assert!(validate(&state, Some(&value), Some(StudioWorkMode::Kworker)).is_ok());
        assert!(validate(&state, Some(&value), Some(StudioWorkMode::Kcoder)).is_err());
        assert!(
            validate(
                &state,
                Some(&ClientPresentationV1 {
                    version: 2,
                    ..value
                }),
                None
            )
            .is_err()
        );
    }
}
