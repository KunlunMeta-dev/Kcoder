//! Owned observation of the original State writer ticket for one queued input.
//!
//! Cancellation revokes model dispatch only. The process-local State owner
//! retains the original writer ticket, even if this observer is dropped.
use kcoder_state::{CommittedUserInput, PendingUserInput};
use tokio::task::JoinHandle;

pub(super) const UNCONFIRMED_INPUT_NOTICE: &str = "The save result for this input is not yet confirmed. Check the conversation before submitting it again.";
pub(super) const CANCELLED_INPUT_NOTICE: &str =
    "This input was not sent and may already be saved. Start a new session to continue without it.";
pub(super) const UNCERTAIN_INPUT_NOTICE: &str =
    "The input's save result is not confirmed. Review the conversation before continuing.";
pub(super) const MAX_RETIRED_ADMISSIONS: usize = 128;

/// Print after the TUI surface is restored so the warning stays visible.
pub(super) fn write_unconfirmed_exit_notice(
    output: &mut impl std::io::Write,
) -> std::io::Result<()> {
    write!(
        output,
        "\r\n{UNCONFIRMED_INPUT_NOTICE}\r\nOptional session-end actions were skipped.\r\n"
    )?;
    output.flush()
}

pub(super) fn write_cancelled_exit_notice(output: &mut impl std::io::Write) -> std::io::Result<()> {
    write!(
        output,
        "\r\n{CANCELLED_INPUT_NOTICE}\r\nOptional session-end actions were skipped.\r\n"
    )?;
    output.flush()
}

#[must_use]
pub(super) struct PendingInputAdmission {
    pub(super) id: u64,
    pub(super) uuid: String,
    pub(super) owner: kcoder_state::AppStateLifecycleIdentity,
    pub(super) cancelled: bool,
    pub(super) witness: Option<CommittedUserInput>,
    pub(super) observer: Option<JoinHandle<Result<CommittedUserInput, String>>>,
}

impl PendingInputAdmission {
    pub(super) fn new(
        id: u64,
        pending: PendingUserInput,
        cancelled: bool,
        owner: kcoder_state::AppStateLifecycleIdentity,
    ) -> Self {
        let uuid = pending.uuid().to_owned();
        let observer = tokio::spawn(async move {
            pending
                .wait_with_witness()
                .await
                .map_err(|error| format!("{error:#}"))
        });
        Self {
            id,
            uuid,
            owner,
            cancelled,
            witness: None,
            observer: Some(observer),
        }
    }

    pub(super) fn cancel_dispatch(&mut self) {
        self.cancelled = true;
    }

    pub(super) fn observation_finished(&self) -> bool {
        self.observer.as_ref().is_some_and(JoinHandle::is_finished)
    }

    pub(super) async fn take_observation(&mut self) -> Option<Result<CommittedUserInput, String>> {
        if !self.observation_finished() {
            return None;
        }
        let observer = self.observer.take()?;
        Some(match observer.await {
            Ok(outcome) => outcome,
            Err(error) => Err(format!("input observer failed: {error}")),
        })
    }
}

/// Process only the result of the exact ticket originally owned by this UI.
/// This runs after the observer has already completed and never waits for I/O.
pub(super) async fn poll_input_admission(app: &mut crate::ReplApp) -> bool {
    if app.input_admission.as_ref().is_some_and(|admission| {
        app.input_session_owner
            .as_ref()
            .is_some_and(|owner| !admission.owner.same_lifecycle(owner))
    }) {
        return app.retire_stale_input_admission();
    }
    let outcome = match app.input_admission.as_mut() {
        Some(admission) => admission.take_observation().await,
        None => None,
    };
    let Some(outcome) = outcome else {
        return false;
    };
    let Some(admission) = app.input_admission.as_mut() else {
        return false;
    };
    let id = admission.id;
    let cancelled = admission.cancelled;
    let uuid = admission.uuid.clone();
    let owner = admission.owner.clone();
    let mut error_text = None;
    match outcome {
        Ok(witness) => admission.witness = Some(witness),
        Err(error) => {
            app.input_unknown_diagnostic = Some((uuid, error));
            app.mark_input_uncertain_for(Some(owner));
            error_text = Some(
                "The save result for this input is not yet confirmed. Check the conversation before submitting it again.",
            );
        }
    }
    let next_action = if cancelled || error_text.is_some() {
        crate::QueuedInputAction::Uncertain
    } else {
        crate::QueuedInputAction::Admitted(id)
    };
    for item in app
        .user_message_queue
        .iter_mut()
        .chain(app.rejected_turn_steers.iter_mut())
    {
        if item.action == crate::QueuedInputAction::Admitting(id) {
            item.action = next_action;
        }
    }
    if let Some(text) = error_text {
        app.push_message(crate::MessageRole::System, text.to_owned());
    }
    app.sync_input_preparation_indicator();
    app.force_next_viewport_redraw();
    true
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::test_support::test_engine_with_isolated_provider;
    use crate::*;
    use kcoder_types::{ContentBlock, ImageSource, MessagesRequest, StreamEvent};
    use std::os::fd::AsRawFd;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use std::time::Duration;
    use tokio::sync::mpsc;

    #[test]
    fn unconfirmed_exit_notice_remains_user_readable_without_internal_identifiers() {
        let mut output = Vec::new();
        write_unconfirmed_exit_notice(&mut output).unwrap();
        let text = String::from_utf8(output).unwrap();
        assert!(text.contains(UNCONFIRMED_INPUT_NOTICE));
        assert!(text.contains("Optional session-end actions were skipped."));
        assert!(!text.contains("INPUT_COMMIT_UNKNOWN"));
    }

    struct CountingProvider(Arc<AtomicUsize>);

    struct RecordingProvider(Arc<std::sync::Mutex<Vec<MessagesRequest>>>);

    impl kcoder_api::Provider for RecordingProvider {
        fn name(&self) -> &'static str {
            "cancelled-input-recording-test"
        }
        fn stream_messages(
            &self,
            request: MessagesRequest,
        ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
            self.0.lock().unwrap().push(request);
            Ok(Box::pin(futures::stream::iter(vec![
                Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: kcoder_types::ContentBlock::Text {
                        text: String::new(),
                    },
                }),
                Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: kcoder_types::ContentDelta::TextDelta {
                        text: "done".into(),
                    },
                }),
                Ok(StreamEvent::ContentBlockStop { index: 0 }),
                Ok(StreamEvent::MessageStop),
            ])))
        }
    }

    struct BlockingSideProvider {
        requests: Arc<std::sync::Mutex<Vec<MessagesRequest>>>,
        started: std::sync::mpsc::SyncSender<()>,
        release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    }

    impl kcoder_api::Provider for BlockingSideProvider {
        fn name(&self) -> &'static str {
            "blocking-side-question-test"
        }
        fn stream_messages(
            &self,
            request: MessagesRequest,
        ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
            self.requests.lock().unwrap().push(request);
            let _ = self.started.send(());
            let _ = self
                .release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(4));
            Ok(Box::pin(futures::stream::iter(vec![Ok(
                StreamEvent::MessageStop,
            )])))
        }
    }
    fn test_engine_with_provider(
        cwd: &std::path::Path,
        provider: Arc<dyn kcoder_api::Provider>,
    ) -> QueryEngine {
        crate::test_support::require_isolated_profile()
            .expect("an explicitly isolated test profile is required");
        test_engine_with_isolated_provider(cwd, provider)
    }
    impl kcoder_api::Provider for CountingProvider {
        fn name(&self) -> &'static str {
            "input-admission-test"
        }
        fn stream_messages(
            &self,
            _: MessagesRequest,
        ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(Box::pin(futures::stream::iter(vec![Ok(
                StreamEvent::MessageStop,
            )])))
        }
    }

    fn queued(owner: kcoder_state::AppStateLifecycleIdentity, text: &str) -> QueuedUserMessage {
        let message = Message::user_content(vec![
            ContentBlock::Text {
                text: text.to_string(),
            },
            ContentBlock::Image {
                source: ImageSource::base64("image/png", "aW1hZ2U="),
            },
        ]);
        let mut queued = QueuedUserMessage::from_model_message(message);
        queued.owner = Some(owner);
        queued
    }

    fn lock_history(root: &std::path::Path) -> std::io::Result<std::fs::File> {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join(".kcoder-history.lock"))?;
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(file)
    }

    #[tokio::test]
    async fn unconfirmed_input_blocks_direct_provider_entries_and_background_followup()
    -> anyhow::Result<()> {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::unconfirmed_input_blocks_direct_provider_entries_and_background_followup"
        )) {
            return Ok(());
        }
        let root = tempfile::tempdir()?;
        let calls = Arc::new(AtomicUsize::new(0));
        let engine =
            test_engine_with_provider(root.path(), Arc::new(CountingProvider(calls.clone())));
        let history = root.path().join("owned.jsonl");
        engine.state.with_history_path(&history);
        engine.state.save_history()?;
        let lock = lock_history(root.path())?;
        let owner = engine.state.inspection_lifecycle_identity();
        let mut app = ReplApp {
            input_session_owner: Some(owner.clone()),
            ..ReplApp::default()
        };
        app.enqueue_user_message_for_turn(queued(owner, "pending input"));
        let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
        let tx = AppEventSender::new(raw_tx);
        let prompt = TuiPermissionPrompt::new(tx.clone());
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        let original_uuid = app
            .input_admission
            .as_ref()
            .context("original ticket")?
            .uuid
            .clone();
        handle_user_action(
            UserAction::StartSideQuestion("direct side".into()),
            &engine,
            &mut app,
            &tx,
            &prompt,
        )
        .await?;
        assert!(app.side_question_overlay.is_none());
        app.prefill_input(String::new());
        handle_user_action(
            UserAction::SlashCommand("/btw retained question".into()),
            &engine,
            &mut app,
            &tx,
            &prompt,
        )
        .await?;
        assert_eq!(app.input, "/btw retained question");
        assert!(app.side_question_overlay.is_none());
        app.prefill_input(String::new());
        handle_user_action(
            UserAction::SlashCommand("/agent steer child retained message".into()),
            &engine,
            &mut app,
            &tx,
            &prompt,
        )
        .await?;
        assert_eq!(app.input, "/agent steer child retained message");
        app.prefill_input(String::new());
        handle_user_action(
            UserAction::SlashCommand("/agent\tStEeR\tchild\tretained message".into()),
            &engine,
            &mut app,
            &tx,
            &prompt,
        )
        .await?;
        assert_eq!(app.input, "/agent\tStEeR\tchild\tretained message");
        handle_user_action(
            UserAction::CompactConversation,
            &engine,
            &mut app,
            &tx,
            &prompt,
        )
        .await?;
        handle_user_action(
            UserAction::StartMoaPlan("plan".into()),
            &engine,
            &mut app,
            &tx,
            &prompt,
        )
        .await?;
        enqueue_background_followup(
            &mut app,
            vec![String::new()],
            vec!["background".into()],
            "background".into(),
        );
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!app.turn_state.is_active());
        assert_eq!(app.input_admission.as_ref().unwrap().uuid, original_uuid);
        assert_eq!(app.pending_background_followups.len(), 1);
        assert!(
            app.messages
                .iter()
                .any(|message| message.text.contains("still being saved"))
        );
        app.cancel_preparing_inputs();
        drop(lock);
        tokio::time::timeout(Duration::from_secs(5), async {
            while !poll_input_admission(&mut app).await {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn preexisting_side_question_settles_before_new_input_admission() -> anyhow::Result<()> {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::preexisting_side_question_settles_before_new_input_admission"
        )) {
            return Ok(());
        }
        let root = tempfile::tempdir()?;
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (started_tx, started_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let engine = test_engine_with_provider(
            root.path(),
            Arc::new(BlockingSideProvider {
                requests: requests.clone(),
                started: started_tx,
                release: std::sync::Mutex::new(release_rx),
            }),
        );
        let owner = engine.state.inspection_lifecycle_identity();
        let mut app = ReplApp {
            input_session_owner: Some(owner.clone()),
            ..ReplApp::default()
        };
        let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
        let tx = AppEventSender::new(raw_tx);
        let prompt = TuiPermissionPrompt::new(tx.clone());
        start_side_question(&engine, &mut app, &tx, "prior side".into());
        started_rx.recv_timeout(Duration::from_secs(2))?;
        app.enqueue_user_message_for_turn(queued(owner, "must wait"));
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        assert!(engine.state.messages().is_empty());
        app.handle_side_question_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        assert!(engine.state.messages().is_empty());
        release_tx.send(())?;
        tokio::time::timeout(Duration::from_secs(3), async {
            while app.has_running_side_questions() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
        assert_eq!(requests.lock().unwrap().len(), 1);
        assert!(
            requests.lock().unwrap()[0]
                .messages
                .iter()
                .all(|message| *message != Message::user_text("must wait"))
        );
        tokio::time::sleep(Duration::from_millis(90)).await;
        let handled = handle_app_event(AppEvent::FrameTick, &mut app, &engine, &tx, &prompt).await;
        assert!(matches!(handled.action, Some(UserAction::TryStartTurn)));
        assert!(
            !handle_user_action(handled.action.unwrap(), &engine, &mut app, &tx, &prompt).await?
        );
        assert_eq!(engine.state.messages().len(), 1);
        Ok(())
    }

    #[tokio::test]
    async fn unknown_input_remains_blocked_after_its_queue_item_is_cleared() -> anyhow::Result<()> {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::unknown_input_remains_blocked_after_its_queue_item_is_cleared"
        )) {
            return Ok(());
        }
        let root = tempfile::tempdir()?;
        let calls = Arc::new(AtomicUsize::new(0));
        let engine =
            test_engine_with_provider(root.path(), Arc::new(CountingProvider(calls.clone())));
        let mut app = ReplApp {
            input_session_owner: Some(engine.state.inspection_lifecycle_identity()),
            input_shutdown_uncertain: true,
            ..ReplApp::default()
        };
        let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
        let tx = AppEventSender::new(raw_tx);
        let prompt = TuiPermissionPrompt::new(tx.clone());
        handle_user_action(
            UserAction::StartSideQuestion("keep question".into()),
            &engine,
            &mut app,
            &tx,
            &prompt,
        )
        .await?;
        assert_eq!(app.input, "/btw keep question");
        enqueue_background_followup(
            &mut app,
            vec![String::new()],
            vec!["background".into()],
            "background".into(),
        );
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(app.pending_background_followups.len(), 1);
        Ok(())
    }

    #[tokio::test]
    async fn busy_state_keeps_the_original_graphical_input_at_the_head() -> anyhow::Result<()> {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::busy_state_keeps_the_original_graphical_input_at_the_head"
        )) {
            return Ok(());
        }
        let root = tempfile::tempdir()?;
        let calls = Arc::new(AtomicUsize::new(0));
        let engine =
            test_engine_with_provider(root.path(), Arc::new(CountingProvider(calls.clone())));
        let mut app = ReplApp::default();
        let first = queued(engine.state.inspection_lifecycle_identity(), "first");
        let exact = first.model_message.clone();
        app.enqueue_user_message_for_turn(first);
        app.enqueue_user_message_for_turn(queued(
            engine.state.inspection_lifecycle_identity(),
            "second",
        ));
        engine
            .state
            .upsert_task(kcoder_state::Task::new("held", "fixture"));
        let state = engine.state.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            state.update_task("held", |_| {
                let _ = ready_tx.send(());
                let _ = release_rx.recv_timeout(Duration::from_secs(4));
            })
        });
        ready_rx.recv_timeout(Duration::from_secs(2))?;
        let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
        let tx = AppEventSender::new(raw_tx);
        let prompt = TuiPermissionPrompt::new(tx.clone());
        let before = std::time::Instant::now();
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        assert!(before.elapsed() < Duration::from_millis(200));
        assert_eq!(app.user_message_queue.len(), 2);
        assert_eq!(app.user_message_queue[0].model_message, exact);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(app.input_admission.is_none());
        release_tx.send(())?;
        holder.join().expect("held State thread");
        assert!(engine.state.messages().is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn native_history_lock_keeps_queue_and_keyboard_live_until_original_ticket()
    -> anyhow::Result<()> {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::native_history_lock_keeps_queue_and_keyboard_live_until_original_ticket"
        )) {
            return Ok(());
        }
        let root = tempfile::tempdir()?;
        let calls = Arc::new(AtomicUsize::new(0));
        let engine =
            test_engine_with_provider(root.path(), Arc::new(CountingProvider(calls.clone())));
        let history = root.path().join("owned.jsonl");
        engine.state.with_history_path(&history);
        engine.state.save_history()?;
        let file = lock_history(root.path())?;
        let owner = engine.state.inspection_lifecycle_identity();
        let first = queued(owner.clone(), "one");
        let exact = first.model_message.clone();
        let mut app = ReplApp::default();
        app.enqueue_user_message_for_turn(first);
        app.enqueue_user_message_for_turn(queued(owner, "two"));
        let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
        let tx = AppEventSender::new(raw_tx);
        let prompt = TuiPermissionPrompt::new(tx.clone());
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        assert!(matches!(
            app.user_message_queue[0].action,
            QueuedInputAction::Admitting(_)
        ));
        assert_eq!(app.user_message_queue[0].model_message, exact);
        tokio::time::sleep(Duration::from_millis(120)).await;
        let before = std::time::Instant::now();
        let handled = handle_app_event(
            AppEvent::Terminal(CEvent::Key(KeyEvent::new(
                KeyCode::Char('x'),
                KeyModifiers::NONE,
            ))),
            &mut app,
            &engine,
            &tx,
            &prompt,
        )
        .await;
        assert!(handled.action.is_none());
        assert!(before.elapsed() < Duration::from_millis(200));
        assert_eq!(app.input, "x");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(app.user_message_queue.len(), 2);
        drop(file);
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if poll_input_admission(&mut app).await {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
        assert!(matches!(
            app.user_message_queue[0].action,
            QueuedInputAction::Admitted(_)
        ));
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Started
        ));
        tokio::time::timeout(Duration::from_secs(3), async {
            while calls.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
        let original = kcoder_state::load_history(&history)?;
        assert_eq!(
            original
                .iter()
                .filter(|entry| entry.message == exact)
                .count(),
            1
        );
        assert_eq!(app.user_message_queue.len(), 1);
        assert_eq!(
            app.user_message_queue[0].model_message,
            queued(engine.state.inspection_lifecycle_identity(), "two").model_message
        );
        if let Some(handle) = app.abort_turn_for_shutdown() {
            let _ = handle.await;
        }
        Ok(())
    }

    #[tokio::test]
    async fn quit_wait_is_bounded_and_does_not_resubmit_the_original_ticket() -> anyhow::Result<()>
    {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::quit_wait_is_bounded_and_does_not_resubmit_the_original_ticket"
        )) {
            return Ok(());
        }
        let root = tempfile::tempdir()?;
        let calls = Arc::new(AtomicUsize::new(0));
        let engine =
            test_engine_with_provider(root.path(), Arc::new(CountingProvider(calls.clone())));
        let history = root.path().join("owned.jsonl");
        engine.state.with_history_path(&history);
        engine.state.save_history()?;
        let file = lock_history(root.path())?;
        let mut app = ReplApp::default();
        let first = queued(engine.state.inspection_lifecycle_identity(), "unknown");
        let exact = first.model_message.clone();
        app.enqueue_user_message_for_turn(first);
        let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
        let tx = AppEventSender::new(raw_tx);
        let prompt = TuiPermissionPrompt::new(tx.clone());
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        assert!(!handle_user_action(UserAction::Quit, &engine, &mut app, &tx, &prompt).await?);
        app.input_shutdown_deadline = Some(std::time::Instant::now());
        let frame = handle_app_event(AppEvent::FrameTick, &mut app, &engine, &tx, &prompt).await;
        assert!(frame.redraw && frame.action.is_none());
        assert!(app.input_shutdown_timed_out && app.input_shutdown_uncertain);
        assert!(
            app.messages
                .iter()
                .any(|message| message.text.contains("save result")
                    && !message.text.contains("INPUT_COMMIT_UNKNOWN"))
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!app.restore_latest_queued_message_for_edit());
        app.input_shutdown_notice_until = Some(std::time::Instant::now());
        let frame = handle_app_event(AppEvent::FrameTick, &mut app, &engine, &tx, &prompt).await;
        assert!(matches!(frame.action, Some(UserAction::Quit)));
        drop(file);
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if poll_input_admission(&mut app).await {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
        let original = kcoder_state::load_history(&history)?;
        assert_eq!(
            original
                .iter()
                .filter(|entry| entry.message == exact)
                .count(),
            1
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            app.user_message_queue[0].action,
            QueuedInputAction::Uncertain
        );
        Ok(())
    }

    #[tokio::test]
    async fn committed_input_is_not_dispatched_after_the_session_is_replaced() -> anyhow::Result<()>
    {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::committed_input_is_not_dispatched_after_the_session_is_replaced"
        )) {
            return Ok(());
        }
        let root = tempfile::tempdir()?;
        let calls = Arc::new(AtomicUsize::new(0));
        let engine =
            test_engine_with_provider(root.path(), Arc::new(CountingProvider(calls.clone())));
        let mut app = ReplApp::default();
        app.enqueue_user_message_for_turn(queued(
            engine.state.inspection_lifecycle_identity(),
            "original",
        ));
        let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
        let tx = AppEventSender::new(raw_tx);
        let prompt = TuiPermissionPrompt::new(tx.clone());
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if poll_input_admission(&mut app).await {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
        assert!(matches!(
            app.user_message_queue[0].action,
            QueuedInputAction::Admitted(_)
        ));
        engine.state.start_new_session()?;
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(engine.state.messages().is_empty());
        assert_eq!(
            app.user_message_queue[0].action,
            QueuedInputAction::Uncertain
        );
        assert!(!app.restore_latest_queued_message_for_edit());
        Ok(())
    }

    #[tokio::test]
    async fn committed_input_is_not_dispatched_after_same_identity_content_rewrite()
    -> anyhow::Result<()> {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::committed_input_is_not_dispatched_after_same_identity_content_rewrite"
        )) {
            return Ok(());
        }
        let root = tempfile::tempdir()?;
        let calls = Arc::new(AtomicUsize::new(0));
        let engine =
            test_engine_with_provider(root.path(), Arc::new(CountingProvider(calls.clone())));
        let mut app = ReplApp::default();
        app.enqueue_user_message_for_turn(queued(
            engine.state.inspection_lifecycle_identity(),
            "original",
        ));
        let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
        let tx = AppEventSender::new(raw_tx);
        let prompt = TuiPermissionPrompt::new(tx.clone());
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if poll_input_admission(&mut app).await {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
        engine
            .state
            .set_messages_preserving_history_ids(vec![Message::user_text("changed")]);
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            app.user_message_queue[0].action,
            QueuedInputAction::Uncertain
        );
        assert!(!app.restore_latest_queued_message_for_edit());
        Ok(())
    }

    #[tokio::test]
    async fn clearing_an_accepted_input_never_reissues_or_dispatches_it() -> anyhow::Result<()> {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::clearing_an_accepted_input_never_reissues_or_dispatches_it"
        )) {
            return Ok(());
        }
        let root = tempfile::tempdir()?;
        let calls = Arc::new(AtomicUsize::new(0));
        let engine =
            test_engine_with_provider(root.path(), Arc::new(CountingProvider(calls.clone())));
        let history = root.path().join("owned.jsonl");
        engine.state.with_history_path(&history);
        engine.state.save_history()?;
        let file = lock_history(root.path())?;
        let mut app = ReplApp::default();
        let first = queued(
            engine.state.inspection_lifecycle_identity(),
            "clear accepted",
        );
        let exact = first.model_message.clone();
        app.enqueue_user_message_for_turn(first);
        let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
        let tx = AppEventSender::new(raw_tx);
        let prompt = TuiPermissionPrompt::new(tx.clone());
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        assert_eq!(app.clear_user_message_queue(), 1);
        assert!(
            app.input_admission
                .as_ref()
                .is_some_and(|pending| pending.cancelled)
        );
        drop(file);
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if poll_input_admission(&mut app).await {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
        assert!(app.input_admission.as_ref().is_some_and(|admission| {
            admission.cancelled && admission.witness.is_some() && admission.observer.is_none()
        }));
        assert!(app.has_cancelled_input_barrier());
        assert!(
            app.messages
                .iter()
                .any(|message| message.role == MessageRole::User
                    && message.text.contains("clear accepted"))
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            kcoder_state::load_history(&history)?
                .iter()
                .filter(|entry| entry.message == exact)
                .count(),
            1
        );
        assert!(app.user_message_queue.is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn cleared_accepted_input_is_visible_and_never_enters_a_followup_request()
    -> anyhow::Result<()> {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::cleared_accepted_input_is_visible_and_never_enters_a_followup_request"
        )) {
            return Ok(());
        }
        let root = tempfile::tempdir()?;
        let test_profile = crate::test_support::require_isolated_profile()?;
        std::fs::create_dir(root.path().join(".kcoder"))?;
        std::fs::write(
            root.path().join(".kcoder/settings.json"),
            serde_json::to_vec(&serde_json::json!({
                "hooks": { "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "printf touched > should-not-run", "timeout": 3 }] }] }
            }))?,
        )?;
        kcoder_config::FolderTrustStore::load(&test_profile).trust(root.path())?;
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let engine =
            test_engine_with_provider(root.path(), Arc::new(RecordingProvider(requests.clone())));
        let history = root.path().join("owned.jsonl");
        engine.state.with_history_path(&history);
        engine.state.save_history()?;
        let file = lock_history(root.path())?;
        let owner = engine.state.inspection_lifecycle_identity();
        let mut app = ReplApp {
            input_session_owner: Some(owner.clone()),
            ..ReplApp::default()
        };
        let first = queued(owner, "cancelled-original");
        let exact = first.model_message.clone();
        app.enqueue_user_message_for_turn(first);
        let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
        let tx = AppEventSender::new(raw_tx);
        let prompt = TuiPermissionPrompt::new(tx.clone());
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        assert_eq!(app.clear_user_message_queue(), 1);
        assert!(
            app.messages
                .iter()
                .any(|message| message.role == MessageRole::User
                    && message.text.contains("cancelled-original")
                    && message.text.contains("[Image #1]"))
        );
        assert!(
            !app.messages
                .iter()
                .any(|message| message.text.contains("aW1hZ2U="))
        );
        drop(file);
        tokio::time::timeout(Duration::from_secs(5), async {
            while !poll_input_admission(&mut app).await {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
        assert!(app.has_cancelled_input_barrier());
        assert_eq!(
            kcoder_state::load_history(&history)?
                .iter()
                .filter(|entry| entry.message == exact)
                .count(),
            1
        );
        handle_submitted_message(
            SubmittedMessage::text("followup-must-not-run".into()),
            &engine,
            &mut app,
            &tx,
            &prompt,
        )
        .await?;
        assert_eq!(app.input, "followup-must-not-run");
        assert!(!app.input_preparation.is_pending());
        start_side_question(&engine, &mut app, &tx, "side-must-not-run".into());
        start_manual_compaction(&engine, &mut app, &tx);
        start_moa_plan(&engine, &mut app, &tx, "moa-must-not-run".into());
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            requests.lock().unwrap().is_empty(),
            "cancelled input reached a Provider"
        );
        assert!(
            !root.path().join("should-not-run").exists(),
            "cancelled-input barrier ran a submission Hook"
        );
        Ok(())
    }

    #[tokio::test]
    async fn clearing_a_confirmed_undispatched_input_keeps_the_same_barrier() -> anyhow::Result<()>
    {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::clearing_a_confirmed_undispatched_input_keeps_the_same_barrier"
        )) {
            return Ok(());
        }
        let root = tempfile::tempdir()?;
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let engine =
            test_engine_with_provider(root.path(), Arc::new(RecordingProvider(requests.clone())));
        let owner = engine.state.inspection_lifecycle_identity();
        let mut app = ReplApp {
            input_session_owner: Some(owner.clone()),
            ..ReplApp::default()
        };
        app.enqueue_user_message_for_turn(queued(owner, "confirmed-original"));
        let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
        let tx = AppEventSender::new(raw_tx);
        let prompt = TuiPermissionPrompt::new(tx.clone());
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        tokio::time::timeout(Duration::from_secs(5), async {
            while !poll_input_admission(&mut app).await {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
        assert!(
            app.input_admission
                .as_ref()
                .is_some_and(|admission| admission.witness.is_some())
        );
        assert_eq!(app.clear_user_message_queue(), 1);
        assert!(app.has_cancelled_input_barrier());
        assert!(
            app.messages
                .iter()
                .any(|message| message.role == MessageRole::User
                    && message.text.contains("confirmed-original"))
        );
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        assert!(requests.lock().unwrap().is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn lost_observer_never_authorizes_reset_while_the_original_writer_is_blocked()
    -> anyhow::Result<()> {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::lost_observer_never_authorizes_reset_while_the_original_writer_is_blocked"
        )) {
            return Ok(());
        }
        let root = tempfile::tempdir()?;
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let engine =
            test_engine_with_provider(root.path(), Arc::new(RecordingProvider(requests.clone())));
        let history = root.path().join("owned.jsonl");
        engine.state.with_history_path(&history);
        engine.state.save_history()?;
        let lock = lock_history(root.path())?;
        let owner = engine.state.inspection_lifecycle_identity();
        let mut app = ReplApp {
            input_session_owner: Some(owner.clone()),
            ..ReplApp::default()
        };
        let first = queued(owner.clone(), "unknown-original");
        let exact = first.model_message.clone();
        app.enqueue_user_message_for_turn(first);
        let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
        let tx = AppEventSender::new(raw_tx);
        let prompt = TuiPermissionPrompt::new(tx.clone());
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        assert_eq!(app.clear_user_message_queue(), 1);
        app.input_admission
            .as_ref()
            .unwrap()
            .observer
            .as_ref()
            .unwrap()
            .abort();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !poll_input_admission(&mut app).await {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
        assert!(app.has_current_input_uncertainty());
        app.enqueue_user_message_for_turn(QueuedUserMessage::from_slash_command("/new".into()));
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        assert!(!app.clear_conversation_ui(&engine));
        assert!(owner.same_lifecycle(&engine.state.inspection_lifecycle_identity()));
        assert!(requests.lock().unwrap().is_empty());
        drop(lock);
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if kcoder_state::load_history(&history)
                    .ok()
                    .is_some_and(|entries| {
                        entries
                            .iter()
                            .filter(|entry| entry.message == exact)
                            .count()
                            == 1
                    })
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
        assert!(app.has_current_input_uncertainty());
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        assert!(requests.lock().unwrap().is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn confirmed_cancelled_tickets_do_not_exhaust_retired_owner_capacity()
    -> anyhow::Result<()> {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::confirmed_cancelled_tickets_do_not_exhaust_retired_owner_capacity"
        )) {
            return Ok(());
        }
        let root = tempfile::tempdir()?;
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let engine =
            test_engine_with_provider(root.path(), Arc::new(RecordingProvider(requests.clone())));
        let mut app = ReplApp {
            input_session_owner: Some(engine.state.inspection_lifecycle_identity()),
            ..ReplApp::default()
        };
        let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
        let tx = AppEventSender::new(raw_tx);
        let prompt = TuiPermissionPrompt::new(tx.clone());
        for _ in 0..=MAX_RETIRED_ADMISSIONS {
            let owner = engine.state.inspection_lifecycle_identity();
            app.enqueue_user_message_for_turn(queued(owner, "cancelled"));
            assert!(matches!(
                try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
                StartTurnOutcome::Idle
            ));
            tokio::time::timeout(Duration::from_secs(5), async {
                while !poll_input_admission(&mut app).await {
                    tokio::task::yield_now().await;
                }
            })
            .await?;
            assert_eq!(app.clear_user_message_queue(), 1);
            assert!(app.clear_conversation_ui(&engine));
            assert!(app.retired_input_admissions.is_empty());
        }
        assert!(requests.lock().unwrap().is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn unowned_unknown_input_stays_blocked_after_a_lifecycle_change() -> anyhow::Result<()> {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::unowned_unknown_input_stays_blocked_after_a_lifecycle_change"
        )) {
            return Ok(());
        }
        let root = tempfile::tempdir()?;
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let engine =
            test_engine_with_provider(root.path(), Arc::new(RecordingProvider(requests.clone())));
        let original_owner = engine.state.inspection_lifecycle_identity();
        let mut app = ReplApp {
            input_session_owner: Some(original_owner.clone()),
            ..ReplApp::default()
        };
        let mut original =
            QueuedUserMessage::from_model_message(Message::user_text("unowned-unknown-original"));
        original.action = QueuedInputAction::Admitted(17);
        assert!(original.owner.is_none());
        assert!(app.enqueue_user_message_for_turn(original));
        let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
        let tx = AppEventSender::new(raw_tx);
        let prompt = TuiPermissionPrompt::new(tx.clone());
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        assert!(app.has_current_input_uncertainty());
        assert!(app.input_uncertainty_owner.is_none());
        assert!(!app.clear_conversation_ui(&engine));

        // Simulate a real external replacement without fabricating provenance.
        let new_owner = engine.start_new_session_with_lifecycle()?;
        assert!(!original_owner.same_lifecycle(&new_owner));
        assert!(app.can_replace_input_owner());
        app.install_input_owner(new_owner.clone());
        assert!(app.has_current_input_uncertainty());
        assert!(app.input_uncertainty_owner.is_none());
        assert_eq!(app.retired_queued_inputs.len(), 1);
        assert!(app.enqueue_user_message_for_turn(queued(new_owner, "new-input")));
        assert!(matches!(
            try_start_next_turn(&engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        assert!(!app.clear_conversation_ui(&engine));
        assert!(requests.lock().unwrap().is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn old_pending_receipt_does_not_contaminate_a_new_lifecycle() -> anyhow::Result<()> {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::old_pending_receipt_does_not_contaminate_a_new_lifecycle"
        )) {
            return Ok(());
        }
        let old_root = tempfile::tempdir()?;
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let old_engine = test_engine_with_provider(
            old_root.path(),
            Arc::new(RecordingProvider(requests.clone())),
        );
        old_engine
            .state
            .with_history_path(old_root.path().join("old.jsonl"));
        old_engine.state.save_history()?;
        let old_lock = lock_history(old_root.path())?;
        let old_owner = old_engine.state.inspection_lifecycle_identity();
        let mut app = ReplApp {
            input_session_owner: Some(old_owner.clone()),
            ..ReplApp::default()
        };
        app.enqueue_user_message_for_turn(queued(old_owner.clone(), "old-not-sent"));
        let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
        let tx = AppEventSender::new(raw_tx);
        let prompt = TuiPermissionPrompt::new(tx.clone());
        assert!(matches!(
            try_start_next_turn(&old_engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        assert_eq!(app.clear_user_message_queue(), 1);
        let old_uuid = app.input_admission.as_ref().unwrap().uuid.clone();

        let new_root = tempfile::tempdir()?;
        old_engine
            .state
            .with_deferred_history_path(new_root.path().join("new-seed.jsonl"));
        let new_owner = old_engine.start_new_session_with_lifecycle()?;
        assert!(!old_owner.same_lifecycle(&new_owner));
        assert!(app.can_replace_input_owner());
        app.install_input_owner(new_owner.clone());
        app.reset_transcript_state_after_clear();
        assert_eq!(app.retired_input_admissions.len(), 1);
        assert_eq!(app.retired_input_admissions[0].uuid, old_uuid);
        assert!(!app.has_unconfirmed_input());
        app.enqueue_user_message_for_turn(queued(new_owner, "new-only"));
        assert!(matches!(
            try_start_next_turn(&old_engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Idle
        ));
        tokio::time::timeout(Duration::from_secs(5), async {
            while !poll_input_admission(&mut app).await {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
        assert!(matches!(
            try_start_next_turn(&old_engine, &mut app, &tx, &prompt).await?,
            StartTurnOutcome::Started
        ));
        let turn = app
            .finish_turn_state()
            .expect("new session turn was started");
        tokio::time::timeout(Duration::from_secs(10), turn).await??;
        {
            let requests = requests.lock().unwrap();
            assert_eq!(requests.len(), 1, "the completed turn sent extra requests");
            let request = serde_json::to_string(&requests[0])?;
            assert!(request.contains("new-only") && !request.contains("old-not-sent"));
        }
        drop(old_lock);
        tokio::time::timeout(Duration::from_secs(5), async {
            while !app.retired_input_admissions[0].observation_finished() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
        assert!(!app.has_current_input_uncertainty());
        assert!(!app.has_cancelled_input_barrier());
        Ok(())
    }

    #[test]
    fn confirmed_unconsumed_steers_continue_in_order_after_interrupt() {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::confirmed_unconsumed_steers_continue_in_order_after_interrupt"
        )) {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let engine = test_engine_with_provider(
            root.path(),
            Arc::new(CountingProvider(Arc::new(AtomicUsize::new(0)))),
        );
        let owner = engine.state.inspection_lifecycle_identity();
        let mut app = ReplApp::default();
        app.track_pending_turn_steer(1, queued(owner.clone(), "first"));
        app.track_pending_turn_steer(2, queued(owner, "second"));
        assert_eq!(app.defer_unapplied_turn_steers(&[1, 2]), 2);
        assert!(!app.has_cancelled_input_barrier());
        for expected in ["first", "second"] {
            let Some(QueuedTurnInput::User { model_message, .. }) = app.pop_user_message_for_turn()
            else {
                panic!("confirmed input should remain ready to send");
            };
            assert!(matches!(
                model_message,
                Message::User { ref content, .. }
                    if matches!(content.first(), Some(ContentBlock::Text { text }) if text == expected)
            ));
        }
        assert!(app.pop_user_message_for_turn().is_none());
    }

    #[test]
    fn unacknowledged_original_session_steer_is_not_requeued_for_execution() {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::unacknowledged_original_session_steer_is_not_requeued_for_execution"
        )) {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let engine = test_engine_with_provider(
            root.path(),
            Arc::new(CountingProvider(Arc::new(AtomicUsize::new(0)))),
        );
        let mut app = ReplApp::default();
        app.track_pending_turn_steer(
            1,
            queued(
                engine.state.inspection_lifecycle_identity(),
                "unknown steer",
            ),
        );
        assert_eq!(app.defer_unapplied_turn_steers(&[]), 1);
        assert_eq!(
            app.rejected_turn_steers[0].action,
            QueuedInputAction::Uncertain
        );
        assert!(app.pop_user_message_for_turn().is_none());
        assert!(!app.restore_latest_queued_message_for_edit());
    }

    #[test]
    fn metadata_refresh_does_not_rebind_the_original_input_owner() -> anyhow::Result<()> {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::metadata_refresh_does_not_rebind_the_original_input_owner"
        )) {
            return Ok(());
        }
        let root = tempfile::tempdir()?;
        let engine = test_engine_with_provider(
            root.path(),
            Arc::new(CountingProvider(Arc::new(AtomicUsize::new(0)))),
        );
        let mut app = ReplApp::default();
        let original = engine.state.inspection_lifecycle_identity();
        app.input_session_owner = Some(original.clone());
        engine.state.start_new_session()?;
        app.refresh_engine_metadata(&engine);
        let retained = app
            .input_session_owner
            .as_ref()
            .expect("captured original lifecycle");
        assert!(retained.same_lifecycle(&original));
        assert_eq!(
            engine.state.try_check_lifecycle_identity(retained)?,
            Some(false)
        );
        Ok(())
    }

    #[test]
    fn new_session_transition_returns_the_original_replacement_lifecycle() -> anyhow::Result<()> {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::new_session_transition_returns_the_original_replacement_lifecycle"
        )) {
            return Ok(());
        }
        let root = tempfile::tempdir()?;
        let engine = test_engine_with_provider(
            root.path(),
            Arc::new(CountingProvider(Arc::new(AtomicUsize::new(0)))),
        );
        let owner = engine.start_new_session_with_lifecycle()?;
        assert_eq!(
            engine.state.try_check_lifecycle_identity(&owner)?,
            Some(true)
        );
        engine.state.start_new_session()?;
        assert_eq!(
            engine.state.try_check_lifecycle_identity(&owner)?,
            Some(false)
        );
        Ok(())
    }

    #[test]
    fn resume_transition_returns_the_lifecycle_installed_with_the_history() -> anyhow::Result<()> {
        if crate::isolated_test_profile::run_or_reexec(concat!(
            module_path!(),
            "::resume_transition_returns_the_lifecycle_installed_with_the_history"
        )) {
            return Ok(());
        }
        let root = tempfile::tempdir()?;
        let history = root.path().join("resume.jsonl");
        let original = kcoder_state::AppState::new(root.path());
        original.with_history_path(&history);
        original.add_message(Message::user_text("persisted original"));
        original.save_history()?;
        let prepared = kcoder_state::prepare_session_resume(&history)?;
        let engine = test_engine_with_provider(
            root.path(),
            Arc::new(CountingProvider(Arc::new(AtomicUsize::new(0)))),
        );
        let (count, owner) = engine.apply_prepared_session_resume_with_lifecycle(prepared)?;
        assert_eq!(count, 1);
        assert_eq!(
            engine.state.try_check_lifecycle_identity(&owner)?,
            Some(true)
        );
        engine.state.start_new_session()?;
        assert_eq!(
            engine.state.try_check_lifecycle_identity(&owner)?,
            Some(false)
        );
        Ok(())
    }
}
