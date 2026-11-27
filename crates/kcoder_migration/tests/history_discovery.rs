use kcoder_migration::{
    discovery::{DiscoveryRoots, SourceRegistry},
    history_discovery::HistoryCatalog,
    history_jobs::HistoryJobStore,
};
use kcoder_types::{external_history::*, migration::MigrationSourceKind as Kind};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
};
const SESSION: &str = "11111111-1111-4111-8111-111111111111";
#[path = "history_discovery/grouping.rs"]
mod grouping;

fn claude_file(root: &Path, id: &str) -> PathBuf {
    let path = root
        .join("projects/project-label")
        .join(format!("{id}.jsonl"));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path,format!("{}\n{}\n",json!({"type":"user","uuid":"message-1","sessionId":id,"cwd":"/original-project","message":{"role":"user","content":"First request"}}),json!({"type":"custom-title","customTitle":"Original custom title"}))).unwrap();
    path
}
fn codex_file(
    root: &Path,
    thread: &str,
    physical: &str,
    archived: bool,
    compressed: bool,
) -> PathBuf {
    let directory = if archived {
        root.join("archived_sessions")
    } else {
        root.join("sessions/2026/10/16")
    };
    fs::create_dir_all(&directory).unwrap();
    let name = format!(
        "rollout-2026-10-16T10-00-00-{thread}_{physical}.jsonl{}",
        if compressed { ".zst" } else { "" }
    );
    let path = directory.join(name);
    let bytes=format!("{}\n{}\n",json!({"type":"session_meta","payload":{"id":thread,"cli_version":"0.163.0","cwd":"/original-codex"}}),json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Source request"}]}})).into_bytes();
    fs::write(
        &path,
        if compressed {
            zstd::stream::encode_all(&bytes[..], 1).unwrap()
        } else {
            bytes
        },
    )
    .unwrap();
    path
}
fn registry(home: &Path) -> SourceRegistry {
    SourceRegistry::new(DiscoveryRoots {
        home: home.into(),
        claude_config_dir: None,
        codex_home: None,
        project: None,
    })
}

#[test]
fn canonical_sessions_page_with_title_metadata_and_flow_into_persistent_jobs() {
    let home = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    claude_file(&home.path().join(".claude"), SESSION);
    fs::write(home.path().join(".claude/auth.json"), b"AUTH-CANARY").unwrap();
    let mut registry = registry(home.path());
    let page = registry
        .discover_history(Kind::ClaudeCode, |_| true)
        .unwrap();
    assert!(page.discovery_complete);
    assert_eq!(page.items.len(), 1);
    let item = &page.items[0];
    assert_eq!(item.title.as_deref(), Some("Original custom title"));
    assert_eq!(item.project.as_deref(), Some("/original-project"));
    assert_eq!(item.source_session_id, SESSION);
    assert!(!item.preview_incomplete);
    let wire = serde_json::to_string(&page).unwrap();
    assert!(!wire.contains("AUTH-CANARY"));
    assert!(!wire.contains(&home.path().to_string_lossy().to_string()));
    let selected = registry
        .selected_history(&page.catalog_id, &item.source_handle, &mut |_, _| true)
        .unwrap();
    assert_eq!(
        selected.snapshot().origin.title.as_deref(),
        Some("Original custom title")
    );
    let store = HistoryJobStore::open(target.path()).unwrap();
    let planned = store
        .create(&uuid::Uuid::new_v4().to_string(), &selected)
        .unwrap();
    assert_eq!(
        store
            .step(&planned.job_id, planned.sequence, 10, |_| true)
            .unwrap()
            .stage,
        HistoryImportStage::Normalizing
    );
}

#[test]
fn codex_active_archived_reverted_and_compressed_files_keep_distinct_physical_identities() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join(".codex");
    codex_file(&root, SESSION, SESSION, false, false);
    let reverted = "22222222-2222-4222-8222-222222222222";
    codex_file(&root, SESSION, reverted, true, true);
    let mut registry = registry(home.path());
    let page = registry.discover_history(Kind::Codex, |_| true).unwrap();
    assert!(page.discovery_complete);
    assert_eq!(page.total_items, 2);
    for item in page.items {
        assert_eq!(item.source_session_id, SESSION);
        assert_eq!(item.project.as_deref(), Some("/original-codex"));
        assert_eq!(item.title.as_deref(), Some("Source request"));
        let selected = registry
            .selected_history(&page.catalog_id, &item.source_handle, &mut |_, _| true)
            .unwrap();
        assert_eq!(
            selected.snapshot().origin.source_artifact_id,
            item.source_artifact_id
        );
        assert_eq!(selected.snapshot().original.is_some(), item.compressed);
        assert_eq!(item.compressed, item.archived);
    }
}

#[test]
fn claude_nested_subagents_are_separate_selections_and_not_merged_into_the_main_file() {
    let root = tempfile::tempdir().unwrap();
    claude_file(root.path(), SESSION);
    let agent = root.path().join(format!(
        "projects/project-label/{SESSION}/subagents/workflows/run/agent-agent-one.jsonl"
    ));
    fs::create_dir_all(agent.parent().unwrap()).unwrap();
    fs::write(agent,json!({"type":"assistant","sessionId":SESSION,"isSidechain":true,"uuid":"agent-message","message":{"role":"assistant","content":"agent result"}}).to_string()+"\n").unwrap();
    let catalog = HistoryCatalog::discover(root.path(), Kind::ClaudeCode, |_| true).unwrap();
    let page = catalog.page(None, |_| true).unwrap();
    assert_eq!(page.items.len(), 2);
    let agent = page
        .items
        .iter()
        .find(|item| item.agent_id.is_some())
        .unwrap();
    assert_eq!(agent.agent_id.as_deref(), Some("agent-one"));
    assert_eq!(agent.parent_session_id.as_deref(), Some(SESSION));
    assert_eq!(
        catalog
            .capture(&agent.source_handle, &mut |_, _| true)
            .unwrap()
            .snapshot()
            .origin
            .parent_session_id
            .as_deref(),
        Some(SESSION)
    );
}

#[test]
fn pages_are_scoped_to_their_catalog_and_old_selections_survive_a_new_scan() {
    let home = tempfile::tempdir().unwrap();
    for _ in 0..12 {
        claude_file(
            &home.path().join(".claude"),
            &uuid::Uuid::new_v4().to_string(),
        );
    }
    let mut registry = registry(home.path());
    let first = registry
        .discover_history(Kind::ClaudeCode, |_| true)
        .unwrap();
    assert_eq!(first.items.len(), 10);
    assert_eq!(first.total_items, 12);
    let second = registry
        .history_page(&first.catalog_id, first.next_cursor.as_deref(), |_| true)
        .unwrap();
    assert_eq!(second.items.len(), 2);
    assert!(second.next_cursor.is_none());
    assert!(first.items.iter().all(|item| {
        !second
            .items
            .iter()
            .any(|next| next.source_handle == item.source_handle)
    }));
    let newer = registry
        .discover_history(Kind::ClaudeCode, |_| true)
        .unwrap();
    assert!(
        registry
            .history_page(&newer.catalog_id, first.next_cursor.as_deref(), |_| true)
            .is_err()
    );
    assert!(
        registry
            .selected_history(
                &first.catalog_id,
                &first.items[0].source_handle,
                &mut |_, _| true
            )
            .is_ok()
    );
    assert!(
        registry
            .selected_history(
                &newer.catalog_id,
                &first.items[0].source_handle,
                &mut |_, _| true
            )
            .is_err()
    );
    assert!(
        registry
            .history_page(&first.catalog_id, Some("../bad"), |_| true)
            .is_err()
    );
}

#[test]
fn selected_roots_and_files_cannot_be_replaced_between_scan_and_capture() {
    let root = tempfile::tempdir().unwrap();
    let file = claude_file(root.path(), SESSION);
    let catalog = HistoryCatalog::discover(root.path(), Kind::ClaudeCode, |_| true).unwrap();
    let page = catalog.page(None, |_| true).unwrap();
    fs::rename(&file, file.with_extension("retained")).unwrap();
    claude_file(root.path(), SESSION);
    assert!(
        catalog
            .capture(&page.items[0].source_handle, &mut |_, _| true)
            .is_err()
    );
    let preview = catalog.page(None, |_| true).unwrap();
    assert!(preview.items[0].preview_incomplete);
}

#[test]
fn custom_roots_do_not_fall_back_to_default_homes_or_other_registries() {
    let home = tempfile::tempdir().unwrap();
    claude_file(&home.path().join(".claude"), SESSION);
    let mut configured = SourceRegistry::new(DiscoveryRoots {
        home: home.path().into(),
        claude_config_dir: Some(home.path().join("absent-custom")),
        codex_home: None,
        project: None,
    });
    assert!(
        configured
            .discover_history(Kind::ClaudeCode, |_| true)
            .is_err()
    );
    let mut relative = SourceRegistry::new(DiscoveryRoots {
        home: home.path().into(),
        claude_config_dir: Some("relative".into()),
        codex_home: None,
        project: None,
    });
    assert!(
        relative
            .discover_history(Kind::ClaudeCode, |_| true)
            .is_err()
    );
    let mut first = registry(home.path());
    let second = registry(home.path());
    let page = first.discover_history(Kind::ClaudeCode, |_| true).unwrap();
    assert!(
        second
            .history_page(&page.catalog_id, None, |_| true)
            .is_err()
    );
    assert!(
        second
            .selected_history(
                &page.catalog_id,
                &page.items[0].source_handle,
                &mut |_, _| true
            )
            .is_err()
    );
}

#[test]
fn cancellation_during_scan_page_or_snapshot_does_not_create_target_state() {
    let root = tempfile::tempdir().unwrap();
    claude_file(root.path(), SESSION);
    assert!(HistoryCatalog::discover(root.path(), Kind::ClaudeCode, |_| false).is_err());
    let catalog = HistoryCatalog::discover(root.path(), Kind::ClaudeCode, |_| true).unwrap();
    assert!(catalog.page(None, |_| false).is_err());
    let page = catalog.page(None, |_| true).unwrap();
    assert!(
        catalog
            .capture(&page.items[0].source_handle, &mut |_, _| false)
            .is_err()
    );
    assert!(!root.path().join("external-history").exists());
    assert!(!root.path().join("migrations").exists());
}

#[test]
fn unknown_names_and_incomplete_large_metadata_are_explicit_without_reading_entire_lines() {
    let root = tempfile::tempdir().unwrap();
    let file = claude_file(root.path(), SESSION);
    fs::write(
        file,
        format!(
            "{{\"type\":\"user\",\"message\":\"{}\"}}\n",
            "x".repeat(2 * 1024 * 1024)
        ),
    )
    .unwrap();
    fs::write(
        root.path().join("projects/project-label/unknown.jsonl"),
        b"unknown",
    )
    .unwrap();
    let catalog = HistoryCatalog::discover(root.path(), Kind::ClaudeCode, |_| true).unwrap();
    let page = catalog.page(None, |_| true).unwrap();
    assert!(!page.discovery_complete);
    assert_eq!(page.items.len(), 1);
    assert!(page.items[0].preview_incomplete);
    assert!(page.items[0].title.is_none());
    assert!(
        page.problems
            .iter()
            .any(|problem| problem.code == "history_discovery_unrecognized_filename")
    );
}

#[cfg(unix)]
#[test]
fn links_and_special_files_do_not_escape_or_block_the_inventory() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    claude_file(root.path(), SESSION);
    let other = claude_file(outside.path(), "22222222-2222-4222-8222-222222222222");
    let parent = root.path().join("projects/project-label");
    symlink(
        &other,
        parent.join("33333333-3333-4333-8333-333333333333.jsonl"),
    )
    .unwrap();
    fs::hard_link(
        &other,
        parent.join("44444444-4444-4444-8444-444444444444.jsonl"),
    )
    .unwrap();
    symlink(outside.path(), root.path().join("projects/linked-project")).unwrap();
    let fifo = parent.join("55555555-5555-4555-8555-555555555555.jsonl");
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
    // SAFETY: the path is an owned temporary fixture and the C string remains live.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let catalog = HistoryCatalog::discover(root.path(), Kind::ClaudeCode, |_| true).unwrap();
    let page = catalog.page(None, |_| true).unwrap();
    assert_eq!(page.items.len(), 1);
    assert!(!page.discovery_complete);
    assert!(
        page.problems
            .iter()
            .any(|problem| problem.code == "history_discovery_unsafe_entry")
    );
}

#[test]
fn identical_subagent_contents_keep_separate_archive_identities() {
    use kcoder_state::external_history::ExternalHistoryStore;
    let root = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    claude_file(root.path(), SESSION);
    let directory = root
        .path()
        .join(format!("projects/project-label/{SESSION}/subagents"));
    fs::create_dir_all(&directory).unwrap();
    let content=json!({"type":"assistant","uuid":"same-row","sessionId":SESSION,"isSidechain":true,"message":{"role":"assistant","content":"same content"}}).to_string()+"\n";
    for id in ["a", "b"] {
        fs::write(directory.join(format!("agent-{id}.jsonl")), &content).unwrap();
    }
    let catalog = HistoryCatalog::discover(root.path(), Kind::ClaudeCode, |_| true).unwrap();
    let page = catalog.page(None, |_| true).unwrap();
    let agents = page
        .items
        .iter()
        .filter(|item| item.agent_id.is_some())
        .collect::<Vec<_>>();
    assert_eq!(agents.len(), 2);
    assert_ne!(agents[0].source_artifact_id, agents[1].source_artifact_id);
    let store = ExternalHistoryStore::open(target.path()).unwrap();
    let mut archives = Vec::new();
    for item in agents {
        let selected = catalog
            .capture(&item.source_handle, &mut |_, _| true)
            .unwrap();
        let committed = selected
            .archive(&store, &uuid::Uuid::new_v4().to_string(), &mut |_| true)
            .unwrap();
        assert!(committed.owns_archive);
        archives.push(committed.receipt.archive_id);
    }
    assert_ne!(archives[0], archives[1]);
}

#[test]
fn bounded_preview_failure_does_not_reject_an_otherwise_valid_compressed_source() {
    let root = tempfile::tempdir().unwrap();
    let raw = codex_file(root.path(), SESSION, SESSION, false, false);
    let logical = fs::read(&raw).unwrap();
    fs::remove_file(&raw).unwrap();
    let mut bytes = vec![0x50, 0x2a, 0x4d, 0x18];
    bytes.extend((512u32 * 1024).to_le_bytes());
    bytes.resize(bytes.len() + 512 * 1024, 0);
    bytes.extend(zstd::stream::encode_all(&logical[..], 1).unwrap());
    let compressed = PathBuf::from(format!("{}.zst", raw.display()));
    fs::write(compressed, &bytes).unwrap();
    let catalog = HistoryCatalog::discover(root.path(), Kind::Codex, |_| true).unwrap();
    let page = catalog.page(None, |_| true).unwrap();
    assert_eq!(page.items.len(), 1);
    assert!(page.items[0].preview_incomplete);
    let selected = catalog
        .capture(&page.items[0].source_handle, &mut |_, _| true)
        .unwrap();
    assert_eq!(selected.snapshot().source_bytes, logical.len() as u64);
    assert_eq!(
        selected.snapshot().original.as_ref().unwrap().bytes,
        bytes.len() as u64
    );
    let mut checks = 0;
    assert!(
        catalog
            .page(None, |_| {
                checks += 1;
                checks < 3
            })
            .is_err()
    );
}

#[test]
fn growing_sources_require_a_fresh_snapshot_and_shrinking_sources_are_rejected() {
    use std::io::Write;
    let root = tempfile::tempdir().unwrap();
    let file = claude_file(root.path(), SESSION);
    let catalog = HistoryCatalog::discover(root.path(), Kind::ClaudeCode, |_| true).unwrap();
    let before = catalog.page(None, |_| true).unwrap();
    let append = json!({"type":"custom-title","customTitle":"New title"}).to_string() + "\n";
    fs::OpenOptions::new()
        .append(true)
        .open(&file)
        .unwrap()
        .write_all(append.as_bytes())
        .unwrap();
    let changed = catalog.page(None, |_| true).unwrap();
    assert!(changed.items[0].preview_incomplete);
    assert_eq!(changed.items[0].title.as_deref(), Some("New title"));
    let selected = catalog
        .capture(&before.items[0].source_handle, &mut |_, _| true)
        .unwrap();
    assert!(selected.snapshot().source_bytes > before.items[0].bytes);
    assert_eq!(
        selected.snapshot().origin.title.as_deref(),
        Some("New title")
    );
    fs::write(file, b"{}\n").unwrap();
    assert!(
        catalog
            .capture(&before.items[0].source_handle, &mut |_, _| true)
            .is_err()
    );
}

#[cfg(unix)]
#[test]
fn oversized_sources_stay_listed_with_a_blocking_size_issue() {
    let root = tempfile::tempdir().unwrap();
    let file = claude_file(root.path(), SESSION);
    fs::OpenOptions::new()
        .write(true)
        .open(file)
        .unwrap()
        .set_len(EXTERNAL_HISTORY_MAX_BYTES + 1)
        .unwrap();
    let catalog = HistoryCatalog::discover(root.path(), Kind::ClaudeCode, |_| true).unwrap();
    let page = catalog.page(None, |_| true).unwrap();
    assert_eq!(page.items.len(), 1);
    assert!(!page.items[0].import_issues.is_empty());
    assert!(
        catalog
            .capture(&page.items[0].source_handle, &mut |_, _| true)
            .is_err()
    );
}

#[test]
fn inventory_budget_reports_partial_discovery_instead_of_claiming_missing_sessions() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("projects/p");
    fs::create_dir_all(&directory).unwrap();
    for _ in 0..10_001 {
        fs::write(
            directory.join(format!("{}.jsonl", uuid::Uuid::new_v4())),
            b"",
        )
        .unwrap();
    }
    let catalog = HistoryCatalog::discover(root.path(), Kind::ClaudeCode, |_| true).unwrap();
    let page = catalog.page(None, |_| true).unwrap();
    assert_eq!(page.total_items, 10_000);
    assert!(!page.discovery_complete);
    assert!(
        page.problems
            .iter()
            .any(|problem| problem.code == "history_discovery_budget_exceeded")
    );
}

#[test]
fn live_catalog_limit_preserves_other_windows_existing_grants() {
    let home = tempfile::tempdir().unwrap();
    claude_file(&home.path().join(".claude"), SESSION);
    let mut registry = registry(home.path());
    let first = registry
        .discover_history(Kind::ClaudeCode, |_| true)
        .unwrap();
    for _ in 1..16 {
        registry
            .discover_history(Kind::ClaudeCode, |_| true)
            .unwrap();
    }
    assert!(
        registry
            .discover_history(Kind::ClaudeCode, |_| true)
            .is_err()
    );
    assert!(
        registry
            .selected_history(
                &first.catalog_id,
                &first.items[0].source_handle,
                &mut |_, _| true
            )
            .is_ok()
    );
}

#[test]
fn snapshot_capture_uses_an_owned_grant_after_the_registry_lock_is_released() {
    let home = tempfile::tempdir().unwrap();
    claude_file(&home.path().join(".claude"), SESSION);
    let registry = std::sync::Mutex::new(registry(home.path()));
    let page = registry
        .lock()
        .unwrap()
        .discover_history(Kind::ClaudeCode, |_| true)
        .unwrap();
    let grant = registry
        .lock()
        .unwrap()
        .history_selection(&page.catalog_id, &page.items[0].source_handle)
        .unwrap();
    let captured = grant
        .capture(&mut |_, _| {
            assert!(registry.try_lock().is_ok());
            true
        })
        .unwrap();
    assert_eq!(captured.snapshot().origin.source_session_id, SESSION);
}

#[test]
fn forged_claude_location_ids_are_rejected_and_omitted_legacy_ids_stay_omitted() {
    use kcoder_migration::history_sources::HistorySourceBinding;
    let root = tempfile::tempdir().unwrap();
    claude_file(root.path(), SESSION);
    let catalog = HistoryCatalog::discover(root.path(), Kind::ClaudeCode, |_| true).unwrap();
    let page = catalog.page(None, |_| true).unwrap();
    let captured = catalog
        .capture(&page.items[0].source_handle, &mut |_, _| true)
        .unwrap();
    let relative = PathBuf::from(format!("projects/project-label/{SESSION}.jsonl"));
    let mut origin = captured.snapshot().origin.clone();
    // Capture accepts a source-instance label, not an already bound root fingerprint.
    origin.source_instance = "selected-history-root".into();
    origin.source_artifact_id = Some(format!("claude-file-{}", "0".repeat(64)));
    assert!(
        HistorySourceBinding::capture(root.path(), &relative, origin.clone(), &mut |_, _| panic!(
            "forged identity must fail before body reads"
        ))
        .is_err()
    );
    origin.source_artifact_id = None;
    let legacy =
        HistorySourceBinding::capture(root.path(), &relative, origin, &mut |_, _| true).unwrap();
    assert!(legacy.snapshot().origin.source_artifact_id.is_none());
    let mut expected = serde_json::to_value(captured.snapshot()).unwrap();
    expected["origin"]
        .as_object_mut()
        .unwrap()
        .remove("sourceArtifactId");
    assert!(serde_json::to_value(legacy.snapshot()).unwrap() == expected);
}

#[test]
fn accepted_history_metadata_matches_the_displayed_page_without_another_preview_read() {
    let root = tempfile::tempdir().unwrap();
    let file = claude_file(root.path(), SESSION);
    let catalog = HistoryCatalog::discover(root.path(), Kind::ClaudeCode, |_| true).unwrap();
    let page = catalog.page(None, |_| true).unwrap();
    let shown = &page.items[0];
    assert_eq!(shown.title.as_deref(), Some("Original custom title"));
    let pinned = catalog
        .selection(&shown.source_handle)
        .unwrap()
        .pin()
        .unwrap();
    assert_eq!(pinned.summary().title, shown.title);
    assert_eq!(pinned.summary().project, shown.project);
    // Pinning still validates source metadata, but does not sample a newly appended title.
    use std::io::Write;
    fs::OpenOptions::new()
        .append(true)
        .open(file)
        .unwrap()
        .write_all(b"{\"type\":\"custom-title\",\"customTitle\":\"Updated title\"}\n")
        .unwrap();
    assert_eq!(
        catalog
            .selection(&shown.source_handle)
            .unwrap()
            .pin()
            .unwrap()
            .summary()
            .title,
        shown.title
    );
    let updated = catalog.page(None, |_| true).unwrap();
    assert_eq!(updated.items[0].title.as_deref(), Some("Updated title"));
    assert_eq!(
        catalog
            .selection(&shown.source_handle)
            .unwrap()
            .pin()
            .unwrap()
            .summary()
            .title,
        updated.items[0].title
    );
    assert_eq!(pinned.summary().title, shown.title);
}
