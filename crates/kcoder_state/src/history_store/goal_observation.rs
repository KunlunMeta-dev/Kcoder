//! Read-only Goal sidecar capture under the existing history mutation fence.
use super::*;
use crate::history_metadata::CapturedSessionMetadata;
use kcoder_config::PortableLeaseIdentity;

struct SharedHistoryLease<'a>(&'a File);

impl Drop for SharedHistoryLease<'_> {
    fn drop(&mut self) {
        let _ = FileExt::unlock(self.0);
    }
}

/// The lock attempt is nonblocking; all other filesystem calls must be run on
/// an owned bounded worker and are not guaranteed to finish by a deadline.
pub(crate) fn try_capture_goal_metadata(
    path: &Path,
    max_bytes: u64,
    check: impl FnMut() -> Result<()>,
) -> Result<CapturedSessionMetadata> {
    capture_inner(path, max_bytes, None, check)
}

pub(super) fn try_capture_goal_metadata_with_lineage(
    path: &Path,
    max_bytes: u64,
    evidence: &super::metadata_lineage::Evidence,
    check: impl FnMut() -> Result<()>,
) -> Result<CapturedSessionMetadata> {
    capture_inner(path, max_bytes, Some(evidence), check)
}

fn capture_inner(
    path: &Path,
    max_bytes: u64,
    lineage: Option<&super::metadata_lineage::Evidence>,
    mut check: impl FnMut() -> Result<()>,
) -> Result<CapturedSessionMetadata> {
    anyhow::ensure!(
        (1..=1024 * 1024).contains(&max_bytes),
        "invalid captured metadata budget"
    );
    check()?;
    let (directory, name) = open_parent_with_create(path, false)?;
    directory
        .verify_private_directory()
        .context("history parent is not private")?;
    let parent_path = path.parent().context("history source has no parent")?;
    let parent_identity = directory.directory_identity()?;
    let lock = directory.open_single_link_regular_file(OsStr::new(MUTATION_LOCK))?;
    let lock_identity = directory.portable_regular_handle_identity(&lock)?;
    FileExt::try_lock_shared(&lock).context("history mutation fence is unavailable")?;
    let lease = SharedHistoryLease(&lock);

    let body = directory.open_single_link_regular_file(&name)?;
    let body_identity = directory.portable_regular_handle_identity(&body)?;
    let control_name = source_directory_name(&name)?;
    let control_directory = directory.open_child(&control_name, false)?;
    control_directory
        .verify_private_directory()
        .context("history control directory is not private")?;
    let control_directory_identity = control_directory.directory_identity()?;
    let mut control =
        control_directory.open_single_link_regular_file(OsStr::new(SOURCE_RECORD_FILE))?;
    let control_identity = control_directory.portable_regular_handle_identity(&control)?;
    let original = read_held_control(&mut control)?;
    anyhow::ensure!(!original.deleted, "history source is deleted");
    anyhow::ensure!(
        original.deletion.is_none(),
        "live history source has a deletion binding"
    );
    let commit = original
        .commit
        .as_ref()
        .context("legacy history source has no commit witness")?;
    commit.check_ready()?;
    if let Some(length) = commit.committed_bytes {
        anyhow::ensure!(
            body.metadata()?.len() == length,
            "history body length differs from source record"
        );
    }

    let verify = |control: &File| -> Result<()> {
        check_held_leaf(&directory, OsStr::new(MUTATION_LOCK), &lock, &lock_identity)?;
        check_held_leaf(&directory, &name, &body, &body_identity)?;
        check_held_leaf(
            &control_directory,
            OsStr::new(SOURCE_RECORD_FILE),
            control,
            &control_identity,
        )?;
        anyhow::ensure!(
            directory
                .open_child(&control_name, false)?
                .directory_identity()?
                == control_directory_identity,
            "history control directory changed during capture"
        );
        anyhow::ensure!(
            PrivateDirectory::open_existing(parent_path)?.directory_identity()? == parent_identity,
            "history parent changed during capture"
        );
        Ok(())
    };
    verify(&control)?;
    let mut sidecar = crate::history_metadata::HeldGoalMetadata::open(path, &directory)?;
    anyhow::ensure!(
        sidecar.is_primary(),
        "legacy sidecar has no native metadata receipt"
    );
    if let Some(evidence) = lineage {
        evidence.verify(path, &directory, &name, &original)?;
        evidence.verify_sidecar(&sidecar)?;
    }
    verify(&control)?;
    drop(lease);
    check()?;
    let captured = sidecar.copy(max_bytes, &mut check)?;
    let (relative_path, length, sha256) = match lineage {
        Some(evidence) => evidence.metadata_receipt(),
        None => match commit.last_operation.as_ref() {
            Some(commit::MutationPlan::Metadata {
                relative_path,
                length,
                sha256,
            }) => (relative_path.as_slice(), *length, sha256.as_str()),
            _ => anyhow::bail!("history source has no current sidecar receipt"),
        },
    };
    anyhow::ensure!(
        captured.matches_source_metadata(relative_path, length, sha256)?,
        "session sidecar differs from its source receipt"
    );
    check()?;
    FileExt::try_lock_shared(&lock).context("history mutation fence is unavailable")?;
    let _final_lease = SharedHistoryLease(&lock);
    verify(&control)?;
    anyhow::ensure!(
        read_held_control(&mut control)? == original,
        "history source changed during capture"
    );
    check()?;
    verify(&control)?;
    sidecar.verify(&directory)?;
    if let Some(evidence) = lineage {
        evidence.verify(path, &directory, &name, &original)?;
        evidence.verify_sidecar(&sidecar)?;
    }
    Ok(captured)
}

fn check_held_leaf(
    directory: &PrivateDirectory,
    name: &OsStr,
    held: &File,
    expected: &PortableLeaseIdentity,
) -> Result<()> {
    anyhow::ensure!(
        directory.portable_regular_handle_identity(held)? == *expected
            && directory.portable_regular_handle_identity(
                &directory.open_single_link_regular_file(name)?
            )? == *expected,
        "history source object changed during capture"
    );
    Ok(())
}

fn read_held_control(file: &mut File) -> Result<SourceRecord> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.take(4097).read_to_end(&mut bytes)?;
    anyhow::ensure!(bytes.len() <= 4096, "history source record is too large");
    let record: SourceRecord =
        serde_json::from_slice(&bytes).context("history source record is corrupt")?;
    anyhow::ensure!(
        record.schema_version == 2,
        "history source has no versioned commit witness"
    );
    record
        .commit
        .as_ref()
        .context("history source has no commit witness")?
        .validate()?;
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AppState, GoalStatus};

    fn private_temp() -> tempfile::TempDir {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tempfile::Builder::new()
                .permissions(std::fs::Permissions::from_mode(0o700))
                .tempdir()
                .unwrap()
        }
        #[cfg(not(unix))]
        {
            tempfile::tempdir().unwrap()
        }
    }

    fn fixture(with_goal: bool) -> (tempfile::TempDir, AppState, PathBuf) {
        let temp = private_temp();
        let state = AppState::new(temp.path());
        let path = temp.path().join("session.jsonl");
        state.with_history_path(&path);
        state.add_message(kcoder_types::Message::user_text("input"));
        state.save_history().unwrap();
        if with_goal {
            state.set_goal("observe", None);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(temp.path()).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        (temp, state, path)
    }

    fn capture(path: &Path) -> Result<CapturedSessionMetadata> {
        CapturedSessionMetadata::try_capture_fenced_goal(path, 1024 * 1024, || Ok(()))
    }

    #[test]
    fn fenced_goal_capture_owns_the_original_goal_bytes_after_unlock() {
        let (temp, state, path) = fixture(true);
        let goal = state.goal().unwrap();
        let captured = capture(&path).unwrap();
        state.update_goal_status(GoalStatus::Complete).unwrap();
        let prepared = captured.prepare_goal_observation().unwrap();
        assert_eq!(prepared.base_cwd.as_deref(), Some(temp.path()));
        assert_eq!(
            prepared.goal,
            Some((goal.goal_id, goal.revision, GoalStatus::Active))
        );
        assert_eq!(
            capture(&path)
                .unwrap()
                .prepare_goal_observation()
                .unwrap()
                .goal
                .unwrap()
                .2,
            GoalStatus::Complete
        );
    }

    #[test]
    fn fenced_goal_capture_distinguishes_no_goal_from_missing_sidecar() {
        let (_temp, state, path) = fixture(false);
        assert!(
            capture(&path)
                .unwrap()
                .prepare_goal_observation()
                .unwrap()
                .goal
                .is_none()
        );
        let sidecar = state.session_state_path().unwrap();
        std::fs::remove_file(sidecar).unwrap();
        assert!(capture(&path).is_err());
    }

    #[test]
    fn fenced_goal_parser_rejects_unknown_status_and_missing_revision() {
        let (_temp, state, path) = fixture(true);
        let sidecar = state.session_state_path().unwrap();
        let original: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&sidecar).unwrap()).unwrap();
        let mut future = original.clone();
        future["goal"]["status"] = "future-status".into();
        let source = HistorySource::bind(&path).unwrap();
        source
            .write_metadata(&sidecar, || Ok(serde_json::to_vec(&future)?))
            .unwrap();
        assert!(capture(&path).unwrap().prepare_goal_observation().is_err());
        let mut old = original;
        old["goal"].as_object_mut().unwrap().remove("revision");
        source
            .write_metadata(&sidecar, || Ok(serde_json::to_vec(&old)?))
            .unwrap();
        assert!(capture(&path).unwrap().prepare_goal_observation().is_err());
    }

    #[test]
    fn fenced_goal_rejects_sidecar_from_another_session_and_later_append() {
        let (_first_root, first, first_history) = fixture(true);
        let (_second_root, second, _) = fixture(true);
        let first_sidecar = first.session_state_path().unwrap();
        let foreign = std::fs::read(second.session_state_path().unwrap()).unwrap();
        std::fs::write(&first_sidecar, foreign).unwrap();
        assert!(
            capture(&first_history).is_err(),
            "foreign bytes have no source receipt"
        );

        let (_root, _state, history) = fixture(true);
        HistorySource::bind(&history)
            .unwrap()
            .append(b"{}\n")
            .unwrap();
        assert!(
            capture(&history).is_err(),
            "last append cannot prove a sidecar receipt"
        );
    }

    #[test]
    fn fenced_goal_capture_rejects_primary_appearing_after_legacy_selection() {
        let (_temp, state, history) = fixture(true);
        let primary = state.session_state_path().unwrap();
        let legacy = crate::session_persistence::session_state_path_for_history(&history);
        let bytes = std::fs::read(&primary).unwrap();
        let legacy_root = PrivateDirectory::open_existing(legacy.parent().unwrap()).unwrap();
        legacy_root
            .atomic_replace(legacy.file_name().unwrap(), &bytes)
            .unwrap();
        std::fs::remove_file(&primary).unwrap();
        assert!(
            capture(&history).is_err(),
            "legacy cannot borrow a primary receipt"
        );
        let (directory, _) = open_parent_with_create(&history, false).unwrap();
        let lock = directory
            .open_single_link_regular_file(OsStr::new(MUTATION_LOCK))
            .unwrap();
        FileExt::try_lock_shared(&lock).unwrap();
        let held = crate::history_metadata::HeldGoalMetadata::open(&history, &directory).unwrap();
        assert!(!held.is_primary());
        FileExt::unlock(&lock).unwrap();
        let target = PrivateDirectory::open_existing(primary.parent().unwrap()).unwrap();
        target
            .atomic_replace(primary.file_name().unwrap(), &bytes)
            .unwrap();
        FileExt::try_lock_shared(&lock).unwrap();
        let verified = held.verify(&directory);
        FileExt::unlock(&lock).unwrap();
        assert!(
            verified.is_err(),
            "new primary cannot be hidden by an older legacy selection"
        );
    }

    #[test]
    fn fenced_goal_rejects_live_source_with_deletion_binding() {
        let (temp, _state, history) = fixture(true);
        assert!(capture(&history).is_ok());
        let (directory, name) = open_parent_with_create(&history, false).unwrap();
        let mut record = read_source_record(&directory, &name).unwrap().unwrap();
        let identity = kcoder_types::PrivateFileIdentityV1 {
            version: 1,
            kind: kcoder_types::PrivateFileKind::Directory,
            native: kcoder_types::PrivateNativeFileIdentity::Linux {
                device: 1,
                inode: 1,
            },
        };
        record.deletion = Some(DeletionBinding {
            workspace: temp.path().to_path_buf(),
            workspace_identity: identity.clone(),
            history_parent: identity,
            source_identity: None,
            source_bytes: None,
            source_incarnation: record.incarnation,
        });
        let path = history.with_extension("hctl").join(SOURCE_RECORD_FILE);
        std::fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(capture(&history).is_err());
    }

    #[test]
    fn fenced_goal_capture_budget_and_cancellation_do_not_leave_the_lock_held() {
        let (_temp, state, path) = fixture(true);
        let sidecar = state.session_state_path().unwrap();
        let before = std::fs::read(&sidecar).unwrap();
        assert!(CapturedSessionMetadata::try_capture_fenced_goal(&path, 1, || Ok(())).is_err());
        let mut calls = 0;
        assert!(
            CapturedSessionMetadata::try_capture_fenced_goal(&path, 1024 * 1024, || {
                calls += 1;
                anyhow::ensure!(calls < 3, "cancelled");
                Ok(())
            })
            .is_err()
        );
        assert_eq!(std::fs::read(&sidecar).unwrap(), before);
        assert!(capture(&path).is_ok());
    }

    #[test]
    fn fenced_goal_capture_fails_immediately_when_real_writer_lock_is_held() {
        let (temp, _state, path) = fixture(true);
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(temp.path().join(MUTATION_LOCK))
            .unwrap();
        FileExt::lock_exclusive(&lock).unwrap();
        let before = std::time::Instant::now();
        let result = capture(&path);
        let elapsed = before.elapsed();
        FileExt::unlock(&lock).unwrap();
        assert!(result.is_err());
        assert!(elapsed < std::time::Duration::from_secs(1));
        assert!(capture(&path).is_ok());
    }

    #[test]
    fn fenced_goal_capture_releases_lock_during_copy_and_rejects_intervening_writer() {
        let (_temp, state, path) = fixture(true);
        let mut count = 0;
        let mut writer = None;
        let mut writer_completed_in_copy = false;
        let result = CapturedSessionMetadata::try_capture_fenced_goal(&path, 1024 * 1024, || {
            count += 1;
            if count == 2 {
                let state = state.clone();
                let (sender, receiver) = std::sync::mpsc::channel();
                writer = Some(std::thread::spawn(move || {
                    let result = state.update_goal_status(GoalStatus::Complete);
                    sender.send(()).unwrap();
                    result
                }));
                writer_completed_in_copy = receiver
                    .recv_timeout(std::time::Duration::from_secs(3))
                    .is_ok();
                anyhow::ensure!(
                    writer_completed_in_copy,
                    "writer blocked while copying sidecar"
                );
            }
            Ok(())
        });
        let committed = writer.unwrap().join().unwrap();
        assert!(writer_completed_in_copy);
        assert!(committed.is_some());
        assert!(result.is_err(), "source changed between the two fences");
        assert_eq!(
            capture(&path)
                .unwrap()
                .prepare_goal_observation()
                .unwrap()
                .goal
                .unwrap()
                .2,
            GoalStatus::Complete
        );
    }

    #[test]
    fn fenced_goal_capture_never_creates_missing_lock_or_claims_unknown_source() {
        let temp = private_temp();
        let path = temp.path().join("missing.jsonl");
        std::fs::write(&path, b"{}\n").unwrap();
        let lock = temp.path().join(MUTATION_LOCK);
        assert!(capture(&path).is_err());
        assert!(!lock.exists());
        std::fs::write(&lock, b"").unwrap();
        assert!(capture(&path).is_err());
        assert!(!temp.path().join("missing.hctl").exists());
    }

    #[test]
    fn fenced_goal_capture_rejects_pending_and_corrupt_control_records() {
        let (_temp, _state, path) = fixture(true);
        let (directory, name) = open_parent_with_create(&path, false).unwrap();
        let mut record = read_source_record(&directory, &name).unwrap().unwrap();
        let commit = record.commit.as_mut().unwrap();
        commit.pending = Some(super::super::commit::PendingCommit {
            next_revision: commit.revision + 1,
            operation: super::super::commit::MutationPlan::Metadata {
                relative_path: vec!["session".into(), "state.json".into()],
                length: 0,
                sha256: "0".repeat(64),
            },
        });
        let control = path.with_extension("hctl").join(SOURCE_RECORD_FILE);
        std::fs::write(&control, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(capture(&path).is_err());
        std::fs::write(&control, b"invalid control").unwrap();
        assert!(capture(&path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn fenced_goal_capture_rejects_same_bytes_control_replacement() {
        use std::os::unix::fs::PermissionsExt;
        let (_temp, _state, path) = fixture(true);
        let control = path.with_extension("hctl").join(SOURCE_RECORD_FILE);
        let bytes = std::fs::read(&control).unwrap();
        let mut calls = 0;
        let result = CapturedSessionMetadata::try_capture_fenced_goal(&path, 1024 * 1024, || {
            calls += 1;
            if calls == 2 {
                std::fs::rename(&control, control.with_extension("original"))?;
                std::fs::write(&control, &bytes)?;
                std::fs::set_permissions(&control, std::fs::Permissions::from_mode(0o600))?;
            }
            Ok(())
        });
        assert!(calls >= 2);
        assert!(result.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn fenced_goal_capture_rejects_same_bytes_sidecar_replacement_between_fences() {
        use std::os::unix::fs::PermissionsExt;
        let (_temp, state, path) = fixture(true);
        let sidecar = state.session_state_path().unwrap();
        let bytes = std::fs::read(&sidecar).unwrap();
        let mut calls = 0;
        let result = CapturedSessionMetadata::try_capture_fenced_goal(&path, 1024 * 1024, || {
            calls += 1;
            if calls == 2 {
                std::fs::rename(&sidecar, sidecar.with_extension("original"))?;
                std::fs::write(&sidecar, &bytes)?;
                std::fs::set_permissions(&sidecar, std::fs::Permissions::from_mode(0o600))?;
            }
            Ok(())
        });
        assert!(calls >= 2);
        assert!(result.is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_goal_observation_rejects_replacement_or_reports_os_denial() {
        for control in [false, true] {
            let (_temp, state, path) = fixture(true);
            let target = if control {
                path.with_extension("hctl").join(SOURCE_RECORD_FILE)
            } else {
                state.session_state_path().unwrap()
            };
            let initial = std::fs::read(&target).unwrap();
            let original = std::fs::File::open(&target).unwrap();
            let identity = PortableLeaseIdentity::from_regular_handle(&original).unwrap();
            let backup = target.with_extension("goal-original");
            let mut calls = 0;
            let mut replaced = false;
            let result =
                CapturedSessionMetadata::try_capture_fenced_goal(&path, 1024 * 1024, || {
                    calls += 1;
                    if calls == 2 {
                        match std::fs::rename(&target, &backup) {
                            Ok(()) => {
                                let parent =
                                    PrivateDirectory::open_existing(target.parent().unwrap())?;
                                parent.atomic_replace(target.file_name().unwrap(), &initial)?;
                                replaced = true;
                                eprintln!(
                                    "Windows Goal fixture: {} replacement happened",
                                    if control { "control" } else { "sidecar" }
                                );
                            }
                            Err(error)
                                if error.kind() == std::io::ErrorKind::PermissionDenied
                                    || matches!(error.raw_os_error(), Some(5 | 32 | 33)) =>
                            {
                                eprintln!(
                                    "Windows Goal fixture: {} replacement denied by OS",
                                    if control { "control" } else { "sidecar" }
                                );
                            }
                            Err(error) => return Err(error.into()),
                        }
                    }
                    Ok(())
                });
            assert!(calls >= 2);
            if replaced {
                assert!(result.is_err(), "a replacement cannot be adopted");
            } else {
                assert!(result.is_ok(), "the unchanged original remains observable");
                assert!(!backup.exists());
                assert_eq!(std::fs::read(&target).unwrap(), initial);
                assert_eq!(
                    PortableLeaseIdentity::from_regular_handle(
                        &std::fs::File::open(&target).unwrap()
                    )
                    .unwrap(),
                    identity
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn fenced_goal_capture_rejects_shared_or_nonprivate_history_parent() {
        use std::os::unix::fs::PermissionsExt;
        let (temp, _state, path) = fixture(true);
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let result = capture(&path);
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err());
    }
}
