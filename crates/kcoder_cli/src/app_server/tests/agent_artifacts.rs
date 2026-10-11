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
        offset: None,
        limit: None,
        revision: None,
        tail: None,
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
    assert!(
        error
            .downcast_ref::<agent_artifacts::ArtifactUnavailable>()
            .is_some()
    );
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
    assert!(
        error
            .downcast_ref::<agent_artifacts::ArtifactUnavailable>()
            .is_some()
    );
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
    assert_eq!(result.revision.len(), 64);
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
    std::fs::write(&transcript, b"private hidden reasoning").unwrap();
    let public = transcript.with_extension("public.txt");
    std::fs::write(
        &public,
        b"<!-- kcoder-public-transcript:v2 -->\n[assistant]\npublic progress\n",
    )
    .unwrap();
    let mut params = read_params("agent-1");
    params.kind = Some(AgentArtifactKind::Transcript);
    let result = agent_artifacts::read(&engine, &params).unwrap();
    assert!(result.path.ends_with("transcript.public.txt"));
    assert_eq!(
        result.content,
        "<!-- kcoder-public-transcript:v2 -->\n[assistant]\npublic progress\n"
    );
    params.path = Some(transcript.to_string_lossy().into_owned());
    assert_eq!(
        agent_artifacts::read(&engine, &params).unwrap().content,
        result.content
    );
    std::fs::remove_file(public).unwrap();
    assert!(
        agent_artifacts::read(&engine, &params).is_err(),
        "missing public transcript must never expose private checkpoint"
    );
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
fn artifact_pages_preserve_unicode_and_reject_replaced_snapshots() {
    let (_workspace, engine) = artifact_engine();
    let output = write_output(&engine, "abc你好！".as_bytes());
    let mut params = read_params("agent-1");
    params.limit = Some(4);
    let first = agent_artifacts::read(&engine, &params).unwrap();
    assert_eq!(first.content, "abc");
    assert_eq!(first.next_offset, Some(3));
    params.offset = first.next_offset;
    params.limit = Some(6);
    params.revision = Some(first.revision.clone());
    let second = agent_artifacts::read(&engine, &params).unwrap();
    assert_eq!(second.content, "你好");
    assert_eq!(second.revision, first.revision);
    params.offset = second.next_offset;
    assert_eq!(
        agent_artifacts::read(&engine, &params).unwrap().content,
        "！"
    );
    std::fs::write(output, "updated new snapshot").unwrap();
    assert!(
        agent_artifacts::read(&engine, &params)
            .unwrap_err()
            .to_string()
            .contains("snapshot_changed")
    );
}

#[test]
fn artifact_tail_reads_current_end_at_a_real_unicode_cursor() {
    let (_workspace, engine) = artifact_engine();
    write_output(&engine, "abc你好！".as_bytes());
    let mut params = read_params("agent-1");
    params.tail = Some(true);
    params.limit = Some(5);
    let last = agent_artifacts::read(&engine, &params).unwrap();
    assert_eq!(last.offset, 9);
    assert_eq!(last.content, "！");
    assert_eq!(last.next_offset, None);
    params.offset = Some(3);
    assert!(agent_artifacts::read(&engine, &params).is_err());
}

#[test]
fn legacy_transcript_is_converted_to_public_text_without_hidden_content() {
    let (_workspace, engine) = artifact_engine();
    let private = engine.state.subagent_transcript_path("agent-1");
    std::fs::create_dir_all(private.parent().unwrap()).unwrap();
    let messages = vec![
        kcoder_types::Message::runtime_text("private reminder"),
        kcoder_types::Message::Assistant {
            usage: None,
            content: vec![
                kcoder_types::ContentBlock::Thinking {
                    thinking: "private thought".into(),
                    signature: "private signature".into(),
                },
                kcoder_types::ContentBlock::Text {
                    text: "public result".into(),
                },
            ],
        },
    ];
    std::fs::write(&private, serde_json::to_vec_pretty(&messages).unwrap()).unwrap();
    let mut params = read_params("agent-1");
    params.kind = Some(AgentArtifactKind::Transcript);
    params.path = Some(private.to_string_lossy().into_owned());
    let result = agent_artifacts::read(&engine, &params).unwrap();
    assert!(result.content.contains("public result"));
    assert!(!result.content.contains("private"));
    assert!(private.with_extension("public.txt").is_file());
    assert_eq!(
        serde_json::from_slice::<Vec<kcoder_types::Message>>(&std::fs::read(private).unwrap())
            .unwrap(),
        messages
    );
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
    assert!(
        error
            .downcast_ref::<agent_artifacts::ArtifactUnavailable>()
            .is_some()
    );

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
    assert!(
        error
            .downcast_ref::<agent_artifacts::ArtifactUnavailable>()
            .is_some()
    );
}

#[test]
fn agent_artifact_uses_current_run_output_without_widening_path_access() {
    let (_workspace, engine) = artifact_engine();
    let legacy = write_output(&engine, b"old report");
    let key = engine.state.begin_background_run("agent-1").unwrap();
    let path = legacy
        .parent()
        .unwrap()
        .join("runs")
        .join(key.run_id)
        .join("output.md");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "current report").unwrap();
    engine
        .state
        .update_task("agent-1", |task| task.output_path = Some(path.clone()));
    assert_eq!(
        agent_artifacts::read(&engine, &read_params("agent-1"))
            .unwrap()
            .content,
        "current report"
    );
    let mut stale = read_params("agent-1");
    stale.path = Some(legacy.to_string_lossy().into_owned());
    assert!(agent_artifacts::read(&engine, &stale).is_err());
    engine.state.update_task("agent-1", |task| {
        task.output_path = Some(legacy.parent().unwrap().join("../../foreign"))
    });
    assert!(agent_artifacts::read(&engine, &read_params("agent-1")).is_err());
}

#[test]
fn obsolete_public_transcript_recovers_runtime_tool_results_without_private_content() {
    let (_workspace, engine) = artifact_engine();
    let private = engine.state.subagent_transcript_path("agent-1");
    std::fs::create_dir_all(private.parent().unwrap()).unwrap();
    let messages = vec![
        kcoder_types::Message::runtime_text("private reminder"),
        kcoder_types::Message::Assistant {
            usage: None,
            content: vec![kcoder_types::ContentBlock::ToolUse {
                id: "call-1".into(),
                name: "glob".into(),
                input: serde_json::json!({"pattern":"*.rs"}),
            }],
        },
        kcoder_types::Message::user_content(vec![kcoder_types::ContentBlock::ToolResult {
            tool_use_id: "call-1".into(),
            is_error: None,
            content: vec![kcoder_types::ContentBlock::Text {
                text: "src/main.rs".into(),
            }],
        }])
        .with_origin(kcoder_types::MessageOrigin::Runtime),
    ];
    let bytes = serde_json::to_vec(&messages).unwrap();
    std::fs::write(&private, &bytes).unwrap();
    std::fs::write(
        private.with_extension("public.txt"),
        b"[tool/start call-1] glob\n{}\n",
    )
    .unwrap();
    let mut params = read_params("agent-1");
    params.kind = Some(AgentArtifactKind::Transcript);
    let result = agent_artifacts::read(&engine, &params).unwrap();
    assert!(result.content.contains("[tool/result call-1] completed"));
    assert!(result.content.contains("src/main.rs"));
    assert!(!result.content.contains("private reminder"));
    assert_eq!(std::fs::read(private).unwrap(), bytes);
}

#[test]
fn conversation_recovery_is_structured_public_and_does_not_start_a_worker() {
    let (_workspace, engine) = artifact_engine();
    engine
        .state
        .update_task("agent-1", |task| task.status = TaskStatus::Completed);
    let transcript = engine.state.subagent_transcript_path("agent-1");
    std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
    let messages = vec![
        kcoder_types::Message::runtime_text("private reminder"),
        kcoder_types::Message::user_text("visible task"),
        kcoder_types::Message::Assistant {
            usage: None,
            content: vec![
                kcoder_types::ContentBlock::Thinking {
                    thinking: "private thought".into(),
                    signature: "private signature".into(),
                },
                kcoder_types::ContentBlock::Text {
                    text: "visible answer".into(),
                },
                kcoder_types::ContentBlock::ToolUse {
                    id: "read-1".into(),
                    name: "read".into(),
                    input: json!({"path":"main.rs"}),
                },
            ],
        },
        kcoder_types::Message::user_content(vec![kcoder_types::ContentBlock::ToolResult {
            tool_use_id: "read-1".into(),
            content: vec![kcoder_types::ContentBlock::Text {
                text: "file output".into(),
            }],
            is_error: Some(false),
        }]),
    ];
    std::fs::write(&transcript, serde_json::to_vec(&messages).unwrap()).unwrap();
    let subscription = engine.subscribe_subagent_conversation("agent-1").unwrap();
    assert!(!subscription.snapshot.active);
    assert!(!engine.has_subagent_live_view("agent-1"));
    let wire = serde_json::to_string(
        &subscription
            .snapshot
            .entries
            .iter()
            .map(|entry| &entry.message)
            .collect::<Vec<_>>(),
    )
    .unwrap();
    for public in ["visible task", "visible answer", "file output", "read-1"] {
        assert!(wire.contains(public));
    }
    for private in ["private reminder", "private thought", "private signature"] {
        assert!(!wire.contains(private));
    }
}

#[test]
fn conversation_observation_requires_parent_ownership_and_rejects_checkpoint_symlinks() {
    let (_workspace, engine) = artifact_engine();
    engine.state.update_task("agent-1", |task| {
        task.parent_session_id = Some("foreign-parent".into())
    });
    assert!(engine.subscribe_subagent_conversation("agent-1").is_err());
    assert!(engine.subscribe_subagent_conversation("unknown").is_err());
    #[cfg(unix)]
    {
        let session_id = engine.session_id();
        engine
            .state
            .update_task("agent-1", |task| task.parent_session_id = Some(session_id));
        let checkpoint = engine.state.subagent_transcript_path("agent-1");
        std::fs::create_dir_all(checkpoint.parent().unwrap()).unwrap();
        let target = checkpoint.with_extension("secret");
        std::fs::write(&target, b"[]").unwrap();
        std::os::unix::fs::symlink(&target, &checkpoint).unwrap();
        assert!(engine.subscribe_subagent_conversation("agent-1").is_err());
    }
}
