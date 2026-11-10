use super::super::test_support::test_runtime;
use super::*;
use kcoder_types::Message;

fn private_root() -> Result<tempfile::TempDir> {
    let mut builder = tempfile::Builder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    Ok(builder.tempdir()?)
}

fn owned(
    root: &std::path::Path,
) -> (
    ThreadManager,
    String,
    std::path::PathBuf,
    ThreadRuntimeHandoffReleaseParams,
) {
    let mut runtime = test_runtime("original", &root.join("unused.jsonl"));
    let id = runtime.engine.session_id();
    let history = root.join(format!("{id}.jsonl"));
    runtime.engine.settings.write().unwrap().history_enabled = true;
    runtime.engine.state.with_history_path(&history);
    runtime
        .engine
        .state
        .add_message(Message::user_text("Original committed input"));
    runtime.engine.state.save_history().unwrap();
    runtime.lease = SessionLease::acquire_existing_history(&history).unwrap();
    let params = ThreadRuntimeHandoffReleaseParams {
        thread_id: id.clone(),
        operation_id: "original-release".into(),
        expected_server_id: "actual-server".into(),
        expected_owner_ref: runtime.handoff_ref.clone(),
        expected_client_turn_count: 0,
    };
    let mut manager = ThreadManager::default();
    assert!(manager.insert(runtime).is_ok());
    (manager, id, history, params)
}
#[tokio::test]
async fn idle_release_keeps_the_same_history_and_holds_the_lease_until_original_shutdown()
-> Result<()> {
    let root = private_root()?;
    let (mut manager, id, path, p) = owned(root.path());
    let original = std::fs::read(&path)?;
    let HandoffBegin::Reserved(reserved) = manager.begin_handoff(&p, "actual-server", true)? else {
        panic!("Original idle owner must be reserved")
    };
    assert!(manager.owns(&id));
    assert!(SessionLease::acquire_existing_history(&path).is_err());
    manager.flush_handoff(&p).await?;
    let runtime = manager.commit_handoff(&p, reserved)?;
    assert!(!manager.owns(&id));
    assert!(SessionLease::acquire_existing_history(&path).is_err());
    runtime.shutdown().await;
    let receipt = manager.finish_handoff(&p)?;
    assert_eq!(receipt.status, ThreadRuntimeHandoffStatus::Released);
    assert!(SessionLease::acquire_existing_history(&path).is_ok());
    assert_eq!(std::fs::read(&path)?, original);
    assert!(
        matches!(manager.begin_handoff(&p,"actual-server",true)?,HandoffBegin::Reply(r) if r==receipt)
    );
    let mut changed = p;
    changed.expected_owner_ref = "different-runtime".into();
    assert!(
        manager
            .begin_handoff(&changed, "actual-server", true)
            .is_err()
    );
    Ok(())
}
#[tokio::test]
async fn busy_rejection_is_stable_after_the_original_turn_becomes_idle() -> Result<()> {
    let root = private_root()?;
    let (mut manager, id, path, p) = owned(root.path());
    let original = std::fs::read(&path)?;
    manager.runtimes[&id]
        .turn_state
        .running
        .store(true, Ordering::SeqCst);
    assert!(
        matches!(manager.begin_handoff(&p,"actual-server",true)?,HandoffBegin::Reply(r) if r.status==ThreadRuntimeHandoffStatus::Rejected)
    );
    manager.runtimes[&id]
        .turn_state
        .running
        .store(false, Ordering::SeqCst);
    assert!(
        matches!(manager.begin_handoff(&p,"actual-server",true)?,HandoffBegin::Reply(r) if r.status==ThreadRuntimeHandoffStatus::Rejected)
    );
    assert!(manager.owns(&id));
    assert!(SessionLease::acquire_existing_history(&path).is_err());
    assert_eq!(std::fs::read(&path)?, original);
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
    Ok(())
}
#[tokio::test]
async fn corrupt_history_is_not_repaired_and_failed_preflight_reopens_admission() -> Result<()> {
    let root = private_root()?;
    let (mut manager, id, path, p) = owned(root.path());
    let broken = b"not an original history record\n";
    std::fs::write(&path, broken)?;
    assert!(
        matches!(manager.begin_handoff(&p,"actual-server",true)?,HandoffBegin::Reply(r) if r.reason_code.as_deref()==Some("THREAD_HANDOFF_HISTORY_UNAVAILABLE"))
    );
    assert!(manager.owns(&id));
    assert!(SessionLease::acquire_existing_history(&path).is_err());
    assert_eq!(std::fs::read(&path)?, broken);
    assert!(
        manager.runtimes[&id]
            .engine
            .try_reserve_background_work_idle()
            .is_some()
    );
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
    Ok(())
}
#[tokio::test]
async fn failed_resource_revoke_keeps_the_original_runtime_and_lease() -> Result<()> {
    let root = private_root()?;
    let (mut manager, id, path, p) = owned(root.path());
    let HandoffBegin::Reserved(reserved) = manager.begin_handoff(&p, "actual-server", true)? else {
        panic!("Reservation required")
    };
    drop(reserved);
    let result = manager.abort_handoff(&p, "THREAD_HANDOFF_REVOKE_FAILED")?;
    assert_eq!(result.status, ThreadRuntimeHandoffStatus::Rejected);
    assert!(manager.owns(&id));
    assert!(SessionLease::acquire_existing_history(&path).is_err());
    assert!(
        manager.runtimes[&id]
            .engine
            .try_reserve_background_work_idle()
            .is_some()
    );
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
    Ok(())
}
