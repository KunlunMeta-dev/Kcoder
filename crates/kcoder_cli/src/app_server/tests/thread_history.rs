#[tokio::test]
async fn task_workspace_must_match_the_app_server_process() {
    let actual = tempfile::tempdir().unwrap();
    let different = tempfile::tempdir().unwrap();
    ensure_same_workspace(actual.path(), actual.path())
        .await
        .unwrap();
    let error = ensure_same_workspace(actual.path(), different.path())
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("does not match app-server workspace")
    );
}

pub(super) fn catalog_list_test_engine(cwd: &Path) -> QueryEngine {
    let settings = kcoder_config::Settings::default();
    let owner = Arc::new(kcoder_config::create_private_temp_dir("catalog-list-test").unwrap());
    let services = kcoder_engine::WorkspaceRuntimeServices::new(cwd, "catalog-list-test")
        .with_private_client_storage(owner);
    QueryEngine::try_new_for_client_with_services(
        Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
            crate::tui_dev_mock::TuiDevScenario::FullTurn,
        )),
        kcoder_state::AppState::new(cwd),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        cwd.to_path_buf(),
        Some(true),
        services,
    )
    .unwrap()
}

#[test]
fn catalog_list_default_performance_gate_avoids_catalog_and_projection() {
    let workspace = tempfile::tempdir().unwrap();
    let history = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let path = history
        .path()
        .join(format!("{}.jsonl", engine.session_id()));
    engine.state.with_history_path(&path);
    engine
        .state
        .add_message(kcoder_types::Message::user_text("default authority"));
    engine.state.save_history().unwrap();
    for _ in 0..2 {
        let (report, projections) = observe_history_operation("history.list_projection", || {
            persisted_thread_snapshot_report(&engine, &HashSet::new(), &HashSet::new()).unwrap()
        });
        assert_eq!(report.threads.len(), 1);
        assert_eq!(report.threads[0]["title"], "default authority");
        assert_eq!(report.issue_count, 0);
        assert_eq!(
            (
                projections,
                engine.client_storage_root().join("history-index").exists()
            ),
            (0, false),
            "failed performance gate must keep the production list on authoritative reads",
        );
    }
}

fn experimental_catalog_list_report(
    engine: &QueryEngine,
    running_thread_ids: &HashSet<String>,
    excluded_ids: &HashSet<String>,
) -> Result<PersistedThreadSnapshotReport> {
    persisted_thread_snapshot_report_with_catalog(
        engine,
        running_thread_ids,
        excluded_ids,
        history_catalog::ListCatalog::open(engine),
    )
}

fn experimental_catalog_list_snapshots(
    engine: &QueryEngine,
    running_thread_ids: &HashSet<String>,
) -> Result<Vec<Value>> {
    Ok(experimental_catalog_list_report(engine, running_thread_ids, &HashSet::new())?.threads)
}

#[test]
fn catalog_list_hot_read_skips_projection_but_refreshes_running_status() {
    let workspace = tempfile::tempdir().unwrap();
    let history = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let path = history
        .path()
        .join(format!("{}.jsonl", engine.session_id()));
    engine.state.with_history_path(&path);
    engine
        .state
        .add_message(kcoder_types::Message::user_text("catalog title"));
    engine.state.save_history().unwrap();
    let (first, cold) = observe_history_operation("history.list_projection", || {
        experimental_catalog_list_snapshots(&engine, &HashSet::new()).unwrap()
    });
    assert_eq!(first[0]["title"], "catalog title");
    assert_eq!(cold, 1);
    let (second, hot) = observe_history_operation("history.list_projection", || {
        experimental_catalog_list_snapshots(&engine, &HashSet::from([engine.session_id()])).unwrap()
    });
    assert_eq!(second[0]["title"], first[0]["title"]);
    assert_eq!(second[0]["status"], "running");
    assert_eq!(hot, 0);
}

#[test]
fn catalog_list_rehashes_same_length_body_with_restored_mtime() {
    let workspace = tempfile::tempdir().unwrap();
    let history = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let path = history
        .path()
        .join(format!("{}.jsonl", engine.session_id()));
    engine.state.with_history_path(&path);
    engine
        .state
        .add_message(kcoder_types::Message::user_text("old title"));
    engine.state.save_history().unwrap();
    let state_path = engine.state.session_state_path().unwrap();
    let mut state: Value = serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
    state["created_at_ms"] = json!(1);
    state["updated_at_ms"] = json!(1);
    std::fs::write(state_path, serde_json::to_vec(&state).unwrap()).unwrap();
    let original = String::from_utf8(std::fs::read(&path).unwrap()).unwrap();
    let mut body: Value = serde_json::from_str(original.trim()).unwrap();
    body["timestamp_ms"] = json!(100);
    let initial_body = format!("{body}\n");
    std::fs::write(&path, &initial_body).unwrap();
    catalog_list_set_committed_bytes(&path, Some(initial_body.len() as u64));
    let first = experimental_catalog_list_snapshots(&engine, &HashSet::new()).unwrap();
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    let changed = initial_body
        .replace("old title", "new title")
        .replace(":100", ":200");
    assert_eq!(changed.len(), initial_body.len());
    std::fs::write(&path, changed).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    let (second, projections) = observe_history_operation("history.list_projection", || {
        experimental_catalog_list_snapshots(&engine, &HashSet::new()).unwrap()
    });
    assert_eq!(first[0]["updatedAt"], "100");
    assert_eq!(second[0]["title"], "new title");
    assert_eq!(second[0]["updatedAt"], "200");
    assert_eq!(projections, 1);
}

fn catalog_list_set_committed_bytes(path: &Path, bytes: Option<u64>) {
    let control = path.with_extension("hctl").join("source.json");
    let mut state: Value = serde_json::from_slice(&std::fs::read(&control).unwrap()).unwrap();
    state["commit"]["committed_bytes"] = json!(bytes);
    std::fs::write(control, serde_json::to_vec(&state).unwrap()).unwrap();
}

fn catalog_list_seed(engine: &QueryEngine, history: &Path) -> PathBuf {
    let path = history.join(format!("{}.jsonl", engine.session_id()));
    engine.state.with_history_path(&path);
    engine
        .state
        .add_message(kcoder_types::Message::user_text("body title"));
    engine.state.save_history().unwrap();
    assert_eq!(
        experimental_catalog_list_snapshots(engine, &HashSet::new())
            .unwrap()
            .len(),
        1
    );
    path
}

#[test]
fn catalog_list_fresh_client_metadata_changes_and_corruption_override_cache() {
    let workspace = tempfile::tempdir().unwrap();
    let history = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    catalog_list_seed(&engine, history.path());
    let directory = engine.session_storage_dir_for(&engine.session_id());
    std::fs::create_dir_all(&directory).unwrap();
    let mut metadata = ThreadClientMetadata {
        version: 1,
        revision: 7,
        thread_id: engine.session_id(),
        workspace: canonical_workspace(&engine).unwrap(),
        updated_at: "9000000000000".into(),
        fields: BTreeMap::new(),
    };
    for title in [Some("renamed"), Some("same revision external edit"), None] {
        metadata
            .fields
            .insert("title".into(), title.map(ToOwned::to_owned));
        metadata
            .fields
            .insert("model".into(), title.map(ToOwned::to_owned));
        metadata.fields.insert(
            "archivedAt".into(),
            title.map(|_| "8000000000000".to_owned()),
        );
        let parent =
            title.map(|_| json!({"taskId":"task", "threadId":"parent", "lastTurnId":"turn"}));
        metadata
            .fields
            .insert("parent".into(), parent.as_ref().map(Value::to_string));
        write_test_thread_metadata(&directory, &metadata).unwrap();
        let (rows, misses) = observe_history_operation("history.list_projection", || {
            experimental_catalog_list_snapshots(&engine, &HashSet::new()).unwrap()
        });
        assert_eq!(rows[0]["metadata"]["title"], json!(title));
        assert_eq!(rows[0]["metadata"]["model"], json!(title));
        assert_eq!(rows[0]["metadata"]["revision"], 7);
        assert_eq!(rows[0].get("archivedAt").is_some(), title.is_some());
        assert_eq!(rows[0].get("title").is_some(), title.is_some());
        assert_eq!(rows[0]["metadata"]["parent"], json!(parent));
        assert_eq!(misses, 1, "same revision must not conceal field changes");
        let (hot, scans) = observe_history_operation("history.list_projection", || {
            experimental_catalog_list_snapshots(&engine, &HashSet::new()).unwrap()
        });
        assert_eq!(hot, rows);
        assert_eq!(scans, 0);
    }
    metadata.fields.clear();
    write_test_thread_metadata(&directory, &metadata).unwrap();
    let rows = experimental_catalog_list_snapshots(&engine, &HashSet::new()).unwrap();
    assert_eq!(
        rows[0]["title"], "body title",
        "absent override differs from explicit null"
    );
    std::fs::write(directory.join(THREAD_METADATA_FILE), b"{broken").unwrap();
    let report =
        experimental_catalog_list_report(&engine, &HashSet::new(), &HashSet::new()).unwrap();
    assert!(report.threads.is_empty());
    assert_eq!(report.issue_count, 1);
}

#[test]
fn catalog_list_fresh_prepared_inputs_invalidate_cached_fields() {
    let workspace = tempfile::tempdir().unwrap();
    let history = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    catalog_list_seed(&engine, history.path());
    let state_path = engine.state.session_state_path().unwrap();
    let mut state: Value = serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
    state["created_at_ms"] = json!(2);
    state["updated_at_ms"] = json!(9000000000000_u64);
    state["session_mode"] = json!("orchestrate");
    std::fs::write(&state_path, serde_json::to_vec(&state).unwrap()).unwrap();
    let (rows, count) = observe_history_operation("history.list_projection", || {
        experimental_catalog_list_snapshots(&engine, &HashSet::new()).unwrap()
    });
    assert_eq!(rows[0]["createdAt"], "2");
    assert_eq!(rows[0]["updatedAt"], "9000000000000");
    assert_eq!(rows[0]["sessionMode"], "orchestrate");
    assert_eq!(count, 1);
}

#[test]
fn catalog_list_missing_empty_and_excluded_sources_never_return_cached_rows() {
    for kind in ["deleted", "empty", "excluded"] {
        let workspace = tempfile::tempdir().unwrap();
        let history = tempfile::tempdir().unwrap();
        let engine = catalog_list_test_engine(workspace.path());
        let path = catalog_list_seed(&engine, history.path());
        let mut excluded = HashSet::new();
        match kind {
            "deleted" => std::fs::remove_file(&path).unwrap(),
            "empty" => std::fs::write(&path, b"").unwrap(),
            _ => {
                excluded.insert(engine.session_id());
            }
        }
        let report = experimental_catalog_list_report(&engine, &HashSet::new(), &excluded).unwrap();
        assert!(report.threads.is_empty(), "{kind}");
        assert_eq!(report.issue_count, 0, "{kind}");
        let catalog = kcoder_state::history_index::HistoryCatalog::open(
            &engine.client_storage_root(),
            &canonical_workspace(&engine).unwrap(),
            false,
        )
        .unwrap()
        .unwrap();
        assert!(
            catalog.has_entry(&engine.session_id()).unwrap(),
            "scan must not infer deletion"
        );
    }
}

#[test]
fn catalog_list_unknown_or_mismatched_commit_boundary_uses_authoritative_reads() {
    for bytes in [None, Some(0)] {
        let workspace = tempfile::tempdir().unwrap();
        let history = tempfile::tempdir().unwrap();
        let engine = catalog_list_test_engine(workspace.path());
        let path = catalog_list_seed(&engine, history.path());
        catalog_list_set_committed_bytes(&path, bytes);
        let control_path = path.with_extension("hctl").join("source.json");
        let before = std::fs::read(&control_path).unwrap();
        for _ in 0..2 {
            let (rows, scans) = observe_history_operation("history.timestamp_replay", || {
                experimental_catalog_list_snapshots(&engine, &HashSet::new()).unwrap()
            });
            assert_eq!(rows[0]["title"], "body title");
            assert_eq!(scans, 1, "unknown or mismatched boundary cannot hit");
        }
        assert_eq!(std::fs::read(control_path).unwrap(), before);
    }
}

#[test]
fn catalog_list_legacy_cold_read_never_attempts_projection_or_upgrades_control() {
    let workspace = tempfile::tempdir().unwrap();
    let history = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let path = history
        .path()
        .join(format!("{}.jsonl", engine.session_id()));
    engine.state.with_history_path(&path);
    engine
        .state
        .add_message(kcoder_types::Message::user_text("legacy title"));
    engine.state.save_history().unwrap();
    let control_path = path.with_extension("hctl").join("source.json");
    let mut control: Value =
        serde_json::from_slice(&std::fs::read(&control_path).unwrap()).unwrap();
    control["schema_version"] = json!(1);
    control.as_object_mut().unwrap().remove("commit");
    let before = serde_json::to_vec(&control).unwrap();
    std::fs::write(&control_path, &before).unwrap();
    for _ in 0..2 {
        let (rows, attempts) = observe_history_operation("history.list_projection", || {
            experimental_catalog_list_snapshots(&engine, &HashSet::new()).unwrap()
        });
        assert_eq!(rows[0]["title"], "legacy title");
        assert_eq!(
            attempts, 0,
            "unknown commits should reject before reading the body twice"
        );
    }
    assert_eq!(std::fs::read(control_path).unwrap(), before);
}

#[test]
fn catalog_list_bad_database_and_busy_setup_fall_back_without_partial() {
    use fs2::FileExt;
    for corrupt in [true, false] {
        let workspace = tempfile::tempdir().unwrap();
        let history = tempfile::tempdir().unwrap();
        let engine = catalog_list_test_engine(workspace.path());
        catalog_list_seed(&engine, history.path());
        let root = engine.client_storage_root().join("history-index");
        let lock = std::fs::File::options()
            .read(true)
            .write(true)
            .open(root.join("setup.lock"))
            .unwrap();
        if corrupt {
            std::fs::write(root.join("catalog.sqlite3"), b"not a database").unwrap();
        } else {
            lock.lock_exclusive().unwrap();
        }
        let report =
            experimental_catalog_list_report(&engine, &HashSet::new(), &HashSet::new()).unwrap();
        assert_eq!(report.threads.len(), 1);
        assert_eq!(report.threads[0]["title"], "body title");
        assert_eq!(report.issue_count, 0);
    }
}

#[test]
fn catalog_list_missing_client_root_is_not_created() {
    let workspace = tempfile::tempdir().unwrap();
    let history = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let root = engine.client_storage_root();
    std::fs::remove_dir(&root).unwrap();
    let path = history
        .path()
        .join(format!("{}.jsonl", engine.session_id()));
    engine.state.with_history_path(&path);
    engine
        .state
        .add_message(kcoder_types::Message::user_text("without catalog"));
    engine.state.save_history().unwrap();
    let report =
        experimental_catalog_list_report(&engine, &HashSet::new(), &HashSet::new()).unwrap();
    assert_eq!(report.threads.len(), 1);
    assert_eq!(report.issue_count, 0);
    assert!(!root.exists());
}

#[test]
fn catalog_list_foreign_workspace_is_rejected_before_any_body_observation() {
    let workspace = tempfile::tempdir().unwrap();
    let foreign = tempfile::tempdir().unwrap();
    let history = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let path = catalog_list_seed(&engine, history.path());
    let state_path = engine.state.session_state_path().unwrap();
    let mut state: Value = serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
    state["base_cwd"] = json!(foreign.path());
    std::fs::write(state_path, serde_json::to_vec(&state).unwrap()).unwrap();
    std::fs::write(&path, b"\xff").unwrap();
    let (report, reads) = observe_history_operation("history.list_projection", || {
        experimental_catalog_list_report(&engine, &HashSet::new(), &HashSet::new()).unwrap()
    });
    assert!(report.threads.is_empty());
    assert_eq!(report.issue_count, 0);
    assert_eq!(reads, 0);
}

#[test]
fn catalog_list_build_budget_includes_rows_too_large_to_publish() {
    let workspace = tempfile::tempdir().unwrap();
    let history = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    engine.state.with_history_path(
        history
            .path()
            .join(format!("{}.jsonl", engine.session_id())),
    );
    for index in 0..130 {
        let id = format!("budget-{index:03}");
        let state = kcoder_state::AppState::new(workspace.path());
        state.with_history_path(history.path().join(format!("{id}.jsonl")));
        state.add_message(kcoder_types::Message::user_text("small body"));
        state.save_history().unwrap();
        let directory = engine.session_storage_dir_for(&id);
        std::fs::create_dir_all(&directory).unwrap();
        write_test_thread_metadata(
            &directory,
            &ThreadClientMetadata {
                version: 1,
                revision: 1,
                thread_id: id,
                workspace: canonical_workspace(&engine).unwrap(),
                updated_at: "1".into(),
                fields: BTreeMap::from([("title".into(), Some("x".repeat(40_000)))]),
            },
        )
        .unwrap();
    }
    let (report, projections) = observe_history_operation("history.list_projection", || {
        experimental_catalog_list_report(&engine, &HashSet::new(), &HashSet::new()).unwrap()
    });
    assert_eq!(report.threads.len(), 130);
    assert_eq!(report.issue_count, 0);
    assert_eq!(
        projections, 128,
        "oversized derived rows still consume build attempts"
    );
}

#[test]
fn catalog_list_invalid_cached_payloads_fall_back_without_partial() {
    for kind in ["version", "identity", "type", "extra_field"] {
        let workspace = tempfile::tempdir().unwrap();
        let history = tempfile::tempdir().unwrap();
        let engine = catalog_list_test_engine(workspace.path());
        catalog_list_seed(&engine, history.path());
        let mut catalog = kcoder_state::history_index::HistoryCatalog::open(
            &engine.client_storage_root(),
            &canonical_workspace(&engine).unwrap(),
            true,
        )
        .unwrap()
        .unwrap();
        let mut snapshot = catalog.snapshot(None, 10).unwrap();
        let entry = &mut snapshot.sessions[0];
        match kind {
            "version" => entry.metadata["version"] = json!(99),
            "identity" => entry.metadata["snapshot"]["id"] = json!("other"),
            "type" => entry.metadata["snapshot"]["title"] = json!(false),
            _ => entry.metadata["snapshot"]["unexpected"] = json!("unvalidated"),
        }
        catalog
            .publish(&snapshot.revision, &snapshot.sessions, &[])
            .unwrap();
        drop(catalog);
        let (report, fallback) = observe_history_operation("history.timestamp_replay", || {
            experimental_catalog_list_report(&engine, &HashSet::new(), &HashSet::new()).unwrap()
        });
        assert_eq!(report.issue_count, 0, "{kind}");
        assert_eq!(report.threads.len(), 1, "{kind}");
        assert_eq!(report.threads[0]["title"], "body title", "{kind}");
        assert!(report.threads[0].get("unexpected").is_none(), "{kind}");
        assert_eq!(fallback, 1, "{kind}");
    }
}

#[test]
fn catalog_list_pending_control_falls_back_without_repairing_source() {
    let workspace = tempfile::tempdir().unwrap();
    let history = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let path = catalog_list_seed(&engine, history.path());
    let control_path = path.with_extension("hctl").join("source.json");
    let mut control: Value =
        serde_json::from_slice(&std::fs::read(&control_path).unwrap()).unwrap();
    let length = std::fs::metadata(&path).unwrap().len();
    control["commit"]["pending"] = json!({
        "next_revision": control["commit"]["revision"].as_u64().unwrap() + 1,
        "operation": {"kind":"append", "start": length, "end": length + 1, "sha256": "0".repeat(64)},
    });
    let before = serde_json::to_vec(&control).unwrap();
    std::fs::write(&control_path, &before).unwrap();
    let (report, fallback) = observe_history_operation("history.timestamp_replay", || {
        experimental_catalog_list_report(&engine, &HashSet::new(), &HashSet::new()).unwrap()
    });
    assert_eq!(report.issue_count, 0);
    assert_eq!(report.threads[0]["title"], "body title");
    assert_eq!(fallback, 1);
    assert_eq!(std::fs::read(control_path).unwrap(), before);
}

#[test]
fn catalog_list_stale_publication_preserves_authoritative_result() {
    use kcoder_state::history_index::{HistoryCatalog, IndexedSession};
    let workspace = tempfile::tempdir().unwrap();
    let history = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let id = engine.session_id();
    let path = history.path().join(format!("{id}.jsonl"));
    engine.state.with_history_path(&path);
    engine
        .state
        .add_message(kcoder_types::Message::user_text("authoritative result"));
    engine.state.save_history().unwrap();
    let prepared = kcoder_state::prepare_session_metadata(&path).unwrap();
    let mut list = history_catalog::ListCatalog::open(&engine);
    let result = list
        .snapshot(&engine, &id, &path, &prepared, false)
        .unwrap();
    let mut competing = HistoryCatalog::open(
        &engine.client_storage_root(),
        &canonical_workspace(&engine).unwrap(),
        true,
    )
    .unwrap()
    .unwrap();
    competing
        .publish(
            &competing.revision().unwrap(),
            &[IndexedSession {
                session_id: "not-an-enumerated-source".into(),
                updated_at_ms: 1,
                archived: false,
                metadata: json!({}),
                source_proof: vec![1],
                metadata_proof: vec![1],
            }],
            &[],
        )
        .unwrap();
    list.publish();
    assert_eq!(result["title"], "authoritative result");
    assert!(
        !competing.has_entry(&id).unwrap(),
        "stale batch must be discarded"
    );
    drop(competing);
    let report =
        experimental_catalog_list_report(&engine, &HashSet::new(), &HashSet::new()).unwrap();
    assert_eq!(report.threads, vec![result]);
    assert_eq!(report.issue_count, 0);
}

fn runtime_context_test_engine(cwd: &Path, persistence_path: Option<PathBuf>) -> QueryEngine {
    let settings = kcoder_config::Settings::default();
    let engine = QueryEngine::new_with_folder_trust(
        Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
            crate::tui_dev_mock::TuiDevScenario::FullTurn,
        )),
        kcoder_state::AppState::new(cwd),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        cwd.to_path_buf(),
        Some(true),
    );
    match persistence_path {
        Some(path) => engine.with_settings_persistence_path(path),
        None => engine,
    }
}

#[test]
fn partial_thread_list_reports_unknown_ownership_without_reading_foreign_body() {
    let workspace = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    let path = workspace
        .path()
        .join(format!("{}.jsonl", engine.session_id()));
    engine.state.with_history_path(&path);
    engine
        .state
        .add_message(kcoder_types::Message::user_text("healthy"));
    engine.state.save_history().unwrap();
    let foreign = kcoder_state::AppState::new(other.path());
    let foreign_path = workspace.path().join("foreign.jsonl");
    foreign.with_history_path(&foreign_path);
    foreign.add_message(kcoder_types::Message::user_text("foreign"));
    foreign.save_history().unwrap();
    std::fs::write(&foreign_path, b"\xff").unwrap();
    std::fs::write(workspace.path().join("unknown.jsonl"), b"{}\n").unwrap();
    let (report, scans) = observe_history_operation("history.timestamp_replay", || {
        persisted_thread_snapshot_report(&engine, &HashSet::new(), &HashSet::new()).unwrap()
    });
    assert_eq!(report.threads.len(), 1);
    assert_eq!(report.threads[0]["title"], "healthy");
    assert_eq!(report.issue_count, 1);
    assert_eq!(scans, 1);
    assert_eq!(
        server_capabilities(true)
            .experimental
            .get("threadListCompleteness"),
        Some(&true)
    );
}

#[test]
fn partial_thread_list_counts_sidecar_and_body_errors() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    let path = workspace
        .path()
        .join(format!("{}.jsonl", engine.session_id()));
    engine.state.with_history_path(&path);
    engine
        .state
        .add_message(kcoder_types::Message::user_text("fixture"));
    engine.state.save_history().unwrap();
    std::fs::write(&path, b"\xff").unwrap();
    let report =
        persisted_thread_snapshot_report(&engine, &HashSet::new(), &HashSet::new()).unwrap();
    assert!(report.threads.is_empty());
    assert_eq!(report.issue_count, 1);
    std::fs::write(engine.state.session_state_path().unwrap(), b"{broken").unwrap();
    let report =
        persisted_thread_snapshot_report(&engine, &HashSet::new(), &HashSet::new()).unwrap();
    assert!(report.threads.is_empty());
    assert_eq!(report.issue_count, 1);
}

#[test]
fn persisted_list_does_not_replay_model_history_for_discarded_count() {
    use tracing_subscriber::prelude::*;
    struct ReplayCounter(Arc<AtomicU64>);
    impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for ReplayCounter {
        fn on_new_span(
            &self,
            attributes: &tracing::span::Attributes<'_>,
            _: &tracing::Id,
            _: tracing_subscriber::layer::Context<'_, S>,
        ) {
            if attributes.metadata().name() == "history.model_replay" {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
    }
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    let path = workspace
        .path()
        .join(format!("{}.jsonl", engine.session_id()));
    engine.state.with_history_path(&path);
    engine
        .state
        .add_message(kcoder_types::Message::user_text("catalog fixture"));
    engine
        .state
        .add_message(kcoder_types::Message::assistant_text(
            "long content".repeat(10000),
        ));
    engine.state.save_history().unwrap();
    let count = Arc::new(AtomicU64::new(0));
    let subscriber = tracing_subscriber::registry().with(ReplayCounter(Arc::clone(&count)));
    let listed = tracing::subscriber::with_default(subscriber, || {
        persisted_thread_snapshots(&engine, &HashSet::new()).unwrap()
    });
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["title"], "catalog fixture");
    assert_eq!(
        count.load(Ordering::SeqCst),
        0,
        "typed list has no messageCount field"
    );
}

#[test]
fn persisted_list_skips_empty_files_without_discarding_uncompacted_transcript() {
    use std::io::Write;
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    let path = workspace
        .path()
        .join(format!("{}.jsonl", engine.session_id()));
    engine.state.with_history_path(&path);
    std::fs::write(&path, b"").unwrap();
    assert!(
        persisted_thread_snapshots(&engine, &HashSet::new())
            .unwrap()
            .is_empty()
    );
    engine.state.add_message(kcoder_types::Message::user_text(
        "retained visible transcript",
    ));
    engine.state.save_history().unwrap();
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    writeln!(
        file,
        "{}",
        json!({"type":"system", "subtype":"compact_boundary"})
    )
    .unwrap();
    assert!(kcoder_state::load_history(&path).unwrap().is_empty());
    let listed = persisted_thread_snapshots(&engine, &HashSet::new()).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["title"], "retained visible transcript");
}

#[test]
fn cold_count_preparation_does_not_reload_visible_history() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        for preserve_tail in [false, true] {
            let workspace = tempfile::tempdir().unwrap();
            let state = kcoder_state::AppState::new(workspace.path());
            let path = workspace.path().join("session.jsonl");
            state.with_history_path(&path);
            state.add_message(kcoder_types::Message::user_text("first request"));
            let tail = kcoder_types::Message::user_text("second request");
            state.add_message(tail.clone());
            let mut compacted = vec![kcoder_types::Message::user_text(
                "Earlier conversation summary: compacted",
            )];
            if preserve_tail {
                compacted.push(tail);
            }
            state
                .set_messages_after_compaction(
                    compacted,
                    kcoder_state::CompactionTranscriptEvent {
                        trigger: kcoder_state::CompactionTrigger::Manual,
                        pre_tokens: 100,
                        post_tokens: 10,
                        summary: "compacted".into(),
                    },
                )
                .await
                .unwrap();
            state.add_message(kcoder_types::Message::user_text(
                "[scheduled task test] inspect",
            ));
            state.add_message(kcoder_types::Message::user_text(
                "[system] Continue working toward the active goal",
            ));
            let cut = state.messages().len();
            state.add_message(kcoder_types::Message::user_text("discarded"));
            state.truncate_messages_for_rewind(cut, 1).await.unwrap();
            let before = std::fs::read(&path).unwrap();
            let ((prepared, count), reloads) =
                observe_history_operation("history.transcript_replay", || {
                    kcoder_state::prepare_session_resume_counting(
                        &path,
                        kcoder_engine::agent::is_real_user_message,
                    )
                    .unwrap()
                });
            assert_eq!(count, 3);
            assert_eq!(prepared.transcript_len(), 4);
            assert_eq!(std::fs::read(&path).unwrap(), before);
            assert_eq!(reloads, 0);
        }
    });
}

#[test]
fn cold_count_summary_rewind_and_zero_rewind_keep_matching_prefixes() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let workspace = tempfile::tempdir().unwrap();
        let path = workspace.path().join("session.jsonl");
        let state = kcoder_state::AppState::new(workspace.path());
        state.with_history_path(&path);
        state.add_message(kcoder_types::Message::user_text("first"));
        let tail = kcoder_types::Message::user_text("tail");
        state.add_message(tail.clone());
        state
            .set_messages_after_compaction(
                vec![
                    kcoder_types::Message::user_text("Earlier conversation summary: compacted"),
                    tail,
                ],
                kcoder_state::CompactionTranscriptEvent {
                    trigger: kcoder_state::CompactionTrigger::Manual,
                    pre_tokens: 100,
                    post_tokens: 10,
                    summary: "compacted".into(),
                },
            )
            .await
            .unwrap();
        state.truncate_messages_for_rewind(1, 1).await.unwrap();
        let (_, count) = kcoder_state::prepare_session_resume_counting(
            &path,
            kcoder_engine::agent::is_real_user_message,
        )
        .unwrap();
        assert_eq!(count, 1);
        state.truncate_messages_for_rewind(0, 1).await.unwrap();
        let (_, count) = kcoder_state::prepare_session_resume_counting(
            &path,
            kcoder_engine::agent::is_real_user_message,
        )
        .unwrap();
        assert_eq!(count, 0);
        state.add_message(kcoder_types::Message::user_text("replacement"));
        state.flush_history().await.unwrap();
        let (_, count) = kcoder_state::prepare_session_resume_counting(
            &path,
            kcoder_engine::agent::is_real_user_message,
        )
        .unwrap();
        assert_eq!(count, 1);
    });
}

#[test]
fn metadata_reads_list_loads_session_sidecar_once() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    let path = workspace
        .path()
        .join(format!("{}.jsonl", engine.session_id()));
    engine.state.with_history_path(&path);
    engine
        .state
        .add_message(kcoder_types::Message::user_text("metadata fixture"));
    engine.state.save_history().unwrap();
    let (listed, count) = observe_history_operation("history.session_state_read", || {
        persisted_thread_snapshots(&engine, &HashSet::new()).unwrap()
    });
    assert_eq!(listed.len(), 1);
    assert_eq!(count, 1);
}

#[test]
fn metadata_reads_reject_cross_workspace_before_scanning_body() {
    let workspace = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    let path = workspace
        .path()
        .join(format!("{}.jsonl", engine.session_id()));
    engine.state.with_history_path(&path);
    let state_path = engine.state.session_state_path().unwrap();
    let mut state: Value = serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
    state["base_cwd"] = json!(other.path());
    std::fs::write(state_path, serde_json::to_vec(&state).unwrap()).unwrap();
    std::fs::write(&path, b"\xff").unwrap();
    let (listed, scans) = observe_history_operation("history.timestamp_replay", || {
        persisted_thread_snapshots(&engine, &HashSet::new()).unwrap()
    });
    assert!(listed.is_empty());
    assert_eq!(scans, 0);
}

#[test]
fn metadata_reads_cold_resume_does_not_repeat_timestamp_scan() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    let path = workspace
        .path()
        .join(format!("{}.jsonl", engine.session_id()));
    engine.state.with_history_path(&path);
    engine
        .state
        .add_message(kcoder_types::Message::user_text("timestamp fixture"));
    engine.state.save_history().unwrap();
    let expected = kcoder_state::session_timestamps_ms(&path).unwrap();
    let resumed = kcoder_state::AppState::new(workspace.path());
    let (_, count) = observe_history_operation("history.timestamp_replay", || {
        resumed.resume_from_history(&path).unwrap()
    });
    assert_eq!(resumed.session_timestamps_ms(), expected);
    assert_eq!(count, 0);
}

fn observe_history_operation<T>(name: &'static str, work: impl FnOnce() -> T) -> (T, u64) {
    use tracing_subscriber::prelude::*;
    struct Counter(&'static str, Arc<AtomicU64>);
    impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Counter {
        fn on_new_span(
            &self,
            attributes: &tracing::span::Attributes<'_>,
            _: &tracing::Id,
            _: tracing_subscriber::layer::Context<'_, S>,
        ) {
            if attributes.metadata().name() == self.0 {
                self.1.fetch_add(1, Ordering::SeqCst);
            }
        }
    }
    let count = Arc::new(AtomicU64::new(0));
    let subscriber = tracing_subscriber::registry().with(Counter(name, Arc::clone(&count)));
    let value = tracing::subscriber::with_default(subscriber, work);
    (value, count.load(Ordering::SeqCst))
}

#[test]
fn thread_snapshot_timestamps_change_only_with_session_content() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    let initial = thread_snapshot(&engine, false);
    std::thread::sleep(Duration::from_millis(10));
    let running = thread_snapshot(&engine, true);
    assert_eq!(running["createdAt"], initial["createdAt"]);
    assert_eq!(running["updatedAt"], initial["updatedAt"]);
    engine
        .state
        .add_message(kcoder_types::Message::user_text("timestamp regression"));
    let changed = thread_snapshot(&engine, false);
    assert_eq!(changed["createdAt"], initial["createdAt"]);
    assert!(changed["updatedAt"].as_str().unwrap() > initial["updatedAt"].as_str().unwrap());
    std::thread::sleep(Duration::from_millis(10));
    assert_eq!(
        thread_snapshot(&engine, false)["updatedAt"],
        changed["updatedAt"]
    );
}

#[test]
fn scheduled_task_rpc_requires_consent_and_preserves_session_ownership() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    let thread_id = engine.session_id();
    let request = json!({"threadId": thread_id, "prompt": "review", "schedule": {"kind":"every", "every_seconds":60}, "confirmed":false});
    assert!(super::cron_processor::process(&engine, "cron/create", request.clone()).is_err());
    let mut confirmed = request;
    confirmed["confirmed"] = json!(true);
    let created = super::cron_processor::process(&engine, "cron/create", confirmed).unwrap();
    let listed =
        super::cron_processor::process(&engine, "cron/list", json!({"threadId":thread_id}))
            .unwrap();
    assert_eq!(listed["jobs"].as_array().unwrap().len(), 1);
    assert!(
        super::cron_processor::process(
            &engine,
            "cron/delete",
            json!({"threadId":"another", "jobId":created["job"]["id"]})
        )
        .is_err()
    );
    let deleted = super::cron_processor::process(
        &engine,
        "cron/delete",
        json!({"threadId":thread_id, "jobId":created["job"]["id"]}),
    )
    .unwrap();
    assert_eq!(deleted["deleted"], true);
    engine.settings.write().unwrap().training_mode = true;
    assert!(
        super::cron_processor::process(&engine, "cron/list", json!({"threadId":thread_id}))
            .is_err()
    );
}

#[test]
fn per_turn_permissions_restore_modes_and_do_not_affect_another_thread() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    let other = runtime_context_test_engine(workspace.path(), None);
    let original = engine.settings.read().unwrap().permission_mode;
    let guard = super::turn_permissions::TurnPermissions::new(
        engine.clone(),
        Some(kcoder_config::PermissionMode::Yolo),
    );
    assert_eq!(
        engine.settings.read().unwrap().permission_mode,
        kcoder_config::PermissionMode::Yolo
    );
    assert_eq!(
        engine.permissions.read().unwrap().mode,
        kcoder_config::PermissionMode::Yolo
    );
    assert_eq!(other.settings.read().unwrap().permission_mode, original);
    drop(guard);
    assert_eq!(engine.settings.read().unwrap().permission_mode, original);
    assert_eq!(engine.permissions.read().unwrap().mode, original);
    assert!(!workspace.path().join("settings.json").exists());
}

#[test]
fn app_server_goal_pro_creation_selection_freezes_the_rejection_limit() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    engine
        .settings
        .write()
        .unwrap()
        .goal_pro
        .completion_rejection_limit = 5;

    let frozen = goal_pro_verifier_selection(&engine);
    engine
        .settings
        .write()
        .unwrap()
        .goal_pro
        .completion_rejection_limit = 3;

    assert_eq!(frozen.completion_rejection_limit, Some(5));
    assert_eq!(
        goal_pro_verifier_selection(&engine).completion_rejection_limit,
        Some(3)
    );
}

#[test]
fn runtime_context_rejects_disabled_persistence_without_discovering_home() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);

    for (method, params) in [
        ("runtime.context.get", json!({})),
        (
            "runtime.context.update",
            json!({"instructions": "do not persist"}),
        ),
    ] {
        let error = runtime_context_request(&engine, method, &params).unwrap_err();
        assert!(error.to_string().contains("no explicit user settings path"));
    }
    assert!(!workspace.path().join("settings.json").exists());
    assert!(
        !workspace
            .path()
            .join(".config/kcoder/settings.json")
            .exists()
    );
    assert!(!workspace.path().join("test-config/settings.json").exists());
}

#[test]
fn runtime_context_uses_only_explicit_user_path_and_preserves_other_settings() {
    let workspace = tempfile::tempdir().unwrap();
    let user = tempfile::tempdir().unwrap();
    let settings_path = user.path().join("custom-settings.json");
    std::fs::write(
        &settings_path,
        r#"{
  "goal_pro": { "verifier_max_turns": 16 }
}"#,
    )
    .unwrap();
    let engine = runtime_context_test_engine(workspace.path(), Some(settings_path.clone()));

    let updated = runtime_context_request(
        &engine,
        "runtime.context.update",
        &json!({"instructions": "be precise", "personality": "friendly"}),
    )
    .unwrap();
    assert_eq!(updated["configPath"], settings_path.display().to_string());
    assert_eq!(updated["instructions"], "be precise");
    assert_eq!(updated["personality"], "friendly");

    let fetched = runtime_context_request(&engine, "runtime.context.get", &json!({})).unwrap();
    assert_eq!(fetched, updated);
    let document: Value =
        serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
    assert_eq!(document["goal_pro"]["verifier_max_turns"], 16);
    assert_eq!(document["studio_context"]["instructions"], "be precise");
    assert_eq!(document["studio_context"]["personality"], "friendly");
    assert!(document.get("model").is_none());
}

#[test]
fn thread_lifecycle_lock_survives_child_deletion_and_orders_multiple_ids() {
    let root = tempfile::tempdir().unwrap();
    let child = root.path().join("thread-a");
    std::fs::create_dir(&child).unwrap();
    let first =
        acquire_thread_lifecycle_locks_at_root(root.path(), &["thread-b", "thread-a"]).unwrap();
    let root_path = root.path().to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    let contender = std::thread::spawn(move || {
        let locks =
            acquire_thread_lifecycle_locks_at_root(&root_path, &["thread-a", "thread-b"]).unwrap();
        tx.send(()).unwrap();
        locks
    });
    std::fs::remove_dir(&child).unwrap();
    std::fs::create_dir(&child).unwrap();
    assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
    drop(first);
    rx.recv_timeout(Duration::from_secs(1)).unwrap();
    drop(contender.join().unwrap());
}

#[test]
fn external_artifact_ids_are_portable_across_all_path_helpers() {
    let root = tempfile::tempdir().unwrap();
    let reserved = ["CON", "con", "NUL", "COM1"];
    for id in reserved {
        assert!(validate_thread_id(id).is_err(), "thread accepted {id}");
        assert!(validate_worktree_id(id).is_err(), "worktree accepted {id}");
        assert!(validated_thread_storage_dir(root.path(), id).is_err());
        assert!(candidate_thread_metadata_path(root.path(), id).is_err());
        assert!(candidate_thread_history_path(root.path(), id).is_err());
        assert!(managed_worktree_target_path(root.path(), id, "repository").is_err());
        assert!(acquire_thread_lifecycle_locks_at_root(root.path(), &[id]).is_err());
    }

    for id in ["CONSOLE", "COM10", "thread-1", "worktree_1"] {
        assert!(validate_thread_id(id).is_ok(), "thread rejected {id}");
        assert!(validate_worktree_id(id).is_ok(), "worktree rejected {id}");
    }
    assert!(is_windows_reserved_basename("con.txt"));
    assert!(is_windows_reserved_basename("LPT9.log"));
    assert!(!is_windows_reserved_basename("COM10.txt"));

    let thread_id = "CONSOLE";
    assert_eq!(
        candidate_thread_metadata_path(root.path(), thread_id).unwrap(),
        root.path().join(thread_id).join(THREAD_METADATA_FILE)
    );
    assert_eq!(
        candidate_thread_history_path(root.path(), thread_id).unwrap(),
        root.path().join("CONSOLE.jsonl")
    );
    assert_eq!(
        managed_worktree_target_path(root.path(), "COM10", "repository").unwrap(),
        root.path().join("COM10").join("repository")
    );
    drop(
        acquire_thread_lifecycle_locks_at_root(root.path(), &[thread_id])
            .expect("portable neighbor must retain its literal lock path"),
    );
    assert!(
        root.path()
            .join(THREAD_LIFECYCLE_LOCK_DIRECTORY)
            .join("CONSOLE.lock")
            .is_file()
    );

    let encoded_namespace = "~unsafe-id-deadbeef";
    assert!(validate_thread_id(encoded_namespace).is_err());
    assert!(validate_worktree_id(encoded_namespace).is_err());
    assert_ne!(
        candidate_thread_history_path(root.path(), "unsafe-id-deadbeef").unwrap(),
        root.path().join(format!("{encoded_namespace}.jsonl"))
    );
}
#[test]
fn session_lease_is_exclusive_and_released_with_its_guard() {
    let root = tempfile::tempdir().unwrap();
    let history = root.path().join("session.jsonl");
    std::fs::write(&history, "").unwrap();
    let lease = SessionLease::acquire(&history).unwrap();
    let error = SessionLease::acquire(&history).unwrap_err();
    assert!(error.to_string().contains("already active"));
    drop(lease);
    SessionLease::acquire(&history).unwrap();

    let missing = root.path().join("missing.jsonl");
    assert!(SessionLease::acquire_existing_history(&missing).is_err());
    assert!(!missing.with_extension("lease").exists());

    #[cfg(unix)]
    {
        let symlink_history = root.path().join("symlinked.jsonl");
        let target = root.path().join("attacker-controlled");
        std::fs::write(&target, "").unwrap();
        std::os::unix::fs::symlink(&target, symlink_history.with_extension("lease")).unwrap();
        assert!(SessionLease::acquire(&symlink_history).is_err());
    }
}

#[test]
fn terminal_engine_events_preserve_failure_and_interrupt_status() {
    assert_eq!(
        terminal_outcome(&EngineEvent::Error("provider failed".into()), false),
        Some(("failed", "provider failed".into()))
    );
    assert_eq!(
        terminal_outcome(
            &EngineEvent::StreamAborted {
                reason: "hook blocked".into()
            },
            false
        ),
        Some(("failed", "hook blocked".into()))
    );
    assert_eq!(
        terminal_outcome(
            &EngineEvent::StreamAborted {
                reason: "cancelled".into()
            },
            true
        ),
        Some(("interrupted", "cancelled".into()))
    );
}

#[test]
fn provider_failure_roundtrips_completion_and_disk_history_with_old_artifact_compatibility() {
    let details = kcoder_types::ProviderFailureDetails {
        category: kcoder_types::ProviderFailureCategory::InvalidParameter,
        recovery_action: kcoder_types::ProviderFailureRecoveryAction::NeedsHuman,
        http_status: Some(400),
        retryable: false,
        resume_safe: false,
        retry_after_ms: None,
    };
    let event = EngineEvent::ProviderFailed {
        message: "not a network failure".into(),
        details: details.clone(),
    };
    assert_eq!(
        terminal_outcome(&event, false),
        Some(("failed", "not a network failure".into()))
    );
    let wire = engine_event_json(event);
    assert_eq!(
        wire["provider_failure"],
        serde_json::to_value(&details).unwrap()
    );
    let completion =
        turn_completion_error(Some("not a network failure".into()), Some(details.clone())).unwrap();
    assert_eq!(completion["code"], -32010);
    assert_eq!(completion["message"], "not a network failure");
    assert_eq!(completion["details"], wire["provider_failure"]);
    let workspace = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let thread_id = engine.session_id();
    save_turn_outcome(
        &engine,
        &thread_id,
        "turn",
        "failed",
        Some("not a network failure"),
        Some(&details),
    )
    .unwrap();
    let restored = load_turn_outcomes(&engine, &thread_id)
        .remove("turn")
        .unwrap();
    assert_eq!(restored.provider_failure, Some(details.clone()));
    let old = json!({"version":1,"thread_id":"thread","turn_id":"turn","status":"failed","error":"not a network failure","completed_at_ms":1});
    let mut artifact: TurnOutcomeArtifact = serde_json::from_value(old).unwrap();
    assert!(artifact.provider_failure.is_none());
    artifact.provider_failure = Some(details.clone());
    let serialized: TurnOutcomeArtifact =
        serde_json::from_slice(&serde_json::to_vec(&artifact).unwrap()).unwrap();
    assert_eq!(serialized.provider_failure, restored.provider_failure);
    let mut message: ThreadMessage = serde_json::from_value(
        json!({"id":"message","role":"assistant","content":"partial","timestampMs":1}),
    )
    .unwrap();
    apply_turn_outcome_to_message(&mut message, &restored);
    assert_eq!(message.error_type.as_deref(), Some("invalid_parameter"));
    assert_eq!(message.provider_failure, Some(details));
    assert_eq!(message.status.as_deref(), Some("failed"));
    let history = serde_json::to_value(message).unwrap();
    assert_eq!(history["providerFailure"], wire["provider_failure"]);
}

#[test]
fn interrupted_turn_outcome_marks_an_existing_assistant_message_cancelled() {
    let mut messages = vec![ThreadMessage {
        id: "assistant-1".into(),
        client_message_id: None,
        turn_id: Some("turn-1".into()),
        role: "assistant".into(),
        content: "partial answer".into(),
        status: None,
        error: None,
        error_type: None,
        provider_failure: None,
                attempt_id: None,
                continued_by_attempt_id: None,
        blocks: Vec::new(),
        timestamp_ms: 10,
        content_truncated: false,
        content_original_chars: None,
    }];
    let outcome = TurnOutcomeArtifact {
        version: 1,
        thread_id: "thread-1".into(),
        turn_id: "turn-1".into(),
        status: "interrupted".into(),
        error: Some("cancelled".into()),
        provider_failure: None,
        continuation_context_hash: None,
        completed_at_ms: 20,
    };

    apply_turn_outcomes(&mut messages, HashMap::from([("turn-1".into(), outcome)]));

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].status.as_deref(), Some("cancelled"));
    assert_eq!(messages[0].content, "partial answer");
}

#[test]
fn interrupted_empty_turn_outcome_inserts_a_cancelled_assistant_message() {
    let mut messages = vec![ThreadMessage {
        id: "user-1".into(),
        client_message_id: None,
        turn_id: Some("turn-1".into()),
        role: "user".into(),
        content: "prompt".into(),
        status: None,
        error: None,
        error_type: None,
        provider_failure: None,
                attempt_id: None,
                continued_by_attempt_id: None,
        blocks: Vec::new(),
        timestamp_ms: 10,
        content_truncated: false,
        content_original_chars: None,
    }];
    let outcome = TurnOutcomeArtifact {
        version: 1,
        thread_id: "thread-1".into(),
        turn_id: "turn-1".into(),
        status: "interrupted".into(),
        error: Some("cancelled".into()),
        provider_failure: None,
        continuation_context_hash: None,
        completed_at_ms: 20,
    };

    apply_turn_outcomes(&mut messages, HashMap::from([("turn-1".into(), outcome)]));

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1].role, "assistant");
    assert_eq!(messages[1].turn_id.as_deref(), Some("turn-1"));
    assert_eq!(messages[1].status.as_deref(), Some("cancelled"));
    assert!(messages[1].content.is_empty());
    assert_eq!(messages[1].timestamp_ms, 20);
}

#[test]
fn failed_empty_turn_outcome_inserts_a_retryable_assistant_message() {
    let mut messages = vec![ThreadMessage {
        id: "user-1".into(),
        client_message_id: None,
        turn_id: Some("turn-1".into()),
        role: "user".into(),
        content: "prompt".into(),
        status: None,
        error: None,
        error_type: None,
        provider_failure: None,
                attempt_id: None,
                continued_by_attempt_id: None,
        blocks: Vec::new(),
        timestamp_ms: 10,
        content_truncated: false,
        content_original_chars: None,
    }];
    let outcome = TurnOutcomeArtifact {
        version: 1,
        thread_id: "thread-1".into(),
        turn_id: "turn-1".into(),
        status: "failed".into(),
        error: Some("provider unavailable".into()),
        provider_failure: None,
        continuation_context_hash: None,
        completed_at_ms: 20,
    };

    apply_turn_outcomes(&mut messages, HashMap::from([("turn-1".into(), outcome)]));

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1].status.as_deref(), Some("failed"));
    assert_eq!(messages[1].error.as_deref(), Some("provider unavailable"));
    assert_eq!(messages[1].error_type.as_deref(), Some("response.failed"));
}

#[test]
fn durable_transcript_turns_drive_fork_identity_after_context_compaction() {
    fn entry(index: usize, message: kcoder_types::Message) -> kcoder_state::HistoryEntry {
        kcoder_state::HistoryEntry {
            session_id: "session".into(),
            timestamp_ms: index as u64,
            uuid: Some(format!("message-{index}")),
            parent_uuid: None,
            message,
        }
    }

    let entries = vec![
        entry(1, kcoder_types::Message::user_text("first")),
        entry(2, kcoder_types::Message::assistant_text("answer one")),
        entry(
            3,
            kcoder_types::Message::user_text(
                "[system] Continue working toward the active `/goal` objective.",
            ),
        ),
        entry(4, kcoder_types::Message::assistant_text("continued")),
        entry(5, kcoder_types::Message::user_text("second")),
        entry(6, kcoder_types::Message::assistant_text("answer two")),
    ];
    assert_eq!(client_transcript_turn_count(&entries), 2);
    let fork = turn_admissions::fork_transcript(&entries, &HashMap::new(), "turn-1").unwrap();
    assert_eq!(fork.len(), 4);
    assert_eq!(fork[0].preview(100), "first");
    assert_eq!(fork[3].preview(100), "continued");
    assert!(turn_admissions::fork_transcript(&entries, &HashMap::new(), "turn-3").is_err());
}

#[test]
fn strict_goal_continuation_is_hidden_from_projected_transcript() {
    let entry = kcoder_state::HistoryEntry {
        session_id: "session".into(),
        timestamp_ms: 1,
        uuid: Some("strict-goal-context".into()),
        parent_uuid: None,
        message: kcoder_types::Message::user_text(
            "[system] Continue working toward the active `/goal-pro` objective.\n\n\
                 This is a strict `/goal-pro` continuation.",
        ),
    };

    assert!(history_entry_thread_message(0, entry, None, &HashMap::new()).is_none());
}

#[test]
fn system_reminder_is_hidden_from_projected_transcript() {
    let entry = kcoder_state::HistoryEntry {
        session_id: "session".into(),
        timestamp_ms: 1,
        uuid: Some("rewind-reminder".into()),
        parent_uuid: None,
        message: kcoder_types::Message::user_text(
            "  <system-reminder>Rewind to checkpoint turn 2 completed: nothing to rewind.\
             </system-reminder>",
        ),
    };

    assert!(history_entry_thread_message(0, entry, None, &HashMap::new()).is_none());
}

#[test]
fn synthetic_skill_context_is_hidden_but_ordinary_skill_discussion_remains() {
    for (text, visible) in [
        (
            "<skill_content name=\"fixture\">\nINTERNAL_SKILL_BODY\n</skill_content>",
            false,
        ),
        (
            "  <skill_content name=\"fixture\">body</skill_content>\n",
            false,
        ),
        (
            "Explain <skill_content name=\"fixture\"> and its format",
            true,
        ),
        (
            "```xml\n<skill_content name=\"fixture\">body</skill_content>\n```",
            true,
        ),
        (
            "<skill_content name=\"fixture\">incomplete user example",
            true,
        ),
    ] {
        let entry = kcoder_state::HistoryEntry {
            session_id: "session".into(),
            timestamp_ms: 1,
            uuid: Some("skill-context".into()),
            parent_uuid: None,
            message: kcoder_types::Message::user_text(text),
        };
        assert_eq!(
            history_entry_thread_message(0, entry, None, &HashMap::new()).is_some(),
            visible,
            "{text}"
        );
    }
}

#[test]
fn runtime_injections_are_hidden_per_block_without_losing_user_or_tool_content() {
    use kcoder_types::{ContentBlock, Message};
    let project = |message| {
        history_entry_thread_message(
            0,
            kcoder_state::HistoryEntry {
                session_id: "session".into(),
                timestamp_ms: 1,
                uuid: Some("mixed".into()),
                parent_uuid: None,
                message,
            },
            None,
            &HashMap::new(),
        )
    };
    for text in [
        "[system] Trusted Orchestrate fleet delta {}",
        "[system] Orchestrate durable plan continuation. hidden",
        "[system][subagent_finish_reminder] finish",
        "[hook:SessionStart] hidden",
        "Orchestrate resume point after compaction:\nhidden",
        "Earlier conversation summary:\nhidden",
        "<task_notification id=\"x\" status=\"completed\"/>",
    ] {
        assert!(project(Message::user_text(text)).is_none(), "{text}");
        let mixed = project(Message::user_content(vec![
            ContentBlock::Text {
                text: "介绍你自己".into(),
            },
            ContentBlock::Text { text: text.into() },
        ]))
        .unwrap();
        assert_eq!(mixed.content, "介绍你自己");
        assert_eq!(
            project(Message::assistant_text(text)).unwrap().content,
            text
        );
    }
    let result = project(Message::user_content(vec![
        ContentBlock::Text {
            text: "[system] hidden".into(),
        },
        ContentBlock::ToolResult {
            tool_use_id: "orphan".into(),
            content: vec![ContentBlock::Text {
                text: "[system] actual tool output".into(),
            }],
            is_error: None,
        },
    ]))
    .unwrap();
    assert_eq!(result.role, "assistant");
    assert_eq!(result.blocks.len(), 1);
    assert!(result.blocks[0].to_string().contains("actual tool output"));
}

#[test]
fn historical_tool_results_are_projected_as_completed_typed_blocks() {
    use kcoder_types::{ContentBlock, Message};

    let entries = vec![
        kcoder_state::HistoryEntry {
            session_id: "session".into(),
            timestamp_ms: 1,
            uuid: Some("tool-use-message".into()),
            parent_uuid: None,
            message: Message::Assistant {
                content: vec![ContentBlock::ToolUse {
                    id: "call-1".into(),
                    name: "bash".into(),
                    input: json!({"command": "pwd"}),
                }],
                usage: None,
            },
        },
        kcoder_state::HistoryEntry {
            session_id: "session".into(),
            timestamp_ms: 2,
            uuid: Some("tool-result-message".into()),
            parent_uuid: None,
            message: Message::user_content(vec![ContentBlock::ToolResult {
                tool_use_id: "call-1".into(),
                content: vec![ContentBlock::Text {
                    text: "/workspace".into(),
                }],
                is_error: Some(false),
            }]),
        },
    ];
    let contexts = transcript_tool_contexts(&entries);
    assert!(history_entry_thread_message(1, entries[1].clone(), None, &contexts).is_none());
    let projected =
        history_entry_thread_message(0, entries[0].clone(), Some("turn-1".into()), &contexts)
            .unwrap();
    assert_eq!(projected.role, "assistant");
    assert_eq!(projected.turn_id.as_deref(), Some("turn-1"));
    assert_eq!(projected.blocks[0]["type"], "tool");
    assert_eq!(projected.blocks[0]["tool_name"], "bash");
    assert_eq!(projected.blocks[0]["tool_output"], "/workspace");
    assert_eq!(projected.blocks[0]["status"], "done");
    assert_eq!(projected.blocks[0]["timestamp"], 1);
    assert_eq!(projected.blocks[0]["completed_at"], 2);
}

#[test]
fn historical_user_question_answers_are_projected_for_the_web_summary() {
    use kcoder_types::{ContentBlock, Message};

    let question = "Which option should be used?";
    let entries = vec![
        kcoder_state::HistoryEntry {
            session_id: "session".into(),
            timestamp_ms: 1,
            uuid: Some("question-tool-use".into()),
            parent_uuid: None,
            message: Message::Assistant {
                content: vec![ContentBlock::ToolUse {
                    id: "question-call-1".into(),
                    name: "AskUserQuestion".into(),
                    input: json!({
                        "questions": [{
                            "question": question,
                            "header": "Option",
                            "options": [
                                {"label": "ALPHA", "description": "Use alpha."},
                                {"label": "BETA", "description": "Use beta."}
                            ],
                            "multi_select": false
                        }]
                    }),
                }],
                usage: None,
            },
        },
        kcoder_state::HistoryEntry {
            session_id: "session".into(),
            timestamp_ms: 2,
            uuid: Some("question-tool-result".into()),
            parent_uuid: None,
            message: Message::user_content(vec![ContentBlock::ToolResult {
                tool_use_id: "question-call-1".into(),
                content: vec![ContentBlock::Text {
                    text: json!({
                        "questions": [],
                        "answers": {question: "BETA"},
                        "annotations": null
                    })
                    .to_string(),
                }],
                is_error: Some(false),
            }]),
        },
    ];

    let contexts = transcript_tool_contexts(&entries);
    let projected =
        history_entry_thread_message(0, entries[0].clone(), Some("turn-1".into()), &contexts)
            .unwrap();
    let payload = &projected.blocks[0]["render_payload"];

    assert_eq!(payload["kind"], "request_user_input");
    assert_eq!(payload["itemId"], "question-call-1");
    assert_eq!(payload["questions"][0]["id"], "question-1");
    assert_eq!(payload["response"]["itemId"], "question-call-1");
    assert_eq!(
        payload["response"]["answers"]["question-1"]["answers"],
        json!(["BETA"])
    );
}

#[test]
fn historical_reused_call_ids_keep_their_own_results() {
    let raw = [
        json!({"role": "assistant", "content": [{"type": "tool_use", "id": "reused", "name": "bash", "input": {}}]}),
        json!({"role": "user", "content": [{"type": "tool_result", "tool_use_id": "reused", "content": [{"type": "text", "text": "first"}]}]}),
        json!({"role": "assistant", "content": [{"type": "tool_use", "id": "reused", "name": "Read", "input": {}}]}),
        json!({"role": "user", "content": [{"type": "tool_result", "tool_use_id": "reused", "content": [{"type": "text", "text": "second"}]}]}),
    ];
    let entries = raw
        .into_iter()
        .enumerate()
        .map(|(index, message)| kcoder_state::HistoryEntry {
            session_id: "session".into(),
            timestamp_ms: index as u64,
            uuid: Some(format!("reused-{index}")),
            parent_uuid: None,
            message: serde_json::from_value(message).unwrap(),
        })
        .collect::<Vec<_>>();
    let contexts = transcript_tool_contexts(&entries);
    for (index, expected_name, expected_output) in [(0, "bash", "first"), (2, "Read", "second")] {
        let message =
            history_entry_thread_message(index, entries[index].clone(), None, &contexts).unwrap();
        assert_eq!(message.blocks[0]["tool_name"], expected_name);
        assert_eq!(message.blocks[0]["tool_output"], expected_output);
    }
}

#[test]
fn historical_timeline_preserves_text_reasoning_and_parallel_call_positions() {
    let raw = [
        json!({"role": "assistant", "content": [
            {"type": "thinking", "thinking": "before", "signature": ""},
            {"type": "text", "text": "commentary"},
            {"type": "tool_use", "id": "a", "name": "bash", "input": {}},
            {"type": "tool_use", "id": "b", "name": "bash", "input": {}}
        ]}),
        json!({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "b", "content": [{"type": "text", "text": "B"}], "is_error": true},
            {"type": "tool_result", "tool_use_id": "a", "content": [{"type": "text", "text": "A"}]}
        ]}),
        json!({"role": "assistant", "content": [
            {"type": "thinking", "thinking": "after", "signature": ""},
            {"type": "text", "text": "final"}
        ]}),
    ];
    let entries = raw
        .into_iter()
        .enumerate()
        .map(|(index, message)| kcoder_state::HistoryEntry {
            session_id: "session".into(),
            timestamp_ms: index as u64,
            uuid: Some(format!("ordered-{index}")),
            parent_uuid: None,
            message: serde_json::from_value(message).unwrap(),
        })
        .collect::<Vec<_>>();
    let contexts = transcript_tool_contexts(&entries);
    let mut messages = entries
        .into_iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            history_entry_thread_message(index, entry, Some("turn-1".into()), &contexts)
        })
        .collect::<Vec<_>>();
    coalesce_assistant_tool_fragments(&mut messages);
    assert_eq!(messages.len(), 1);
    let message = &messages[0];
    assert_eq!(message.content, "final");
    assert_eq!(
        message
            .blocks
            .iter()
            .map(|block| block["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["thinking", "text", "tool", "tool", "thinking"]
    );
    assert_eq!(message.blocks[1]["content"], "commentary");
    assert_eq!(message.blocks[2]["id"], "a");
    assert_eq!(message.blocks[2]["tool_output"], "A");
    assert_eq!(message.blocks[3]["id"], "b");
    assert_eq!(message.blocks[3]["status"], "error");
}

#[test]
fn completed_tool_fragment_is_coalesced_with_its_assistant_text() {
    let mut messages = vec![
        ThreadMessage {
            id: "user".into(),
            client_message_id: None,
            turn_id: Some("turn-1".into()),
            role: "user".into(),
            content: "run it".into(),
            status: None,
            error: None,
            error_type: None,
            provider_failure: None,
                attempt_id: None,
                continued_by_attempt_id: None,
            blocks: Vec::new(),
            timestamp_ms: 5,
            content_truncated: false,
            content_original_chars: None,
        },
        ThreadMessage {
            id: "tool-result".into(),
            client_message_id: None,
            turn_id: Some("turn-1".into()),
            role: "assistant".into(),
            content: String::new(),
            status: None,
            error: None,
            error_type: None,
            provider_failure: None,
                attempt_id: None,
                continued_by_attempt_id: None,
            blocks: vec![json!({"id": "tool-1", "type": "tool"})],
            timestamp_ms: 10,
            content_truncated: false,
            content_original_chars: None,
        },
        ThreadMessage {
            id: "assistant-text".into(),
            client_message_id: None,
            turn_id: Some("turn-1".into()),
            role: "assistant".into(),
            content: "done".into(),
            status: None,
            error: None,
            error_type: None,
            provider_failure: None,
                attempt_id: None,
                continued_by_attempt_id: None,
            blocks: Vec::new(),
            timestamp_ms: 20,
            content_truncated: false,
            content_original_chars: None,
        },
    ];

    coalesce_assistant_tool_fragments(&mut messages);

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1].content, "done");
    assert_eq!(messages[1].blocks.len(), 1);
    assert_eq!(messages[1].timestamp_ms, 5);

    let mut following_tool = messages[1].clone();
    following_tool.id = "following-tool".into();
    following_tool.content.clear();
    following_tool.blocks = vec![json!({"id": "tool-2", "type": "tool"})];
    messages.push(following_tool);
    coalesce_assistant_tool_fragments(&mut messages);
    assert_eq!(messages.len(), 2);
    assert!(messages[1].content.is_empty());
    assert_eq!(messages[1].blocks[0]["id"], "tool-1");
    assert_eq!(messages[1].blocks[1]["type"], "text");
    assert_eq!(messages[1].blocks[1]["content"], "done");
    assert_eq!(messages[1].blocks[2]["id"], "tool-2");
}

#[test]
fn client_message_identity_is_applied_from_turn_metadata() {
    let mut messages = vec![ThreadMessage {
        id: "history-user".into(),
        client_message_id: None,
        turn_id: Some("turn-1".into()),
        role: "user".into(),
        content: "same prompt".into(),
        status: None,
        error: None,
        error_type: None,
        provider_failure: None,
                attempt_id: None,
                continued_by_attempt_id: None,
        blocks: Vec::new(),
        timestamp_ms: 20,
        content_truncated: false,
        content_original_chars: None,
    }];

    apply_turn_client_message_ids(
        &mut messages,
        HashMap::from([("turn-1".into(), "client-123".into())]),
    );

    assert_eq!(messages[0].content, "same prompt");
    assert_eq!(messages[0].client_message_id.as_deref(), Some("client-123"));
}

#[test]
fn historical_attachments_are_structured_before_long_content_is_truncated() {
    let prompt = "你".repeat(MAX_TRANSCRIPT_MESSAGE_BYTES);
    let wire = format!(
        "{prompt}\n\n<kcoder_attachments version=\"1\">\n{}\n</kcoder_attachments>",
        serde_json::to_string(&json!({
            "filename": "screen.png",
            "mimeType": "image/png",
            "fileSize": 42,
            "path": "/private/screen.png"
        }))
        .unwrap(),
    );
    let entry = kcoder_state::HistoryEntry {
        session_id: "session".into(),
        timestamp_ms: 1,
        uuid: Some("attachment-message".into()),
        parent_uuid: None,
        message: kcoder_types::Message::user_text(wire),
    };

    let projected =
        history_entry_thread_message(0, entry, Some("turn-1".into()), &HashMap::new()).unwrap();

    assert!(projected.content_truncated);
    assert!(!projected.content.contains("kcoder_attachments"));
    assert_eq!(projected.blocks.len(), 1);
    assert_eq!(projected.blocks[0]["type"], "attachment");
    assert_eq!(projected.blocks[0]["attachment"]["filename"], "screen.png");
    assert_eq!(projected.blocks[0]["attachment"]["fileSize"], 42);
}

#[test]
fn goal_rpc_mode_is_strict_and_unknown_modes_are_rejected() {
    assert_eq!(parse_goal_mode("strict").unwrap(), GoalMode::Strict);
    assert!(parse_goal_mode("strict-ish").is_err());
    assert_eq!(
        parse_goal_verification_kind("answer").unwrap(),
        kcoder_state::GoalVerificationKind::Answer
    );
    assert!(parse_goal_verification_kind("essay").is_err());

    let mut goal = Goal::new_with_file_and_mode("ship", None, None, GoalMode::Strict);
    goal.push_event(
        kcoder_state::GoalEventKind::VerificationPassed,
        "verifier passed",
    );
    let wire = thread_goal("thread-1", &goal);
    assert_eq!(wire.mode, "strict");
    assert_eq!(wire.verification_kind, "artifact");
    assert_eq!(wire.events.len(), 1);
    assert_eq!(wire.events[0].kind, "verification_passed");
}

#[test]
fn goal_rpc_status_transition_resumes_only_user_resumable_terminal_state() {
    for status in [
        GoalStatus::Paused,
        GoalStatus::Blocked,
        GoalStatus::UsageLimited,
    ] {
        ensure_goal_status_transition(status, Some(GoalStatus::Active)).unwrap();
    }

    for status in [GoalStatus::Complete, GoalStatus::BudgetLimited] {
        let error = ensure_goal_status_transition(status, Some(GoalStatus::Active)).unwrap_err();
        assert!(error.to_string().contains("terminal goal status"));
    }

    // usageLimited may recover only to active and cannot use the generic state RPC to become another terminal state.
    assert!(
        ensure_goal_status_transition(GoalStatus::UsageLimited, Some(GoalStatus::Paused),).is_err()
    );
    ensure_goal_status_transition(GoalStatus::UsageLimited, Some(GoalStatus::UsageLimited))
        .unwrap();
    ensure_goal_status_transition(GoalStatus::UsageLimited, None).unwrap();
}

fn catalog_list_component_fixture() -> (
    tempfile::TempDir,
    tempfile::TempDir,
    QueryEngine,
    Vec<(String, PathBuf)>,
) {
    const SESSIONS: usize = 4;
    const PAIRS: usize = 256;
    let workspace = tempfile::tempdir().unwrap();
    let history = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let scope = canonical_workspace(&engine).unwrap();
    let assistant = "component output ".repeat(256);
    let mut paths = Vec::new();
    for index in 0..SESSIONS {
        let id = format!("component-{index}");
        let path = history.path().join(format!("{id}.jsonl"));
        let state = kcoder_state::AppState::new(workspace.path());
        // Build in memory, then persist once rather than fsyncing every fixture message.
        for pair in 0..PAIRS {
            state.add_message(kcoder_types::Message::user_text(format!(
                "request {index}-{pair}"
            )));
            state.add_message(kcoder_types::Message::assistant_text(assistant.clone()));
        }
        state.with_history_path(&path);
        state.save_history().unwrap();
        let directory = engine.session_storage_dir_for(&id);
        std::fs::create_dir_all(&directory).unwrap();
        write_test_thread_metadata(
            &directory,
            &ThreadClientMetadata {
                version: 1,
                revision: 1,
                thread_id: id.clone(),
                workspace: scope.clone(),
                fields: BTreeMap::from([("model".into(), Some("fixture-model".into()))]),
                updated_at: "1".into(),
            },
        )
        .unwrap();
        paths.push((id, path));
    }
    (workspace, history, engine, paths)
}

#[test]
#[ignore = "explicit isolated list component measurement; no timing threshold"]
fn catalog_list_component_cost() {
    const SESSIONS: usize = 4;
    const PAIRS: usize = 256;
    const SAMPLES: usize = 21;
    let (workspace, _history, engine, paths) = catalog_list_component_fixture();
    let scope = canonical_workspace(&engine).unwrap();
    let root = std::fs::canonicalize(workspace.path()).unwrap();
    let logical_body_bytes: u64 = paths
        .iter()
        .map(|(_, path)| std::fs::metadata(path).unwrap().len())
        .sum();
    let measure = |use_catalog: bool| {
        let started = std::time::Instant::now();
        let mut catalog = if use_catalog {
            history_catalog::ListCatalog::open(&engine)
        } else {
            history_catalog::ListCatalog::default()
        };
        let mut rows = Vec::with_capacity(SESSIONS);
        for (id, path) in &paths {
            let prepared = kcoder_state::prepare_session_metadata(path).unwrap();
            assert_eq!(
                std::fs::canonicalize(prepared.base_cwd().unwrap()).unwrap(),
                root
            );
            rows.push(
                catalog
                    .snapshot(&engine, id, path, &prepared, false)
                    .unwrap(),
            );
        }
        catalog.publish();
        (rows, started.elapsed())
    };
    let (expected, _) = measure(false);
    let (cold_rows, cold) = measure(true);
    assert_eq!(cold_rows, expected);
    let catalog = kcoder_state::history_index::HistoryCatalog::open(
        &engine.client_storage_root(),
        &scope,
        false,
    )
    .unwrap()
    .unwrap();
    for (id, _) in &paths {
        assert!(
            catalog.has_entry(id).unwrap(),
            "cold component must publish each fixture row"
        );
    }
    drop(catalog);
    let mut fallback = Vec::with_capacity(SAMPLES);
    let mut warm = Vec::with_capacity(SAMPLES);
    for sample in 0..SAMPLES {
        for use_catalog in if sample % 2 == 0 {
            [false, true]
        } else {
            [true, false]
        } {
            let (rows, elapsed) = measure(use_catalog);
            assert_eq!(rows, expected);
            if use_catalog {
                warm.push(elapsed);
            } else {
                fallback.push(elapsed);
            }
        }
    }
    fallback.sort_unstable();
    warm.sort_unstable();
    let percentile_ms = |values: &[Duration], percent: usize| {
        values[(values.len() * percent).div_ceil(100) - 1].as_secs_f64() * 1000.0
    };
    println!(
        "catalog_list_component_cost sessions={SESSIONS} pairs_per_session={PAIRS} samples_per_path={SAMPLES} logical_body_bytes={logical_body_bytes} debug_assertions={}",
        cfg!(debug_assertions)
    );
    println!(
        "cold_catalog_ms={:.3} fallback_p50_ms={:.3} fallback_p95_ms={:.3} warm_catalog_p50_ms={:.3} warm_catalog_p95_ms={:.3}",
        cold.as_secs_f64() * 1000.0,
        percentile_ms(&fallback, 50),
        percentile_ms(&fallback, 95),
        percentile_ms(&warm, 50),
        percentile_ms(&warm, 95)
    );
    println!(
        "Scope: same known paths, fresh session/client metadata, snapshot and publish only; warm cache still reads and hashes every body. Not full thread/list, disk-read bytes, Windows/release, or TTFT."
    );
}

#[test]
#[ignore = "explicit isolated list stage diagnosis; no timing threshold"]
fn catalog_list_component_stages() {
    use kcoder_state::history_index::{HistoryCatalog, HistorySourceObservation};
    use sha2::{Digest, Sha256};
    use std::hint::black_box;
    const SAMPLES: usize = 7;
    let (workspace, _history, engine, paths) = catalog_list_component_fixture();
    let scope = canonical_workspace(&engine).unwrap();
    let root = std::fs::canonicalize(workspace.path()).unwrap();
    let bodies: Vec<_> = paths
        .iter()
        .map(|(_, path)| std::fs::read(path).unwrap())
        .collect();
    let logical_body_bytes: usize = bodies.iter().map(Vec::len).sum();
    let mut producer = history_catalog::ListCatalog::open(&engine);
    for (id, path) in &paths {
        let prepared = kcoder_state::prepare_session_metadata(path).unwrap();
        producer
            .snapshot(&engine, id, path, &prepared, false)
            .unwrap();
    }
    producer.publish();
    let mut lookup_catalog = HistoryCatalog::open(&engine.client_storage_root(), &scope, true)
        .unwrap()
        .unwrap();
    let prefetched = lookup_catalog.snapshot(None, paths.len()).unwrap();
    assert_eq!(prefetched.sessions.len(), paths.len());
    let mut samples: [Vec<Duration>; 6] = std::array::from_fn(|_| Vec::with_capacity(SAMPLES));
    for _ in 0..SAMPLES {
        let started = std::time::Instant::now();
        for (_, path) in &paths {
            black_box(std::fs::read(path).unwrap());
        }
        samples[0].push(started.elapsed());

        let started = std::time::Instant::now();
        for body in &bodies {
            black_box(Sha256::digest(black_box(body)));
        }
        samples[1].push(started.elapsed());

        let started = std::time::Instant::now();
        for ((_, path), body) in paths.iter().zip(&bodies) {
            let observation = HistorySourceObservation::read(path, body.len() as u64).unwrap();
            assert!(observation.has_known_commit_boundary());
            black_box(observation);
        }
        samples[2].push(started.elapsed());

        let started = std::time::Instant::now();
        let catalog = HistoryCatalog::open(&engine.client_storage_root(), &scope, true)
            .unwrap()
            .unwrap();
        black_box(catalog.revision().unwrap());
        drop(catalog);
        samples[3].push(started.elapsed());

        let started = std::time::Instant::now();
        // Prefetched proofs isolate DB cost only; they never authorize a user-visible result.
        for row in &prefetched.sessions {
            black_box(
                lookup_catalog
                    .lookup(&row.session_id, &row.source_proof, &row.metadata_proof)
                    .unwrap()
                    .unwrap(),
            );
        }
        samples[4].push(started.elapsed());

        let started = std::time::Instant::now();
        for (id, path) in &paths {
            let prepared = kcoder_state::prepare_session_metadata(path).unwrap();
            assert_eq!(
                std::fs::canonicalize(prepared.base_cwd().unwrap()).unwrap(),
                root
            );
            black_box(read_thread_metadata(&engine, id).unwrap());
            black_box(prepared);
        }
        samples[5].push(started.elapsed());
    }
    println!(
        "catalog_list_component_stages sessions={} samples_per_stage={SAMPLES} logical_body_bytes={logical_body_bytes} debug_assertions={}",
        paths.len(),
        cfg!(debug_assertions)
    );
    for (name, values) in [
        "fs_read",
        "sha256_loaded_bytes",
        "source_observation",
        "catalog_open_revision_drop",
        "catalog_lookup_four_rows",
        "fresh_prepared_and_client_metadata",
    ]
    .into_iter()
    .zip(&mut samples)
    {
        values.sort_unstable();
        println!(
            "{name}_p50_ms={:.3}",
            values[SAMPLES / 2].as_secs_f64() * 1000.0
        );
    }
    println!(
        "Scope: seven isolated stage samples, warm files; not additive full-request timing, disk-read bytes, release/Windows, or TTFT. Prefetched lookup proofs are measurement inputs only."
    );
}

#[test]
fn compat_roots_join_the_relative_history_subpath() {
    // 通用（嵌套/自定义布局）机制测试：相对子路径拼到每个候选根上。
    let history_dir = Path::new("/data/projects/primary/custom-history");
    let project_dir = Path::new("/data/projects/primary");
    let compat = vec![PathBuf::from("/data/projects/legacy-verbatim")];
    assert_eq!(
        history_scan_roots(history_dir, project_dir, &compat),
        vec![
            PathBuf::from("/data/projects/primary/custom-history"),
            PathBuf::from("/data/projects/legacy-verbatim/custom-history"),
        ]
    );
}

#[test]
fn flat_history_layout_yields_bare_compat_roots() {
    // 生产默认布局：history_dir == project_data_dir（main.rs:1386-1392 的
    // history_dir_for_session 默认 = project_data_dir；configure_history_path
    // 平铺写入 <project>/<sid>.jsonl）。相对路径为空 → 兼容根即裸 key 目录
    // ——旧 build 同样平铺写入，这正是要列的目录（并非退化/no-op）。
    let project_dir = Path::new("/data/projects/primary");
    let project_dirs = vec![
        PathBuf::from("/data/projects/primary"),
        PathBuf::from("/data/projects/legacy-verbatim"),
    ];
    assert_eq!(
        history_scan_roots(project_dir, project_dir, &project_dirs),
        vec![
            PathBuf::from("/data/projects/primary"),
            PathBuf::from("/data/projects/legacy-verbatim"),
        ]
    );
}

#[test]
fn non_ancestor_basis_falls_back_to_the_single_history_root() {
    // 自定义/私有 history_dir（KCODER_HISTORY_DIR、fork 私有存储等）：基准不在
    // 祖先链上 → strip 失败 → 单根扫描。
    let project_dirs = vec![PathBuf::from("/data/projects/primary")];
    assert_eq!(
        history_scan_roots(
            Path::new("/tmp/private-history"),
            &project_dirs[0],
            &project_dirs
        ),
        vec![PathBuf::from("/tmp/private-history")]
    );
}

#[test]
fn multi_root_scan_deduplicates_overlapping_candidates() {
    let temp = tempfile::tempdir().unwrap();
    let primary = temp.path().join("primary");
    let compat = temp.path().join("compat");
    std::fs::create_dir_all(&primary).unwrap();
    std::fs::create_dir_all(&compat).unwrap();
    std::fs::write(primary.join("thread-1.jsonl"), b"{}\n").unwrap();
    std::fs::write(compat.join("thread-1.jsonl"), b"{}\n").unwrap();
    std::fs::write(compat.join("thread-2.jsonl"), b"{}\n").unwrap();

    let merged = scan_history_roots(&[primary.clone(), compat.clone()]).unwrap();
    let ids: Vec<&str> = merged
        .candidates
        .iter()
        .map(|candidate| candidate.0.as_str())
        .collect();
    assert_eq!(ids, vec!["thread-1", "thread-2"]);
    assert_eq!(merged.candidates[0].1, primary.join("thread-1.jsonl"));
    let expected_issues = kcoder_state::recent_session_candidates_report(&primary)
        .unwrap()
        .issue_count
        + kcoder_state::recent_session_candidates_report(&compat)
            .unwrap()
            .issue_count;
    assert_eq!(merged.issue_count, expected_issues);
}

#[test]
fn sessions_from_deleted_directories_do_not_count_as_listing_issues() {
    // A session whose recorded working directory no longer exists (deleted
    // project, removed worktree, cleaned temp dir) cannot belong to any
    // workspace list. It must be skipped silently — the same treatment as a
    // session that belongs to another directory — instead of permanently
    // inflating the project's issue count ("incomplete (1 issue)").
    let workspace = tempfile::tempdir().unwrap();
    let history = tempfile::tempdir().unwrap();
    let engine = catalog_list_test_engine(workspace.path());
    let live_path = history
        .path()
        .join(format!("{}.jsonl", engine.session_id()));
    engine.state.with_history_path(&live_path);
    engine
        .state
        .add_message(kcoder_types::Message::user_text("live session"));
    engine.state.save_history().unwrap();

    let gone = tempfile::tempdir().unwrap();
    let gone_engine = catalog_list_test_engine(gone.path());
    let gone_path = history
        .path()
        .join(format!("{}.jsonl", gone_engine.session_id()));
    gone_engine.state.with_history_path(&gone_path);
    gone_engine
        .state
        .add_message(kcoder_types::Message::user_text("orphaned session"));
    gone_engine.state.save_history().unwrap();
    drop(gone_engine);
    gone.close().unwrap();

    let report =
        persisted_thread_snapshot_report(&engine, &HashSet::new(), &HashSet::new()).unwrap();
    assert_eq!(report.threads.len(), 1, "only the live session is listed");
    assert_eq!(
        report.issue_count, 0,
        "a session from a deleted directory must not count as a listing issue"
    );
}

#[test]
fn scan_roots_skip_impossible_windows_key_forms() {
    // The legacy verbatim-derived key keeps its `?`; such a directory can never
    // exist on Windows and scanning it fails with os error 123 instead of
    // NotFound, so it must be filtered before scanning.
    let history_dir = Path::new("/data/projects/primary");
    let project_dir = Path::new("/data/projects/primary");
    let compat = vec![
        PathBuf::from("/data/projects/----primary"),
        PathBuf::from("/data/projects/__?_primary"),
    ];
    assert_eq!(
        history_scan_roots(history_dir, project_dir, &compat),
        vec![
            PathBuf::from("/data/projects/primary"),
            PathBuf::from("/data/projects/----primary")
        ]
    );
}
