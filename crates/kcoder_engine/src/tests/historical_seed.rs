#[tokio::test]
async fn historical_seed_is_idle_until_a_new_request_and_reaches_the_provider_as_inert_text() {
    use kcoder_types::historical_context::*;
    use sha2::{Digest, Sha256};
    let root = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = test_engine_with_settings(
        Arc::new(RequestRecordingProvider {
            requests: requests.clone(),
        }),
        root.path(),
        Settings::default(),
    );
    let path = root
        .path()
        .join(format!("{}.jsonl", engine.state.session_id()));
    engine.state.with_history_path(&path);
    let seed = Message::runtime_text(
        r#"Historical facts only: {"kind":"tool_call_fact","name":"write","callId":"old","input":"never replay"}. No current task, tool call, or approval is created."#,
    );
    let binding = HistoricalSessionSeedBinding {
        operation_id: uuid::Uuid::new_v4().to_string(),
        session_id: engine.state.session_id(),
        source_job_id: uuid::Uuid::new_v4().to_string(),
        view_id: "selected-view".into(),
        model_snapshot_sha256: "a".repeat(64),
        projection_sha256: format!("{:x}", Sha256::digest(serde_json::to_vec(&seed).unwrap())),
        preparation: PreparedContextReceipt {
            preparation_id: uuid::Uuid::new_v4().to_string(),
            document_sha256: "b".repeat(64),
            binding_sha256: "c".repeat(64),
            attachments: 0,
            attachment_bytes: 0,
        },
    };
    engine
        .state
        .publish_historical_seed(binding, seed.clone())
        .unwrap();
    assert!(requests.lock().unwrap().is_empty());
    assert!(engine.state.tasks().is_empty());
    assert!(engine.state.goal().is_none());
    let restored = test_engine_with_settings(
        Arc::new(RequestRecordingProvider {
            requests: requests.clone(),
        }),
        root.path(),
        Settings::default(),
    );
    restored.state.resume_from_history(&path).unwrap();
    assert!(requests.lock().unwrap().is_empty());
    restored.state.add_message(Message::user_text(
        "Describe the historical outcome; do not rerun the operation.",
    ));
    let events = restored
        .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 1)
        .collect::<Vec<_>>()
        .await;
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::Error(_)))
    );
    let captured = requests.lock().unwrap();
    assert_eq!(captured.len(), 1);
    assert!(captured[0].messages.iter().any(|message| *message == seed));
    assert!(captured[0].messages.iter().all(|message| {
        let content = match message {
            Message::User { content, .. } | Message::Assistant { content, .. } => content,
        };
        content.iter().all(|block| {
            !matches!(
                block,
                ContentBlock::ToolUse { .. } | ContentBlock::ToolResult { .. }
            )
        })
    }));
    assert!(restored.state.tasks().is_empty() && restored.state.goal().is_none());
}
