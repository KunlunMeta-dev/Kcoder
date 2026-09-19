use kcoder_app_protocol::AgentArtifactKind;


fn artifact_engine() -> (tempfile::TempDir, QueryEngine) {
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    let mut task = kcoder_state::Task::new("agent-1", "artifact fixture");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.parent_session_id = Some(engine.session_id());
    engine.state.upsert_task(task);
    (workspace, engine)
}

fn read_params(agent_id: &str) -> AgentArtifactReadParams {
    AgentArtifactReadParams {
        thread_id: "thread-1".to_string(),
        agent_id: agent_id.to_string(),
        kind: None,
        path: None,
    }
}

fn write_output(engine: &QueryEngine, contents: &[u8]) -> std::path::PathBuf {
    let path = engine.state.subagent_output_path("agent-1");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, contents).unwrap();
    path
}

#[test]
fn unknown_agent_is_rejected_as_unavailable() {
    let (_workspace, engine) = artifact_engine();
    let error = agent_artifacts::read(&engine, &read_params("missing-agent")).unwrap_err();
    assert!(error
        .downcast_ref::<agent_artifacts::ArtifactUnavailable>()
        .is_some());
    assert!(error.to_string().contains("does not belong to this thread"));
}

#[test]
fn foreign_parent_thread_agent_is_rejected() {
    let (_workspace, engine) = artifact_engine();
    let mut foreign = kcoder_state::Task::new("agent-foreign", "foreign fixture");
    foreign.kind = kcoder_state::TaskKind::Subagent;
    foreign.parent_session_id = Some("another-session".to_string());
    engine.state.upsert_task(foreign);
    let error = agent_artifacts::read(&engine, &read_params("agent-foreign")).unwrap_err();
    assert!(error
        .downcast_ref::<agent_artifacts::ArtifactUnavailable>()
        .is_some());
}

#[test]
fn happy_path_returns_content_and_revision() {
    let (_workspace, engine) = artifact_engine();
    let path = write_output(&engine, b"# report\n");
    let result = agent_artifacts::read(&engine, &read_params("agent-1")).unwrap();
    assert_eq!(result.content, "# report\n");
    assert_eq!(result.name, "output.md");
    assert_eq!(result.size, 9);
    assert!(!result.truncated);
    assert_eq!(result.revision, private_files::hex_sha256(b"# report\n"));
    assert!(result.path.ends_with("output.md"));
    assert_eq!(
        std::fs::canonicalize(&result.path).unwrap(),
        std::fs::canonicalize(&path).unwrap()
    );
}

#[test]
fn transcript_kind_resolves_the_transcript_path() {
    let (_workspace, engine) = artifact_engine();
    let transcript = engine.state.subagent_transcript_path("agent-1");
    std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
    std::fs::write(&transcript, b"{\"turns\":[]}").unwrap();
    let mut params = read_params("agent-1");
    params.kind = Some(AgentArtifactKind::Transcript);
    let result = agent_artifacts::read(&engine, &params).unwrap();
    assert!(result.path.ends_with("transcript.json"));
    assert_eq!(result.content, "{\"turns\":[]}");
}

#[test]
fn oversized_artifact_is_truncated() {
    let (_workspace, engine) = artifact_engine();
    let big = vec![b'x'; 300 * 1024];
    write_output(&engine, &big);
    let result = agent_artifacts::read(&engine, &read_params("agent-1")).unwrap();
    assert!(result.truncated);
    assert_eq!(result.size, big.len() as u64);
    assert_eq!(result.content.len(), 256 * 1024);
}

#[test]
fn client_path_mismatch_is_rejected() {
    let (_workspace, engine) = artifact_engine();
    let output = write_output(&engine, b"ok");
    let transcript = engine.state.subagent_transcript_path("agent-1");
    std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
    std::fs::write(&transcript, b"{}").unwrap();

    let mut mismatched = read_params("agent-1");
    mismatched.path = Some(transcript.to_string_lossy().into_owned());
    let error = agent_artifacts::read(&engine, &mismatched).unwrap_err();
    assert!(error
        .downcast_ref::<agent_artifacts::ArtifactUnavailable>()
        .is_some());

    let mut matching = read_params("agent-1");
    matching.path = Some(output.to_string_lossy().into_owned());
    let result = agent_artifacts::read(&engine, &matching).unwrap();
    assert_eq!(result.content, "ok");
}

#[cfg(unix)]
#[test]
fn symlinked_artifact_is_rejected() {
    let (workspace, engine) = artifact_engine();
    let real = workspace.path().join("real-output.md");
    std::fs::write(&real, b"real").unwrap();
    let link = engine.state.subagent_output_path("agent-1");
    std::fs::create_dir_all(link.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let error = agent_artifacts::read(&engine, &read_params("agent-1")).unwrap_err();
    assert!(error
        .downcast_ref::<agent_artifacts::ArtifactUnavailable>()
        .is_some());
}
