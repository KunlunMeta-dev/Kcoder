use super::*;
use crate::{CommittedUserInput, ContentBlock, HistoryMessageLocator, UserInputStart};
use kcoder_types::TurnAttemptIdentity;
use std::os::unix::fs::{MetadataExt, PermissionsExt};

struct Fixture {
    _directory: tempfile::TempDir,
    path: PathBuf,
    state: AppState,
    source: HistorySource,
    tracker: NativeHistoryLineageReservation,
    input: CommittedUserInput,
    receipt: NativeHistoryRowReceipt,
    attempt: TurnAttemptIdentity,
}

fn accepted(result: UserInputStart) -> crate::PendingUserInput {
    match result {
        UserInputStart::Accepted(input) => input,
        _ => panic!("expected one accepted original input"),
    }
}

async fn build_fixture() -> Result<Fixture> {
    let directory = tempfile::tempdir()?;
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))?;
    ensure!(
        fs::metadata(directory.path())?.mode() & 0o777 == 0o700,
        "fixture must be private"
    );
    let path = directory.path().join("history.jsonl");
    fs::write(&path, b"")?;
    let state = AppState::new(directory.path());
    state.with_history_path(&path);
    let source = state
        .read_inner()
        .history_source
        .clone()
        .context("source missing")?;
    source.materialize()?;
    let owner = state.inspection_lifecycle_identity();
    let tracker = state
        .try_reserve_native_history_lineage(&owner)?
        .context("tracker unavailable")?;
    ensure!(
        tracker.status() == NativeHistoryLineageStatus::Armed,
        "tracker was not armed"
    );
    let attempt = TurnAttemptIdentity {
        thread_id: state.session_id(),
        turn_id: "original-turn".into(),
        attempt_id: "original-attempt".into(),
    };
    let input = state
        .history_attempt_scope(attempt.clone())?
        .run(async {
            accepted(state.try_begin_user_input(&owner, Message::user_text("original input")))
                .wait_with_witness()
                .await
        })
        .await?;
    let receipt = input
        .try_take_native_row_receipt()?
        .context("original row receipt missing")?;
    Ok(Fixture {
        _directory: directory,
        path,
        state,
        source,
        tracker,
        input,
        receipt,
        attempt,
    })
}

fn observe(fixture: &Fixture) -> Result<CurrentHistoryObservation> {
    fixture.state.observe_current_history_user_inputs(
        &fixture.state.session_id(),
        &[HistoryMessageLocator {
            history_uuid: fixture.input.uuid().to_owned(),
            attempt: fixture.attempt.clone(),
        }],
    )
}

fn tool_result() -> Message {
    Message::User {
        origin: MessageOrigin::Runtime,
        content: vec![ContentBlock::ToolResult {
            tool_use_id: "call-1".into(),
            content: vec![ContentBlock::Text {
                text: "real tool result".into(),
            }],
            is_error: Some(false),
        }],
    }
}

#[tokio::test(flavor = "current_thread")]
async fn real_input_and_normal_assistant_tool_writes_extend_the_live_chain() -> Result<()> {
    let fixture = build_fixture().await?;
    assert_eq!(
        fixture.tracker.status(),
        NativeHistoryLineageStatus::Tracking
    );
    fixture
        .tracker
        .verify_original(&fixture.receipt, &observe(&fixture)?, 0)?;
    fixture
        .state
        .add_message(Message::assistant_text("working"));
    fixture.state.flush_history().await?;
    fixture
        .tracker
        .verify_original(&fixture.receipt, &observe(&fixture)?, 0)?;
    fixture.state.add_message(tool_result());
    fixture.state.flush_history().await?;
    fixture
        .tracker
        .verify_original(&fixture.receipt, &observe(&fixture)?, 0)?;
    let rows = crate::load_history(&fixture.path)?;
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].uuid.as_deref(), Some(fixture.input.uuid()));
    assert_eq!(rows[2].message, tool_result());
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn same_bytes_body_and_control_replacement_invalidate_the_live_chain() -> Result<()> {
    let fixture = build_fixture().await?;
    let data = fs::read(&fixture.path)?;
    let held = fixture.path.with_file_name("held-history.jsonl");
    fs::rename(&fixture.path, &held)?;
    fs::write(&fixture.path, data)?;
    assert!(
        fixture
            .tracker
            .verify_original(&fixture.receipt, &observe(&fixture)?, 0)
            .is_err()
    );
    assert_eq!(
        fixture.tracker.status(),
        NativeHistoryLineageStatus::Unknown
    );

    let fixture = build_fixture().await?;
    let control = fixture.path.with_extension("hctl").join("source.json");
    let data = fs::read(&control)?;
    fs::rename(&control, control.with_file_name("held-source.json"))?;
    fs::write(&control, data)?;
    assert!(
        fixture
            .tracker
            .verify_original(&fixture.receipt, &observe(&fixture)?, 0)
            .is_err()
    );
    assert_eq!(
        fixture.tracker.status(),
        NativeHistoryLineageStatus::Unknown
    );
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn observer_failure_keeps_the_normal_append_and_invalidates_only_evidence() -> Result<()> {
    let fixture = build_fixture().await?;
    let row = HistoryEntry {
        session_id: fixture.state.session_id(),
        timestamp_ms: 2,
        uuid: Some("assistant-step".into()),
        parent_uuid: Some(fixture.input.uuid().into()),
        message: Message::assistant_text("written once"),
        history_attempt: Some(fixture.attempt.clone()),
        web_sources: Vec::new(),
    };
    let mut bytes = serde_json::to_vec(&row)?;
    bytes.push(b'\n');
    super::super::commit::inject_control_observer_failure();
    fixture.source.append(&bytes)?;
    assert_eq!(
        fixture.tracker.status(),
        NativeHistoryLineageStatus::Unknown
    );
    let rows = crate::load_history(&fixture.path)?;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].uuid.as_deref(), Some("assistant-step"));
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn replacement_and_foreign_lifecycle_cannot_reuse_the_tracker() -> Result<()> {
    let fixture = build_fixture().await?;
    let before = fs::read(&fixture.path)?;
    fixture.source.replace(&before)?;
    assert_eq!(
        fixture.tracker.status(),
        NativeHistoryLineageStatus::Unknown
    );
    assert_eq!(fs::read(&fixture.path)?, before);
    assert!(
        fixture
            .tracker
            .verify_original(&fixture.receipt, &observe(&fixture)?, 0)
            .is_err()
    );

    let fixture = build_fixture().await?;
    let foreign = AppState::new(fixture._directory.path());
    let owner = foreign.inspection_lifecycle_identity();
    assert!(
        fixture
            .state
            .try_reserve_native_history_lineage(&owner)
            .is_err()
    );
    let other = build_fixture().await?;
    assert!(
        fixture
            .tracker
            .verify_original(&other.receipt, &observe(&fixture)?, 0)
            .is_err()
    );
    Ok(())
}

fn next_assistant(fixture: &Fixture, uuid: &str) -> Result<Vec<u8>> {
    let row = HistoryEntry {
        session_id: fixture.state.session_id(),
        timestamp_ms: 2,
        uuid: Some(uuid.into()),
        parent_uuid: Some(fixture.input.uuid().into()),
        message: Message::assistant_text("one physical append"),
        history_attempt: Some(fixture.attempt.clone()),
        web_sources: Vec::new(),
    };
    let mut bytes = serde_json::to_vec(&row)?;
    bytes.push(b'\n');
    Ok(bytes)
}

#[tokio::test(flavor = "current_thread")]
async fn control_publication_replacement_invalidates_evidence_without_failing_the_writer()
-> Result<()> {
    let fixture = build_fixture().await?;
    let bytes = next_assistant(&fixture, "replace-control")?;
    super::super::commit::inject_control_ready_replacement();
    fixture.source.append(&bytes)?;
    assert_eq!(
        fixture.tracker.status(),
        NativeHistoryLineageStatus::Unknown
    );
    let rows = crate::load_history(&fixture.path)?;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].uuid.as_deref(), Some("replace-control"));
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn actual_control_sync_failure_is_unknown_and_is_never_replayed() -> Result<()> {
    let fixture = build_fixture().await?;
    let bytes = next_assistant(&fixture, "sync-cut")?;
    super::super::commit::inject_control_ready_sync_failure();
    let error = fixture
        .source
        .append(&bytes)
        .expect_err("injected control sync must fail");
    assert!(is_uncertain_mutation(&error));
    assert_eq!(
        fixture.tracker.status(),
        NativeHistoryLineageStatus::Unknown
    );
    let body = fs::read(&fixture.path)?;
    let marker = b"sync-cut";
    assert_eq!(
        body.windows(marker.len())
            .filter(|item| *item == marker)
            .count(),
        1
    );
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn real_compaction_and_different_state_cannot_extend_original_proof() -> Result<()> {
    let fixture = build_fixture().await?;
    let before = fs::read(&fixture.path)?;
    fixture
        .state
        .set_messages_after_compaction(
            vec![Message::compaction_text("summary")],
            crate::CompactionTranscriptEvent {
                trigger: crate::CompactionTrigger::Manual,
                pre_tokens: 100,
                post_tokens: 40,
                summary: "summary".into(),
            },
        )
        .await?;
    assert!(fs::read(&fixture.path)?.starts_with(&before));
    assert_eq!(
        fixture.tracker.status(),
        NativeHistoryLineageStatus::Unknown
    );
    assert!(
        fixture
            .tracker
            .verify_original(&fixture.receipt, &observe(&fixture)?, 0)
            .is_err()
    );
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn one_binding_has_one_revocable_reservation_and_no_filesystem_side_effect() -> Result<()> {
    let fixture = build_fixture().await?;
    let owner = fixture.state.inspection_lifecycle_identity();
    let before = fs::read(&fixture.path)?;
    assert!(
        fixture
            .state
            .try_reserve_native_history_lineage(&owner)?
            .is_none()
    );
    drop(fixture.tracker);
    let replacement = fixture
        .state
        .try_reserve_native_history_lineage(&owner)?
        .context("released reservation was not reclaimed")?;
    assert_eq!(replacement.status(), NativeHistoryLineageStatus::Armed);
    assert_eq!(fs::read(&fixture.path)?, before);
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn observer_clone_failure_does_not_fail_an_original_witnessed_append() -> Result<()> {
    use crate::history_flusher::{HistoryFlusher, process_history_flusher_command};
    use tokio::sync::mpsc;

    let directory = tempfile::tempdir()?;
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))?;
    let path = directory.path().join("history.jsonl");
    fs::write(&path, b"")?;
    let state = AppState::new(directory.path());
    let source = HistorySource::bind(&path)?;
    source.materialize()?;
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let flusher = HistoryFlusher::new(sender, source.clone());
    let queue = Arc::clone(&flusher.queue);
    {
        let mut inner = state.write_inner();
        inner.history_path = Some(path.clone());
        inner.history_source = Some(source);
        inner.history_flusher = Some(flusher);
    }
    let owner = state.inspection_lifecycle_identity();
    let tracker = state
        .try_reserve_native_history_lineage(&owner)?
        .context("tracker unavailable")?;
    let attempt = TurnAttemptIdentity {
        thread_id: state.session_id(),
        turn_id: "turn".into(),
        attempt_id: "attempt".into(),
    };
    let original = Message::user_text("one physical input");
    let pending = state
        .history_attempt_scope(attempt.clone())?
        .run(async { accepted(state.try_begin_user_input(&owner, original.clone())) })
        .await;
    let uuid = pending.uuid().to_owned();
    super::super::commit::inject_control_observer_failure();
    process_history_flusher_command(&path, &queue, receiver.try_recv()?);
    let committed = pending.wait_with_witness().await?;
    let mut receipt = committed
        .try_take_native_row_receipt()?
        .context("original receipt missing")?;
    receipt.verify_entry(
        &state.session_id(),
        &uuid,
        Some(&attempt),
        &original,
        MAX_ROW_BYTES,
    )?;
    assert_eq!(tracker.status(), NativeHistoryLineageStatus::Unknown);
    assert_eq!(crate::load_history(&path)?.len(), 1);
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn lifecycle_replacement_makes_the_old_tracker_unknown() -> Result<()> {
    let fixture = build_fixture().await?;
    let observed = observe(&fixture)?;
    fixture
        .tracker
        .verify_original(&fixture.receipt, &observed, 0)?;
    fixture.state.write_inner().history_attempts = Default::default();
    assert_eq!(
        fixture.tracker.status(),
        NativeHistoryLineageStatus::Unknown
    );
    assert!(
        fixture
            .tracker
            .verify_original(&fixture.receipt, &observed, 0)
            .is_err()
    );
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn repeated_normal_appends_keep_a_bounded_number_of_held_handles() -> Result<()> {
    let fixture = build_fixture().await?;
    // Count only handles into this fixture: parallel tests share the
    // process descriptor table, so a process-wide count is not attributable.
    let root = fs::canonicalize(fixture._directory.path())?;
    let count = || -> Result<usize> {
        Ok(fs::read_dir("/proc/self/fd")?
            .flatten()
            .filter_map(|entry| fs::read_link(entry.path()).ok())
            .filter(|target| target.starts_with(&root))
            .count())
    };
    let baseline = count()?;
    ensure!(baseline > 0, "the fixture holds no handle to measure");
    let mut maximum = baseline;
    for index in 0..64 {
        fixture
            .state
            .add_message(Message::assistant_text(format!("step {index}")));
        fixture.state.flush_history().await?;
        assert_eq!(
            fixture.tracker.status(),
            NativeHistoryLineageStatus::Tracking
        );
        maximum = maximum.max(count()?);
    }
    fixture
        .tracker
        .verify_original(&fixture.receipt, &observe(&fixture)?, 0)?;
    assert!(
        maximum <= baseline + 24,
        "held handles grew from {baseline} to {maximum}"
    );
    assert_eq!(crate::load_history(&fixture.path)?.len(), 65);
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn status_polling_never_locks_the_writer_owned_tracker_state() -> Result<()> {
    let fixture = build_fixture().await?;
    let guard = fixture
        .tracker
        .slot
        .phase
        .lock()
        .map_err(|_| anyhow::anyhow!("phase poisoned"))?;
    assert_eq!(
        fixture.tracker.status(),
        NativeHistoryLineageStatus::Tracking
    );
    drop(guard);
    fixture
        .state
        .add_message(Message::assistant_text("still tracked"));
    fixture.state.flush_history().await?;
    fixture
        .tracker
        .verify_original(&fixture.receipt, &observe(&fixture)?, 0)?;
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn independent_binding_append_cannot_be_adopted_as_the_original_chain() -> Result<()> {
    let fixture = build_fixture().await?;
    let other = HistorySource::bind(&fixture.path)?;
    assert!(!other.shares_binding(&fixture.source));
    other.append(&next_assistant(&fixture, "foreign-binding")?)?;
    assert!(
        fixture
            .tracker
            .verify_original(&fixture.receipt, &observe(&fixture)?, 0)
            .is_err()
    );
    assert_eq!(
        fixture.tracker.status(),
        NativeHistoryLineageStatus::Unknown
    );
    assert_eq!(crate::load_history(&fixture.path)?.len(), 2);
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn replaced_body_disables_observer_without_replaying_or_failing_the_regular_writer()
-> Result<()> {
    let fixture = build_fixture().await?;
    let original_bytes = fs::read(&fixture.path)?;
    let old_path = fixture.path.with_file_name("held-original.jsonl");
    fs::rename(&fixture.path, &old_path)?;
    fs::write(&fixture.path, &original_bytes)?;
    fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o600))?;
    fixture
        .source
        .append(&next_assistant(&fixture, "replacement-append")?)?;
    assert_eq!(
        fixture.tracker.status(),
        NativeHistoryLineageStatus::Unknown
    );
    assert_eq!(fs::read(old_path)?, original_bytes);
    let rows = crate::load_history(&fixture.path)?;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].uuid.as_deref(), Some("replacement-append"));
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn same_inode_same_length_rewrite_with_restored_mtime_is_not_a_lineage() -> Result<()> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::FileExt;
    let fixture = build_fixture().await?;
    let bytes = fs::read(&fixture.path)?;
    let offset = bytes
        .windows(b"original input".len())
        .position(|part| part == b"original input")
        .context("original marker missing")?;
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&fixture.path)?;
    let metadata = file.metadata()?;
    file.write_all_at(b"Original input", offset as u64)?;
    let times = [
        libc::timespec {
            tv_sec: metadata.atime(),
            tv_nsec: metadata.atime_nsec(),
        },
        libc::timespec {
            tv_sec: metadata.mtime(),
            tv_nsec: metadata.mtime_nsec(),
        },
    ];
    // SAFETY: the fixture owns this live descriptor and two valid timespecs.
    assert_eq!(
        unsafe { libc::futimens(file.as_raw_fd(), times.as_ptr()) },
        0
    );
    assert_eq!(file.metadata()?.len(), metadata.len());
    assert!(
        fixture
            .tracker
            .verify_original(&fixture.receipt, &observe(&fixture)?, 0)
            .is_err()
    );
    assert_eq!(
        fixture.tracker.status(),
        NativeHistoryLineageStatus::Unknown
    );
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn native_source_lock_wait_does_not_hold_state_or_block_runtime() -> Result<()> {
    use fs2::FileExt;
    use std::time::Duration;
    let fixture = build_fixture().await?;
    let lock = fs::OpenOptions::new().read(true).write(true).open(
        fixture
            .path
            .parent()
            .context("history parent missing")?
            .join(MUTATION_LOCK),
    )?;
    lock.lock_exclusive()?;
    fixture
        .state
        .add_message(Message::assistant_text("after native lock"));
    let flush = fixture.state.flush_history();
    tokio::pin!(flush);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut flush)
            .await
            .is_err()
    );
    assert!(fixture.state.inner.try_write().is_ok());
    FileExt::unlock(&lock)?;
    flush.await?;
    fixture
        .tracker
        .verify_original(&fixture.receipt, &observe(&fixture)?, 0)?;
    assert_eq!(crate::load_history(&fixture.path)?.len(), 2);
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn exhausted_step_budget_does_not_block_or_replay_a_normal_write() -> Result<()> {
    let fixture = build_fixture().await?;
    for index in 0..=MAX_STEPS {
        fixture
            .state
            .add_message(Message::assistant_text(format!("step {index}")));
        fixture.state.flush_history().await?;
        if index < MAX_STEPS {
            assert_eq!(
                fixture.tracker.status(),
                NativeHistoryLineageStatus::Tracking
            );
        }
    }
    assert_eq!(
        fixture.tracker.status(),
        NativeHistoryLineageStatus::Unknown
    );
    assert_eq!(crate::load_history(&fixture.path)?.len(), MAX_STEPS + 2);
    Ok(())
}
