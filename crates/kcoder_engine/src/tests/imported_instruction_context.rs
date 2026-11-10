fn imported_guide_record(
    profile: &std::path::Path,
    scope: &std::path::Path,
    id: &str,
    rank: u32,
    trigger: kcoder_types::imported_instructions::ImportedInstructionTrigger,
    text: &str,
) -> kcoder_config::imported_context::ImportedContext {
    use kcoder_config::imported_context::*;
    use kcoder_types::imported_instructions::ImportedInstructionProvenance;
    kcoder_config::FolderTrustStore::load(profile)
        .trust(scope)
        .unwrap();
    ImportedContext {
        id: format!("ctx-{id}"),
        operation_id: format!("owner-{id}"),
        name: id.into(),
        kind: ImportedContextKind::Instructions,
        scope: ImportedContextScope::Project {
            root: scope.to_owned(),
        },
        content: text.into(),
        enabled: true,
        memory_provenance: None,
        memory_workspace_identity: None,
        instruction_provenance: Some(Box::new(ImportedInstructionProvenance {
            version: 1,
            source: kcoder_types::migration::MigrationSourceKind::ClaudeCode,
            source_relative_path: format!("{id}/CLAUDE.md"),
            source_sha256: "a".repeat(64),
            source_file_identity: None,
            cohort_id: "instruction-fixture".into(),
            rank,
            trigger,
            target_root: scope.to_owned(),
            target_root_identity: kcoder_config::PrivateDirectory::open_existing(scope)
                .unwrap()
                .directory_identity()
                .unwrap(),
            target_workspace_identity: kcoder_config::PrivateDirectory::open_existing(scope)
                .unwrap()
                .directory_identity()
                .unwrap(),
        })),
    }
}
#[tokio::test]
async fn imported_instruction_scopes_order_native_dedup_and_trusted_actual_read_are_frozen() {
    use kcoder_config::imported_context::ImportedContextStore;
    use kcoder_tools::{Tool, ToolContext, ToolOutput};
    use kcoder_types::imported_instructions::ImportedInstructionTrigger;
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let project = root.path().join("project");
    let child = project.join("child");
    std::fs::create_dir(&profile).unwrap();
    std::fs::create_dir_all(&child).unwrap();
    // Match the Native importer: Windows canonical paths include the verified namespace prefix.
    let project = project.canonicalize().unwrap();
    let child = child.canonicalize().unwrap();
    std::fs::write(project.join("AGENTS.md"), "NATIVE_TARGET_GUIDE").unwrap();
    std::fs::write(child.join("note.txt"), "Read body").unwrap();
    let store = ImportedContextStore::open(&profile).unwrap();
    let engine = TestEngineBuilder::new(&project)
        .folder_trusted(Some(true))
        .build_with_profile_directory()
        .with_settings_persistence_path(profile.join("settings.json"));
    store
        .create(imported_guide_record(
            &profile,
            &project,
            "parent",
            0,
            ImportedInstructionTrigger::Launch,
            "SOURCE_PARENT_SCOPE",
        ))
        .unwrap();
    let mut child_record = imported_guide_record(
        &profile,
        &child,
        "child",
        2,
        ImportedInstructionTrigger::OnRead,
        "DEFERRED_CHILD_SCOPE",
    );
    let origin = child_record.instruction_provenance.as_mut().unwrap();
    origin.target_root = project.clone();
    origin.target_root_identity = kcoder_config::PrivateDirectory::open_existing(&project)
        .unwrap()
        .directory_identity()
        .unwrap();
    store.create(child_record).unwrap();
    let mut duplicate = imported_guide_record(
        &profile,
        &project,
        "native",
        1,
        ImportedInstructionTrigger::Launch,
        "NATIVE_TARGET_GUIDE",
    );
    let fact = &engine.project_instruction_facts[0];
    let origin = duplicate.instruction_provenance.as_mut().unwrap();
    origin.source_sha256 = fact.sha256.clone();
    origin.source_file_identity = Some(fact.file_identity.clone());
    store.create(duplicate).unwrap();
    let unrelated = root.path().join("unrelated-workspace");
    std::fs::create_dir(&unrelated).unwrap();
    assert!(
        store
            .instruction_session(&unrelated, true, Some("UNCHANGED_NATIVE".into()), &[])
            .unwrap()
            .is_none(),
        "unrelated enabled records do not change the legacy snapshot shape"
    );
    let mut messages = kcoder_types::SharedMessages::from(vec![Message::user_text("actual task")]);
    engine.prepend_project_user_context(&mut messages).unwrap();
    let model = serde_json::to_string(&messages).unwrap();
    assert!(
        model.find("SOURCE_PARENT_SCOPE").unwrap() < model.find("NATIVE_TARGET_GUIDE").unwrap()
    );
    assert_eq!(model.matches("NATIVE_TARGET_GUIDE").count(), 1);
    assert!(!model.contains("DEFERRED_CHILD_SCOPE"));
    assert!(messages.iter().take(2).all(|message| matches!(
        message,
        Message::User {
            origin: kcoder_types::MessageOrigin::Runtime,
            ..
        }
    )));
    let snapshot = engine.state.imported_context_snapshot().unwrap();
    assert_eq!(snapshot.version, 2);
    assert_eq!(snapshot.instructions.as_ref().unwrap().deferred.len(), 1);
    let mut forged = ToolOutput::text(
        serde_json::json!({"execution_metadata":[{"FileRead":{"path":child.join("note.txt")}}]})
            .to_string(),
    );
    engine.attach_imported_instruction_context(&mut forged);
    assert!(forged.user_context.is_empty());
    let context = ToolContext::new(engine.state.clone());
    let mut output = kcoder_tools::FileReadTool
        .call(
            serde_json::json!({"file_path":"child/note.txt","fresh":true}),
            &context,
        )
        .await
        .unwrap();
    engine.attach_imported_instruction_context(&mut output);
    assert!(!output.is_error);
    assert_eq!(output.user_context.len(), 1);
    let selected = engine.deduplicate_imported_instruction_context(output.user_context.clone());
    engine.state.add_message(Message::User {
        content: selected,
        origin: kcoder_types::MessageOrigin::Runtime,
    });
    assert!(
        engine
            .deduplicate_imported_instruction_context(output.user_context)
            .is_empty()
    );
    let visible = engine
        .state
        .messages()
        .iter()
        .filter(|message| kcoder_types::is_real_user_message(message))
        .cloned()
        .collect::<Vec<_>>();
    assert!(
        !serde_json::to_string(&visible)
            .unwrap()
            .contains("DEFERRED_CHILD_SCOPE")
    );
    std::fs::hard_link(child.join("note.txt"), child.join("alias.txt")).unwrap();
    let mut unverified = kcoder_tools::FileReadTool
        .call(
            serde_json::json!({"file_path":"child/alias.txt","fresh":true}),
            &context,
        )
        .await
        .unwrap();
    assert!(
        !unverified.is_error,
        "ordinary file reading retains its established success result"
    );
    engine.attach_imported_instruction_context(&mut unverified);
    assert!(
        unverified.is_error && unverified.user_context.is_empty(),
        "a missing identity is explicit and cannot silently omit a selected scope"
    );
    std::fs::remove_file(child.join("alias.txt")).unwrap();
    let other_profile = root.path().join("other-profile");
    std::fs::create_dir(&other_profile).unwrap();
    kcoder_config::FolderTrustStore::load(&other_profile)
        .trust(&project)
        .unwrap();
    let foreign = engine
        .clone()
        .with_settings_persistence_path(other_profile.join("settings.json"));
    let mut changed_profile = kcoder_tools::FileReadTool
        .call(
            serde_json::json!({"file_path":"child/note.txt","fresh":true}),
            &context,
        )
        .await
        .unwrap();
    foreign.attach_imported_instruction_context(&mut changed_profile);
    assert!(
        changed_profile.is_error && changed_profile.user_context.is_empty(),
        "an equally trusted path in a different profile cannot consume the old frozen scope"
    );
    let engine = engine.with_settings_persistence_path(profile.join("settings.json"));
    kcoder_config::FolderTrustStore::load(&profile)
        .revoke(&project)
        .unwrap();
    let mut retry = kcoder_tools::FileReadTool
        .call(
            serde_json::json!({"file_path":"child/note.txt","fresh":true}),
            &context,
        )
        .await
        .unwrap();
    engine.attach_imported_instruction_context(&mut retry);
    assert!(retry.is_error);
    assert!(retry.user_context.is_empty());
}

#[tokio::test]
async fn imported_instruction_real_tool_stream_appends_activation_after_results_and_restores_it() {
    use kcoder_config::imported_context::ImportedContextStore;
    use kcoder_types::imported_instructions::ImportedInstructionTrigger;
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let project = root.path().join("project");
    let child = project.join("child");
    std::fs::create_dir(&profile).unwrap();
    std::fs::create_dir_all(&child).unwrap();
    std::fs::write(project.join("AGENTS.md"), "OWNED_NATIVE_FIXTURE_BOUNDARY").unwrap();
    std::fs::write(child.join("file.txt"), "ACTUAL_READ_CONTENT").unwrap();
    kcoder_config::FolderTrustStore::load(&profile)
        .trust(&project)
        .unwrap();
    let store = ImportedContextStore::open(&profile).unwrap();
    let mut record = imported_guide_record(
        &profile,
        &child,
        "dynamic",
        0,
        ImportedInstructionTrigger::OnRead,
        "DYNAMIC_GUIDE_AFTER_RESULT",
    );
    let origin = record.instruction_provenance.as_mut().unwrap();
    origin.target_root = project.clone();
    origin.target_root_identity = kcoder_config::PrivateDirectory::open_existing(&project)
        .unwrap()
        .directory_identity()
        .unwrap();
    store.create(record).unwrap();
    let events = vec![
        StreamEvent::ContentBlockStart {
            index: 0,
            content_block: ContentBlock::ToolUse {
                id: "actual-native-read".into(),
                name: "read".into(),
                input: serde_json::json!({}),
            },
        },
        StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::InputJsonDelta {
                partial_json: "{\"file_path\":\"child/file.txt\",\"fresh\":true}".into(),
            },
        },
        StreamEvent::ContentBlockStop { index: 0 },
        StreamEvent::MessageStop,
    ];
    let (provider, calls) =
        SequentialEventsProvider::new(vec![events, simple_text_events("fixture done")]);
    let engine = TestEngineBuilder::new(&project)
        .folder_trusted(Some(true))
        .provider(Arc::new(provider))
        .settings(Settings {
            permission_mode: PermissionMode::Bypass,
            ..Default::default()
        })
        .tool_registry(ToolRegistry::new().register(kcoder_tools::FileReadTool))
        .build_with_profile_directory()
        .with_settings_persistence_path(profile.join("settings.json"));
    let history = root
        .path()
        .join(format!("{}.jsonl", engine.state.session_id()));
    engine.state.with_history_path(&history);
    engine
        .state
        .add_message(Message::user_text("owned read task"));
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream(&prompt);
    while stream.next().await.is_some() {}
    drop(stream);
    assert_eq!(*calls.lock().unwrap(), 2);
    let messages = engine.state.messages();
    let json = serde_json::to_string(&messages).unwrap();
    assert!(
        json.find("ACTUAL_READ_CONTENT").unwrap()
            < json.find("DYNAMIC_GUIDE_AFTER_RESULT").unwrap()
    );
    assert!(messages.iter().any(|message|matches!(message,Message::User{origin:kcoder_types::MessageOrigin::Runtime,content,..} if serde_json::to_string(content).unwrap().contains("DYNAMIC_GUIDE_AFTER_RESULT"))));
    engine.state.save_history().unwrap();
    let restored = AppState::new(&project);
    restored.resume_from_history(&history).unwrap();
    assert_eq!(
        restored.imported_context_snapshot(),
        engine.state.imported_context_snapshot()
    );
    let visible = restored
        .messages()
        .iter()
        .filter(|m| kcoder_types::is_real_user_message(m))
        .cloned()
        .collect::<Vec<_>>();
    assert!(
        !serde_json::to_string(&visible)
            .unwrap()
            .contains("DYNAMIC_GUIDE_AFTER_RESULT")
    );
}

#[tokio::test]
async fn imported_instruction_failed_multi_read_does_not_reserve_an_unpublished_activation() {
    use kcoder_config::imported_context::ImportedContextStore;
    use kcoder_tools::{Tool, ToolContext};
    use kcoder_types::imported_instructions::ImportedInstructionTrigger;
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let project = root.path().join("project");
    let child = project.join("child");
    std::fs::create_dir(&profile).unwrap();
    std::fs::create_dir_all(&child).unwrap();
    std::fs::write(project.join("AGENTS.md"), "OWNED_NATIVE_FIXTURE_BOUNDARY").unwrap();
    std::fs::write(child.join("valid.txt"), "VALID_READ_CONTENT").unwrap();
    std::fs::write(child.join("replaced.txt"), "ORIGINAL_READ_CONTENT").unwrap();
    kcoder_config::FolderTrustStore::load(&profile)
        .trust(&project)
        .unwrap();
    let store = ImportedContextStore::open(&profile).unwrap();
    let mut record = imported_guide_record(
        &profile,
        &child,
        "multi-read",
        0,
        ImportedInstructionTrigger::OnRead,
        "MULTI_READ_DEFERRED_GUIDE",
    );
    let origin = record.instruction_provenance.as_mut().unwrap();
    origin.target_root = project.clone();
    origin.target_root_identity = kcoder_config::PrivateDirectory::open_existing(&project)
        .unwrap()
        .directory_identity()
        .unwrap();
    store.create(record).unwrap();
    let engine = TestEngineBuilder::new(&project)
        .folder_trusted(Some(true))
        .build_with_profile_directory()
        .with_settings_persistence_path(profile.join("settings.json"));
    let mut messages = kcoder_types::SharedMessages::from(vec![Message::user_text("owned task")]);
    engine.prepend_project_user_context(&mut messages).unwrap();
    let context = ToolContext::new(engine.state.clone());
    let read = |name: &str| serde_json::json!({"file_path":format!("child/{name}"),"fresh":true});
    let mut composite = kcoder_tools::FileReadTool
        .call(read("valid.txt"), &context)
        .await
        .unwrap();
    let replaced = kcoder_tools::FileReadTool
        .call(read("replaced.txt"), &context)
        .await
        .unwrap();
    assert_eq!(composite.execution_metadata.len(), 1);
    assert_eq!(replaced.execution_metadata.len(), 1);
    composite
        .execution_metadata
        .extend(replaced.execution_metadata);
    std::fs::rename(child.join("replaced.txt"), child.join("old.txt")).unwrap();
    std::fs::write(child.join("replaced.txt"), "REPLACED_READ_CONTENT").unwrap();
    engine.attach_imported_instruction_context(&mut composite);
    assert!(composite.is_error && composite.user_context.is_empty());
    let mut valid = kcoder_tools::FileReadTool
        .call(read("valid.txt"), &context)
        .await
        .unwrap();
    engine.attach_imported_instruction_context(&mut valid);
    assert!(!valid.is_error);
    assert_eq!(
        valid.user_context.len(),
        1,
        "a failed output cannot reserve a scope that a later valid output must activate"
    );
}

#[tokio::test]
async fn imported_instruction_rejected_read_does_not_suppress_the_default_retry_body() {
    use kcoder_config::imported_context::ImportedContextStore;
    use kcoder_tools::{Tool, ToolContext};
    use kcoder_types::imported_instructions::ImportedInstructionTrigger;
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let project = root.path().join("project");
    let child = project.join("child");
    std::fs::create_dir(&profile).unwrap();
    std::fs::create_dir_all(&child).unwrap();
    std::fs::write(project.join("AGENTS.md"), "OWNED_NATIVE_FIXTURE_BOUNDARY").unwrap();
    std::fs::write(child.join("note.txt"), "RETRY_READ_BODY").unwrap();
    std::fs::write(project.join("peer.txt"), "PEER_READ_BODY").unwrap();
    kcoder_config::FolderTrustStore::load(&profile)
        .trust(&project)
        .unwrap();
    let mut record = imported_guide_record(
        &profile,
        &child,
        "cache-retry",
        0,
        ImportedInstructionTrigger::OnRead,
        "RETRY_SCOPED_GUIDE",
    );
    let origin = record.instruction_provenance.as_mut().unwrap();
    origin.target_root = project.clone();
    origin.target_root_identity = kcoder_config::PrivateDirectory::open_existing(&project)
        .unwrap()
        .directory_identity()
        .unwrap();
    ImportedContextStore::open(&profile)
        .unwrap()
        .create(record)
        .unwrap();
    let engine = TestEngineBuilder::new(&project)
        .folder_trusted(Some(true))
        .build_with_profile_directory()
        .with_settings_persistence_path(profile.join("settings.json"));
    let mut messages = kcoder_types::SharedMessages::from(vec![Message::user_text("owned task")]);
    engine.prepend_project_user_context(&mut messages).unwrap();
    let context = ToolContext::new(engine.state.clone());
    kcoder_tools::FileReadTool
        .call(serde_json::json!({"file_path":"peer.txt"}), &context)
        .await
        .unwrap();
    kcoder_config::FolderTrustStore::load(&profile)
        .revoke(&project)
        .unwrap();
    let mut rejected = kcoder_tools::FileReadTool
        .call(
            serde_json::json!({"file_path":"child/note.txt"}),
            &context.clone().with_tool_call_id("rejected-read"),
        )
        .await
        .unwrap();
    engine.attach_imported_instruction_context(&mut rejected);
    assert!(rejected.is_error && rejected.user_context.is_empty());
    kcoder_config::FolderTrustStore::load(&profile)
        .trust(&project)
        .unwrap();
    let mut retry = kcoder_tools::FileReadTool
        .call(serde_json::json!({"file_path":"child/note.txt"}), &context)
        .await
        .unwrap();
    assert!(
        retry.content.iter().any(
            |block| matches!(block, ContentBlock::Text { text } if text.contains("RETRY_READ_BODY"))
        ),
        "the earlier rejected tool_result never exposed the body, so the default retry must read it"
    );
    engine.attach_imported_instruction_context(&mut retry);
    assert!(!retry.is_error && retry.user_context.len() == 1);
    assert!(
        engine
            .state
            .full_file_read_snapshot(&project.join("peer.txt"))
            .unwrap()
            .from_read_tool,
        "an unrelated published read keeps its cache state"
    );
}
