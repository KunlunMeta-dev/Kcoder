use super::*;
use crate::{EngineEvent, Message, test_support::engine_builder::TestEngineBuilder};
use kcoder_state::{Task, TaskKind, TaskStatus};

#[tokio::test]
async fn admitted_run_is_observable_before_work_is_polled_and_closes_with_its_owner() {
    let temp = tempfile::tempdir().unwrap();
    let engine = TestEngineBuilder::new(temp.path()).build_with_profile_directory();
    engine
        .state
        .with_history_path(temp.path().join("parent.jsonl"));
    let cancel = tokio_util::sync::CancellationToken::new();
    let work_cancel = cancel.clone();
    let owner_cancel = cancel.clone();
    engine
        .background_jobs
        .spawn_cancellable_subagent_with_id_with_cap(
            "waiting-child",
            "No child event has been produced",
            Box::pin(async move {
                work_cancel.cancelled().await;
                kcoder_tools::ToolOutput::error("owned waiting child cancelled")
            }),
            std::sync::Arc::new(move || owner_cancel.cancel()),
            Some(2),
        )
        .unwrap();
    let key = engine
        .state
        .task("waiting-child")
        .unwrap()
        .background_run
        .unwrap();
    // There has been no await since admission, so the child cannot have emitted
    // a first frame or registered a writer from the execution loop.
    let waiting = engine
        .subscribe_subagent_conversation_for_run(&key)
        .unwrap();
    assert!(waiting.snapshot.active);
    assert!(waiting.snapshot.entries.is_empty());
    assert_eq!(waiting.snapshot.run_id, key.run_id);
    assert!(engine.background_jobs.has_live_run(&key.agent_id, &key));
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            engine
                .background_jobs
                .abort_and_wait_for_run(&key.agent_id, &key)
        )
        .await
        .unwrap()
        .unwrap()
    );
    assert!(cancel.is_cancelled());
    let cancelled = engine
        .subscribe_subagent_conversation_for_run(&key)
        .unwrap();
    assert!(!cancelled.snapshot.active);
    assert_eq!(cancelled.snapshot.status, "cancelled");
    assert!(!engine.background_jobs.has_live_run(&key.agent_id, &key));
}

fn fixture() -> (tempfile::TempDir, QueryEngine, BackgroundRunKey) {
    let temp = tempfile::tempdir().unwrap();
    let engine = TestEngineBuilder::new(temp.path()).build_with_profile_directory();
    let mut task = Task::new("original-child", "Exact run fixture");
    task.kind = TaskKind::Subagent;
    task.managed = true;
    task.parent_session_id = Some(engine.session_id());
    let key = engine.state.start_background_task_run(task).unwrap();
    (temp, engine, key)
}
#[test]
fn exact_registered_stream_has_actual_parent_agent_run_and_final_snapshot() {
    let (_temp, engine, key) = fixture();
    let mut writer = engine.background_jobs.live_views.register_with_run(
        &key.agent_id,
        vec![Message::assistant_text("Actual original stream")],
        key.run_id.clone(),
    );
    let mut observed = engine
        .subscribe_subagent_conversation_for_run(&key)
        .unwrap();
    assert_eq!(observed.snapshot.run_id, key.run_id);
    assert!(observed.snapshot.active);
    writer.update(
        &EngineEvent::AssistantTextDelta(" incremental original".into()),
        Vec::new,
    );
    let update = observed.receiver.try_recv().unwrap();
    assert!(matches!(
        update.delta,
        crate::agent_conversation_stream::AgentConversationDelta::Event(
            EngineEvent::AssistantTextDelta(_)
        )
    ));
    engine
        .state
        .commit_background_terminal(
            &kcoder_types::BackgroundEventIdentity::terminal(key.clone()),
            TaskStatus::Completed,
            None,
        )
        .unwrap();
    writer.finish(false);
    let finished = engine
        .subscribe_subagent_conversation_for_run(&key)
        .unwrap()
        .snapshot;
    assert!(!finished.active);
    assert_eq!(finished.status, "completed");
    let tail = engine
        .subagent_public_live_tail_for_run(&key, None)
        .unwrap();
    assert!(!tail.active);
    assert!(tail.content.contains("Actual original stream"));
}
#[test]
fn legacy_checkpoint_cache_does_not_become_registered_run_authority() {
    let (_temp, engine, key) = fixture();
    // The legacy reader can cache an observation under the current string id.
    let legacy = engine
        .subscribe_subagent_conversation(&key.agent_id)
        .unwrap();
    assert_eq!(legacy.snapshot.run_id, key.run_id);
    assert!(
        engine
            .subscribe_subagent_conversation_for_run(&key)
            .err()
            .unwrap()
            .to_string()
            .contains("unavailable")
    );
    let writer = engine.background_jobs.live_views.register_with_run(
        &key.agent_id,
        vec![Message::assistant_text("Native producer")],
        key.run_id.clone(),
    );
    assert!(engine.subscribe_subagent_conversation_for_run(&key).is_ok());
    drop(writer);
}
#[test]
fn original_run_cannot_read_a_replacement_or_foreign_parent() {
    let (_temp, engine, key) = fixture();
    let mut writer = engine.background_jobs.live_views.register_with_run(
        &key.agent_id,
        vec![],
        key.run_id.clone(),
    );
    for wrong in [
        BackgroundRunKey {
            parent_session_id: "foreign-parent".into(),
            ..key.clone()
        },
        BackgroundRunKey {
            agent_id: "foreign-child".into(),
            ..key.clone()
        },
        BackgroundRunKey {
            run_id: "replacement-run".into(),
            ..key.clone()
        },
    ] {
        assert!(
            engine
                .subscribe_subagent_conversation_for_run(&wrong)
                .err()
                .unwrap()
                .to_string()
                .contains("identity_conflict")
        );
    }
    writer.finish(false);
    engine
        .state
        .commit_background_terminal(
            &kcoder_types::BackgroundEventIdentity::terminal(key.clone()),
            TaskStatus::Completed,
            None,
        )
        .unwrap();
    let next = engine.state.begin_background_run(&key.agent_id).unwrap();
    assert!(
        engine
            .subscribe_subagent_conversation_for_run(&key)
            .err()
            .unwrap()
            .to_string()
            .contains("identity_conflict")
    );
    assert!(
        engine
            .subscribe_subagent_conversation_for_run(&next)
            .err()
            .unwrap()
            .to_string()
            .contains("unavailable")
    );
    drop(writer);
}
