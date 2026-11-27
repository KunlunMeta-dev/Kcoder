use kcoder_state::{
    AppState, llm_request_history_dir_path, managed_task_output_path, session_state_path,
    subagent_transcript_path,
};

#[test]
fn state_artifact_paths_remain_scoped_to_the_session_directory() {
    let temporary = tempfile::tempdir().expect("temporary directory should be created");
    let project = temporary.path().join("project-state");
    let session = "session-contract";

    for path in [
        session_state_path(&project, session),
        llm_request_history_dir_path(&project, session),
        managed_task_output_path(&project, session, "task-1"),
        subagent_transcript_path(&project, session, "agent-1"),
    ] {
        assert!(path.starts_with(project.join(session)));
        assert!(!path.components().any(|part| part.as_os_str() == ".."));
    }
}

#[test]
fn app_state_keeps_base_workspace_separate_from_active_workspace() {
    let temporary = tempfile::tempdir().expect("temporary directory should be created");
    let base = temporary.path().join("base");
    let moved = temporary.path().join("moved");
    let state = AppState::new(&base);

    state.set_cwd(&moved);

    assert_eq!(state.base_cwd(), base);
    assert_eq!(state.cwd(), moved);
    assert!(state.active_worktree().is_none());
    assert!(!state.session_id().is_empty());
}
