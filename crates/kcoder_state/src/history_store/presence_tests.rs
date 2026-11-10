use super::*;
use crate::history_store::{HistorySource, MUTATION_LOCK, SourceRecord};
use fs2::FileExt;
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

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

fn write_record(path: &Path, record: &SourceRecord) -> PathBuf {
    let control = path.with_extension("hctl");
    fs::create_dir(&control).unwrap();
    let record_path = control.join("source.json");
    fs::write(&record_path, serde_json::to_vec(record).unwrap()).unwrap();
    record_path
}

fn live_record() -> SourceRecord {
    SourceRecord {
        schema_version: 1,
        incarnation: uuid::Uuid::new_v4(),
        deleted: false,
        commit: None,
        deletion: None,
    }
}

fn create_bound_deleted_history(root: &Path, name: &str) -> (PathBuf, PathBuf) {
    let path = root.join(name);
    let state = crate::AppState::new(root);
    state.with_history_path(&path);
    state.add_message(crate::Message::user_text("seed"));
    state.save_history().unwrap();
    state.commit_session_state();
    crate::mark_session_history_deleted(&path, root).unwrap();
    let control = path.with_extension("hctl").join("source.json");
    (path, control)
}

#[cfg(target_os = "linux")]
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
#[cfg(target_os = "linux")]
fn bounded_observation_never_reads_large_history_body() {
    // /proc/self/io includes reads by every thread in the test process. Run
    // this probe alone in an owned child so concurrent tests cannot skew it.
    const CHILD_ENV: &str = "KCODER_TEST_PRESENCE_IO_CHILD";
    if std::env::var_os(CHILD_ENV).as_deref() != Some(std::ffi::OsStr::new("1")) {
        use std::io::Read;
        use std::process::{Command, Stdio};
        use std::time::Instant;

        struct OwnedChild(std::process::Child);
        impl Drop for OwnedChild {
            fn drop(&mut self) {
                if self.0.try_wait().ok().flatten().is_none() {
                    let _ = self.0.kill();
                    let _ = self.0.wait();
                }
            }
        }

        let mut log = tempfile::tempfile().unwrap();
        let mut child = OwnedChild(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "history_store::presence::tests::bounded_observation_never_reads_large_history_body",
                    "--nocapture",
                ])
                .env(CHILD_ENV, "1")
                .stdout(Stdio::from(log.try_clone().unwrap()))
                .stderr(Stdio::from(log.try_clone().unwrap()))
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(30);
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "owned history I/O probe timed out"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        use std::io::{Seek, SeekFrom};
        log.seek(SeekFrom::Start(0)).unwrap();
        let mut output = String::new();
        log.read_to_string(&mut output).unwrap();
        assert!(
            status.success() && output.contains("1 passed; 0 failed; 0 ignored"),
            "owned history I/O probe failed or did not run: {output}"
        );
        return;
    }

    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("large.jsonl");
    let source = HistorySource::bind(&path).unwrap();
    source.replace(b"{\"seed\":true}\n").unwrap();
    OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(128 * 1024 * 1024)
        .unwrap();

    let before_rchar = process_rchar();
    let observation = crate::observe_session_history_source_presence(&path, temp.path()).unwrap();
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
#[cfg(target_os = "linux")]
fn bounded_observation_isolated_from_parallel_process_io() {
    use std::io::{Read, Seek, SeekFrom, Write};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    let mut noise = tempfile::tempfile().unwrap();
    noise.write_all(&[0_u8; 64 * 1024]).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = Arc::clone(&stop);
    let (started, ready) = mpsc::sync_channel(1);
    let before = process_rchar();
    let worker = std::thread::spawn(move || {
        let mut buffer = [0_u8; 64 * 1024];
        let mut signalled = false;
        while !worker_stop.load(Ordering::Acquire) {
            noise.seek(SeekFrom::Start(0)).unwrap();
            noise.read_exact(&mut buffer).unwrap();
            if !signalled {
                started.send(()).unwrap();
                signalled = true;
            }
            std::thread::yield_now();
        }
    });
    if let Err(error) = ready.recv_timeout(Duration::from_secs(5)) {
        stop.store(true, Ordering::Release);
        let _ = worker.join();
        panic!("parallel I/O fixture did not start: {error}");
    }
    let outcome = std::panic::catch_unwind(bounded_observation_never_reads_large_history_body);
    stop.store(true, Ordering::Release);
    worker.join().unwrap();
    assert!(process_rchar().saturating_sub(before) >= 64 * 1024);
    if let Err(error) = outcome {
        std::panic::resume_unwind(error);
    }
}

#[test]
fn bounded_observation_reports_missing_states_without_writes() {
    let temp = tempfile::tempdir().unwrap();
    let missing_parent = temp.path().join("not-created").join("session.jsonl");
    let before = snapshot(temp.path());
    assert_eq!(
        crate::observe_session_history_source_presence(&missing_parent, temp.path()).unwrap(),
        HistorySourceObservation::Unknown(HistorySourceUnknown::MissingHistoryParent)
    );
    assert_eq!(snapshot(temp.path()), before);
    assert!(!missing_parent.parent().unwrap().exists());

    let missing_control = temp.path().join("missing-control.jsonl");
    assert_eq!(
        crate::observe_session_history_source_presence(&missing_control, temp.path()).unwrap(),
        HistorySourceObservation::Unknown(HistorySourceUnknown::MissingControlDirectory)
    );
    let control = missing_control.with_extension("hctl");
    fs::create_dir(&control).unwrap();
    let before_missing_record = snapshot(temp.path());
    assert_eq!(
        crate::observe_session_history_source_presence(&missing_control, temp.path()).unwrap(),
        HistorySourceObservation::Unknown(HistorySourceUnknown::MissingControlRecord)
    );
    assert_eq!(snapshot(temp.path()), before_missing_record);

    let live_missing_leaf = temp.path().join("live-missing.jsonl");
    write_record(&live_missing_leaf, &live_record());
    let before_live_missing_leaf = snapshot(temp.path());
    assert_eq!(
        crate::observe_session_history_source_presence(&live_missing_leaf, temp.path()).unwrap(),
        HistorySourceObservation::Unknown(HistorySourceUnknown::MissingSourceForLiveRecord)
    );
    assert_eq!(snapshot(temp.path()), before_live_missing_leaf);
    assert!(!temp.path().join(MUTATION_LOCK).exists());
}

#[test]
fn bounded_observation_uses_nonblocking_shared_lock() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("locked.jsonl");
    HistorySource::bind(&path)
        .unwrap()
        .replace(b"{\"seed\":true}\n")
        .unwrap();
    let mutation_lock = File::open(temp.path().join(MUTATION_LOCK)).unwrap();
    FileExt::try_lock_exclusive(&mutation_lock).unwrap();

    let (sender, receiver) = mpsc::channel();
    let path_for_reader = path.clone();
    let workspace = temp.path().to_path_buf();
    let reader = std::thread::spawn(move || {
        sender
            .send(crate::observe_session_history_source_presence(
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
}

#[test]
fn bounded_observation_mints_only_bound_deleted_absence_reference() {
    let temp = tempfile::tempdir().unwrap();
    let (path, control) = create_bound_deleted_history(temp.path(), "bound-absent.jsonl");
    let proof = crate::read_session_history_deletion(&path, temp.path())
        .unwrap()
        .unwrap();
    let control_before = fs::read(&control).unwrap();
    let tree_before = snapshot(temp.path());

    let observation = crate::observe_session_history_source_presence(&path, temp.path()).unwrap();

    let HistorySourceObservation::BoundDeletedSourceAbsent(reference) = observation else {
        panic!("expected an independent bounded absence reference, got {observation:?}");
    };
    assert_eq!(reference.history_path(), path);
    assert_eq!(reference.workspace(), temp.path());
    assert_eq!(reference.thread_id(), "bound-absent");
    assert_eq!(
        reference.source_incarnation(),
        proof.binding.source_incarnation
    );
    assert!(!reference.control_record_sha256().is_empty());
    assert_eq!(fs::read(&control).unwrap(), control_before);
    assert_eq!(snapshot(temp.path()), tree_before);
    proof.verify(&path, temp.path()).unwrap();

    fs::remove_file(temp.path().join(MUTATION_LOCK)).unwrap();
    let without_lock_before = snapshot(temp.path());
    assert_eq!(
        crate::observe_session_history_source_presence(&path, temp.path()).unwrap(),
        HistorySourceObservation::Unknown(
            HistorySourceUnknown::BoundDeletionMissingSourceWithoutLock
        )
    );
    assert_eq!(snapshot(temp.path()), without_lock_before);
}

#[test]
fn bounded_observation_keeps_residual_same_inode_unverified() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("residual.jsonl");
    let backup = temp.path().join("residual-backup.jsonl");
    let state = crate::AppState::new(temp.path());
    state.with_history_path(&path);
    state.add_message(crate::Message::user_text("seed"));
    state.save_history().unwrap();
    state.commit_session_state();
    fs::hard_link(&path, &backup).unwrap();
    crate::mark_session_history_deleted(&path, temp.path()).unwrap();
    fs::hard_link(&backup, &path).unwrap();

    assert_eq!(
        crate::observe_session_history_source_presence(&path, temp.path()).unwrap(),
        HistorySourceObservation::Unknown(HistorySourceUnknown::BoundDeletionResidualSameIdentity)
    );
}

#[test]
fn bounded_observation_rejects_corrupt_oversized_and_nonregular_control_without_writes() {
    let temp = tempfile::tempdir().unwrap();
    let corrupt = temp.path().join("corrupt.jsonl");
    let corrupt_control = write_record(&corrupt, &live_record());
    fs::write(&corrupt_control, b"{truncated").unwrap();
    let before_corrupt = snapshot(temp.path());
    assert!(crate::observe_session_history_source_presence(&corrupt, temp.path()).is_err());
    assert_eq!(snapshot(temp.path()), before_corrupt);

    let oversized = temp.path().join("oversized.jsonl");
    let oversized_control = write_record(&oversized, &live_record());
    fs::write(&oversized_control, vec![b'x'; 4097]).unwrap();
    let before_oversized = snapshot(temp.path());
    assert!(crate::observe_session_history_source_presence(&oversized, temp.path()).is_err());
    assert_eq!(snapshot(temp.path()), before_oversized);

    let nonregular = temp.path().join("nonregular.jsonl");
    let control_dir = nonregular.with_extension("hctl");
    fs::create_dir(&control_dir).unwrap();
    fs::create_dir(control_dir.join("source.json")).unwrap();
    let before_nonregular = snapshot(temp.path());
    assert!(crate::observe_session_history_source_presence(&nonregular, temp.path()).is_err());
    assert_eq!(snapshot(temp.path()), before_nonregular);
    assert!(!temp.path().join(MUTATION_LOCK).exists());
}

#[cfg(target_os = "linux")]
#[test]
fn bounded_observation_rejects_foreign_workspace_parent_and_incarnation_without_writes() {
    use kcoder_types::PrivateNativeFileIdentity;

    let temp = tempfile::tempdir().unwrap();
    let foreign_workspace = tempfile::tempdir().unwrap();
    let (path, _control) = create_bound_deleted_history(temp.path(), "foreign-workspace.jsonl");
    let before_foreign_workspace = snapshot(temp.path());
    assert!(
        crate::observe_session_history_source_presence(&path, foreign_workspace.path()).is_err()
    );
    assert_eq!(snapshot(temp.path()), before_foreign_workspace);

    for mismatch in ["parent", "incarnation"] {
        let (path, control) =
            create_bound_deleted_history(temp.path(), &format!("{mismatch}-mismatch.jsonl"));
        let mut record: SourceRecord =
            serde_json::from_slice(&fs::read(&control).unwrap()).unwrap();
        let binding = record.deletion.as_mut().unwrap();
        if mismatch == "parent" {
            let PrivateNativeFileIdentity::Linux { inode, .. } = &mut binding.history_parent.native;
            *inode = inode.wrapping_add(1);
        } else {
            binding.source_incarnation = uuid::Uuid::new_v4();
        }
        fs::write(&control, serde_json::to_vec(&record).unwrap()).unwrap();
        let before = snapshot(temp.path());
        assert!(crate::observe_session_history_source_presence(&path, temp.path()).is_err());
        assert_eq!(snapshot(temp.path()), before);
    }
}

#[test]
fn bounded_observation_rejects_deleted_residual_foreign_inode_without_writes() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("foreign-residual.jsonl");
    let backup = temp.path().join("foreign-residual-backup.jsonl");
    let state = crate::AppState::new(temp.path());
    state.with_history_path(&path);
    state.add_message(crate::Message::user_text("seed"));
    state.save_history().unwrap();
    state.commit_session_state();
    fs::hard_link(&path, &backup).unwrap();
    crate::mark_session_history_deleted(&path, temp.path()).unwrap();
    fs::write(&path, b"replacement source with a foreign inode").unwrap();
    let before = snapshot(temp.path());

    assert!(crate::observe_session_history_source_presence(&path, temp.path()).is_err());
    assert_eq!(snapshot(temp.path()), before);
}
