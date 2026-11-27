#[cfg(unix)]
#[test]
fn persistence_never_follows_a_predictable_temporary_symlink() {
    use std::os::unix::fs::symlink;

    let tmp = tempfile::tempdir().unwrap();
    let outside = tmp.path().join("outside.txt");
    fs::write(&outside, b"outside").unwrap();
    fs::create_dir_all(examples_dir(tmp.path())).unwrap();
    let final_path = example_file_path(tmp.path(), "session-1");
    let predictable_temporary = final_path.with_extension("jsonl.tmp");
    symlink(&outside, &predictable_temporary).unwrap();

    recorder_with_one_repair()
        .persist_session_examples(tmp.path(), "session-1")
        .unwrap();

    assert_eq!(fs::read(&outside).unwrap(), b"outside");
    assert!(final_path.is_file());
    assert!(
        !fs::symlink_metadata(final_path)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[cfg(unix)]
#[test]
fn audit_append_rejects_a_symlink_without_writing_outside() {
    use std::os::unix::fs::symlink;

    let tmp = tempfile::tempdir().unwrap();
    let outside = tmp.path().join("outside.log");
    fs::write(&outside, b"outside\n").unwrap();
    fs::create_dir_all(examples_dir(tmp.path())).unwrap();
    symlink(&outside, session_audit_log_path(tmp.path())).unwrap();

    let error = ToolRepairSessionRecorder::default()
        .persist_session_examples(tmp.path(), "empty-session")
        .unwrap_err();

    assert!(format!("{error:#}").contains("session-end.log"));
    assert_eq!(fs::read(&outside).unwrap(), b"outside\n");
}

#[cfg(unix)]
#[test]
fn persistence_rejects_a_symlinked_private_ancestor_without_creating_outside_files() {
    use std::os::unix::fs::symlink;

    let tmp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), tmp.path().join(".kcoder")).unwrap();

    recorder_with_one_repair()
        .persist_session_examples(tmp.path(), "session-1")
        .unwrap_err();

    assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
}

#[cfg(unix)]
#[test]
fn loader_rejects_jsonl_symlinks_without_injecting_examples() {
    use std::os::unix::fs::symlink;

    let tmp = tempfile::tempdir().unwrap();
    let outside = tmp.path().join("outside.jsonl");
    let example = ToolRepairExample {
        version: STORE_VERSION,
        session_id: "attacker".to_string(),
        tool_name: "TodoWrite".to_string(),
        schema_fingerprint: "schema".to_string(),
        failure_signature: "failure".to_string(),
        error_summary: "failure".to_string(),
        failed_input: json!({}),
        successful_input: json!({}),
        created_at_ms: 1,
    };
    fs::write(
        &outside,
        format!("{}\n", serde_json::to_string(&example).unwrap()),
    )
    .unwrap();
    fs::create_dir_all(examples_dir(tmp.path())).unwrap();
    symlink(&outside, examples_dir(tmp.path()).join("attacker.jsonl")).unwrap();

    let index = ToolRepairIndex::load(tmp.path());

    assert!(index.examples.is_empty());
}

#[cfg(unix)]
#[test]
fn persistence_replaces_a_final_target_symlink_without_writing_outside() {
    use std::os::unix::fs::symlink;

    let tmp = tempfile::tempdir().unwrap();
    let outside = tmp.path().join("outside.jsonl");
    fs::write(&outside, b"outside\n").unwrap();
    fs::create_dir_all(examples_dir(tmp.path())).unwrap();
    let target = example_file_path(tmp.path(), "session-1");
    symlink(&outside, &target).unwrap();

    recorder_with_one_repair()
        .persist_session_examples(tmp.path(), "session-1")
        .unwrap();

    assert_eq!(fs::read(&outside).unwrap(), b"outside\n");
    assert!(
        !fs::symlink_metadata(&target)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[cfg(unix)]
#[test]
fn persistence_rejects_a_symlinked_final_directory_without_creating_outside_files() {
    use std::os::unix::fs::symlink;

    let tmp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::create_dir(tmp.path().join(".kcoder")).unwrap();
    symlink(
        outside.path(),
        tmp.path().join(".kcoder").join("tool-repair-examples"),
    )
    .unwrap();

    recorder_with_one_repair()
        .persist_session_examples(tmp.path(), "session-1")
        .unwrap_err();

    assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
}

#[cfg(unix)]
#[test]
fn loader_never_injects_a_symlink_swapped_after_enumeration() {
    use std::os::unix::fs::symlink;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    let tmp = tempfile::tempdir().unwrap();
    recorder_with_one_repair()
        .persist_session_examples(tmp.path(), "race")
        .unwrap();
    let outside = tmp.path().join("outside.jsonl");
    let attacker_example = ToolRepairExample {
        version: STORE_VERSION,
        session_id: "attacker".to_string(),
        tool_name: "TodoWrite".to_string(),
        schema_fingerprint: "schema".to_string(),
        failure_signature: "failure".to_string(),
        error_summary: "failure".to_string(),
        failed_input: json!({}),
        successful_input: json!({}),
        created_at_ms: 1,
    };
    fs::write(
        &outside,
        format!("{}\n", serde_json::to_string(&attacker_example).unwrap()),
    )
    .unwrap();
    let active = example_file_path(tmp.path(), "race");
    let parked = examples_dir(tmp.path()).join("race.parked");
    let stop = Arc::new(AtomicBool::new(false));
    let swaps = Arc::new(AtomicUsize::new(0));
    let attacker_stop = Arc::clone(&stop);
    let attacker_swaps = Arc::clone(&swaps);
    let outside_for_attacker = outside.clone();
    let active_for_attacker = active.clone();
    let parked_for_attacker = parked.clone();
    let attacker = std::thread::spawn(move || {
        while !attacker_stop.load(Ordering::Acquire) {
            if fs::rename(&active_for_attacker, &parked_for_attacker).is_err() {
                std::thread::yield_now();
                continue;
            }
            if symlink(&outside_for_attacker, &active_for_attacker).is_ok() {
                attacker_swaps.fetch_add(1, Ordering::Relaxed);
                std::thread::yield_now();
                let _ = fs::remove_file(&active_for_attacker);
            }
            let _ = fs::rename(&parked_for_attacker, &active_for_attacker);
        }
    });

    for _ in 0..300 {
        let index = ToolRepairIndex::load(tmp.path());
        assert!(
            index
                .examples
                .iter()
                .all(|example| example.session_id != "attacker"),
            "loader followed the swapped JSONL symlink"
        );
    }
    stop.store(true, Ordering::Release);
    attacker.join().unwrap();

    assert!(swaps.load(Ordering::Relaxed) > 0);
}

#[test]
fn distinct_sessions_keep_independent_example_files_and_append_audit_entries() {
    let tmp = tempfile::tempdir().unwrap();
    let recorder = recorder_with_one_repair();

    recorder
        .persist_session_examples(tmp.path(), "session-one")
        .unwrap();
    recorder
        .persist_session_examples(tmp.path(), "session-two")
        .unwrap();

    assert!(example_file_path(tmp.path(), "session-one").is_file());
    assert!(example_file_path(tmp.path(), "session-two").is_file());
    let audit = fs::read_to_string(session_audit_log_path(tmp.path())).unwrap();
    assert_eq!(audit.lines().count(), 2);
}
