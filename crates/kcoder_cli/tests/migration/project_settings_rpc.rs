use super::{TestAppServer, json, rpc};
use kcoder_migration::{
    discovery::{DiscoveryRoots, SourceRegistry},
    source_transfer::*,
};
use kcoder_types::migration::MigrationSourceKind;
use std::{path::Path, time::Duration};

fn project_files(root: &Path) -> std::collections::BTreeMap<std::path::PathBuf, Option<Vec<u8>>> {
    fn collect(
        root: &Path,
        relative: &Path,
        entries: &mut std::collections::BTreeMap<std::path::PathBuf, Option<Vec<u8>>>,
    ) {
        for entry in std::fs::read_dir(root.join(relative)).unwrap() {
            let entry = entry.unwrap();
            let path = relative.join(entry.file_name());
            let kind = entry.file_type().unwrap();
            assert!(!kind.is_symlink());
            if kind.is_dir() {
                entries.insert(path.clone(), None);
                collect(root, &path, entries);
            } else {
                entries.insert(path, Some(std::fs::read(entry.path()).unwrap()));
            }
        }
    }
    let mut entries = std::collections::BTreeMap::new();
    let relative = Path::new(".kcoder");
    if root.join(relative).exists() {
        collect(root, relative, &mut entries);
    }
    entries
}

#[test]
fn received_project_batch_reopens_same_scope_and_async_publishes_and_undoes_without_user_fallback()
{
    run_project_batch(false);
}

#[test]
fn project_mcp_inheritance_public_pages_keep_names_private_values_and_original_batch_undo() {
    run_project_batch(true);
}

fn run_project_batch(inherit_mcp: bool) {
    let root = tempfile::tempdir().unwrap();
    let source_profile = root.path().join("source-profile");
    let profile = root.path().join("target-profile");
    let source_cwd = root.path().join("source-workspace");
    let cwd = root.path().join("target-workspace");
    let foreign = root.path().join("foreign-workspace");
    let empty_home = root.path().join("source-home");
    for path in [&source_cwd, &cwd, &foreign, &empty_home] {
        std::fs::create_dir(path).unwrap();
    }
    let source = SourceTransfers::open(&source_profile).unwrap();
    let target = IncomingTransfers::open(&profile).unwrap();
    let inherited = if inherit_mcp {
        (0..13).map(|index| json!({"name":format!("inherited-{index:02}"),"command":"NEVER_EXECUTE_INHERITED_MCP","env":{"TOKEN":"SYNTHETIC_INHERITED_PRIVATE_VALUE"}})).collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let original=json!({"credential_store":"file","active_provider":"User","providers":{"User":{"api_format":"openai_chat_completions","endpoint":"https://user.invalid/v1","authentication":{"mode":"none"},"default_model":"user-model","discover_models":false,"context_window_tokens":128000,"output_headroom_tokens":8192,"max_output_tokens":8192}},"mcp_servers":inherited}).to_string();
    std::fs::write(profile.join("settings.json"), &original).unwrap();
    std::fs::write(
        profile.join("trusted-folders.json"),
        json!({"trusted":[cwd,foreign],"never":[]}).to_string(),
    )
    .unwrap();
    std::fs::create_dir(source_cwd.join(".claude")).unwrap();
    let source_bytes = r#"{"model":"source-model","env":{"ANTHROPIC_BASE_URL":"https://source.invalid"},"mcpServers":{"docs":{"command":"NEVER_EXECUTE_RECEIVED_PROJECT_SOURCE","args":[]}}}"#;
    std::fs::write(source_cwd.join(".claude/settings.json"), source_bytes).unwrap();
    let mut registry = SourceRegistry::new(DiscoveryRoots {
        home: empty_home.clone(),
        claude_config_dir: Some(empty_home.clone()),
        codex_home: None,
        project: Some(source_cwd.clone()),
    });
    let (found, _) = registry.discover(&[MigrationSourceKind::ClaudeCode], true);
    let selected = found.iter().find(|item| item.scope == "project").unwrap();
    let binding = registry.selected(&selected.source_id).unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let destination = target
        .issue_destination(&request, source.authority())
        .unwrap();
    source
        .prepare(
            &request,
            &destination,
            vec![ExportSelection::Configuration(binding)],
        )
        .unwrap();
    let manifest = source.capture(&request, &destination, |_| true).unwrap();
    target.begin(&manifest, source.authority()).unwrap();
    for entry in &manifest.entries {
        for index in 0..entry.bytes.div_ceil(TRANSFER_CHUNK_BYTES as u64) as u32 {
            let chunk = source
                .chunk(
                    &request,
                    &destination,
                    &manifest.digest().unwrap(),
                    &entry.id,
                    index,
                )
                .unwrap();
            target.write_part(source.authority(), &chunk).unwrap();
        }
    }
    let receipt = target
        .finish(&request, source.authority(), |_| true)
        .unwrap();
    let choices = target
        .received_sources(&request, &receipt.manifest_sha256, 0)
        .unwrap()
        .items
        .into_iter()
        .map(|entry| ReceivedAdoptionSelection {
            entry_id: entry.entry_id,
            project_mapping: Some(ReceivedProjectMapping::CurrentWorkspace),
        })
        .collect();
    let mapping = ReceivedProjectTarget::capture(&profile, &cwd).unwrap();
    let adoption = uuid::Uuid::new_v4().to_string();
    let (_, owner) = target
        .prepare_adoption(
            &request,
            &adoption,
            &receipt.manifest_sha256,
            choices,
            Some(mapping),
        )
        .unwrap();
    let ready = target.execute_adoption(owner.unwrap(), |_| true).unwrap();
    assert_eq!(ready.phase, ReceivedAdoptionPhase::PreviewReady);
    assert_eq!(ready.jobs.len(), 1);
    let job = ready.jobs[0].job_id.clone();
    std::fs::rename(&source_cwd, root.path().join("withheld-source-workspace")).unwrap();
    let overlay = root.path().join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let start = |workspace: &Path| {
        let mut builder = TestAppServer::builder(workspace, &overlay)
            .config_dir(&profile)
            .without_scenario()
            .discard_stderr();
        builder
            .extra_env
            .push(("HOME".into(), empty_home.as_os_str().into()));
        builder.spawn()
    };
    let initialize = |server: &mut TestAppServer| {
        rpc(
            server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"received-project-target","version":"test"}}),
        )
    };
    let mut server = start(&cwd);
    initialize(&mut server);
    let project_directory_existed = cwd.join(".kcoder").exists();
    let project_before = project_files(&cwd);
    let catalog = rpc(
        &mut server,
        20,
        "migration/project/mcp/catalog",
        json!({"jobId":job}),
    );
    assert_eq!(catalog["status"], "selection_required");
    assert_eq!(cwd.join(".kcoder").exists(), project_directory_existed);
    assert_eq!(project_files(&cwd), project_before);
    assert!(
        !catalog
            .to_string()
            .contains("SYNTHETIC_INHERITED_PRIVATE_VALUE")
    );
    if inherit_mcp {
        assert_eq!(catalog["names"].as_array().unwrap().len(), 10);
        assert_eq!(catalog["totalNames"], 13);
        let second = rpc(
            &mut server,
            21,
            "migration/project/mcp/catalog",
            json!({"jobId":job,"pageIndex":1,"expectedRevision":catalog["revision"]}),
        );
        assert_eq!(second["names"].as_array().unwrap().len(), 3);
        assert!(second["nextPageIndex"].is_null());
        server.send(json!({"jsonrpc":"2.0","id":22,"method":"migration/project/mcp/catalog","params":{"jobId":job,"pageIndex":1,"expectedRevision":"a".repeat(64)}}));
        assert_eq!(
            server.response(22)["error"]["message"],
            "migration_target_changed"
        );
    }
    let items = rpc(&mut server, 2, "migration/items", json!({"jobId":job}));
    let provider = items["providers"][0]["itemId"].clone();
    let mcp = items["mcps"][0]["itemId"].clone();
    let state = rpc(&mut server, 3, "migration/batch/read", json!({"jobId":job}));
    let mut choices = json!({"jobId":job,"expectedSequence":state["state"]["job"]["sequence"],"choices":[{"kind":"provider","itemId":provider,"targetName":"ReceivedProject","endpoint":null,"model":null,"contextWindowTokens":128000,"outputHeadroomTokens":8192,"maxOutputTokens":8192},{"kind":"mcp","itemId":mcp,"targetName":"project-docs","cwd":cwd,"enableAfterImport":false}],"includeDefaultItems":false});
    if inherit_mcp {
        choices["projectMcpInheritance"] =
            json!({"names":["inherited-11"],"expectedRevision":catalog["revision"]});
    }
    let planned = rpc(&mut server, 4, "migration/batch/plan", choices);
    assert_eq!(
        std::fs::read_to_string(profile.join("settings.json")).unwrap(),
        original
    );
    assert!(!cwd.join(".kcoder/settings.json").exists());
    let params = json!({"jobId":job,"planId":planned["batch"]["planId"],"requestId":"received-project-apply","expectedSequence":planned["job"]["sequence"],"mode":"apply"});
    let mut wrong = start(&foreign);
    initialize(&mut wrong);
    wrong.send(json!({"jsonrpc":"2.0","id":5,"method":"migration/batch/run","params":params}));
    assert_eq!(
        wrong.response(5)["error"]["message"],
        "migration_project_target_scope_changed"
    );
    drop(wrong);
    rpc(&mut server, 6, "migration/batch/run", params);
    let mut state = serde_json::Value::Null;
    for index in 0..200 {
        state = rpc(
            &mut server,
            100 + index,
            "migration/batch/read",
            json!({"jobId":job}),
        );
        if state["workerRunning"] == false {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(state["workerRunning"], false);
    assert_eq!(state["state"]["job"]["committedItems"], 2, "{state}");
    let raw: serde_json::Value =
        serde_json::from_slice(&std::fs::read(cwd.join(".kcoder/settings.json")).unwrap()).unwrap();
    assert!(raw["providers"].get("ReceivedProject").is_some());
    assert!(raw["providers"].get("User").is_none());
    assert!(raw.get("active_provider").is_none());
    assert_eq!(raw["mcp_servers"][0]["policy"]["workspace"], json!(cwd));
    assert!(
        !raw.to_string()
            .contains("SYNTHETIC_INHERITED_PRIVATE_VALUE")
    );
    if inherit_mcp {
        assert_eq!(raw["mcp_inherited_servers"], json!(["inherited-11"]));
    }
    assert_eq!(
        std::fs::read_to_string(profile.join("settings.json")).unwrap(),
        original
    );
    drop(server);
    let mut server = start(&cwd);
    initialize(&mut server);
    let reopened = rpc(&mut server, 7, "migration/batch/read", json!({"jobId":job}));
    rpc(
        &mut server,
        8,
        "migration/batch/run",
        json!({"jobId":job,"planId":planned["batch"]["planId"],"requestId":"received-project-undo","expectedSequence":reopened["state"]["job"]["sequence"],"mode":"rollback"}),
    );
    for index in 0..200 {
        state = rpc(
            &mut server,
            400 + index,
            "migration/batch/read",
            json!({"jobId":job}),
        );
        if state["workerRunning"] == false {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(state["state"]["job"]["status"], "rolled_back", "{state}");
    assert_eq!(
        std::fs::read_to_string(profile.join("settings.json")).unwrap(),
        original
    );
    assert_eq!(
        std::fs::read_to_string(
            root.path()
                .join("withheld-source-workspace/.claude/settings.json")
        )
        .unwrap(),
        source_bytes
    );
}
