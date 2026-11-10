#[tokio::test]
async fn imported_memory_notes_keep_unverified_runtime_provenance_and_frozen_session_context() {
    use kcoder_config::imported_context::{
        ImportedContext, ImportedContextKind, ImportedContextScope, ImportedContextStore,
        ImportedMemoryControl, imported_context_revision,
    };
    use kcoder_types::{
        MessageOrigin,
        imported_memory::{ImportedMemoryLayout, ImportedMemoryProvenance},
        migration::MigrationSourceKind,
    };
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let project = root.path().join("project");
    std::fs::create_dir(&profile).unwrap();
    std::fs::create_dir(&project).unwrap();
    let store = ImportedContextStore::open(&profile).unwrap();
    let record = ImportedContext {
        id: "ctx-memory-fixture".into(),
        operation_id: "original-memory-owner".into(),
        name: "Reviewed source note".into(),
        kind: ImportedContextKind::Memory,
        scope: ImportedContextScope::Global,
        content: "UNVERIFIED_MEMORY_RUNTIME_MARKER".into(),
        enabled: false,
        memory_workspace_identity: None,
        instruction_provenance: None,
        memory_provenance: Some(Box::new(ImportedMemoryProvenance {
            source: MigrationSourceKind::Codex,
            layout: ImportedMemoryLayout::CodexMemoryFilesV1,
            source_group: "memories".into(),
            source_file: "MEMORY.md".into(),
            source_revision: "a".repeat(64),
            source_modified_at_ms: None,
            facts_verified: false,
            migration_job_id: Some("original-memory-job".into()),
        })),
    };
    store.create(record.clone()).unwrap();
    store
        .memory_control(&ImportedMemoryControl {
            request_id: "memory-context-enable".into(),
            id: record.id.clone(),
            owner_operation_id: record.operation_id.clone(),
            expected_revision: imported_context_revision(&record).unwrap(),
            enabled: true,
            confirm_unverified_notes: true,
        })
        .unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = TestEngineBuilder::new(&project)
        .provider(Arc::new(RequestRecordingProvider {
            requests: Arc::clone(&requests),
        }))
        .build_with_profile_directory()
        .with_settings_persistence_path(profile.join("settings.json"));
    for text in ["first", "second"] {
        engine.state.add_message(Message::user_text(text));
        let prompt = kcoder_permissions::AutoAllowPrompt;
        let mut stream = engine.run_turn_stream(&prompt);
        while stream.next().await.is_some() {}
        if text == "first" {
            let enabled = store.list().unwrap().remove(0);
            store
                .memory_control(&ImportedMemoryControl {
                    request_id: "memory-context-disable".into(),
                    id: record.id.clone(),
                    owner_operation_id: record.operation_id.clone(),
                    expected_revision: imported_context_revision(&enabled).unwrap(),
                    enabled: false,
                    confirm_unverified_notes: false,
                })
                .unwrap();
        }
    }
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].system, requests[1].system);
    for request in requests.iter() {
        assert!(
            !request
                .system
                .as_deref()
                .unwrap_or_default()
                .contains("UNVERIFIED_MEMORY_RUNTIME_MARKER")
        );
        let notes = request
            .messages
            .iter()
            .filter(|v| {
                v.preview(usize::MAX)
                    .contains("UNVERIFIED_MEMORY_RUNTIME_MARKER")
            })
            .collect::<Vec<_>>();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].origin(), MessageOrigin::Runtime);
        let text = notes[0].preview(usize::MAX);
        assert!(
            text.contains("unverified reference data")
                && text.contains("\"factsVerified\":false")
                && text.contains("original-memory-job")
        );
    }
    assert!(!engine.state.messages().iter().any(|v| {
        v.origin() == MessageOrigin::User
            && v.preview(usize::MAX)
                .contains("UNVERIFIED_MEMORY_RUNTIME_MARKER")
    }));
    let next = TestEngineBuilder::new(&project)
        .build_with_profile_directory()
        .with_settings_persistence_path(profile.join("settings.json"));
    let mut fresh: kcoder_types::SharedMessages = vec![Message::user_text("fresh session")].into();
    next.prepend_project_user_context(&mut fresh).unwrap();
    assert!(!fresh.iter().any(|v| {
        v.preview(usize::MAX)
            .contains("UNVERIFIED_MEMORY_RUNTIME_MARKER")
    }));
}

#[tokio::test]
async fn imported_memory_snapshot_survives_native_history_reload_after_record_removal() {
    use kcoder_config::imported_context::{
        ImportedContext, ImportedContextKind, ImportedContextScope, ImportedContextStore,
    };
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let project = root.path().join("project");
    let histories = profile.join("projects/owned");
    std::fs::create_dir_all(&histories).unwrap();
    std::fs::create_dir(&project).unwrap();
    let record = ImportedContext {
        id: "ctx-restart-note".into(),
        operation_id: "restart-original-owner".into(),
        name: "Unverified restart note".into(),
        kind: ImportedContextKind::Memory,
        scope: ImportedContextScope::Global,
        content: "FROZEN_IMPORTED_NOTE_ACROSS_NATIVE_RESTART".into(),
        enabled: true,
        memory_provenance: None,
        memory_workspace_identity: None,
        instruction_provenance: None,
    };
    ImportedContextStore::open(&profile)
        .unwrap()
        .create(record)
        .unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let first = TestEngineBuilder::new(&project)
        .provider(Arc::new(RequestRecordingProvider {
            requests: Arc::clone(&requests),
        }))
        .build_with_profile_directory()
        .with_settings_persistence_path(profile.join("settings.json"));
    let history = histories.join(format!("{}.jsonl", first.session_id()));
    first.state.with_history_path(&history);
    first.state.add_message(Message::user_text("first"));
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = first.run_turn_stream(&prompt);
    while stream.next().await.is_some() {}
    drop(stream);
    first.state.flush_history().await.unwrap();
    assert!(requests.lock().unwrap()[0].messages.iter().any(|v| {
        v.preview(usize::MAX)
            .contains("FROZEN_IMPORTED_NOTE_ACROSS_NATIVE_RESTART")
    }));
    std::fs::remove_file(profile.join("imported-context.json")).unwrap();
    drop(first);
    let restored = TestEngineBuilder::new(&project)
        .provider(Arc::new(RequestRecordingProvider {
            requests: Arc::clone(&requests),
        }))
        .build_with_profile_directory()
        .with_settings_persistence_path(profile.join("settings.json"));
    restored.state.resume_from_history(&history).unwrap();
    restored
        .state
        .add_message(Message::user_text("after restart"));
    let mut stream = restored.run_turn_stream(&prompt);
    while stream.next().await.is_some() {}
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(
        requests[1].messages.iter().any(|v| v
            .preview(usize::MAX)
            .contains("FROZEN_IMPORTED_NOTE_ACROSS_NATIVE_RESTART")),
        "restoring a native conversation must use its persisted context, not the currently missing source record"
    );
}
