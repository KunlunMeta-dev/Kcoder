use super::*;

fn recorded_summary_prompt(provider: &RecordingProvider) -> String {
    let requests = provider.requests.lock().unwrap();
    let request = requests.first().expect("one summary request recorded");
    request
        .messages
        .iter()
        .map(|message| message.preview(usize::MAX))
        .collect::<Vec<_>>()
        .join("\n")
}

#[tokio::test]
async fn compact_reuses_complete_prefire_without_provider_request() {
    let provider = Arc::new(RecordingProvider::default());
    let compactor = test_compactor(provider.clone());
    let messages = messages_with_summarizable_history();
    let summary =
        "complete cached summary\n\nRecent messages are preserved verbatim.\nKEEP_THIS_EARLY_FACT";
    let note = PrefireNote::new(&split_for_compaction(&messages).old, summary.into());
    let mut request = test_compaction_request(messages);
    request.prefire = Some(note);
    let result = compactor.compact(request, 60_000).await.unwrap();
    assert!(result.did_compact && result.used_prefire);
    assert_eq!(result.summary, summary);
    assert!(
        provider.requests.lock().unwrap().is_empty(),
        "no delta means no second model call"
    );
}

#[tokio::test]
async fn compact_complete_prefire_does_not_bypass_new_instructions_or_validation() {
    for (summary, instructions) in [
        (
            "cached",
            Some("preserve the newest hook instruction".to_string()),
        ),
        ("[Tool use unknown_id: bash with {}]", None),
        ("", None),
    ] {
        let provider = Arc::new(RecordingProvider::default());
        let compactor = test_compactor(provider.clone());
        let messages = messages_with_summarizable_history();
        let note = PrefireNote::new(&split_for_compaction(&messages).old, summary.into());
        let mut request = test_compaction_request(messages);
        request.prefire = Some(note);
        request.custom_instructions = instructions;
        let result = compactor.compact(request, 60_000).await.unwrap();
        assert!(!result.used_prefire);
        assert_eq!(provider.requests.lock().unwrap().len(), 1);
        assert!(recorded_summary_prompt(&provider).contains("user 0"));
    }
}

#[tokio::test]
async fn compact_complete_prefire_still_requires_context_reduction() {
    let provider = Arc::new(RecordingProvider::default());
    let compactor = test_compactor(provider.clone());
    let messages = messages_with_summarizable_history();
    let note = PrefireNote::new(&split_for_compaction(&messages).old, "cached".into());
    let mut request = test_compaction_request(messages);
    request.prefire = Some(note);
    let error = compactor.compact(request, 1).await.unwrap_err();
    assert!(error.to_string().contains("did not reduce context"));
    assert!(provider.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn compact_uses_prefire_note_for_delta_only_summarization() {
    let provider = Arc::new(RecordingProvider::default());
    let compactor = test_compactor(provider.clone());
    let messages = messages_with_summarizable_history();
    let split = split_for_compaction(&messages);
    assert!(split.old.len() >= 4);
    let covered = split.old.len() - 2;
    let note = PrefireNote::new(
        &split.old[..covered],
        "pass-1 background summary".to_string(),
    );

    let mut request = test_compaction_request(messages);
    request.prefire = Some(note);
    let result = compactor
        .compact(request, 60_000)
        .await
        .expect("compaction should succeed");

    assert!(result.did_compact);
    assert!(result.used_prefire);
    let prompt = recorded_summary_prompt(&provider);
    assert!(prompt.contains("pass-1 background summary"), "{prompt}");
    assert!(
        prompt.contains("user 2") || prompt.contains("assistant 3"),
        "{prompt}"
    );
    assert!(!prompt.contains("user 0"), "{prompt}");
}

#[tokio::test]
async fn compact_rejects_prefire_after_earlier_prefix_edit() {
    let provider = Arc::new(RecordingProvider::default());
    let compactor = test_compactor(provider.clone());
    let mut messages = messages_with_summarizable_history();
    let covered = split_for_compaction(&messages).old.len() - 2;
    let note = PrefireNote::new(&messages[..covered], "stale summary".into());
    messages[0] = Message::user_text("corrected early requirement");
    let mut request = test_compaction_request(messages);
    request.prefire = Some(note);
    let result = compactor.compact(request, 60_000).await.unwrap();
    assert!(
        !result.used_prefire,
        "an unchanged last message cannot prove an unchanged prefix"
    );
    assert!(recorded_summary_prompt(&provider).contains("corrected early requirement"));
}

#[test]
fn prefire_identity_covers_tool_payload_and_role_and_allows_append() {
    let prefix = vec![
        Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: "call".into(),
                name: "bash".into(),
                input: serde_json::json!({"command":"ls"}),
            }],
            usage: None,
        },
        Message::User {
            origin: kcoder_types::MessageOrigin::Unknown,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "call".into(),
                content: vec![ContentBlock::Text {
                    text: "old output".into(),
                }],
                is_error: Some(false),
            }],
        },
        Message::user_text("unchanged tail"),
    ];
    let note = PrefireNote::new(&prefix, "summary".into());
    let mut current = prefix.clone();
    current.push(Message::user_text("new request"));
    assert!(note.matches(&current));
    let mut changed = current.clone();
    if let Message::Assistant { content, .. } = &mut changed[0]
        && let ContentBlock::ToolUse { input, .. } = &mut content[0]
    {
        *input = serde_json::json!({"command":"pwd"});
    }
    assert!(!note.matches(&changed));
    changed = current.clone();
    if let Message::User { content, .. } = &mut changed[1]
        && let ContentBlock::ToolResult { content, .. } = &mut content[0]
    {
        *content = vec![ContentBlock::Text {
            text: "corrected output".into(),
        }];
    }
    assert!(!note.matches(&changed));
    current[2] = Message::assistant_text("unchanged tail");
    assert!(!note.matches(&current));
    assert!(!note.matches(&prefix[..2]));
    assert!(!PrefireNote::new(&[], "empty".into()).matches(&prefix));
}

#[tokio::test]
async fn compact_ignores_stale_prefire_note_and_summarizes_full_prefix() {
    let provider = Arc::new(RecordingProvider::default());
    let compactor = test_compactor(provider.clone());
    let messages = messages_with_summarizable_history();
    let split = split_for_compaction(&messages);
    let covered = split.old.len() - 2;
    // Fingerprint no longer matches: the note claims coverage of a prefix
    // whose last message differs from the actual conversation.
    let mut stale_prefix = split.old[..covered].to_vec();
    stale_prefix[covered - 1] = Message::user_text("tampered tail");
    let note = PrefireNote::new(&stale_prefix, "stale".to_string());

    let mut request = test_compaction_request(messages);
    request.prefire = Some(note);
    let result = compactor
        .compact(request, 60_000)
        .await
        .expect("compaction should succeed");

    assert!(result.did_compact);
    assert!(!result.used_prefire);
    let prompt = recorded_summary_prompt(&provider);
    assert!(prompt.contains("user 0"), "{prompt}");
}
