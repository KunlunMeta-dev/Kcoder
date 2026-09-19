use kcoder_test_harness::{
    ModelPolicy, RetentionPolicy, RunContext, RunMetadata, RunStatus, TestTier, prune_runs,
};
use std::time::Duration;

fn metadata(name: &str) -> RunMetadata {
    RunMetadata::new(name, TestTier::Unit, ModelPolicy::Forbidden)
}

#[test]
fn retention_never_deletes_running_or_invalid_manifests() {
    let temporary = tempfile::tempdir().unwrap();
    let running = RunContext::create(temporary.path(), metadata("running")).unwrap();
    let running_root = running.root().to_path_buf();

    let mut finished = RunContext::create(temporary.path(), metadata("finished")).unwrap();
    let finished_root = finished.root().to_path_buf();
    finished.finish(RunStatus::Passed, None).unwrap();

    let invalid_root = temporary.path().join("invalid");
    std::fs::create_dir(&invalid_root).unwrap();
    std::fs::write(invalid_root.join("manifest.json"), b"not-json").unwrap();

    let report = prune_runs(
        temporary.path(),
        RetentionPolicy {
            max_age: Duration::ZERO,
            keep_latest: 0,
        },
        u64::MAX,
    )
    .unwrap();

    assert!(running_root.exists());
    assert!(invalid_root.exists());
    assert!(!finished_root.exists());
    assert_eq!(report.removed, vec![finished_root]);
    assert!(report.retained.contains(&running_root));
    assert!(report.ignored.contains(&invalid_root));
}

#[test]
fn retention_keeps_latest_terminal_runs() {
    let temporary = tempfile::tempdir().unwrap();
    let mut contexts = Vec::new();
    for name in ["one", "two", "three"] {
        let mut context = RunContext::create(temporary.path(), metadata(name)).unwrap();
        context.finish(RunStatus::Failed, Some("expected")).unwrap();
        contexts.push(context.root().to_path_buf());
        std::thread::sleep(Duration::from_millis(2));
    }

    let report = prune_runs(
        temporary.path(),
        RetentionPolicy {
            max_age: Duration::ZERO,
            keep_latest: 1,
        },
        u64::MAX,
    )
    .unwrap();
    assert_eq!(report.removed.len(), 2);
    assert_eq!(report.retained.len(), 1);
}

#[cfg(unix)]
#[test]
fn retention_rejects_a_symlinked_run_root() {
    use std::os::unix::fs::symlink;

    let temporary = tempfile::tempdir().unwrap();
    let real = temporary.path().join("real");
    let linked = temporary.path().join("linked");
    std::fs::create_dir(&real).unwrap();
    symlink(&real, &linked).unwrap();
    assert!(
        prune_runs(
            &linked,
            RetentionPolicy {
                max_age: Duration::ZERO,
                keep_latest: 0,
            },
            u64::MAX,
        )
        .is_err()
    );
}
