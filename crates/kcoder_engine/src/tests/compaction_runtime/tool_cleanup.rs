use super::*;

#[tokio::test]
async fn summary_boundary_is_preserved_while_suffix_tool_results_are_recompressed() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = lifecycle_test_engine(tmp.path());
    let new_result = "new suffix result ".repeat(80);

    engine.state.set_messages(vec![
        Message::user_text("Earlier conversation summary: previous compact summary"),
        assistant_tool_use("new-read", "read"),
        user_tool_result("new-read", new_result),
        Message::assistant_text("latest assistant response"),
    ]);

    let result = engine.perform_compaction(false).await.unwrap();

    assert_eq!(result.summary, "");
    let messages = engine.state.messages();
    assert!(
        messages[0]
            .preview(1000)
            .starts_with("Earlier conversation summary:")
    );
    assert_eq!(
        tool_result_text(&messages[2]),
        crate::context::TOOL_RESULT_CLEARED_MESSAGE
    );
}

#[tokio::test]
async fn threshold_micro_compact_revokes_duplicate_read_suppression_but_keeps_stale_write_snapshot()
{
    let tmp = tempfile::tempdir().unwrap();
    let engine = lifecycle_test_engine(tmp.path());
    let path = tmp.path().join("old-read.txt");
    let modified = std::time::UNIX_EPOCH + std::time::Duration::from_secs(42);
    engine.state.record_read_tool_snapshot(
        path.clone(),
        Some("snapshot content".to_string()),
        Some(modified),
        None,
        None,
    );
    engine
        .state
        .record_read_tool_call_key("old-read", path.clone(), None, None);
    engine.state.set_messages(vec![
        assistant_tool_use("old-read", "read"),
        user_tool_result("old-read", "small read result".to_string()),
        Message::assistant_text("latest assistant response"),
    ]);

    let no_op = engine.perform_compaction(false).await.unwrap();

    assert!(!no_op.did_compact);
    assert!(
        engine
            .state
            .file_read_snapshot(&path)
            .unwrap()
            .from_read_tool
    );

    engine.state.set_messages(vec![
        assistant_tool_use("old-read", "read"),
        user_tool_result("old-read", "large read result ".repeat(80)),
        Message::assistant_text("latest assistant response"),
    ]);

    let result = engine.perform_compaction(false).await.unwrap();

    assert!(!result.did_compact);
    assert_eq!(
        tool_result_text(&engine.state.messages()[1]),
        crate::context::TOOL_RESULT_CLEARED_MESSAGE
    );
    let snapshot = engine.state.file_read_snapshot(&path).unwrap();
    assert!(!snapshot.from_read_tool);
    assert_eq!(snapshot.content.as_deref(), Some("snapshot content"));
    assert_eq!(snapshot.modified, Some(modified));
}

#[tokio::test]
async fn actual_oversized_tool_result_is_reduced_before_the_next_request() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        context_window_tokens: Some(10_000),
        context_output_headroom: Some(2_000),
        estimated_tool_growth_tokens: Some(1_000),
        max_tokens: Some(2_000),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    engine.state.set_messages(vec![
        Message::user_text("run the command"),
        assistant_tool_use("huge-bash", "bash"),
        user_tool_result("huge-bash", "ACTUAL_TOOL_RESULT ".repeat(8_000)),
    ]);
    let budget = engine.context_budget();
    assert!(TokenCounter::count(&engine.state.messages()) > budget.hard_input_limit());

    assert!(!engine.maybe_compact_conversation(1).await);

    let visible = engine
        .state
        .messages()
        .iter()
        .map(|message| message.preview(20_000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(visible.contains("<persisted-output>"));
    assert!(TokenCounter::count(&engine.state.messages()) < budget.hard_input_limit());
    assert_eq!(
        requests.load(Ordering::SeqCst),
        0,
        "工具存储层已恢复安全预算时不应再消耗一次 summary 请求"
    );
}

#[test]
fn engine_applies_time_based_micro_compact_before_cold_main_turn() {
    let tmp = tempfile::tempdir().unwrap();
    let mut settings = Settings::default();
    settings.time_based_micro_compact.gap_threshold_minutes = 0;
    settings.time_based_micro_compact.keep_recent = 1;
    let engine = test_engine_with_settings(Arc::new(EmptyProvider), tmp.path(), settings);
    engine.state.add_message(Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: "old-call".to_string(),
            name: "bash".to_string(),
            input: serde_json::json!({"command":"old"}),
        }],
        usage: None,
    });
    engine.state.add_message(Message::User {
        origin: kcoder_types::MessageOrigin::Unknown,
        content: vec![ContentBlock::ToolResult {
            tool_use_id: "old-call".to_string(),
            content: vec![ContentBlock::Text {
                text: "old output".to_string(),
            }],
            is_error: Some(false),
        }],
    });
    engine.state.add_message(Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: "recent-call".to_string(),
            name: "read".to_string(),
            input: serde_json::json!({"file_path":"recent.rs"}),
        }],
        usage: None,
    });
    engine.state.add_message(Message::User {
        origin: kcoder_types::MessageOrigin::Unknown,
        content: vec![ContentBlock::ToolResult {
            tool_use_id: "recent-call".to_string(),
            content: vec![ContentBlock::Text {
                text: "recent output".to_string(),
            }],
            is_error: Some(false),
        }],
    });
    engine.state.add_message(Message::assistant_text("ready"));
    engine.state.add_message(Message::user_text("continue"));

    assert_eq!(engine.maybe_apply_time_based_micro_compact(), 1);

    let rendered = engine
        .state
        .messages()
        .iter()
        .map(|message| message.preview(2_000))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(rendered.contains(crate::context::tool_storage::TOOL_RESULT_CLEARED_MESSAGE));
    assert!(rendered.contains("recent output"));
}

#[test]
fn time_based_micro_compact_revokes_duplicate_read_suppression_but_keeps_stale_write_snapshot() {
    let tmp = tempfile::tempdir().unwrap();
    let mut settings = Settings::default();
    settings.time_based_micro_compact.gap_threshold_minutes = 0;
    settings.time_based_micro_compact.keep_recent = 1;
    let engine = test_engine_with_settings(Arc::new(EmptyProvider), tmp.path(), settings);
    let path = tmp.path().join("old-read.txt");
    let modified = std::time::UNIX_EPOCH + std::time::Duration::from_secs(42);
    engine.state.record_read_tool_snapshot(
        path.clone(),
        Some("snapshot content".to_string()),
        Some(modified),
        None,
        None,
    );
    engine
        .state
        .record_read_tool_call_key("old-read", path.clone(), None, None);
    for message in [
        assistant_tool_use("old-read", "read"),
        user_tool_result("old-read", "old read output".to_string()),
        Message::assistant_text("ready"),
        Message::user_text("continue"),
    ] {
        engine.state.add_message(message);
    }

    assert_eq!(engine.maybe_apply_time_based_micro_compact(), 0);
    assert!(
        engine
            .state
            .file_read_snapshot(&path)
            .unwrap()
            .from_read_tool
    );

    let recent_path = tmp.path().join("recent-call.txt");
    engine.state.record_read_tool_snapshot(
        recent_path.clone(),
        Some("recent snapshot".to_string()),
        Some(modified),
        None,
        None,
    );
    engine
        .state
        .record_read_tool_call_key("recent-call", recent_path.clone(), None, None);

    for message in [
        assistant_tool_use("recent-call", "read"),
        user_tool_result("recent-call", "recent read output".to_string()),
        Message::assistant_text("ready again"),
        Message::user_text("continue again"),
    ] {
        engine.state.add_message(message);
    }

    assert_eq!(engine.maybe_apply_time_based_micro_compact(), 1);

    assert_eq!(
        tool_result_text(&engine.state.messages()[1]),
        crate::context::TOOL_RESULT_CLEARED_MESSAGE
    );
    let snapshot = engine.state.file_read_snapshot(&path).unwrap();
    assert!(!snapshot.from_read_tool);
    assert!(snapshot.anchor_pending);
    assert_eq!(snapshot.content.as_deref(), Some("snapshot content"));
    assert_eq!(snapshot.modified, Some(modified));
    let recent_snapshot = engine.state.file_read_snapshot(&recent_path).unwrap();
    assert!(recent_snapshot.from_read_tool);
    assert!(!recent_snapshot.anchor_pending);
}

#[tokio::test]
async fn early_tool_cleanup_stops_after_three_passes_without_early_summary() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let settings = Settings {
        auto_compact_threshold_tokens: Some(2_000),
        prefire_threshold_tokens: Some(1_999),
        ..settings_using_main_summary_runtime(Settings::default())
    };
    let engine = test_engine_with_settings(
        Arc::new(SummaryCountingProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
        settings,
    );
    for pass in 0..4 {
        let id = format!("old-tool-{pass}");
        engine.state.set_messages(vec![
            Message::user_text("old request"),
            assistant_tool_use(&id, "bash"),
            user_tool_result(&id, "x".repeat(5_000)),
            Message::assistant_text("old output inspected"),
            Message::user_text("latest request"),
        ]);
        let tokens = TokenCounter::count(&engine.state.messages());
        assert!(tokens > 1_600 && tokens < 1_999, "fixture tokens={tokens}");
        assert!(!engine.maybe_compact_conversation(pass + 1).await);
        let output = tool_result_text(&engine.state.messages()[2]).to_string();
        if pass < 3 {
            assert_eq!(output, crate::context::TOOL_RESULT_CLEARED_MESSAGE);
        } else {
            assert_eq!(output, "x".repeat(5_000));
        }
        assert_eq!(
            requests.load(Ordering::SeqCst),
            0,
            "tool threshold cannot trigger full summary"
        );
    }
    assert!(!engine.tool_result_compaction_available());
    // Crossing the original summary threshold still invokes the summary model.
    engine
        .state
        .add_message(Message::assistant_text("new context ".repeat(200)));
    engine.state.add_message(Message::user_text("continue"));
    assert!(engine.maybe_compact_conversation(5).await);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert!(
        engine.tool_result_compaction_available(),
        "successful summary starts a fresh three-pass cycle"
    );
}

#[tokio::test]
async fn early_tool_cleanup_preserves_latest_result_and_does_not_spend_empty_pass() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = lifecycle_test_engine(tmp.path());
    engine.state.set_messages(vec![
        assistant_tool_use("latest", "bash"),
        user_tool_result("latest", "x".repeat(5_000)),
    ]);
    for _ in 0..4 {
        assert!(!engine.try_early_tool_result_compaction().await);
    }
    assert!(engine.tool_result_compaction_available());
    assert_eq!(
        tool_result_text(&engine.state.messages()[1]),
        "x".repeat(5_000)
    );
}

#[tokio::test]
async fn early_tool_cleanup_counts_batches_not_individual_results() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = lifecycle_test_engine(tmp.path());
    for pass in 0..3 {
        let mut messages = Vec::new();
        for (index, name) in ["WebSearch", "WebFetch", "PowerShell", "read"]
            .iter()
            .enumerate()
        {
            let id = format!("batch-{pass}-{index}");
            messages.push(assistant_tool_use(&id, name));
            messages.push(user_tool_result(&id, "x".repeat(2_000)));
        }
        messages.push(Message::assistant_text("latest response"));
        engine.state.set_messages(messages);
        assert!(engine.try_early_tool_result_compaction().await);
        for index in [1, 3, 5, 7] {
            assert_eq!(
                tool_result_text(&engine.state.messages()[index]),
                crate::context::TOOL_RESULT_CLEARED_MESSAGE
            );
        }
        assert_eq!(engine.tool_result_compaction_available(), pass < 2);
    }
    assert!(!engine.try_early_tool_result_compaction().await);
}
