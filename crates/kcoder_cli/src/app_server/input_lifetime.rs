//! Original input identity and interaction route, independent of session survival.
use super::*;

#[derive(Clone)]
pub(super) struct ClientInputLifetime {
    owner: std::sync::Weak<()>,
    ended: CancellationToken,
    pub(super) outbound: mpsc::Sender<Value>,
    client_questions: bool,
    async_user_questions: bool,
    channel_policy: Option<kcoder_types::channel_tool_restrictions::ChannelToolRestrictions>,
}

impl ClientInputLifetime {
    /// Private Native admission has its own current-source/background checks.
    /// Public input never obtains that policy through a serialized source label.
    pub(super) fn capture(
        state: &ConnectionState,
        outbound: &mpsc::Sender<Value>,
        async_user_questions: bool,
        channel_policy: Option<kcoder_types::channel_tool_restrictions::ChannelToolRestrictions>,
    ) -> Option<Self> {
        (!state.native_source_dispatch).then(|| Self {
            owner: Arc::downgrade(&state.source_management_owner),
            ended: state.input_ended.clone(),
            outbound: outbound.clone(),
            client_questions: state.client_questions,
            async_user_questions: state.async_user_questions_v1 && async_user_questions,
            channel_policy,
        })
    }

    pub(super) fn is_active(&self) -> bool {
        self.owner.upgrade().is_some() && !self.ended.is_cancelled()
    }

    pub(super) fn question_guard(&self) -> QuestionSourceGuard {
        let source = self.clone();
        Arc::new(move || source.is_active())
    }

    /// Input restrictions survive its transport, but never become task-wide grants.
    pub(super) fn apply_input_policy(&self, engine: QueryEngine) -> QueryEngine {
        match &self.channel_policy {
            Some(policy) => engine
                .with_unattended_input()
                .with_channel_tool_restrictions(policy.clone()),
            None => engine,
        }
    }

    pub(super) fn owner(&self) -> std::sync::Weak<()> {
        self.owner.clone()
    }

    /// These are protocol capabilities, not cached permission decisions.
    /// Recheck source liveness each time a continuation starts.
    pub(super) fn interaction_capabilities(&self) -> (bool, bool) {
        if self.channel_policy.is_none() && self.is_active() && !self.outbound.is_closed() {
            (self.client_questions, self.async_user_questions)
        } else {
            (false, false)
        }
    }
}

pub(super) fn question_source_guard(state: &ConnectionState) -> QuestionSourceGuard {
    let owner = Arc::downgrade(&state.source_management_owner);
    let ended = state.input_ended.clone();
    Arc::new(move || owner.upgrade().is_some() && !ended.is_cancelled())
}

impl BackgroundFollowupState {
    pub(super) fn suspend_client_continuations(&self, state: &ConnectionState) -> bool {
        // Detach cleanup disarms only the automatic source this real client
        // currently owns. A late cleanup cannot pause a newer client's, a
        // channel's or a Native source's continuation; those keep their owner.
        // Match claim_continuation_source's lock order: goals, then source.
        if state.native_source_dispatch {
            return false;
        }
        let mut goals = self.goals.lock().unwrap();
        let current = self.client_lifetime.lock().unwrap();
        let owner = Arc::downgrade(&state.source_management_owner);
        let owns = current
            .as_ref()
            .is_some_and(|source| source.channel_policy.is_none() && source.owner.ptr_eq(&owner));
        if owns {
            goals.suspend();
        }
        owns
    }

    pub(super) fn continuation_client_lifetime(&self) -> Option<ClientInputLifetime> {
        // Match goal controls' lock order. Expiry retires only the currently
        // selected source, never a newer client's continuation.
        let source = self.client_lifetime.lock().unwrap();
        source.clone()
    }

    pub(super) fn claim_continuation_source(
        &self,
        expected: &Option<ClientInputLifetime>,
        running: &AtomicBool,
    ) -> bool {
        let goals = self.goals.lock().unwrap();
        let current = self.client_lifetime.lock().unwrap();
        let same_source = match (expected, current.as_ref()) {
            (None, None) => true,
            (Some(expected), Some(current)) => expected.owner.ptr_eq(&current.owner),
            _ => false,
        };
        same_source
            && !goals.is_suspended()
            && running
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continuation_interactions_require_negotiation_request_and_current_source() {
        for negotiated in [false, true] {
            for requested in [false, true] {
                let state = ConnectionState {
                    client_questions: true,
                    async_user_questions_v1: negotiated,
                    ..Default::default()
                };
                let (output, receiver) = mpsc::channel(8);
                let source =
                    ClientInputLifetime::capture(&state, &output, requested, None).unwrap();
                assert_eq!(
                    source.interaction_capabilities(),
                    (true, negotiated && requested)
                );
                let peer = ConnectionState::default();
                peer.input_ended.cancel();
                assert_eq!(
                    source.interaction_capabilities(),
                    (true, negotiated && requested)
                );
                drop(receiver);
                assert_eq!(source.interaction_capabilities(), (false, false));
            }
        }
        let state = ConnectionState {
            client_questions: true,
            async_user_questions_v1: true,
            ..Default::default()
        };
        let (output, _receiver) = mpsc::channel(8);
        let source = ClientInputLifetime::capture(&state, &output, true, None).unwrap();
        state.input_ended.cancel();
        assert_eq!(source.interaction_capabilities(), (false, false));
        let state = ConnectionState {
            native_source_dispatch: true,
            ..Default::default()
        };
        assert!(ClientInputLifetime::capture(&state, &output, true, None).is_none());
    }

    #[tokio::test]
    async fn detach_cleanup_suspends_only_the_current_client_source() {
        let root = tempfile::tempdir().unwrap();
        let runtime =
            thread_runtime::test_support::test_runtime("owned", &root.path().join("owned.jsonl"));
        let followups = BackgroundFollowupState::default();
        // Automatic turns start disarmed; arm them as an explicit resume would.
        followups.goals.lock().unwrap().resume(&runtime.engine());
        assert!(!followups.goals.lock().unwrap().is_suspended());
        let owner = ConnectionState::default();
        let late = ConnectionState::default();
        let (output, _receiver) = mpsc::channel(8);
        // No recorded client source: nothing this client owns is paused.
        assert!(!followups.suspend_client_continuations(&owner));
        *followups.client_lifetime.lock().unwrap() =
            ClientInputLifetime::capture(&owner, &output, false, None);
        // A late cleanup from another connection cannot pause this source.
        assert!(!followups.suspend_client_continuations(&late));
        assert!(!followups.goals.lock().unwrap().is_suspended());
        let native = ConnectionState {
            native_source_dispatch: true,
            source_management_owner: owner.source_management_owner.clone(),
            ..Default::default()
        };
        assert!(!followups.suspend_client_continuations(&native));
        assert!(!followups.goals.lock().unwrap().is_suspended());
        assert!(followups.suspend_client_continuations(&owner));
        assert!(followups.goals.lock().unwrap().is_suspended());
    }

    struct ReadOnce {
        emitted: Arc<AtomicBool>,
        file: PathBuf,
    }
    impl kcoder_api::Provider for ReadOnce {
        fn name(&self) -> &'static str {
            "input-policy-read-fixture"
        }
        fn stream_messages(
            &self,
            _: kcoder_types::MessagesRequest,
        ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
            let mut events = Vec::new();
            if !self.emitted.swap(true, Ordering::SeqCst) {
                events.push(kcoder_types::StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: kcoder_types::ContentBlock::ToolUse {
                        id: uuid::Uuid::new_v4().to_string(),
                        name: "read".into(),
                        input: json!({"file_path":self.file}),
                    },
                });
                events.push(kcoder_types::StreamEvent::ContentBlockStop { index: 0 });
            } else {
                events.push(kcoder_types::StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: kcoder_types::ContentBlock::Text {
                        text: String::new(),
                    },
                });
                events.push(kcoder_types::StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: kcoder_types::ContentDelta::TextDelta {
                        text: "Fixture read finished.".into(),
                    },
                });
                events.push(kcoder_types::StreamEvent::ContentBlockStop { index: 0 });
            }
            events.push(kcoder_types::StreamEvent::MessageStop);
            Ok(Box::pin(futures::stream::iter(events.into_iter().map(Ok))))
        }
    }

    async fn read_turn(engine: &QueryEngine, turn: &str) -> kcoder_tools::ToolOutput {
        engine
            .state
            .add_message(kcoder_types::Message::user_text("Read the owned fixture"));
        let mut stream =
            engine.run_turn_stream_for_turn(&kcoder_permissions::AutoAllowPrompt, turn);
        let mut result = None;
        while let Some(event) = tokio::time::timeout(Duration::from_secs(10), stream.next())
            .await
            .unwrap()
        {
            match event {
                EngineEvent::ToolResult { name, output, .. } if name == "read" => {
                    result = Some(output);
                }
                EngineEvent::Error(error) => panic!("owned read turn failed: {error}"),
                EngineEvent::ProviderFailed { message, .. } => {
                    panic!("owned read provider failed: {message}")
                }
                _ => {}
            }
        }
        result.expect("owned read tool did not run")
    }

    #[tokio::test]
    async fn channel_continuation_keeps_restrictions_after_disconnect_without_affecting_web_input()
    {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("probe.txt");
        std::fs::write(&file, "owned fixture").unwrap();
        let emitted = Arc::new(AtomicBool::new(false));
        let runtime = thread_runtime::test_support::test_runtime_with_provider(
            &root.path().join("history.jsonl"),
            Arc::new(ReadOnce {
                emitted: emitted.clone(),
                file,
            }),
        );
        let engine = runtime.engine().with_turn_tools(
            kcoder_tools::ToolRegistry::new().register(kcoder_tools::FileReadTool),
        );
        let state = ConnectionState {
            client_questions: true,
            async_user_questions_v1: true,
            ..Default::default()
        };
        let (outbound, _output) = mpsc::channel(8);
        let source = ClientInputLifetime::capture(
            &state,
            &outbound,
            true,
            Some(
                kcoder_types::channel_tool_restrictions::ChannelToolRestrictions {
                    enabled: true,
                    disabled_tools: vec!["read".into()],
                },
            ),
        )
        .unwrap();
        for disconnected in [false, true] {
            if disconnected {
                state.input_ended.cancel();
            }
            assert_eq!(source.interaction_capabilities(), (false, false));
            let continuation =
                source.apply_input_policy(studio_presentation::execution_engine(&engine));
            assert!(!continuation.user_interaction_round_is_attended());
            assert!(continuation.active_tool_registry().get("read").is_some());
            emitted.store(false, Ordering::SeqCst);
            let output = read_turn(
                &continuation,
                if disconnected {
                    "disconnected-read"
                } else {
                    "channel-read"
                },
            )
            .await;
            assert!(output.is_error);
            assert!(
                serde_json::to_string(&output.content)
                    .unwrap()
                    .contains("CHANNEL_TOOL_DISABLED")
            );
        }
        let web_state = ConnectionState::default();
        let web = ClientInputLifetime::capture(&web_state, &outbound, false, None).unwrap();
        let web = web.apply_input_policy(studio_presentation::execution_engine(&engine));
        assert!(web.user_interaction_round_is_attended());
        emitted.store(false, Ordering::SeqCst);
        let output = read_turn(&web, "web-read").await;
        assert!(!output.is_error, "{output:?}");
        runtime.shutdown().await;
    }

    #[test]
    fn source_liveness_only_controls_its_interactions_not_session_survival() {
        let state = ConnectionState::default();
        let (output, _) = mpsc::channel(8);
        let source = ClientInputLifetime::capture(&state, &output, false, None).unwrap();
        assert!(source.is_active());
        let original_turn = CancellationToken::new();
        state.input_ended.cancel();
        assert!(!source.is_active());
        assert!(!original_turn.is_cancelled());
        let guard = source.question_guard();
        assert!(!guard());
        let guard = question_source_guard(&state);
        assert!(!guard());
        let replacement = ConnectionState::default();
        let guard = question_source_guard(&replacement);
        assert!(guard());
        drop(replacement);
        assert!(
            !guard(),
            "a question guard must not keep its original input alive"
        );
    }
}
