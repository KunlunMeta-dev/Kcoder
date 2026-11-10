use super::*;
use kcoder_config::{PrivateDirectory, Settings};
use kcoder_memory::{MemoryManager, MemoryStore};
use kcoder_permissions::PermissionEngine;
use kcoder_skills::SkillRegistry;
use kcoder_state::{Task, TaskKind, TaskStatus};
use kcoder_tools::{DenyAllUserQuestioner, ToolRegistry};
fn fixture(
    completed: bool,
) -> (
    tempfile::TempDir,
    QueryEngine,
    BackgroundRunKey,
    SessionLease,
) {
    let temp = tempfile::tempdir().unwrap();
    PrivateDirectory::open_or_create(temp.path()).unwrap();
    let settings = Settings::default();
    let state = kcoder_state::AppState::new(temp.path());
    state.with_history_path(temp.path().join("owned.jsonl"));
    let engine = QueryEngine::new_with_folder_trust(
        Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
            crate::tui_dev_mock::TuiDevScenario::FullTurn,
        )),
        state,
        ToolRegistry::new(),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::empty(),
        Arc::new(DenyAllUserQuestioner),
        temp.path().to_path_buf(),
        Some(true),
    );
    let mut task = Task::new("original-child", "Actual owned view");
    task.kind = TaskKind::Subagent;
    task.managed = true;
    task.parent_session_id = Some(engine.session_id());
    let key = engine.state.start_background_task_run(task).unwrap();
    if completed {
        engine
            .state
            .commit_background_terminal(
                &kcoder_types::BackgroundEventIdentity::terminal(key.clone()),
                TaskStatus::Completed,
                None,
            )
            .unwrap();
    }
    let lease = SessionLease::acquire(&engine.session_lease_target()).unwrap();
    (temp, engine, key, lease)
}
#[test]
fn exact_completed_native_owner_survives_read_but_not_foreign_or_replacement_run() {
    let (_temp, engine, key, lease) = fixture(true);
    let guard =
        AgentRunObservation::capture(&engine, &lease, &key.parent_session_id, &key.agent_id, &key)
            .unwrap();
    assert!(guard.verify(&engine).is_ok());
    assert!(verify_state(&engine, "foreign", &key.agent_id, Some(&key)).is_err());
    engine.state.begin_background_run(&key.agent_id).unwrap();
    let error = guard.verify(&engine).unwrap_err();
    assert_eq!(response_code(&error, 0), -32038);
    let closed = guard.closed("original-observer", &error);
    assert_eq!(closed.expected_background_run, key);
    assert_eq!(closed.reason_code, AgentStreamCloseReason::RunChanged);
}
#[test]
fn observation_does_not_extend_or_rebind_an_original_native_session_lease() {
    let (_temp, engine, key, lease) = fixture(true);
    let guard =
        AgentRunObservation::capture(&engine, &lease, &key.parent_session_id, &key.agent_id, &key)
            .unwrap();
    drop(lease);
    assert!(guard.verify(&engine).is_err());
    let replacement = SessionLease::acquire(&engine.session_lease_target()).unwrap();
    assert!(guard.verify(&engine).is_err());
    assert!(
        AgentRunObservation::capture(
            &engine,
            &replacement,
            &key.parent_session_id,
            &key.agent_id,
            &key
        )
        .is_ok()
    );
}
#[test]
fn exact_output_reads_only_actual_current_per_run_file_and_rejects_legacy_transcript() {
    let (_temp, engine, key, _lease) = fixture(false);
    let legacy = engine.state.subagent_output_path(&key.agent_id);
    let output = legacy
        .parent()
        .unwrap()
        .join("runs")
        .join(&key.run_id)
        .join("output.md");
    let directory = PrivateDirectory::open_or_create(output.parent().unwrap()).unwrap();
    directory
        .atomic_replace(
            std::ffi::OsStr::new("output.md"),
            b"Actual completed original output",
        )
        .unwrap();
    engine
        .state
        .update_task(&key.agent_id, |task| {
            task.output_path = Some(output.clone())
        })
        .unwrap();
    engine
        .state
        .commit_background_terminal(
            &kcoder_types::BackgroundEventIdentity::terminal(key.clone()),
            TaskStatus::Completed,
            Some(output),
        )
        .unwrap();
    let params = kcoder_app_protocol::AgentArtifactReadParams {
        thread_id: key.parent_session_id.clone(),
        agent_id: key.agent_id.clone(),
        kind: None,
        path: None,
        offset: None,
        limit: None,
        revision: None,
        tail: None,
        expected_background_run: Some(key.clone()),
    };
    let actual = super::super::agent_artifacts::read(&engine, &params).unwrap();
    assert_eq!(actual.content, "Actual completed original output");
    assert_eq!(actual.background_run, Some(key.clone()));
    let mut transcript = params.clone();
    transcript.kind = Some(kcoder_app_protocol::AgentArtifactKind::Transcript);
    assert!(super::super::agent_artifacts::read(&engine, &transcript).is_err());
    let (_other_temp, other, other_key, _other_lease) = fixture(false);
    let other_legacy = other.state.subagent_output_path(&other_key.agent_id);
    let legacy_dir = PrivateDirectory::open_or_create(other_legacy.parent().unwrap()).unwrap();
    legacy_dir
        .atomic_replace(std::ffi::OsStr::new("output.md"), b"Unbound legacy output")
        .unwrap();
    other
        .state
        .update_task(&other_key.agent_id, |task| {
            task.output_path = Some(other_legacy.clone())
        })
        .unwrap();
    other
        .state
        .commit_background_terminal(
            &kcoder_types::BackgroundEventIdentity::terminal(other_key.clone()),
            TaskStatus::Completed,
            Some(other_legacy),
        )
        .unwrap();
    let legacy_params = kcoder_app_protocol::AgentArtifactReadParams {
        thread_id: other_key.parent_session_id.clone(),
        agent_id: other_key.agent_id.clone(),
        expected_background_run: Some(other_key),
        ..params
    };
    assert!(super::super::agent_artifacts::read(&other, &legacy_params).is_err());
}
