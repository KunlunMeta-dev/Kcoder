use anyhow::Result;
use kcoder_test_harness::{
    ModelPolicy, Prerequisite, RunContext, RunManifest, RunMetadata, RunStatus, TestTier,
};
use serde_json::json;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

fn metadata(suite: &str) -> RunMetadata {
    RunMetadata::new(suite, TestTier::Unit, ModelPolicy::Forbidden)
}

#[test]
fn safe_paths_reject_escape_and_absolute_paths() {
    let temporary = tempfile::tempdir().unwrap();
    let context = RunContext::create(temporary.path(), metadata("paths")).unwrap();

    assert!(context.state_path("../escape").is_err());
    assert!(context.artifact_path("/absolute.json").is_err());
    assert!(context.case_path("case", "../../escape").is_err());
    assert!(
        context
            .state_path("nested/state.json")
            .unwrap()
            .starts_with(context.state_dir())
    );
}

#[cfg(unix)]
#[test]
fn safe_paths_reject_existing_symlink_components() {
    use std::os::unix::fs::symlink;

    let temporary = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let context = RunContext::create(temporary.path(), metadata("symlink-path")).unwrap();
    symlink(outside.path(), context.artifacts_dir().join("linked")).unwrap();

    assert!(context.artifact_path("linked/escape.json").is_err());
}

#[test]
fn artifact_json_redacts_registered_and_structured_secrets() {
    let temporary = tempfile::tempdir().unwrap();
    let mut context = RunContext::create(temporary.path(), metadata("redaction")).unwrap();
    context.register_secret("sk-test-secret").unwrap();

    let path = context
        .write_artifact_json(
            "nested/result.json",
            &json!({
                "message": "token=sk-test-secret",
                "nested": {"api_key": "unregistered-value", "safe": ["sk-test-secret"]}
            }),
        )
        .unwrap();
    let content = std::fs::read_to_string(path).unwrap();

    assert!(!content.contains("sk-test-secret"));
    assert!(!content.contains("unregistered-value"));
    assert!(content.contains("[REDACTED]"));
}

#[test]
fn artifact_json_rejects_overwrite_and_short_secrets() {
    let temporary = tempfile::tempdir().unwrap();
    let mut context = RunContext::create(temporary.path(), metadata("artifact-overwrite")).unwrap();
    assert!(context.register_secret("1").is_err());
    assert!(context.register_secret("abc").is_err());
    assert!(context.register_secret("true").is_err());
    context.register_secret("abcdefgh").unwrap();
    context
        .write_artifact_json("result.json", &json!({"attempt": 1}))
        .unwrap();

    assert!(
        context
            .write_artifact_json("result.json", &json!({"attempt": 2}))
            .is_err()
    );
}

#[test]
fn finish_runs_cleanup_in_lifo_order() {
    let temporary = tempfile::tempdir().unwrap();
    let mut context = RunContext::create(temporary.path(), metadata("cleanup")).unwrap();
    let order = Arc::new(Mutex::new(Vec::new()));
    for value in [1, 2, 3] {
        let order = Arc::clone(&order);
        context.register_cleanup(move || {
            order.lock().unwrap().push(value);
            Ok(())
        });
    }

    let report = context.finish(RunStatus::Passed, None).unwrap();
    assert_eq!(report.attempted, 3);
    assert!(report.failures.is_empty());
    assert_eq!(*order.lock().unwrap(), vec![3, 2, 1]);
    assert!(!context.state_dir().exists());
    let manifest = RunManifest::read(&context.root().join("manifest.json")).unwrap();
    assert_eq!(manifest.status, RunStatus::Passed);
}

#[test]
fn cleanup_failure_changes_terminal_status_and_redacts_error() {
    let temporary = tempfile::tempdir().unwrap();
    let mut context = RunContext::create(temporary.path(), metadata("cleanup-failure")).unwrap();
    context.register_secret("cleanup-secret").unwrap();
    context.register_cleanup(|| anyhow::bail!("failed with cleanup-secret"));

    let report = context
        .finish(RunStatus::Passed, Some("requested pass"))
        .unwrap();
    assert_eq!(report.failures, vec!["failed with [REDACTED]"]);
    let manifest = RunManifest::read(&context.root().join("manifest.json")).unwrap();
    assert_eq!(manifest.status, RunStatus::Failed);
    assert!(!manifest.message.unwrap().contains("cleanup-secret"));
}

#[test]
fn concurrent_contexts_get_distinct_run_directories() {
    let temporary = tempfile::tempdir().unwrap();
    let base = temporary.path().to_path_buf();
    let handles: Vec<_> = (0..12)
        .map(|_| {
            let base = base.clone();
            std::thread::spawn(move || {
                RunContext::create(base, metadata("concurrent"))
                    .unwrap()
                    .root()
                    .to_path_buf()
            })
        })
        .collect();
    let mut paths: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    paths.sort();
    paths.dedup();
    assert_eq!(paths.len(), 12);
}

#[test]
fn unmet_prerequisite_is_persisted_without_environment_snapshot() {
    let temporary = tempfile::tempdir().unwrap();
    let mut context = RunContext::create(temporary.path(), metadata("prerequisite")).unwrap();
    let result = context.evaluate_prerequisite(&Prerequisite::path(
        "missing",
        Path::new("definitely-not-a-real-prerequisite-path"),
    ));
    assert!(!result.met);
    context
        .finish(RunStatus::UnmetPrerequisite, Some("unmet prerequisite"))
        .unwrap();

    let content = std::fs::read_to_string(context.root().join("manifest.json")).unwrap();
    assert!(content.contains("unmet_prerequisites"));
    assert!(!content.contains("environment"));
    assert!(!content.contains("HOME"));
}

#[test]
fn nonpanic_drop_does_not_claim_success() -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let run_root = {
        let context = RunContext::create(temporary.path(), metadata("abandoned"))?;
        context.root().to_path_buf()
    };
    let manifest = RunManifest::read(&run_root.join("manifest.json"))?;
    assert_eq!(manifest.status, RunStatus::Running);
    Ok(())
}

#[test]
fn panic_drop_marks_failed_and_runs_best_effort_cleanup() {
    let temporary = tempfile::tempdir().unwrap();
    let base = temporary.path().to_path_buf();
    let run_root = Arc::new(Mutex::new(None));
    let cleanup_ran = Arc::new(Mutex::new(false));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe({
        let run_root = Arc::clone(&run_root);
        let cleanup_ran = Arc::clone(&cleanup_ran);
        move || {
            let mut context = RunContext::create(&base, metadata("panic")).unwrap();
            *run_root.lock().unwrap() = Some(context.root().to_path_buf());
            context.register_cleanup(move || {
                *cleanup_ran.lock().unwrap() = true;
                Ok(())
            });
            panic!("expected panic");
        }
    }));
    assert!(result.is_err());
    assert!(*cleanup_ran.lock().unwrap());
    let root = run_root.lock().unwrap().clone().unwrap();
    let manifest = RunManifest::read(&root.join("manifest.json")).unwrap();
    assert_eq!(manifest.status, RunStatus::Failed);
    assert!(manifest.message.unwrap().contains("best-effort cleanup"));
}

#[test]
fn repeated_manifest_updates_are_atomically_readable_and_leave_no_temp_files() {
    let temporary = tempfile::tempdir().unwrap();
    let mut context = RunContext::create(temporary.path(), metadata("atomic-manifest")).unwrap();
    let manifest_path = context.root().join("manifest.json");
    let stop = Arc::new(AtomicBool::new(false));
    let read_failed = Arc::new(AtomicBool::new(false));
    let reader = {
        let stop = Arc::clone(&stop);
        let read_failed = Arc::clone(&read_failed);
        std::thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                if RunManifest::read(&manifest_path).is_err() {
                    read_failed.store(true, Ordering::Release);
                    break;
                }
            }
        })
    };

    for index in 0..40 {
        context
            .write_artifact_json(format!("result-{index}.json"), &json!({"index": index}))
            .unwrap();
    }
    stop.store(true, Ordering::Release);
    reader.join().unwrap();

    assert!(!read_failed.load(Ordering::Acquire));
    assert!(std::fs::read_dir(context.root()).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".tmp-")
    }));
}
