use super::*;
use crate::{GoalStatus, Message};

static TEST_GUARD: Mutex<()> = Mutex::new(());

fn fixture() -> (
    tempfile::TempDir,
    AppState,
    PathBuf,
    NativeGoalMetadataLineage,
) {
    #[cfg(unix)]
    let temp = {
        use std::os::unix::fs::PermissionsExt;
        tempfile::Builder::new()
            .permissions(std::fs::Permissions::from_mode(0o700))
            .tempdir()
            .unwrap()
    };
    #[cfg(not(unix))]
    let temp = tempfile::tempdir().unwrap();
    let state = AppState::new(temp.path());
    let history = temp.path().join("session.jsonl");
    state.with_history_path(&history);
    state.add_message(Message::user_text("first"));
    state.save_history().unwrap();
    let owner = state.inspection_lifecycle_identity();
    let tracker = state
        .try_reserve_native_goal_metadata_lineage(&owner)
        .unwrap()
        .unwrap();
    (temp, state, history, tracker)
}

fn source(state: &AppState) -> HistorySource {
    state.read_inner().history_source.clone().unwrap()
}

fn read_goal(tracker: &NativeGoalMetadataLineage, _state: &AppState) -> Option<GoalStatus> {
    tracker
        .try_capture(1024 * 1024, || Ok(()))
        .unwrap()?
        .prepare_goal_observation()
        .unwrap()
        .goal
        .map(|(_, _, status)| status)
}

fn assert_new_metadata_can_rearm_without_reviving_old_observer(
    state: &AppState,
    old: NativeGoalMetadataLineage,
) {
    let old_observer = old.observer();
    assert!(old.is_definitively_revoked());
    drop(old);
    let owner = state.inspection_lifecycle_identity();
    let renewed = state
        .try_reserve_native_goal_metadata_lineage(&owner)
        .unwrap()
        .unwrap();
    state.set_goal("new metadata after revocation", None);
    assert_eq!(read_goal(&renewed, state), Some(GoalStatus::Active));
    assert!(
        old_observer
            .try_capture(1024 * 1024, || Ok(()))
            .unwrap()
            .is_none()
    );
}

#[test]
fn metadata_then_multiple_native_appends_preserve_original_goal() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    let (_temp, state, history, tracker) = fixture();
    assert_eq!(tracker.status(), NativeGoalMetadataLineageStatus::Armed);
    assert!(
        tracker
            .try_capture(1024 * 1024, || Ok(()))
            .unwrap()
            .is_none()
    );
    state.set_goal("owned metadata", None);
    assert_eq!(tracker.status(), NativeGoalMetadataLineageStatus::Tracking);
    assert_eq!(read_goal(&tracker, &state), Some(GoalStatus::Active));
    for _ in 0..3 {
        source(&state).append(b"{}\n").unwrap();
    }
    assert_eq!(tracker.status(), NativeGoalMetadataLineageStatus::Tracking);
    assert_eq!(read_goal(&tracker, &state), Some(GoalStatus::Active));
    assert!(
        CapturedSessionMetadata::try_capture_fenced_goal(&history, 1024 * 1024, || Ok(())).is_err()
    );
    state.update_goal_status(GoalStatus::Paused).unwrap();
    source(&state).append(b"{}\n").unwrap();
    assert_eq!(read_goal(&tracker, &state), Some(GoalStatus::Paused));
}

#[test]
fn default_writer_keeps_existing_control_layout_without_any_tracker() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    let (temp, state, history, tracker) = fixture();
    drop(tracker);
    state.set_goal("ordinary writer", None);
    source(&state).append(b"{}\n").unwrap();
    assert_eq!(ACTIVE_TRACKERS.load(Ordering::Acquire), 0);
    let mut names = std::fs::read_dir(history.with_extension("hctl"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(names, vec![std::ffi::OsString::from(SOURCE_RECORD_FILE)]);
    assert!(
        CapturedSessionMetadata::try_capture_fenced_goal(&history, 1024 * 1024, || Ok(())).is_err()
    );
    drop(state);
    drop(temp);
}

#[test]
fn dropping_state_releases_weak_tracker_after_original_writer_ends() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    let (_temp, state, _history, tracker) = fixture();
    state.set_goal("owned metadata", None);
    assert_eq!(tracker.status(), NativeGoalMetadataLineageStatus::Tracking);
    let weak = tracker.observer.slot.clone();
    drop(state);
    assert!(weak.upgrade().is_none());
    assert_eq!(ACTIVE_TRACKERS.load(Ordering::Acquire), 0);
}

#[test]
fn append_step_limit_revokes_only_the_observation() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    let (_temp, state, _history, tracker) = fixture();
    state.set_goal("owned metadata", None);
    for _ in 0..MAX_STEPS {
        source(&state).append(b"{}\n").unwrap();
    }
    assert_eq!(read_goal(&tracker, &state), Some(GoalStatus::Active));
    source(&state).append(b"{}\n").unwrap();
    assert_eq!(tracker.status(), NativeGoalMetadataLineageStatus::Unknown);
    assert_new_metadata_can_rearm_without_reviving_old_observer(&state, tracker);
}

#[test]
fn append_byte_limit_revokes_only_the_observation() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    let (_temp, state, _history, tracker) = fixture();
    state.set_goal("owned metadata", None);
    let mut payload = vec![b'x'; MAX_APPENDED_BYTES as usize];
    *payload.last_mut().unwrap() = b'\n';
    source(&state).append(&payload).unwrap();
    assert_eq!(read_goal(&tracker, &state), Some(GoalStatus::Active));
    source(&state).append(b"\n").unwrap();
    assert_eq!(tracker.status(), NativeGoalMetadataLineageStatus::Unknown);
    assert_new_metadata_can_rearm_without_reviving_old_observer(&state, tracker);
}

#[test]
fn temporary_state_lock_contention_is_not_definitive_revocation() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    let (_temp, state, _history, tracker) = fixture();
    state.set_goal("owned metadata", None);
    let write_guard = state.inner.write().unwrap();
    assert!(!tracker.is_definitively_revoked());
    drop(write_guard);
    assert_eq!(tracker.status(), NativeGoalMetadataLineageStatus::Tracking);
    assert_eq!(read_goal(&tracker, &state), Some(GoalStatus::Active));
}

#[test]
fn settled_unused_reservation_releases_capacity_without_reviving_old_observers() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    let (_temp, state, _history, tracker) = fixture();
    let observer = tracker.observer();
    let settlement = tracker.settlement();
    let slot = observer.slot.upgrade().unwrap();
    let phase = slot.phase.lock().unwrap();
    assert!(!settlement.try_revoke_if_armed());
    drop(phase);
    assert!(settlement.try_revoke_if_armed());
    assert_eq!(ACTIVE_TRACKERS.load(Ordering::Acquire), 0);
    assert!(tracker.is_definitively_revoked());
    assert_new_metadata_can_rearm_without_reviving_old_observer(&state, tracker);
}

#[test]
fn settling_a_turn_does_not_revoke_a_committed_metadata_observation() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    let (_temp, state, _history, tracker) = fixture();
    state.set_goal("committed goal", None);
    assert!(!tracker.settlement().try_revoke_if_armed());
    assert_eq!(read_goal(&tracker, &state), Some(GoalStatus::Active));
}

#[test]
fn settlement_during_real_metadata_commit_does_not_revoke_its_published_observation() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    let (_temp, state, history, tracker) = fixture();
    let slot = tracker.observer.slot.upgrade().unwrap();
    let settlement = tracker.settlement();
    let sidecar = state.session_state_path().unwrap();
    let bytes = std::fs::read(&sidecar).unwrap();
    let (directory, name) = open_parent_with_create(&history, false).unwrap();
    let lock = open_mutation_lock(&directory).unwrap();
    fs2::FileExt::lock_exclusive(&lock).unwrap();
    let original = read_source_record(&directory, &name).unwrap().unwrap();
    let mutation = Mutation::Metadata {
        path: &sidecar,
        bytes,
    };
    let mut advance = Advance::new(Arc::clone(&slot));
    let observation = advance.prepare(&history, &directory, &name, &original, &mutation);
    assert!(matches!(*slot.phase.lock().unwrap(), Phase::InFlight));
    assert!(!settlement.try_revoke_if_armed());
    drop(settlement);
    assert!(!slot.invalid.load(Ordering::Acquire));
    let committed = commit::commit_mutation(
        &history,
        &directory,
        &name,
        original,
        mutation,
        commit::CommitObservations {
            live_preparation: None,
            metadata: observation,
            #[cfg(target_os = "linux")]
            lineage: commit::LineageCommitOptions {
                preparation: None,
                observe_ready_publisher: false,
            },
        },
    )
    .unwrap();
    advance.finish(&history, &directory, &name, committed.metadata_publication);
    fs2::FileExt::unlock(&lock).unwrap();
    assert_eq!(tracker.status(), NativeGoalMetadataLineageStatus::Tracking);
    assert!(
        tracker
            .try_capture(1024 * 1024, || Ok(()))
            .unwrap()
            .is_some()
    );
}

#[test]
fn untracked_external_append_invalidates_without_blocking_normal_writer() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    let (_temp, state, history, tracker) = fixture();
    state.set_goal("owned metadata", None);
    HistorySource::bind(&history)
        .unwrap()
        .append(b"{}\n")
        .unwrap();
    assert!(
        tracker
            .try_capture(1024 * 1024, || Ok(()))
            .unwrap()
            .is_none()
    );
    source(&state).append(b"[]\n").unwrap();
    assert_eq!(tracker.status(), NativeGoalMetadataLineageStatus::Unknown);
}

#[test]
fn failed_observer_clone_never_fails_or_replays_the_metadata_write() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    let (_temp, state, history, tracker) = fixture();
    commit::inject_metadata_observer_failure();
    let goal = state.set_goal("committed even when observer fails", None);
    assert_eq!(goal.status, GoalStatus::Active);
    assert_eq!(tracker.status(), NativeGoalMetadataLineageStatus::Unknown);
    let stored = crate::history_persisted_goal(&history).unwrap().unwrap();
    assert_eq!(stored.goal_id, goal.goal_id);
    source(&state).append(b"{}\n").unwrap();
    assert_eq!(tracker.status(), NativeGoalMetadataLineageStatus::Unknown);
}

#[test]
fn failed_control_observer_never_fails_the_metadata_write() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    let (_temp, state, history, tracker) = fixture();
    commit::inject_metadata_control_observer_failure();
    let goal = state.set_goal("control observer may fail", None);
    assert_eq!(tracker.status(), NativeGoalMetadataLineageStatus::Unknown);
    assert_eq!(
        crate::history_persisted_goal(&history)
            .unwrap()
            .unwrap()
            .goal_id,
        goal.goal_id
    );
    source(&state).append(b"{}\n").unwrap();
}

#[cfg(unix)]
#[test]
fn same_bytes_replacement_then_restore_never_reauthorizes_original_tracker() {
    use std::os::unix::fs::PermissionsExt;
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    for kind in ["body", "control", "sidecar"] {
        let (_temp, state, history, tracker) = fixture();
        state.set_goal("owned metadata", None);
        let path = match kind {
            "body" => history.clone(),
            "control" => history.with_extension("hctl").join(SOURCE_RECORD_FILE),
            _ => state.session_state_path().unwrap(),
        };
        let bytes = std::fs::read(&path).unwrap();
        let backup = path.with_extension("original");
        std::fs::rename(&path, &backup).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(
            tracker
                .try_capture(1024 * 1024, || Ok(()))
                .unwrap()
                .is_none(),
            "{kind}"
        );
        std::fs::remove_file(&path).unwrap();
        std::fs::rename(&backup, &path).unwrap();
        assert_eq!(
            tracker.status(),
            NativeGoalMetadataLineageStatus::Unknown,
            "{kind}"
        );
        assert!(
            tracker
                .try_capture(1024 * 1024, || Ok(()))
                .unwrap()
                .is_none(),
            "{kind}"
        );
    }
}

#[cfg(windows)]
#[test]
fn windows_replacement_is_rejected_or_the_os_keeps_the_original() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    for kind in ["body", "control", "sidecar"] {
        let (_temp, state, history, tracker) = fixture();
        state.set_goal("owned metadata", None);
        let path = match kind {
            "body" => history.clone(),
            "control" => history.with_extension("hctl").join(SOURCE_RECORD_FILE),
            _ => state.session_state_path().unwrap(),
        };
        let bytes = std::fs::read(&path).unwrap();
        let original = File::open(&path).unwrap();
        let identity =
            kcoder_config::PortableLeaseIdentity::from_regular_handle(&original).unwrap();
        let backup = path.with_extension("original");
        match std::fs::rename(&path, &backup) {
            Ok(()) => {
                let parent = PrivateDirectory::open_existing(path.parent().unwrap()).unwrap();
                parent
                    .atomic_replace(path.file_name().unwrap(), &bytes)
                    .unwrap();
                eprintln!("Windows metadata tracker fixture: {kind} replacement happened");
                assert!(
                    tracker
                        .try_capture(1024 * 1024, || Ok(()))
                        .unwrap()
                        .is_none()
                );
                assert_eq!(tracker.status(), NativeGoalMetadataLineageStatus::Unknown);
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::PermissionDenied
                    || matches!(error.raw_os_error(), Some(5 | 32 | 33)) =>
            {
                eprintln!("Windows metadata tracker fixture: {kind} replacement denied by OS");
                assert!(!backup.exists());
                assert_eq!(std::fs::read(&path).unwrap(), bytes);
                assert_eq!(
                    kcoder_config::PortableLeaseIdentity::from_regular_handle(
                        &File::open(&path).unwrap()
                    )
                    .unwrap(),
                    identity
                );
                assert_eq!(read_goal(&tracker, &state), Some(GoalStatus::Active));
            }
            Err(error) => panic!("unexpected replacement result: {error}"),
        }
    }
}

#[test]
fn replaced_or_compacted_source_and_new_lifecycle_never_inherit_tracker() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    let (_temp, state, _history, tracker) = fixture();
    state.set_goal("owned metadata", None);
    let observer = tracker.observer();
    assert!(observer.matches_lifecycle(&state.inspection_lifecycle_identity()));
    source(&state).replace(b"{}\n").unwrap();
    assert_eq!(tracker.status(), NativeGoalMetadataLineageStatus::Unknown);
    state.start_new_session().unwrap();
    assert!(!observer.matches_lifecycle(&state.inspection_lifecycle_identity()));
    assert_eq!(tracker.status(), NativeGoalMetadataLineageStatus::Unknown);
}

#[test]
fn same_lifecycle_with_a_different_source_does_not_inherit_the_tracker() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    let (temp, state, _history, tracker) = fixture();
    state.set_goal("owned metadata", None);
    let owner = state.inspection_lifecycle_identity();
    state.with_history_path(temp.path().join("different.jsonl"));
    assert_eq!(owner.try_matches(&state), Some(true));
    assert_eq!(tracker.status(), NativeGoalMetadataLineageStatus::Unknown);
    assert!(
        tracker
            .try_capture(1024 * 1024, || Ok(()))
            .unwrap()
            .is_none()
    );
}

#[test]
fn cancelled_observation_does_not_replay_or_invalidate_a_valid_writer() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    let (_temp, state, _history, tracker) = fixture();
    state.set_goal("owned metadata", None);
    let mut calls = 0;
    assert!(
        tracker
            .try_capture(1024 * 1024, || {
                calls += 1;
                anyhow::ensure!(calls < 3, "observation cancelled");
                Ok(())
            })
            .unwrap()
            .is_none()
    );
    assert_eq!(read_goal(&tracker, &state), Some(GoalStatus::Active));
}

#[test]
fn old_observer_is_unknown_if_native_append_completes_during_copy() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    let (_temp, state, _history, tracker) = fixture();
    state.set_goal("owned metadata", None);
    let observer = tracker.observer();
    let worker_observer = observer.clone();
    let (entered, ready) = std::sync::mpsc::channel();
    let (resume, wait) = std::sync::mpsc::channel();
    let read = std::thread::spawn(move || {
        let mut calls = 0;
        worker_observer
            .try_capture(1024 * 1024, || {
                calls += 1;
                if calls == 2 {
                    entered.send(()).unwrap();
                    wait.recv().unwrap();
                }
                Ok(())
            })
            .unwrap()
    });
    ready
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    source(&state).append(b"{}\n").unwrap();
    resume.send(()).unwrap();
    assert!(read.join().unwrap().is_none());
    assert_eq!(read_goal(&tracker, &state), Some(GoalStatus::Active));
}

#[test]
fn stalled_observer_does_not_retain_a_closed_state_owner() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    let (_temp, state, _history, tracker) = fixture();
    state.set_goal("owned metadata", None);
    let observer = tracker.observer();
    let worker_observer = observer.clone();
    let original_state = state.inspection_identity();
    let (entered, ready) = std::sync::mpsc::channel();
    let (resume, wait) = std::sync::mpsc::channel();
    let read = std::thread::spawn(move || {
        let mut calls = 0;
        worker_observer
            .try_capture(1024 * 1024, || {
                calls += 1;
                if calls == 2 {
                    entered.send(()).unwrap();
                    wait.recv().unwrap();
                }
                Ok(())
            })
            .unwrap()
    });
    ready
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    drop(tracker);
    assert_eq!(observer.status(), NativeGoalMetadataLineageStatus::Unknown);
    drop(state);
    assert!(!original_state.is_alive(), "observer must not retain State");
    assert_eq!(
        ACTIVE_TRACKERS.load(Ordering::Acquire),
        1,
        "in-flight handles still own capacity"
    );
    resume.send(()).unwrap();
    assert!(read.join().unwrap().is_none());
    assert_eq!(ACTIVE_TRACKERS.load(Ordering::Acquire), 0);
}

#[test]
fn unknown_commit_does_not_replay_or_claim_a_receipt() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    let (_temp, state, history, tracker) = fixture();
    state.set_goal("owned metadata", None);
    let original = std::fs::metadata(&history).unwrap().len();
    let _cut = commit::install_cut(&history, commit::CommitStage::AfterAuthority, false);
    assert!(source(&state).append(b"{}\n").is_err());
    assert_eq!(std::fs::metadata(&history).unwrap().len(), original + 3);
    assert_eq!(tracker.status(), NativeGoalMetadataLineageStatus::Unknown);
    assert!(
        tracker
            .try_capture(1024 * 1024, || Ok(()))
            .unwrap()
            .is_none()
    );
}

#[test]
fn tracker_capacity_and_owner_release_are_bounded() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    let mut fixtures = Vec::new();
    for _ in 0..MAX_TRACKERS {
        fixtures.push(fixture());
    }
    assert_eq!(ACTIVE_TRACKERS.load(Ordering::Acquire), MAX_TRACKERS);
    let (extra_temp, extra_state, _history, extra_tracker) = fixture_without_reservation();
    assert!(extra_tracker.is_none());
    let (_, _, _, released) = fixtures.pop().unwrap();
    drop(released);
    let owner = extra_state.inspection_lifecycle_identity();
    let replacement = extra_state
        .try_reserve_native_goal_metadata_lineage(&owner)
        .unwrap()
        .unwrap();
    drop(replacement);
    drop(extra_state);
    drop(extra_temp);
    drop(fixtures);
    assert_eq!(ACTIVE_TRACKERS.load(Ordering::Acquire), 0);
}

#[test]
fn busy_settlements_do_not_permanently_exhaust_process_capacity() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    let fixtures = (0..MAX_TRACKERS).map(|_| fixture()).collect::<Vec<_>>();
    let slots = fixtures
        .iter()
        .map(|(_, _, _, tracker)| tracker.observer.slot.upgrade().unwrap())
        .collect::<Vec<_>>();
    let held = slots
        .iter()
        .map(|slot| slot.phase.lock().unwrap())
        .collect::<Vec<_>>();
    for (_, _, _, tracker) in &fixtures {
        let settlement = tracker.settlement();
        assert!(!settlement.try_revoke_if_armed());
        drop(settlement);
    }
    assert_eq!(ACTIVE_TRACKERS.load(Ordering::Acquire), MAX_TRACKERS);
    drop(held);
    let (_temp, _state, _history, extra) = fixture_without_reservation();
    assert!(
        extra.is_some(),
        "settled but briefly busy Armed slots must not permanently exhaust capacity"
    );
}

#[test]
fn settlement_during_state_lock_busy_does_not_strand_its_slot() {
    let _guard = TEST_GUARD.lock().unwrap_or_else(|error| error.into_inner());
    let (_temp, state, _history, tracker) = fixture();
    let owner = state.inspection_lifecycle_identity();
    let held = state.inner.write().unwrap();
    let settlement = tracker.settlement();
    settlement.try_revoke_if_armed();
    drop(settlement);
    drop(held);
    assert!(tracker.is_definitively_revoked());
    drop(tracker);
    assert!(
        state
            .try_reserve_native_goal_metadata_lineage(&owner)
            .unwrap()
            .is_some()
    );
}

fn fixture_without_reservation() -> (
    tempfile::TempDir,
    AppState,
    PathBuf,
    Option<NativeGoalMetadataLineage>,
) {
    #[cfg(unix)]
    let temp = {
        use std::os::unix::fs::PermissionsExt;
        tempfile::Builder::new()
            .permissions(std::fs::Permissions::from_mode(0o700))
            .tempdir()
            .unwrap()
    };
    #[cfg(not(unix))]
    let temp = tempfile::tempdir().unwrap();
    let state = AppState::new(temp.path());
    let history = temp.path().join("session.jsonl");
    state.with_history_path(&history);
    state.add_message(Message::user_text("first"));
    state.save_history().unwrap();
    let owner = state.inspection_lifecycle_identity();
    let tracker = state
        .try_reserve_native_goal_metadata_lineage(&owner)
        .unwrap();
    (temp, state, history, tracker)
}
