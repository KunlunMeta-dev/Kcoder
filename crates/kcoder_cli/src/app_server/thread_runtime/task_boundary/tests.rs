use super::*;
use crate::app_server::thread_runtime::test_support;

fn test_runtime(id: &str, path: &std::path::Path) -> ThreadRuntime {
    let runtime = test_support::test_runtime(id, path);
    runtime.engine.state.with_history_path(path);
    runtime
}

#[tokio::test]
async fn task_boundary_blocks_only_the_reserved_task_and_releases_its_admissions() {
    let root = kcoder_config::create_private_temp_dir("task-boundary-test").unwrap();
    let first = test_runtime("first", &root.path().join("first.jsonl"));
    let second = test_runtime("second", &root.path().join("second.jsonl"));
    let first_engine = first.engine();
    let second_engine = second.engine();
    let first_state = first.turn_state.clone();
    let second_state = second.turn_state.clone();
    let mut manager = ThreadManager::default();
    assert!(manager.insert(first).is_ok());
    assert!(manager.insert(second).is_ok());
    let boundary = manager
        .try_reserve_task_idle(&first_engine.session_id())
        .unwrap();
    assert!(first_state.activity_gate.try_lock().is_err());
    assert!(!first_state.accepting_turns.load(Ordering::SeqCst));
    assert!(first_engine.try_reserve_background_work_idle().is_none());
    assert!(
        manager
            .try_reserve_task_idle(&first_engine.session_id())
            .is_err()
    );
    assert!(second_state.activity_gate.try_lock().is_ok());
    assert!(second_state.accepting_turns.load(Ordering::SeqCst));
    assert!(second_engine.try_reserve_background_work_idle().is_some());
    assert!(boundary.verify_configuration_source(&first_engine).is_ok());
    assert!(
        boundary
            .verify_configuration_source(&second_engine)
            .is_err()
    );
    drop(boundary);
    assert!(first_state.activity_gate.try_lock().is_ok());
    assert!(first_state.accepting_turns.load(Ordering::SeqCst));
    assert!(first_engine.try_reserve_background_work_idle().is_some());
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn task_boundary_never_reopens_a_previously_closed_admission() {
    let root = kcoder_config::create_private_temp_dir("task-boundary-test").unwrap();
    let runtime = test_runtime("closed", &root.path().join("history.jsonl"));
    let engine = runtime.engine();
    let state = runtime.turn_state.clone();
    state.stop_accepting_turns();
    let mut manager = ThreadManager::default();
    assert!(manager.insert(runtime).is_ok());
    assert!(manager.try_reserve_task_idle(&engine.session_id()).is_err());
    assert!(!state.accepting_turns.load(Ordering::SeqCst));
    state.resume_accepting_turns();
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn task_boundary_failure_restores_only_its_own_admission() {
    let root = kcoder_config::create_private_temp_dir("task-boundary-test").unwrap();
    let runtime = test_runtime("busy", &root.path().join("history.jsonl"));
    let engine = runtime.engine();
    let state = runtime.turn_state.clone();
    let mut manager = ThreadManager::default();
    assert!(manager.insert(runtime).is_ok());
    state.running.store(true, Ordering::SeqCst);
    assert!(manager.try_reserve_task_idle(&engine.session_id()).is_err());
    assert!(state.accepting_turns.load(Ordering::SeqCst));
    state.running.store(false, Ordering::SeqCst);
    let work = engine.try_reserve_background_work_idle().unwrap();
    assert!(manager.try_reserve_task_idle(&engine.session_id()).is_err());
    assert!(state.accepting_turns.load(Ordering::SeqCst));
    assert!(state.activity_gate.try_lock().is_ok());
    drop(work);
    assert!(manager.try_reserve_task_idle(&engine.session_id()).is_ok());
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn eviction_cannot_reopen_or_remove_a_reserved_task() {
    let root = kcoder_config::create_private_temp_dir("task-boundary-test").unwrap();
    let runtime = test_runtime("reserved", &root.path().join("history.jsonl"));
    let engine = runtime.engine();
    let state = runtime.turn_state.clone();
    let mut manager = ThreadManager::with_resident_limit(1);
    assert!(manager.insert(runtime).is_ok());
    let boundary = manager.try_reserve_task_idle(&engine.session_id()).unwrap();
    assert!(manager.reserve_capacity().is_err());
    assert!(manager.remove_if_idle(&engine.session_id()).is_err());
    assert!(!state.accepting_turns.load(Ordering::SeqCst));
    assert!(state.activity_gate.try_lock().is_err());
    drop(boundary);
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
}
