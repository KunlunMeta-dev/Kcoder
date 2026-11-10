use super::*;
use crate::test_support::test_engine_with_isolated_provider;
#[cfg(unix)]
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::mpsc;

fn test_engine(cwd: &std::path::Path) -> QueryEngine {
    crate::test_support::require_isolated_profile()
        .expect("an explicitly isolated test profile is required");
    test_engine_with_isolated_provider(cwd, Arc::new(crate::test_support::EmptyProvider))
}

#[cfg(unix)]
fn test_engine_with_provider(
    cwd: &std::path::Path,
    provider: Arc<dyn kcoder_api::Provider>,
) -> QueryEngine {
    crate::test_support::require_isolated_profile()
        .expect("an explicitly isolated test profile is required");
    test_engine_with_isolated_provider(cwd, provider)
}

#[cfg(unix)]
fn engine_with_gated_submit_hook() -> Result<(tempfile::TempDir, QueryEngine)> {
    engine_with_gated_submit_hook_and_provider(None)
}

#[cfg(unix)]
fn engine_with_gated_submit_hook_and_provider(
    provider: Option<std::sync::Arc<dyn kcoder_api::Provider>>,
) -> Result<(tempfile::TempDir, QueryEngine)> {
    let test_profile = crate::test_support::require_isolated_profile()?;
    let root = tempfile::tempdir()?;
    let config = root.path().join(".kcoder");
    std::fs::create_dir(&config)?;
    let ledger = test_profile.join(format!("owned-hook-{}.log", uuid::Uuid::new_v4()));
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&ledger)?;
    let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
    let executable = std::env::current_exe()?;
    let executable = quote(
        executable
            .to_str()
            .context("test executable path must be UTF-8")?,
    );
    let quoted_ledger = quote(
        ledger
            .to_str()
            .context("test Hook ledger path must be UTF-8")?,
    );
    let quoted_profile = quote(
        test_profile
            .to_str()
            .context("test profile path must be UTF-8")?,
    );
    let token = quote(&std::env::var("KCODER_TEST_PROFILE_CHILD")?);
    let command = format!(
        "hook_result=$(KCODER_CONFIG_DIR={quoted_profile} KCODER_TEST_ISOLATED_PROFILE={quoted_profile} KCODER_TEST_PROFILE_CHILD={token} KCODER_TEST_HOOK_PID=\"$$\" KCODER_TEST_HOOK_LEDGER={quoted_ledger} {executable} --exact isolated_test_profile::record_fixture_hook_group --ignored --nocapture 2>&1) || exit 1; case \"$hook_result\" in *'running 1 test'*'1 passed; 0 failed'*) : ;; *) exit 1 ;; esac; printf '%s' \"$$\" > hook.pid; while [ ! -f allow-submit ]; do /bin/sleep 0.02; done"
    );
    let script = root.path().join("owned-hook.sh");
    use std::io::Write;
    let mut script_file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&script)?;
    writeln!(script_file, "#!/bin/sh\n{command}")?;
    drop(script_file);
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))?;
    std::fs::write(
        config.join("settings.json"),
        serde_json::to_vec(&serde_json::json!({
            "hooks": {"UserPromptSubmit": [{"hooks": [{
                "type": "command",
                "command": "exec ./owned-hook.sh",
                "timeout": 10
            }]}]}
        }))?,
    )?;
    kcoder_config::FolderTrustStore::load(&test_profile).trust(root.path())?;
    let engine = match provider {
        Some(provider) => test_engine_with_provider(root.path(), provider),
        None => test_engine(root.path()),
    };
    Ok((root, engine))
}

#[cfg(unix)]
struct RecordingSlowHookProvider {
    requests: Arc<Mutex<Vec<kcoder_types::MessagesRequest>>>,
    release_first: Arc<tokio::sync::Notify>,
}

#[cfg(unix)]
impl kcoder_api::Provider for RecordingSlowHookProvider {
    fn name(&self) -> &'static str {
        "recording-slow-hook"
    }

    fn stream_messages(
        &self,
        request: kcoder_types::MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let call = {
            let mut requests = self.requests.lock().unwrap();
            requests.push(request);
            requests.len()
        };
        let release = self.release_first.clone();
        let start = futures::stream::iter([Ok(kcoder_types::StreamEvent::MessageStart {
            message: kcoder_types::StreamingMessage {
                id: format!("slow-hook-{call}"),
                role: "assistant".to_string(),
                content: Vec::new(),
                model: "test".to_string(),
                stop_reason: None,
                stop_sequence: None,
                usage: None,
            },
        })]);
        let gate = futures::stream::once(async move {
            if call == 1 {
                release.notified().await;
            }
            Ok(kcoder_types::StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text {
                    text: String::new(),
                },
            })
        });
        let rest = futures::stream::iter([
            Ok(kcoder_types::StreamEvent::ContentBlockDelta {
                index: 0,
                delta: kcoder_types::ContentDelta::TextDelta {
                    text: format!("response {call}"),
                },
            }),
            Ok(kcoder_types::StreamEvent::ContentBlockStop { index: 0 }),
            Ok(kcoder_types::StreamEvent::MessageStop),
        ]);
        Ok(Box::pin(start.chain(gate).chain(rest)))
    }
}

#[cfg(unix)]
async fn wait_for_owned_hook(root: &std::path::Path) -> Result<i32> {
    Ok(tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Ok(value) = std::fs::read_to_string(root.join("hook.pid"))
                && let Ok(pid) = value.parse::<i32>()
            {
                break pid;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?)
}

#[cfg(unix)]
async fn wait_until_owned_hook_exits(pid: i32) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let alive = unsafe { libc::kill(pid, 0) } == 0;
            if !alive && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn slow_hook_keeps_event_loop_responsive_and_preserves_input_order() -> Result<()> {
    if crate::isolated_test_profile::run_or_reexec(concat!(
        module_path!(),
        "::slow_hook_keeps_event_loop_responsive_and_preserves_input_order"
    )) {
        return Ok(());
    }
    let requests = Arc::new(Mutex::new(Vec::new()));
    let release_first = Arc::new(tokio::sync::Notify::new());
    let (root, engine) =
        engine_with_gated_submit_hook_and_provider(Some(Arc::new(RecordingSlowHookProvider {
            requests: requests.clone(),
            release_first: release_first.clone(),
        })))?;
    let history = root.path().join("slow-hook-history.jsonl");
    engine.state.with_history_path(&history);
    let mut app = ReplApp {
        input_session_owner: Some(engine.state.inspection_lifecycle_identity()),
        ..ReplApp::default()
    };
    let (raw_tx, mut rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());
    for text in ["first request", "second request"] {
        handle_submitted_message(
            SubmittedMessage::text(text.into()),
            &engine,
            &mut app,
            &tx,
            &prompt,
        )
        .await?;
    }
    assert_eq!(app.pending_input_count(), 2);
    assert!(app.pop_user_message_for_turn().is_none());
    assert!(app.spinner.is_running());
    let handled = tokio::time::timeout(
        Duration::from_millis(200),
        handle_app_event(
            AppEvent::Terminal(CEvent::Key(KeyEvent::new(
                KeyCode::Char('x'),
                KeyModifiers::NONE,
            ))),
            &mut app,
            &engine,
            &tx,
            &prompt,
        ),
    )
    .await?;
    assert!(handled.action.is_none());
    assert_eq!(app.input, "x");
    let early = tokio::time::timeout(Duration::from_millis(80), rx.recv()).await;
    assert!(early.is_err(), "hook completed unexpectedly: {early:?}");
    std::fs::write(root.path().join("allow-submit"), b"go")?;
    let first = tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await?
        .context("event channel closed")?;
    assert!(matches!(first, AppEvent::InputPreparationFinished { .. }));
    handle_app_event(first, &mut app, &engine, &tx, &prompt).await;
    assert!(
        matches!(engine.state.messages().first(), Some(Message::User { content, .. }) if matches!(content.as_slice(), [ContentBlock::Text { text }] if text == "first request"))
    );
    assert_eq!(app.pending_input_count(), 2);
    assert_eq!(
        app.user_message_queue[0].model_message,
        Message::user_text("first request")
    );
    assert_eq!(
        app.user_message_queue[1].model_message,
        Message::user_text("second request")
    );
    assert!(matches!(
        app.user_message_queue[0].action,
        QueuedInputAction::Admitting(_)
    ));
    let first_uuid = app
        .input_admission
        .as_ref()
        .context("first original ticket")?
        .uuid
        .clone();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !crate::input_admission::poll_input_admission(&mut app).await {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    assert!(matches!(
        try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
        StartTurnOutcome::Started
    ));
    assert_eq!(app.pending_input_count(), 1);
    tokio::time::timeout(Duration::from_secs(5), async {
        while requests.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    let first_requests = requests.lock().unwrap().clone();
    assert_eq!(first_requests.len(), 1);
    assert_eq!(
        first_requests[0]
            .messages
            .iter()
            .filter(|m| **m == Message::user_text("first request"))
            .count(),
        1
    );
    assert_eq!(
        first_requests[0]
            .messages
            .iter()
            .filter(|m| **m == Message::user_text("second request"))
            .count(),
        0
    );
    let entries = kcoder_state::load_history(&history)?;
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.uuid.as_deref() == Some(first_uuid.as_str())
                && entry.message == Message::user_text("first request"))
            .count(),
        1
    );
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.message == Message::user_text("first request"))
            .count(),
        1
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        while app.pending_turn_steers.is_empty() {
            let event = rx.recv().await.expect("event channel");
            let handled = handle_app_event(event, &mut app, &engine, &tx, &prompt).await;
            if let Some(action) = handled.action {
                let _ = handle_user_action(action, &engine, &mut app, &tx, &prompt).await;
            }
        }
    })
    .await?;
    release_first.notify_one();
    tokio::time::timeout(Duration::from_secs(5), async {
        while requests.lock().unwrap().len() < 2 {
            tokio::select! {
                event = rx.recv() => {
                    let handled = handle_app_event(event.expect("event channel"), &mut app, &engine, &tx, &prompt).await;
                    if let Some(action) = handled.action {
                        let _ = handle_user_action(action, &engine, &mut app, &tx, &prompt).await;
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(10)) => {}
            }
        }
    }).await?;
    let final_requests = requests.lock().unwrap().clone();
    assert_eq!(final_requests.len(), 2);
    for text in ["first request", "second request"] {
        assert_eq!(
            final_requests[1]
                .messages
                .iter()
                .filter(|m| **m == Message::user_text(text))
                .count(),
            1
        );
    }
    let entries = kcoder_state::load_history(&history)?;
    for text in ["first request", "second request"] {
        let matching: Vec<_> = entries
            .iter()
            .filter(|entry| entry.message == Message::user_text(text))
            .collect();
        assert_eq!(matching.len(), 1);
        assert!(matching[0].uuid.is_some());
    }
    if let Some(handle) = app.abort_turn_for_shutdown() {
        let _ = handle.await;
    }
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn clearing_or_switching_session_cancels_owned_preparation() -> Result<()> {
    if crate::isolated_test_profile::run_or_reexec(concat!(
        module_path!(),
        "::clearing_or_switching_session_cancels_owned_preparation"
    )) {
        return Ok(());
    }
    for switch_session in [false, true] {
        let (root, engine) = engine_with_gated_submit_hook()?;
        let mut app = ReplApp {
            input_session_owner: Some(engine.state.inspection_lifecycle_identity()),
            ..ReplApp::default()
        };
        let (raw_tx, mut rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
        let tx = AppEventSender::new(raw_tx);
        let prompt = TuiPermissionPrompt::new(tx.clone());
        handle_submitted_message(
            SubmittedMessage::text("old session input".into()),
            &engine,
            &mut app,
            &tx,
            &prompt,
        )
        .await?;
        let hook_pid = wait_for_owned_hook(root.path()).await?;
        if switch_session {
            assert!(app.clear_conversation_ui(&engine));
        } else {
            assert_eq!(app.clear_user_message_queue(), 1);
        }
        assert!(!app.input_preparation.is_pending());
        wait_until_owned_hook_exits(hook_pid).await?;
        std::fs::write(root.path().join("allow-submit"), b"go")?;
        tokio::time::sleep(Duration::from_millis(100)).await;
        while let Ok(event) = rx.try_recv() {
            handle_app_event(event, &mut app, &engine, &tx, &prompt).await;
        }
        assert_eq!(engine.state.message_count(), 0);
        assert!(app.user_message_queue.is_empty());
    }
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn quitting_cancels_an_already_running_owned_hook() -> Result<()> {
    if crate::isolated_test_profile::run_or_reexec(concat!(
        module_path!(),
        "::quitting_cancels_an_already_running_owned_hook"
    )) {
        return Ok(());
    }
    let (root, engine) = engine_with_gated_submit_hook()?;
    let mut app = ReplApp {
        input_session_owner: Some(engine.state.inspection_lifecycle_identity()),
        ..ReplApp::default()
    };
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());
    handle_submitted_message(
        SubmittedMessage::text("quit while preparing".into()),
        &engine,
        &mut app,
        &tx,
        &prompt,
    )
    .await?;
    let hook_pid = wait_for_owned_hook(root.path()).await?;
    let mut quit = handle_user_action(UserAction::Quit, &engine, &mut app, &tx, &prompt).await?;
    tokio::time::timeout(Duration::from_secs(3), async {
        while !quit {
            tokio::time::sleep(Duration::from_millis(10)).await;
            let handled =
                handle_app_event(AppEvent::FrameTick, &mut app, &engine, &tx, &prompt).await;
            if let Some(UserAction::Quit) = handled.action {
                quit =
                    handle_user_action(UserAction::Quit, &engine, &mut app, &tx, &prompt).await?;
            }
        }
        Ok::<(), anyhow::Error>(())
    })
    .await??;
    drop(app);
    wait_until_owned_hook_exits(hook_pid).await?;
    Ok(())
}

#[tokio::test]
async fn quit_keeps_the_owner_of_an_inflight_blocking_read_until_it_settles() -> Result<()> {
    if crate::isolated_test_profile::run_or_reexec(concat!(
        module_path!(),
        "::quit_keeps_the_owner_of_an_inflight_blocking_read_until_it_settles"
    )) {
        return Ok(());
    }
    let root = tempfile::tempdir()?;
    let engine = test_engine(root.path());
    let mut app = ReplApp {
        input_session_owner: Some(engine.state.inspection_lifecycle_identity()),
        ..ReplApp::default()
    };
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let blocking = tokio::task::spawn_blocking(move || {
        let _ = started_tx.send(());
        let _ = release_rx.recv();
    });
    let owner = tokio::spawn(async move {
        let _ = blocking.await;
    });
    app.input_preparation.retired.push(owner);
    started_rx.recv_timeout(Duration::from_secs(2))?;
    assert!(!handle_user_action(UserAction::Quit, &engine, &mut app, &tx, &prompt).await?);
    assert!(app.input_shutdown_pending);
    let pending = handle_app_event(AppEvent::FrameTick, &mut app, &engine, &tx, &prompt).await;
    assert!(pending.action.is_none());
    assert!(pending.redraw);
    release_tx.send(())?;
    let final_action = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let handled =
                handle_app_event(AppEvent::FrameTick, &mut app, &engine, &tx, &prompt).await;
            if let Some(action) = handled.action {
                break action;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    assert!(matches!(&final_action, UserAction::Quit));
    assert!(handle_user_action(final_action, &engine, &mut app, &tx, &prompt).await?);
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn pending_preparations_count_against_the_existing_queue_limit() -> Result<()> {
    if crate::isolated_test_profile::run_or_reexec(concat!(
        module_path!(),
        "::pending_preparations_count_against_the_existing_queue_limit"
    )) {
        return Ok(());
    }
    let (root, engine) = engine_with_gated_submit_hook()?;
    let mut app = ReplApp {
        input_session_owner: Some(engine.state.inspection_lifecycle_identity()),
        ..ReplApp::default()
    };
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());
    for index in 0..=USER_MESSAGE_QUEUE_MAX {
        handle_submitted_message(
            SubmittedMessage::text(format!("input {index}")),
            &engine,
            &mut app,
            &tx,
            &prompt,
        )
        .await?;
    }
    assert_eq!(app.pending_input_count(), USER_MESSAGE_QUEUE_MAX);
    let _hook = wait_for_owned_hook(root.path()).await?;
    assert_eq!(app.clear_user_message_queue(), USER_MESSAGE_QUEUE_MAX);
    assert!(!app.input_preparation.is_pending());
    tokio::time::timeout(Duration::from_secs(3), app.input_preparation.settle()).await?;
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn cancelling_preparation_unblocks_a_full_event_channel() -> Result<()> {
    if crate::isolated_test_profile::run_or_reexec(concat!(
        module_path!(),
        "::cancelling_preparation_unblocks_a_full_event_channel"
    )) {
        return Ok(());
    }
    let (root, engine) = engine_with_gated_submit_hook()?;
    std::fs::write(root.path().join("allow-submit"), b"go")?;
    let mut app = ReplApp {
        input_session_owner: Some(engine.state.inspection_lifecycle_identity()),
        ..ReplApp::default()
    };
    let (raw_tx, mut rx) = mpsc::channel(1);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());
    assert!(tx.send(AppEvent::SystemNotice("occupied".into())));
    handle_submitted_message(
        SubmittedMessage::text("input".into()),
        &engine,
        &mut app,
        &tx,
        &prompt,
    )
    .await?;
    let _pid = wait_for_owned_hook(root.path()).await?;
    tokio::time::sleep(Duration::from_millis(50)).await;
    app.cancel_preparing_inputs();
    tokio::time::timeout(Duration::from_secs(2), app.input_preparation.settle()).await?;
    assert!(matches!(rx.try_recv(), Ok(AppEvent::SystemNotice(text)) if text == "occupied"));
    assert!(rx.try_recv().is_err());
    assert_eq!(engine.state.message_count(), 0);
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn busy_state_preserves_prepared_input_and_keeps_frames_responsive() -> Result<()> {
    if crate::isolated_test_profile::run_or_reexec(concat!(
        module_path!(),
        "::busy_state_preserves_prepared_input_and_keeps_frames_responsive"
    )) {
        return Ok(());
    }
    let (root, engine) = engine_with_gated_submit_hook()?;
    std::fs::write(root.path().join("allow-submit"), b"go")?;
    let mut app = ReplApp {
        input_session_owner: Some(engine.state.inspection_lifecycle_identity()),
        ..ReplApp::default()
    };
    app.refresh_engine_metadata(&engine);
    let (raw_tx, mut rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());
    handle_submitted_message(
        SubmittedMessage::text("keep while busy".into()),
        &engine,
        &mut app,
        &tx,
        &prompt,
    )
    .await?;
    let event = tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await?
        .context("event channel closed")?;
    assert!(matches!(event, AppEvent::InputPreparationFinished { .. }));
    engine
        .state
        .upsert_task(kcoder_state::Task::new("held-state", "test owner"));
    let held_state = engine.state.clone();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let owner = tokio::task::spawn_blocking(move || {
        held_state.update_task("held-state", |_| {
            let _ = started_tx.send(());
            let _ = release_rx.recv_timeout(Duration::from_secs(3));
        });
    });
    started_rx.recv_timeout(Duration::from_secs(2))?;
    let before = Instant::now();
    handle_app_event(event, &mut app, &engine, &tx, &prompt).await;
    assert!(before.elapsed() < Duration::from_millis(200));
    assert!(app.input_preparation.has_deferred());
    assert_eq!(app.pending_input_count(), 1);
    for _ in 0..3 {
        tokio::time::sleep(Duration::from_millis(90)).await;
        let before = Instant::now();
        let handled = handle_app_event(AppEvent::FrameTick, &mut app, &engine, &tx, &prompt).await;
        assert!(before.elapsed() < Duration::from_millis(200));
        assert!(handled.action.is_none());
        assert!(app.input_preparation.has_deferred());
    }
    let key = handle_app_event(
        AppEvent::Terminal(CEvent::Key(KeyEvent::new(
            KeyCode::Char('z'),
            KeyModifiers::NONE,
        ))),
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;
    assert!(key.action.is_none());
    assert_eq!(app.input, "z");
    release_tx.send(())?;
    owner.await?;
    tokio::time::sleep(Duration::from_millis(90)).await;
    handle_app_event(AppEvent::FrameTick, &mut app, &engine, &tx, &prompt).await;
    assert!(!app.input_preparation.has_deferred());
    assert!(
        matches!(engine.state.messages().first(), Some(Message::User { content, .. }) if matches!(content.as_slice(), [ContentBlock::Text { text }] if text == "keep while busy"))
    );
    if let Some(handle) = app.abort_turn_for_shutdown() {
        let _ = handle.await;
    }
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn input_submitted_during_busy_state_keeps_the_original_session_owner() -> Result<()> {
    if crate::isolated_test_profile::run_or_reexec(concat!(
        module_path!(),
        "::input_submitted_during_busy_state_keeps_the_original_session_owner"
    )) {
        return Ok(());
    }
    let (root, engine) = engine_with_gated_submit_hook()?;
    std::fs::write(root.path().join("allow-submit"), b"go")?;
    let mut app = ReplApp {
        input_session_owner: Some(engine.state.inspection_lifecycle_identity()),
        ..ReplApp::default()
    };
    app.refresh_engine_metadata(&engine);
    engine
        .state
        .upsert_task(kcoder_state::Task::new("held-state", "test owner"));
    let held_state = engine.state.clone();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let owner = tokio::task::spawn_blocking(move || {
        held_state.update_task("held-state", |_| {
            let _ = started_tx.send(());
            let _ = release_rx.recv_timeout(Duration::from_secs(3));
        });
    });
    started_rx.recv_timeout(Duration::from_secs(2))?;
    let (raw_tx, mut rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());
    let before = Instant::now();
    handle_submitted_message(
        SubmittedMessage::text("owned before lock".into()),
        &engine,
        &mut app,
        &tx,
        &prompt,
    )
    .await?;
    assert!(before.elapsed() < Duration::from_millis(200));
    assert_eq!(app.pending_input_count(), 1);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(rx.try_recv().is_err());
    release_tx.send(())?;
    owner.await?;
    let event = tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await?
        .context("event channel closed")?;
    handle_app_event(event, &mut app, &engine, &tx, &prompt).await;
    assert!(
        matches!(engine.state.messages().first(), Some(Message::User { content, .. }) if matches!(content.as_slice(), [ContentBlock::Text { text }] if text == "owned before lock"))
    );
    if let Some(handle) = app.abort_turn_for_shutdown() {
        let _ = handle.await;
    }
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn prepared_input_stays_held_when_the_session_changes_before_admission() -> Result<()> {
    if crate::isolated_test_profile::run_or_reexec(concat!(
        module_path!(),
        "::prepared_input_stays_held_when_the_session_changes_before_admission"
    )) {
        return Ok(());
    }
    let (root, engine) = engine_with_gated_submit_hook()?;
    std::fs::write(root.path().join("allow-submit"), b"go")?;
    let mut app = ReplApp {
        input_session_owner: Some(engine.state.inspection_lifecycle_identity()),
        ..ReplApp::default()
    };
    app.refresh_engine_metadata(&engine);
    let (raw_tx, mut rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());
    handle_submitted_message(
        SubmittedMessage::text("old input".into()),
        &engine,
        &mut app,
        &tx,
        &prompt,
    )
    .await?;
    let event = tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await?
        .context("event channel closed")?;
    engine.state.start_new_session()?;
    handle_app_event(event, &mut app, &engine, &tx, &prompt).await;
    assert!(engine.state.messages().is_empty());
    assert_eq!(app.user_message_queue.len(), 1);
    assert_eq!(app.user_message_queue[0].action, QueuedInputAction::Held);
    assert!(matches!(
        try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
        StartTurnOutcome::Idle
    ));
    assert!(engine.state.messages().is_empty());
    Ok(())
}

#[tokio::test]
async fn queued_prepared_input_is_not_appended_to_a_replaced_session() -> Result<()> {
    if crate::isolated_test_profile::run_or_reexec(concat!(
        module_path!(),
        "::queued_prepared_input_is_not_appended_to_a_replaced_session"
    )) {
        return Ok(());
    }
    let root = tempfile::tempdir()?;
    let engine = test_engine(root.path());
    let mut app = ReplApp {
        input_session_owner: Some(engine.state.inspection_lifecycle_identity()),
        ..ReplApp::default()
    };
    let owner = engine.state.inspection_lifecycle_identity();
    let submitted = SubmittedMessage::text("original owner input".into());
    let mut queued =
        QueuedUserMessage::from_submitted(Message::user_text(&submitted.text), &submitted);
    queued.owner = Some(owner);
    assert!(app.enqueue_user_message_for_turn(queued));
    engine.state.start_new_session()?;
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());
    assert!(matches!(
        try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
        StartTurnOutcome::Idle
    ));
    assert!(engine.state.messages().is_empty());
    assert_eq!(app.user_message_queue[0].action, QueuedInputAction::Held);
    assert!(
        app.messages
            .iter()
            .all(|message| !message.text.contains("original owner input"))
    );
    Ok(())
}

#[test]
fn editing_the_last_deferred_input_disarms_its_retry() -> Result<()> {
    if crate::isolated_test_profile::run_or_reexec(concat!(
        module_path!(),
        "::editing_the_last_deferred_input_disarms_its_retry"
    )) {
        return Ok(());
    }
    let root = tempfile::tempdir()?;
    let engine = test_engine(root.path());
    let mut app = ReplApp {
        input_session_owner: Some(engine.state.inspection_lifecycle_identity()),
        ..ReplApp::default()
    };
    let submitted = SubmittedMessage::text("edit this input".into());
    let mut queued =
        QueuedUserMessage::from_submitted(Message::user_text(&submitted.text), &submitted);
    queued.owner = Some(engine.state.inspection_lifecycle_identity());
    assert!(app.enqueue_user_message_for_turn(queued));
    app.input_start_retry_at = Some(Instant::now());
    app.sync_input_preparation_indicator();
    assert!(app.restore_latest_queued_message_for_edit());
    assert_eq!(app.input, "edit this input");
    assert!(app.input_start_retry_at.is_none());
    assert!(!app.spinner.is_running());
    Ok(())
}

#[test]
fn attachment_read_rejects_oversize_and_cancelled_before_reading() -> Result<()> {
    let root = tempfile::tempdir()?;
    let image = root.path().join("large.png");
    let file = std::fs::File::create(&image)?;
    file.set_len(MAX_IMAGE_BYTES + 1)?;
    let mut submitted = SubmittedMessage::text("[image]".into());
    submitted.images.push(LocalImageAttachment {
        path: image,
        placeholder: "[image]".into(),
        media_type: "image/png".into(),
        clipboard_image: None,
    });
    let token = CancellationToken::new();
    assert!(
        submitted
            .to_model_message_cancellable("[image]".into(), &token)
            .is_err()
    );
    token.cancel();
    let error = submitted
        .to_model_message_cancellable("[image]".into(), &token)
        .unwrap_err();
    assert!(error.to_string().contains("cancelled"));
    Ok(())
}

#[cfg(unix)]
#[test]
fn attachment_read_rejects_fifo_without_waiting_for_a_writer() -> Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let root = tempfile::tempdir()?;
    let image = root.path().join("not-an-image.png");
    let name = std::ffi::CString::new(image.as_os_str().as_bytes())?;
    anyhow::ensure!(
        unsafe { libc::mkfifo(name.as_ptr(), 0o600) } == 0,
        "mkfifo failed"
    );
    let mut submitted = SubmittedMessage::text("[image]".into());
    submitted.images.push(LocalImageAttachment {
        path: image,
        placeholder: "[image]".into(),
        media_type: "image/png".into(),
        clipboard_image: None,
    });
    let start = Instant::now();
    assert!(submitted.to_model_message("[image]".into()).is_err());
    assert!(start.elapsed() < Duration::from_secs(1));
    Ok(())
}
