use super::*;
use tokio::sync::{Notify, Semaphore};

#[derive(Debug)]
struct SummaryBarrierProvider {
    entered: Arc<Notify>,
    release: Arc<Semaphore>,
}

impl Provider for SummaryBarrierProvider {
    fn name(&self) -> &'static str {
        "summary-barrier"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let mut stream = SummaryCountingProvider {
            requests: Arc::new(AtomicUsize::new(0)),
        }
        .stream_messages(request)?;
        let entered = self.entered.clone();
        let release = self.release.clone();
        Ok(Box::pin(async_stream::stream! {
            entered.notify_one();
            let permit = release.acquire().await.unwrap();
            permit.forget();
            while let Some(event) = stream.next().await {
                yield event;
            }
        }))
    }
}

#[tokio::test]
async fn summary_commit_preserves_messages_appended_after_snapshot_and_on_resume() {
    let tmp = tempfile::tempdir().unwrap();
    let history = tmp.path().join("history.jsonl");
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let engine = test_engine_with_settings(
        Arc::new(SummaryBarrierProvider {
            entered: entered.clone(),
            release: release.clone(),
        }),
        tmp.path(),
        settings_using_main_summary_runtime(Settings::default()),
    );
    engine.state.with_history_path(&history);
    for message in [
        Message::user_text("old request ".repeat(300)),
        Message::assistant_text("old response ".repeat(300)),
        Message::user_text("middle request ".repeat(300)),
        Message::assistant_text("middle response ".repeat(300)),
        Message::user_text("recent request"),
        Message::assistant_text("recent response"),
    ] {
        engine.state.add_message(message);
    }
    let appended = vec![
        Message::user_text("BACKGROUND_CONTINUATION_REQUEST"),
        assistant_tool_use("new-background-read", "read"),
        user_tool_result("new-background-read", "NEW_COMPLETE_TOOL_RESULT".into()),
        Message::user_text("NEW_AGENT_COMPLETION_NOTIFICATION"),
    ];
    let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(engine.perform_compaction(true), async {
            entered.notified().await;
            for message in &appended {
                engine.state.add_message(message.clone());
            }
            release.add_permits(1);
        })
    })
    .await
    .unwrap();
    let live = engine.state.messages();
    assert!(
        live.ends_with(&appended),
        "new context lost; compact succeeded={}",
        result.is_ok()
    );
    let error = result.expect_err("summary of a stale snapshot must not commit");
    assert!(
        error
            .to_string()
            .contains("conversation changed during compaction"),
        "{error}"
    );
    engine.state.flush_history().await.unwrap();
    let restored = kcoder_state::AppState::new(tmp.path());
    restored.resume_from_history(&history).unwrap();
    assert!(
        restored.messages().ends_with(&appended),
        "restored context lost"
    );
    assert!(
        !std::fs::read_to_string(&history)
            .unwrap()
            .contains("compact_boundary")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn no_op_commit_preserves_messages_appended_during_pre_compact_hook() {
    let tmp = tempfile::tempdir().unwrap();
    let history = tmp.path().join("history.jsonl");
    let mut engine = TestEngineBuilder::new(tmp.path()).build();
    engine.hook_registry = kcoder_hooks::HookRegistry::from_matchers(vec![(
        kcoder_hooks::HookEvent::PreCompact,
        serde_json::from_value(serde_json::json!({"hooks": [{
            "type": "command",
            "command": "touch hook-entered; while [ ! -e hook-release ]; do sleep 0.01; done",
            "timeout": 5
        }]}))
        .unwrap(),
    )]);
    engine.state.with_history_path(&history);
    engine
        .state
        .add_message(Message::user_text("recent request"));
    engine
        .state
        .add_message(Message::assistant_text("recent response"));
    let appended = Message::user_text("LATE_AGENT_COMPLETION");
    let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(engine.perform_compaction(true), async {
            while !tmp.path().join("hook-entered").exists() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            engine.state.add_message(appended.clone());
            std::fs::write(tmp.path().join("hook-release"), "release").unwrap();
        })
    })
    .await
    .unwrap();
    assert_eq!(
        engine.state.messages().last(),
        Some(&appended),
        "no-op overwrote late context"
    );
    let error = result.expect_err("changed snapshot must reject no-op commit");
    assert!(
        error
            .to_string()
            .contains("conversation changed during compaction"),
        "{error}"
    );
    engine.state.flush_history().await.unwrap();
    let restored = kcoder_state::AppState::new(tmp.path());
    restored.resume_from_history(&history).unwrap();
    assert_eq!(restored.messages().last(), Some(&appended));
}

#[cfg(unix)]
#[tokio::test]
async fn session_memory_commit_rejects_stale_context_without_rebasing_metadata() {
    let tmp = tempfile::tempdir().unwrap();
    let history = tmp.path().join("history.jsonl");
    let mut settings = Settings::default();
    settings.session_memory.enabled = true;
    settings.session_memory.compact_enabled = true;
    settings.session_memory.compact_min_chars = 5;
    settings.session_memory.compact_min_recent_tokens = 1;
    settings.session_memory.compact_max_recent_tokens = 200;
    settings.session_memory.compact_min_recent_messages = 2;
    let mut engine = TestEngineBuilder::new(tmp.path())
        .settings(settings)
        .build();
    engine.hook_registry = kcoder_hooks::HookRegistry::from_matchers(vec![(
        kcoder_hooks::HookEvent::PostCompact,
        serde_json::from_value(serde_json::json!({"hooks": [{
            "type": "command",
            "command": "touch hook-entered; while [ ! -e hook-release ]; do sleep 0.01; done",
            "timeout": 5
        }]}))
        .unwrap(),
    )]);
    engine.state.with_history_path(&history);
    let summary_path = tmp.path().join("summary.md");
    std::fs::write(
        &summary_path,
        DEFAULT_SESSION_MEMORY_TEMPLATE.replace(
            "# Current State",
            "# Current State\n\nEarlier work is complete.",
        ),
    )
    .unwrap();
    let snapshot = SessionMemorySnapshot::new(&summary_path, 6, 100, 1, "model:test");
    engine.state.set_session_memory(snapshot.clone());
    for message in [
        Message::user_text("old alpha request"),
        Message::assistant_text("old alpha response"),
        Message::user_text("old gamma request"),
        Message::assistant_text("old gamma response"),
        Message::user_text("old delta request"),
        Message::assistant_text("old delta response"),
        Message::user_text("recent beta request"),
        Message::assistant_text("recent beta response"),
    ] {
        engine.state.add_message(message);
    }
    let appended = Message::user_text("LATE_SESSION_MEMORY_AGENT_COMPLETION");
    let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(engine.perform_compaction(true), async {
            while !tmp.path().join("hook-entered").exists() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            engine.state.add_message(appended.clone());
            std::fs::write(tmp.path().join("hook-release"), "release").unwrap();
        })
    })
    .await
    .unwrap();
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("conversation changed during compaction")
    );
    assert_eq!(engine.state.messages().last(), Some(&appended));
    assert_eq!(engine.state.session_memory(), Some(snapshot));
    engine.state.flush_history().await.unwrap();
    assert!(
        !std::fs::read_to_string(&history)
            .unwrap()
            .contains("compact_boundary")
    );
    let restored = kcoder_state::AppState::new(tmp.path());
    restored.resume_from_history(&history).unwrap();
    assert_eq!(restored.messages().last(), Some(&appended));
}
