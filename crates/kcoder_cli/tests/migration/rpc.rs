use super::{TestAppServer, Value, json};
#[path = "batch_mcp_credentials_rpc.rs"]
mod batch_mcp_credentials;
#[path = "codex_layers_rpc.rs"]
mod codex_layers;
#[path = "configuration_layers_rpc.rs"]
mod configuration_layers;
#[path = "credentials_rpc.rs"]
mod credentials;
#[path = "definitions_rpc.rs"]
mod definitions;
#[path = "history_rpc.rs"]
mod history;
#[path = "mcp_credentials_rpc.rs"]
mod mcp_credentials;
#[path = "memory_rpc.rs"]
mod memory;
#[path = "memory_snapshot_rpc.rs"]
mod memory_snapshot;
#[path = "profiles_rpc.rs"]
mod profiles;
#[path = "project_settings_rpc.rs"]
mod project_settings;
#[path = "projects_rpc.rs"]
mod projects;
#[path = "source_bindings_rpc.rs"]
mod source_bindings;
#[path = "source_directory_rpc.rs"]
mod source_directory;
#[path = "source_product_rpc.rs"]
mod source_product;
#[path = "source_upload_rpc.rs"]
mod source_upload;

fn rpc(server: &mut TestAppServer, id: i64, method: &str, params: Value) -> Value {
    server.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
    let response = server.response(id);
    assert!(response.get("error").is_none(), "{response}");
    response["result"].clone()
}

#[test]
fn migration_rpc_batch_survives_restart_and_pages_records_without_executing_sources() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let profile = root.path().join("profile");
    let claude = root.path().join("claude");
    for directory in [&workspace, &profile, &claude] {
        std::fs::create_dir(directory).unwrap();
    }
    std::fs::write(profile.join("settings.json"), "{}").unwrap();
    let overlay = workspace.join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let helper = claude.join("source-helper.sh");
    std::fs::write(&helper, "printf invoked > \"$0.marker\"\n").unwrap();
    std::fs::write(
        claude.join("settings.json"),
        json!({"mcpServers":{"documents":{"command":"sh","args":[helper]}}}).to_string(),
    )
    .unwrap();
    std::fs::write(
        claude.join("CLAUDE.md"),
        "Preserve the original source files.",
    )
    .unwrap();
    for index in 0..12 {
        let skill = claude.join(format!("skills/sample-{index}"));
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            format!(
                "---\nname: sample-{index}\ndescription: Source fixture\n---\nInspect the evidence."
            ),
        )
        .unwrap();
    }
    let start = || {
        let mut builder = TestAppServer::builder(&workspace, &overlay)
            .config_dir(&profile)
            .discard_stderr();
        for (name, path) in [
            ("HOME", root.path()),
            ("USERPROFILE", root.path()),
            ("CLAUDE_CONFIG_DIR", claude.as_path()),
            ("CODEX_HOME", root.path()),
        ] {
            builder
                .extra_env
                .push((name.into(), path.as_os_str().into()));
        }
        builder.spawn()
    };
    let initialize = |server: &mut TestAppServer| {
        rpc(
            server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"batch-migration-fixture","version":"test"}}),
        )
    };
    let mut server = start();
    let initialized = initialize(&mut server);
    assert_eq!(
        initialized["capabilities"]["experimental"]["migrationBatchV1"],
        true
    );
    assert!(
        rpc(&mut server, 2, "migration/jobs/list", json!({}))["jobs"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let discovered = rpc(
        &mut server,
        3,
        "migration/discover",
        json!({"sources":["claude-code"]}),
    );
    let source_ids = discovered["sources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|source| source["sourceId"].clone())
        .collect::<Vec<_>>();
    let scanned = rpc(
        &mut server,
        4,
        "migration/batch/scan",
        json!({"sourceIds":source_ids}),
    );
    let job = scanned["job"]["jobId"].as_str().unwrap().to_owned();
    assert_eq!(scanned["job"]["totalItems"], 14);
    assert_eq!(
        scanned["batch"]["defaultItemIds"].as_array().unwrap().len(),
        14
    );
    let page = rpc(
        &mut server,
        5,
        "migration/items",
        json!({"jobId":job,"pageIndex":1}),
    );
    assert_eq!(page["items"].as_array().unwrap().len(), 4);
    let staged = rpc(
        &mut server,
        6,
        "migration/batch/plan",
        json!({"jobId":job,"expectedSequence":scanned["job"]["sequence"],"choices":[],"includeDefaultItems":true}),
    );
    let plan = staged["batch"]["planId"].clone();
    assert_eq!(staged["batch"]["selectedItems"], 14);
    assert_eq!(
        kcoder_config::read_settings_file(&profile.join("settings.json")).unwrap(),
        json!({})
    );
    drop(server);
    let mut server = start();
    initialize(&mut server);
    let current = rpc(&mut server, 7, "migration/read", json!({"jobId":job}));
    assert_eq!(current["batch"]["planId"], plan);
    let applied = rpc(
        &mut server,
        8,
        "migration/batch/apply",
        json!({"jobId":job,"planId":plan,"requestId":"batch-request","expectedSequence":current["job"]["sequence"]}),
    );
    assert_eq!(applied["job"]["committedItems"], 14);
    let records = rpc(&mut server, 9, "migration/jobs/list", json!({}));
    assert_eq!(records["jobs"][0]["job"]["jobId"], job);
    assert_eq!(records["jobs"][0]["isBatch"], true);
    assert!(!records.to_string().contains(root.path().to_str().unwrap()));
    let repeated = rpc(
        &mut server,
        10,
        "migration/batch/apply",
        json!({"jobId":job,"planId":plan,"requestId":"batch-request","expectedSequence":staged["job"]["sequence"]}),
    );
    assert_eq!(repeated, applied);
    let discovered = rpc(
        &mut server,
        20,
        "migration/discover",
        json!({"sources":["claude-code"]}),
    );
    let ids = discovered["sources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|source| source["sourceId"].clone())
        .collect::<Vec<_>>();
    let next = rpc(
        &mut server,
        21,
        "migration/batch/scan",
        json!({"sourceIds":ids}),
    );
    let next_job = next["job"]["jobId"].clone();
    let next = rpc(
        &mut server,
        22,
        "migration/batch/plan",
        json!({"jobId":next_job,"expectedSequence":next["job"]["sequence"],"choices":[],"includeDefaultItems":true,"reuseExisting":true}),
    );
    let reused = rpc(
        &mut server,
        23,
        "migration/batch/apply",
        json!({"jobId":next_job,"planId":next["batch"]["planId"],"expectedSequence":next["job"]["sequence"],"requestId":"reuse-confirmed-results"}),
    );
    assert_eq!(reused["batch"]["reusedItems"], 14);
    assert_eq!(reused["job"]["committedItems"], 0);
    let blocked = rpc(
        &mut server,
        24,
        "migration/batch/rollback",
        json!({"jobId":job,"planId":plan,"requestId":"blocked-original-undo","expectedSequence":applied["job"]["sequence"]}),
    );
    assert_eq!(blocked["job"]["status"], "rollback_conflict");
    let released = rpc(
        &mut server,
        25,
        "migration/batch/rollback",
        json!({"jobId":next_job,"planId":next["batch"]["planId"],"expectedSequence":reused["job"]["sequence"],"requestId":"release-reuse-only"}),
    );
    assert_eq!(released["job"]["status"], "rolled_back");
    let applied = blocked;
    let undone = rpc(
        &mut server,
        11,
        "migration/batch/rollback",
        json!({"jobId":job,"planId":plan,"requestId":"undo-batch-request","expectedSequence":applied["job"]["sequence"]}),
    );
    assert_eq!(undone["job"]["status"], "rolled_back");
    assert_eq!(
        kcoder_config::read_settings_file(&profile.join("settings.json")).unwrap(),
        json!({})
    );
    assert!(!helper.with_extension("sh.marker").exists());
    assert!(claude.join("skills/sample-0/SKILL.md").is_file());
    let store = kcoder_migration::store::MigrationStore::open_existing(&profile).unwrap();
    let legacy = store
        .create_scan(
            "PRIVATE_SOURCE_DIGEST_CANARY",
            kcoder_migration::parse_claude_settings("{\"mcpServers\":{}}").unwrap(),
        )
        .unwrap();
    let projected = rpc(
        &mut server,
        12,
        "migration/read",
        json!({"jobId":legacy.job_id}),
    );
    assert!(
        !projected
            .to_string()
            .contains("PRIVATE_SOURCE_DIGEST_CANARY")
    );
}

#[test]
fn migration_rpc_work_assets_use_bounded_previews_native_skills_and_durable_undo() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let profile = root.path().join("profile");
    let claude = root.path().join("claude");
    for directory in [&workspace, &profile, &claude] {
        std::fs::create_dir(directory).unwrap();
    }
    let skill = claude.join("skills/review-api");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(skill.join("SKILL.md"),"---\nname: review-api\ndescription: Review API requests\n---\nReview $ARGUMENTS with evidence.").unwrap();
    std::fs::write(skill.join("helper.sh"), "exit 51\n").unwrap();
    let instructions = "迁移指令原文\n".repeat(12000);
    std::fs::write(claude.join("CLAUDE.md"), &instructions).unwrap();
    let overlay = workspace.join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    std::fs::write(profile.join("settings.json"), "{}").unwrap();
    let start = || {
        let mut builder = TestAppServer::builder(&workspace, &overlay)
            .config_dir(&profile)
            .discard_stderr();
        for (key, path) in [
            ("HOME", root.path()),
            ("USERPROFILE", root.path()),
            ("CLAUDE_CONFIG_DIR", claude.as_path()),
            ("CODEX_HOME", root.path()),
        ] {
            builder
                .extra_env
                .push((key.into(), path.as_os_str().into()));
        }
        builder.spawn()
    };
    let mut server = start();
    let initialized = rpc(
        &mut server,
        1,
        "initialize",
        json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"asset-migration-fixture","version":"test"}}),
    );
    assert_eq!(
        initialized["capabilities"]["experimental"]["migrationAssetsV1"],
        true
    );
    let discovered = rpc(
        &mut server,
        2,
        "migration/discover",
        json!({"sources":["claude-code"]}),
    );
    let sources = discovered["sources"].as_array().unwrap();
    let instruction_source = sources
        .iter()
        .find(|source| source["scope"] == "user-instructions")
        .unwrap();
    let scanned = rpc(
        &mut server,
        3,
        "migration/scan",
        json!({"sourceId":instruction_source["sourceId"]}),
    );
    let job = scanned["job"]["jobId"].as_str().unwrap();
    let page = rpc(&mut server, 4, "migration/items", json!({"jobId":job}));
    let item = &page["assets"][0]["itemId"];
    assert!(!page.to_string().contains("迁移指令原文"));
    let preview = rpc(
        &mut server,
        5,
        "migration/asset/preview",
        json!({"jobId":job,"itemId":item}),
    );
    assert!(preview["text"].as_str().unwrap().len() <= 64 * 1024);
    assert_eq!(preview["totalBytes"], instructions.len());
    let next = preview["nextOffset"].as_u64().unwrap();
    let second = rpc(
        &mut server,
        6,
        "migration/asset/preview",
        json!({"jobId":job,"itemId":item,"offset":next}),
    );
    assert_eq!(
        format!(
            "{}{}",
            preview["text"].as_str().unwrap(),
            second["text"].as_str().unwrap()
        ),
        instructions[..second["nextOffset"].as_u64().unwrap() as usize]
    );
    let source = sources
        .iter()
        .find(|source| source["scope"] == "user-skills")
        .unwrap();
    let scanned = rpc(
        &mut server,
        7,
        "migration/scan",
        json!({"sourceId":source["sourceId"]}),
    );
    let job = scanned["job"]["jobId"].as_str().unwrap().to_owned();
    let page = rpc(&mut server, 8, "migration/items", json!({"jobId":job}));
    let staged = rpc(
        &mut server,
        9,
        "migration/asset/plan",
        json!({"jobId":job,"itemId":page["assets"][0]["itemId"],"targetName":"imported-review-api","expectedSequence":scanned["job"]["sequence"]}),
    );
    let plan = staged["assetPlans"][0]["planId"].clone();
    assert!(!staged.to_string().contains("Review $ARGUMENTS"));
    let applied = rpc(
        &mut server,
        10,
        "migration/asset/apply",
        json!({"jobId":job,"planId":plan,"expectedSequence":staged["job"]["sequence"]}),
    );
    assert_eq!(applied["job"]["status"], "completed");
    let imported =
        kcoder_skills::parse_skill_file(&profile.join("skills/imported-review-api/SKILL.md"))
            .unwrap();
    assert!(!imported.activation.unwrap().default_enabled);
    assert!(
        profile
            .join("skills/imported-review-api/helper.sh")
            .is_file()
    );
    drop(server);
    let mut server = start();
    rpc(
        &mut server,
        11,
        "initialize",
        json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"asset-migration-restart","version":"test"}}),
    );
    let undone = rpc(
        &mut server,
        12,
        "migration/asset/rollback",
        json!({"jobId":job,"planId":plan,"expectedSequence":applied["job"]["sequence"]}),
    );
    assert_eq!(undone["job"]["status"], "rolled_back");
    assert!(!profile.join("skills/imported-review-api").exists());
    assert!(skill.join("helper.sh").is_file());
    assert_eq!(
        std::fs::read_to_string(claude.join("CLAUDE.md")).unwrap(),
        instructions
    );
}

#[test]
fn migration_rpc_discovers_pages_imports_and_rolls_back_without_executing_source_tools() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let profile = root.path().join("profile");
    let claude = root.path().join("claude-fixture");
    let codex = root.path().join("codex-fixture");
    for directory in [&workspace, &profile, &claude, &codex] {
        std::fs::create_dir(directory).unwrap();
    }
    let mut servers = serde_json::Map::new();
    for index in 0..14 {
        servers.insert(
            format!("fixture-{index}"),
            json!({"command":"never-run-this-source-command"}),
        );
    }
    #[cfg(unix)]
    {
        let probe = claude.join("source-helper.sh");
        std::fs::write(&probe, "printf invoked > \"$0.marker\"\n").unwrap();
        servers.insert(
            "fixture-0".into(),
            json!({"command":"/bin/sh","args":[probe]}),
        );
    }
    let source = json!({"model":"claude-fixture-model", "env":{"ANTHROPIC_BASE_URL":"https://example.invalid", "ANTHROPIC_API_KEY":"SYNTHETIC_SOURCE_CREDENTIAL_CANARY"}, "mcpServers":servers});
    std::fs::write(claude.join("settings.json"), source.to_string()).unwrap();
    std::fs::write(codex.join("config.toml"), "model='codex-fixture-model'\nmodel_provider='Team'\n[model_providers.Team]\nbase_url='https://example.invalid/v1'\nwire_api='responses'\n[mcp_servers.documents]\ncommand='never-run-this-source-command'\nenabled_tools=['read']\ndisabled_tools=['write']\n").unwrap();
    std::fs::write(codex.join("auth.json"), "must not be opened or parsed").unwrap();
    let overlay = workspace.join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let user = profile.join("settings.json");
    std::fs::write(&user, "{}").unwrap();
    let start = || {
        let mut builder = TestAppServer::builder(&workspace, &overlay)
            .config_dir(&profile)
            .discard_stderr();
        for (name, path) in [
            ("HOME", root.path()),
            ("USERPROFILE", root.path()),
            ("CLAUDE_CONFIG_DIR", claude.as_path()),
            ("CODEX_HOME", codex.as_path()),
        ] {
            builder
                .extra_env
                .push((name.into(), path.as_os_str().into()));
        }
        builder.spawn()
    };
    let mut server = start();
    let initialized = rpc(
        &mut server,
        1,
        "initialize",
        json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"migration-fixture","version":"test"}}),
    );
    assert_eq!(
        initialized["capabilities"]["experimental"]["migrationProvidersV1"],
        true
    );
    assert_ne!(
        initialized["capabilities"]["experimental"]["migrationV1"],
        true
    );
    let discovered = rpc(&mut server, 2, "migration/discover", json!({}));
    assert_eq!(discovered["sources"].as_array().unwrap().len(), 2);
    let public = discovered.to_string();
    assert!(!public.contains(root.path().to_str().unwrap()));
    assert!(!public.contains("SYNTHETIC_SOURCE_CREDENTIAL_CANARY"));
    let mut request_id = 10;
    for kind in ["claude-code", "codex"] {
        let selected = discovered["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|source| source["kind"] == kind)
            .unwrap();
        let scanned = rpc(
            &mut server,
            request_id,
            "migration/scan",
            json!({"sourceId":selected["sourceId"]}),
        );
        request_id += 1;
        let job_id = scanned["job"]["jobId"].as_str().unwrap().to_owned();
        let page = rpc(
            &mut server,
            request_id,
            "migration/items",
            json!({"jobId":job_id}),
        );
        request_id += 1;
        assert!(
            !page
                .to_string()
                .contains("SYNTHETIC_SOURCE_CREDENTIAL_CANARY")
        );
        assert!(
            page["mcps"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item.get("command").is_some())
        );
        if kind == "claude-code" {
            assert_eq!(page["items"].as_array().unwrap().len(), 10);
            let next = rpc(
                &mut server,
                request_id,
                "migration/items",
                json!({"jobId":job_id,"cursor":page["nextCursor"]}),
            );
            request_id += 1;
            assert_eq!(next["items"].as_array().unwrap().len(), 5);
            assert!(next.get("nextCursor").is_none());
        }
        let item_id = page["providers"][0]["itemId"].clone();
        let target_name = if kind == "codex" {
            "ImportedCodex"
        } else {
            "ImportedClaude"
        };
        // Notifications cannot plan or write anything, even with otherwise valid input.
        let params = json!({"jobId":job_id,"expectedSequence":scanned["job"]["sequence"],"itemId":item_id,"targetName":target_name,"contextWindowTokens":128000,"outputHeadroomTokens":8192,"maxOutputTokens":8192});
        server.send(json!({"jsonrpc":"2.0","method":"migration/provider/plan","params":params}));
        let unchanged = rpc(
            &mut server,
            request_id,
            "migration/read",
            json!({"jobId":job_id}),
        );
        request_id += 1;
        assert_eq!(unchanged["job"]["sequence"], scanned["job"]["sequence"]);
        let planned = rpc(&mut server, request_id, "migration/provider/plan", params);
        request_id += 1;
        if kind == "codex" {
            drop(server);
            server = start();
            rpc(
                &mut server,
                1,
                "initialize",
                json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"migration-reconnect-fixture","version":"test"}}),
            );
            assert_eq!(
                rpc(
                    &mut server,
                    request_id,
                    "migration/read",
                    json!({"jobId":job_id})
                ),
                planned
            );
            request_id += 1;
        }
        let applied_params = json!({"jobId":job_id,"planId":planned["plans"][0]["planId"],"expectedSequence":planned["job"]["sequence"]});
        let applied = rpc(
            &mut server,
            request_id,
            "migration/provider/apply",
            applied_params.clone(),
        );
        request_id += 1;
        assert_eq!(applied["job"]["status"], "completed_with_issues");
        assert_eq!(applied["job"]["committedItems"], 1);
        let document = kcoder_config::read_settings_file(&user).unwrap();
        // The built-in catalog is empty since 92bb219fb, so the prior selection
        // is "none". It is pinned as an explicit null so that importing the only
        // provider cannot silently select it (migration_default_selection_changed).
        assert!(document["active_provider"].is_null(), "{document}");
        assert!(
            document
                .as_object()
                .unwrap()
                .contains_key("active_provider")
        );
        assert!(document["providers"][target_name].is_object());
        assert_eq!(
            rpc(
                &mut server,
                request_id,
                "migration/provider/apply",
                applied_params
            ),
            applied
        );
        request_id += 1;
        let rolled_back = rpc(
            &mut server,
            request_id,
            "migration/provider/rollback",
            json!({"jobId":job_id,"planId":planned["plans"][0]["planId"],"expectedSequence":applied["job"]["sequence"]}),
        );
        request_id += 1;
        assert_eq!(rolled_back["job"]["status"], "rolled_back");
        assert_eq!(kcoder_config::read_settings_file(&user).unwrap(), json!({}));
        let found = rpc(
            &mut server,
            request_id,
            "migration/discover",
            json!({"sources":[kind]}),
        );
        request_id += 1;
        let scanned = rpc(
            &mut server,
            request_id,
            "migration/scan",
            json!({"sourceId":found["sources"][0]["sourceId"]}),
        );
        request_id += 1;
        let mcp_job = scanned["job"]["jobId"].clone();
        let page = rpc(
            &mut server,
            request_id,
            "migration/items",
            json!({"jobId":mcp_job}),
        );
        request_id += 1;
        let mcp = page["mcps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["command"] == "never-run-this-source-command")
            .unwrap();
        let staged = rpc(
            &mut server,
            request_id,
            "migration/mcp/plan",
            json!({"jobId":mcp_job,"expectedSequence":scanned["job"]["sequence"],"itemId":mcp["itemId"],"targetName":"ImportedDocuments"}),
        );
        request_id += 1;
        let params = json!({"jobId":mcp_job,"planId":staged["mcpPlans"][0]["planId"],"expectedSequence":staged["job"]["sequence"]});
        let applied = rpc(
            &mut server,
            request_id,
            "migration/mcp/apply",
            params.clone(),
        );
        request_id += 1;
        assert_eq!(applied["job"]["committedItems"], 1);
        let document = kcoder_config::read_settings_file(&user).unwrap();
        assert_eq!(
            document["mcp_servers"][0]["command"],
            "never-run-this-source-command"
        );
        assert_eq!(
            document["mcp_disabled_servers"],
            json!(["ImportedDocuments"])
        );
        assert_eq!(
            rpc(&mut server, request_id, "migration/mcp/apply", params),
            applied
        );
        request_id += 1;
        let restored = rpc(
            &mut server,
            request_id,
            "migration/mcp/rollback",
            json!({"jobId":mcp_job,"planId":staged["mcpPlans"][0]["planId"],"expectedSequence":applied["job"]["sequence"]}),
        );
        request_id += 1;
        assert_eq!(restored["job"]["status"], "rolled_back");
        assert_eq!(kcoder_config::read_settings_file(&user).unwrap(), json!({}));
    }
    server.send(json!({"jsonrpc":"2.0","id":request_id,"method":"migration/scan","params":{"sourceId":"forged","path":"/another-account/auth.json"}}));
    assert!(server.response(request_id).get("error").is_some());
    assert_eq!(
        std::fs::read_to_string(claude.join("settings.json")).unwrap(),
        source.to_string()
    );
    assert_eq!(
        std::fs::read_to_string(codex.join("auth.json")).unwrap(),
        "must not be opened or parsed"
    );
    assert!(!claude.join("source-helper.sh.marker").exists());
}
