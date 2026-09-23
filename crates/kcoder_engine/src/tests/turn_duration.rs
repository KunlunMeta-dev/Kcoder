#[derive(Debug)]
struct SlowFirstCallProvider {
    batches: Vec<Vec<StreamEvent>>,
    first_delay: std::time::Duration,
    subsequent_delay: std::time::Duration,
    calls: Arc<Mutex<usize>>,
}

impl Provider for SlowFirstCallProvider {
    fn name(&self) -> &'static str {
        "slow-first-call"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let mut calls = self.calls.lock().unwrap();
        let attempt = *calls;
        *calls += 1;
        let batch = self
            .batches
            .get(attempt)
            .or_else(|| self.batches.last())
            .cloned()
            .unwrap_or_default();
        let delay = if attempt == 0 {
            Some(self.first_delay)
        } else if !self.subsequent_delay.is_zero() {
            Some(self.subsequent_delay)
        } else {
            None
        };
        drop(calls);
        let stream = async_stream::stream! {
            if let Some(delay) = delay {
                tokio::time::sleep(delay).await;
            }
            for event in batch {
                yield Ok(event);
            }
        };
        Ok(Box::pin(stream))
    }
}

#[tokio::test]
async fn max_duration_nudges_wrap_up_near_the_soft_deadline() {
    let calls = Arc::new(Mutex::new(0));
    let provider = SlowFirstCallProvider {
        batches: vec![
            sleep_tool_call_events(0),
            simple_text_events("wrapped up in time"),
        ],
        first_delay: std::time::Duration::from_millis(9200),
        subsequent_delay: std::time::Duration::ZERO,
        calls: Arc::clone(&calls),
    };
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        max_duration_secs: Some(10),
        ..Settings::default()
    };
    let engine = test_engine_with_settings(Arc::new(provider), tmp.path(), settings);
    engine.state.add_message(Message::user_text("go"));

    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;

    // After the ~9.2s first call the elapsed time is past the 90% mark
    // (9s of 10s), with enough scheduling headroom for parallel Windows
    // test runs. The follow-up text response completes the turn normally.
    assert!(events.iter().any(|event| {
        matches!(event, EngineEvent::SystemNotice(text) if text.contains("wrap-up nudge sent"))
    }));
    assert!(
        engine.state.messages().iter().any(|message| message
            .preview(4096)
            .contains("time budget for this task is almost exhausted")),
        "the wrap-up nudge must be recorded in the conversation"
    );
    assert_eq!(*calls.lock().unwrap(), 2);
    assert!(
        engine
            .state
            .messages()
            .iter()
            .any(|message| message.preview(4096).contains("wrapped up in time"))
    );
    assert!(!events.iter().any(|event| {
        matches!(event, EngineEvent::SystemNotice(text) if text.contains("Max duration reached"))
    }));
}

#[tokio::test]
async fn max_duration_grants_one_closing_subturn_when_nudge_never_fired() {
    let calls = Arc::new(Mutex::new(0));
    let provider = SlowFirstCallProvider {
        batches: vec![
            sleep_tool_call_events(1),
            simple_text_events("final answer on disk"),
        ],
        first_delay: std::time::Duration::from_millis(1200),
        subsequent_delay: std::time::Duration::ZERO,
        calls: Arc::clone(&calls),
    };
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        max_duration_secs: Some(1),
        ..Settings::default()
    };
    let engine = test_engine_with_settings(Arc::new(provider), tmp.path(), settings);
    engine.state.add_message(Message::user_text("go"));

    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;

    // The first call (~2.2s with its tool) exhausts the 1s budget in one
    // stretch, so the 90% nudge is skipped entirely; the turn instead
    // grants exactly one bounded closing sub-turn for deliverables.
    assert!(events.iter().any(|event| {
        matches!(event, EngineEvent::SystemNotice(text) if text.contains("final wrap-up nudge"))
    }));
    assert!(
        engine
            .state
            .messages()
            .iter()
            .any(|message| message.preview(4096).contains("LAST action window")),
        "the final wrap-up nudge must be recorded in the conversation"
    );
    assert!(
        engine.state.messages().iter().any(|message| {
            let text = message.preview(4096);
            text.contains("must preserve every original task constraint")
                && text.contains("read-only or forbids file changes")
        }),
        "the final nudge must preserve read-only and no-write constraints"
    );
    assert_eq!(
        *calls.lock().unwrap(),
        2,
        "exactly one closing sub-turn is granted before the turn ends"
    );
    assert!(
        engine
            .state
            .messages()
            .iter()
            .any(|message| message.preview(4096).contains("final answer on disk"))
    );
    assert!(events.iter().any(|event| {
        matches!(event, EngineEvent::StreamAborted { reason } if reason == "max_duration")
    }));
}

#[tokio::test]
async fn max_duration_ends_without_duplicate_nudge_once_warned_at_ninety_percent() {
    let calls = Arc::new(Mutex::new(0));
    let provider = SlowFirstCallProvider {
        batches: vec![
            sleep_tool_call_events(1),
            sleep_tool_call_events(1),
            simple_text_events("must not be called"),
        ],
        first_delay: std::time::Duration::from_millis(3700),
        subsequent_delay: std::time::Duration::from_millis(1000),
        calls: Arc::clone(&calls),
    };
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        max_duration_secs: Some(4),
        ..Settings::default()
    };
    let engine = test_engine_with_settings(Arc::new(provider), tmp.path(), settings);
    engine.state.add_message(Message::user_text("go"));

    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;

    // The first boundary lands in the 90% window (~3.7s of 4s), so the
    // wrap-up nudge fires there. The follow-up call (1s) pushes elapsed
    // past 100%; the turn then ends gracefully without a duplicate or
    // "final" nudge and without a third provider call.
    assert_eq!(*calls.lock().unwrap(), 2);
    assert!(events.iter().any(|event| {
        matches!(event, EngineEvent::SystemNotice(text) if text.contains("wrap-up nudge sent"))
    }));
    assert!(events.iter().any(|event| {
            matches!(event, EngineEvent::SystemNotice(text) if text.contains("ending the turn gracefully"))
        }));
    assert!(!events.iter().any(|event| {
        matches!(event, EngineEvent::SystemNotice(text) if text.contains("final wrap-up nudge"))
    }));
    assert!(events.iter().any(|event| {
        matches!(event, EngineEvent::StreamAborted { reason } if reason == "max_duration")
    }));
    assert!(
        !engine
            .state
            .messages()
            .iter()
            .any(|message| message.preview(4096).contains("LAST action window")),
        "a turn already warned at 90% must not receive the final nudge"
    );
}
