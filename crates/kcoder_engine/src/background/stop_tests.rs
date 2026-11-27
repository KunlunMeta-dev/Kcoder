use super::*;

#[tokio::test]
async fn restore_reservation_only_covers_the_managed_stop_registry() {
    let root = tempfile::tempdir().unwrap();
    let engine = crate::test_support::engine_builder::TestEngineBuilder::new(root.path())
        .build_with_profile_directory();
    let memory = engine.memory_idle_gate.write().unwrap();
    let reservation = engine.try_reserve_managed_work_idle().unwrap();
    assert!(matches!(
        engine
            .background_jobs
            .spawn("reserved", Box::pin(std::future::pending())),
        Err(SpawnError::AdmissionClosed)
    ));
    drop(reservation);
    drop(memory);
    engine
        .background_jobs
        .spawn("owned", Box::pin(std::future::pending()))
        .unwrap();
    engine.stop_accepting_managed_work();
    assert!(engine.try_reserve_managed_work_idle().is_none());
    assert!(engine.stop_managed_work().await);
    let reservation = engine.try_reserve_managed_work_idle().unwrap();
    assert!(engine.resume_accepting_managed_work());
    drop(reservation);
}

#[test]
fn stop_signal_does_not_wait_for_background_admission() {
    let root = tempfile::tempdir().unwrap();
    let (jobs, _) = BackgroundJobManager::new(kcoder_state::AppState::new(root.path()));
    let observer = jobs.stop_signal();
    let held = jobs.admission.lock().unwrap();
    let owned = jobs.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        owned.stop_accepting_work();
        tx.send(()).unwrap();
    });
    let signalled = rx.recv_timeout(std::time::Duration::from_secs(1));
    drop(held);
    worker.join().unwrap();
    assert!(signalled.is_ok(), "stop waited behind background admission");
    assert!(observer.is_cancelled());
}

#[tokio::test]
async fn stop_is_owner_scoped_and_fences_new_work_until_explicit_resume() {
    let root = tempfile::tempdir().unwrap();
    let (jobs, mut events) = BackgroundJobManager::new(kcoder_state::AppState::new(root.path()));
    let (peer, _) = BackgroundJobManager::new(kcoder_state::AppState::new(root.path()));
    let id = jobs
        .spawn("owned", Box::pin(std::future::pending()))
        .unwrap();
    let signal = jobs.stop_signal();
    let peer_signal = peer.stop_signal();
    let other = peer
        .spawn("peer", Box::pin(std::future::pending()))
        .unwrap();
    jobs.stop_accepting_work();
    assert!(signal.is_cancelled());
    assert!(!peer_signal.is_cancelled());
    assert!(matches!(
        jobs.spawn("late", Box::pin(std::future::pending())),
        Err(SpawnError::AdmissionClosed)
    ));
    assert!(!jobs.resume_accepting_work());
    assert!(jobs.stop_registered_work().await);
    assert_eq!(jobs.state.task(&id).unwrap().status, TaskStatus::Cancelled);
    assert_eq!(peer.state.task(&other).unwrap().status, TaskStatus::Running);
    let mut cancellation_observed = false;
    while let Ok(event) = events.try_recv() {
        cancellation_observed |= matches!(event.payload(), BackgroundJobEvent::Cancelled { id: cancelled, .. } if cancelled == &id);
    }
    assert!(cancellation_observed);
    assert!(jobs.resume_accepting_work());
    assert!(signal.is_cancelled());
    assert!(!jobs.stop_signal().is_cancelled());
    assert!(
        jobs.spawn("new", Box::pin(async { ToolOutput::text("done") }))
            .is_ok()
    );
    peer.abort_all();
}

#[tokio::test]
async fn multiple_uncooperative_jobs_share_one_grace_window() {
    let root = tempfile::tempdir().unwrap();
    let (jobs, _) = BackgroundJobManager::new(kcoder_state::AppState::new(root.path()));
    for _ in 0..3 {
        jobs.spawn("owned", Box::pin(std::future::pending()))
            .unwrap();
    }
    // A serial implementation needs fifteen seconds; the whole batch must fit in two windows.
    assert!(
        tokio::time::timeout(
            SUBAGENT_CANCELLATION_GRACE_PERIOD * 2,
            jobs.stop_registered_work()
        )
        .await
        .unwrap()
    );
}
