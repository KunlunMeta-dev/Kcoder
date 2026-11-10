use super::*;
use std::sync::{Arc, Barrier};

fn managed_background(id: &str) -> Task {
    let mut task = Task::new(id, "managed background task");
    task.managed = true;
    task.delivery = TaskDelivery::Background;
    task
}

#[test]
fn historyless_task_updates_remain_in_memory_without_creating_files() {
    let root = tempfile::tempdir().unwrap();
    let state = AppState::new(root.path());
    state.upsert_task(managed_background("first"));
    state.upsert_task(managed_background("second"));
    assert_eq!(
        state.update_task("first", |task| {
            task.status = TaskStatus::Completed;
            task.output = Some("actual output".into());
            42
        }),
        Some(42)
    );

    assert!(state.session_state_path().is_none());
    let first = state.task("first").unwrap();
    assert_eq!(first.output.as_deref(), Some("actual output"));
    assert_eq!(first.status, TaskStatus::Completed);
    assert!(state.task("second").is_some());
    assert!(std::fs::read_dir(root.path()).unwrap().next().is_none());
}

#[test]
fn persistent_concurrent_task_updates_keep_the_full_sidecar_and_receipts() {
    let root = tempfile::tempdir().unwrap();
    let state = AppState::new(root.path());
    state.with_history_path(root.path().join("session.jsonl"));
    state.upsert_task(managed_background("first"));
    let mut agent = Task::new("agent", "subagent");
    agent.kind = TaskKind::Subagent;
    agent.status = TaskStatus::Running;
    state.upsert_task(agent);
    let receipt = state
        .enqueue_subagent_delivery_with_client_id("agent", "follow up", Some("client-1"))
        .unwrap()
        .unwrap();
    let mut foreground = managed_background("foreground");
    foreground.delivery = TaskDelivery::Foreground;
    state.upsert_task(foreground);

    let barrier = Arc::new(Barrier::new(3));
    let workers: Vec<_> = [("first", "first output"), ("agent", "agent output")]
        .into_iter()
        .map(|(id, output)| {
            let state = state.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                state.update_task(id, |task| task.output = Some(output.into()))
            })
        })
        .collect();
    barrier.wait();
    for worker in workers {
        assert!(worker.join().unwrap().is_some());
    }

    let persisted = load_session_state(&state.session_state_path().unwrap()).unwrap();
    assert_eq!(persisted.tasks.len(), 2);
    assert!(!persisted.tasks.contains_key("foreground"));
    assert_eq!(
        persisted.tasks["first"].output.as_deref(),
        Some("first output")
    );
    assert_eq!(
        persisted.tasks["agent"].output.as_deref(),
        Some("agent output")
    );
    assert_eq!(
        persisted.tasks["agent"].message_queue[0].message_id,
        receipt.message_id
    );
    assert_eq!(
        persisted.tasks["agent"].command_receipts[0].client_message_id,
        "client-1"
    );
}
