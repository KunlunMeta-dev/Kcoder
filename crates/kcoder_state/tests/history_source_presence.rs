#[cfg(target_os = "linux")]
mod linux {
    use fs2::FileExt;
    use kcoder_state::{
        AppState, BoundDeletedHistoryPresenceReference, HistorySourceObservation,
        HistorySourceObservationBusy, HistorySourceUnknown, mark_session_history_deleted,
        observe_session_history_source_presence, read_session_history_deletion,
    };
    use kcoder_types::Message;
    use std::collections::BTreeMap;
    use std::fs::{self, File, OpenOptions};
    use std::path::{Path, PathBuf};
    use std::sync::mpsc;
    use std::time::Duration;

    const MUTATION_LOCK: &str = ".kcoder-history.lock";

    fn save_history(root: &Path, name: &str) -> (AppState, PathBuf) {
        let path = root.join(name);
        let state = AppState::new(root);
        state.with_history_path(&path);
        state.add_message(Message::user_text("public API history seed"));
        state.save_history().unwrap();
        state.commit_session_state();
        (state, path)
    }

    fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut result = BTreeMap::new();
        for entry in fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                result.extend(snapshot(&path));
            } else {
                result.insert(path.clone(), fs::read(path).unwrap());
            }
        }
        result
    }

    fn process_rchar() -> u64 {
        fs::read_to_string("/proc/self/io")
            .unwrap()
            .lines()
            .find_map(|line| {
                line.strip_prefix("rchar:")
                    .and_then(|value| value.trim().parse().ok())
            })
            .unwrap()
    }

    #[test]
    fn bounded_presence_does_not_read_large_source_body() {
        let temp = tempfile::tempdir().unwrap();
        let (_state, path) = save_history(temp.path(), "large-source.jsonl");
        OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(128 * 1024 * 1024)
            .unwrap();

        let before_rchar = process_rchar();
        let observation = observe_session_history_source_presence(&path, temp.path()).unwrap();
        let after_rchar = process_rchar();

        assert!(matches!(
            observation,
            HistorySourceObservation::PhysicalSourceFileObserved { .. }
        ));
        assert!(
            after_rchar.saturating_sub(before_rchar) < 16 * 1024,
            "observation read {} bytes with a 128 MiB source present",
            after_rchar.saturating_sub(before_rchar)
        );
    }

    #[test]
    fn bounded_presence_reports_missing_storage_without_writes() {
        let temp = tempfile::tempdir().unwrap();
        let missing_parent = temp.path().join("not-created").join("missing.jsonl");
        let before = snapshot(temp.path());
        assert_eq!(
            observe_session_history_source_presence(&missing_parent, temp.path()).unwrap(),
            HistorySourceObservation::Unknown(HistorySourceUnknown::MissingHistoryParent)
        );
        assert_eq!(snapshot(temp.path()), before);
        assert!(!missing_parent.parent().unwrap().exists());

        let missing_control = temp.path().join("missing-control.jsonl");
        assert_eq!(
            observe_session_history_source_presence(&missing_control, temp.path()).unwrap(),
            HistorySourceObservation::Unknown(HistorySourceUnknown::MissingControlDirectory)
        );
        assert_eq!(snapshot(temp.path()), before);
        assert!(!temp.path().join(MUTATION_LOCK).exists());

        let missing_record = temp.path().join("missing-record.jsonl");
        fs::create_dir(missing_record.with_extension("hctl")).unwrap();
        let before_missing_record = snapshot(temp.path());
        assert_eq!(
            observe_session_history_source_presence(&missing_record, temp.path()).unwrap(),
            HistorySourceObservation::Unknown(HistorySourceUnknown::MissingControlRecord)
        );
        assert_eq!(snapshot(temp.path()), before_missing_record);
        assert!(!temp.path().join(MUTATION_LOCK).exists());
    }

    #[test]
    fn bounded_presence_returns_busy_without_blocking_or_writing() {
        let temp = tempfile::tempdir().unwrap();
        let (_state, path) = save_history(temp.path(), "busy.jsonl");
        let before = snapshot(temp.path());
        let mutation_lock = File::open(temp.path().join(MUTATION_LOCK)).unwrap();
        FileExt::try_lock_exclusive(&mutation_lock).unwrap();

        let (sender, receiver) = mpsc::channel();
        let path_for_reader = path.clone();
        let workspace = temp.path().to_path_buf();
        let reader = std::thread::spawn(move || {
            sender
                .send(observe_session_history_source_presence(
                    &path_for_reader,
                    &workspace,
                ))
                .unwrap();
        });
        let early = receiver.recv_timeout(Duration::from_millis(300));
        let returned_early = early.is_ok();
        FileExt::unlock(&mutation_lock).unwrap();
        let result = match early {
            Ok(result) => result,
            Err(_) => receiver.recv_timeout(Duration::from_secs(2)).unwrap(),
        };
        reader.join().unwrap();

        assert!(
            returned_early,
            "presence observation blocked on a busy writer lock"
        );
        let error = result.unwrap_err();
        assert!(
            error
                .downcast_ref::<HistorySourceObservationBusy>()
                .is_some(),
            "expected typed busy error, got: {error:#}"
        );
        assert_eq!(snapshot(temp.path()), before);
    }

    #[test]
    fn bounded_presence_returns_bound_absence_and_preserves_public_deletion_proof() {
        let temp = tempfile::tempdir().unwrap();
        let (_state, path) = save_history(temp.path(), "bound-absent.jsonl");
        let proof = mark_session_history_deleted(&path, temp.path()).unwrap();
        assert_eq!(
            read_session_history_deletion(&path, temp.path()).unwrap(),
            Some(proof.clone())
        );
        let before = snapshot(temp.path());

        let observation = observe_session_history_source_presence(&path, temp.path()).unwrap();

        let HistorySourceObservation::BoundDeletedSourceAbsent(reference) = observation else {
            panic!("expected bounded deleted absence, got {observation:?}");
        };
        assert_bound_absence_reference(&reference, &path, temp.path());
        proof.verify(&path, temp.path()).unwrap();
        assert_eq!(snapshot(temp.path()), before);
    }

    fn assert_bound_absence_reference(
        reference: &BoundDeletedHistoryPresenceReference,
        path: &Path,
        workspace: &Path,
    ) {
        assert_eq!(reference.history_path(), path);
        assert_eq!(reference.workspace(), workspace);
        assert_eq!(reference.thread_id(), "bound-absent");
        assert!(!reference.control_record_sha256().is_empty());
    }

    #[test]
    fn bounded_presence_rejects_foreign_workspace_and_corrupt_control_without_writes() {
        let temp = tempfile::tempdir().unwrap();
        let foreign = tempfile::tempdir().unwrap();
        let (_state, path) = save_history(temp.path(), "invalid-binding.jsonl");
        let proof = mark_session_history_deleted(&path, temp.path()).unwrap();
        let before_foreign = snapshot(temp.path());
        assert!(observe_session_history_source_presence(&path, foreign.path()).is_err());
        assert_eq!(snapshot(temp.path()), before_foreign);
        proof.verify(&path, temp.path()).unwrap();

        let control = path.with_extension("hctl").join("source.json");
        fs::write(&control, b"{truncated").unwrap();
        let before_corrupt = snapshot(temp.path());
        assert!(observe_session_history_source_presence(&path, temp.path()).is_err());
        assert_eq!(snapshot(temp.path()), before_corrupt);
        assert!(proof.verify(&path, temp.path()).is_err());
    }

    #[test]
    fn bounded_presence_keeps_same_inode_residual_unknown() {
        let temp = tempfile::tempdir().unwrap();
        let (_state, path) = save_history(temp.path(), "residual.jsonl");
        let backup = temp.path().join("residual-backup.jsonl");
        fs::hard_link(&path, &backup).unwrap();
        mark_session_history_deleted(&path, temp.path()).unwrap();
        fs::hard_link(&backup, &path).unwrap();
        let before = snapshot(temp.path());

        assert_eq!(
            observe_session_history_source_presence(&path, temp.path()).unwrap(),
            HistorySourceObservation::Unknown(
                HistorySourceUnknown::BoundDeletionResidualSameIdentity
            )
        );
        assert_eq!(snapshot(temp.path()), before);
    }

    #[test]
    fn bounded_presence_rejects_foreign_residual_inode_without_writes() {
        let temp = tempfile::tempdir().unwrap();
        let (_state, path) = save_history(temp.path(), "foreign-residual.jsonl");
        let backup = temp.path().join("original-inode.jsonl");
        fs::hard_link(&path, &backup).unwrap();
        mark_session_history_deleted(&path, temp.path()).unwrap();
        fs::write(&path, b"replacement with a foreign inode").unwrap();
        let before = snapshot(temp.path());

        assert!(observe_session_history_source_presence(&path, temp.path()).is_err());
        assert_eq!(snapshot(temp.path()), before);
    }
}

#[cfg(all(test, not(target_os = "linux")))]
#[test]
fn bounded_presence_reports_unsupported_platform() {
    let temp = tempfile::tempdir().unwrap();
    let error = kcoder_state::observe_session_history_source_presence(
        &temp.path().join("session.jsonl"),
        temp.path(),
    )
    .unwrap_err();
    assert!(
        error
            .downcast_ref::<kcoder_state::HistorySourcePresenceUnsupported>()
            .is_some(),
        "expected typed unsupported-platform error, got: {error:#}"
    );
}
