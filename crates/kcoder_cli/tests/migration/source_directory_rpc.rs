use super::{TestAppServer, json, rpc};
use kcoder_app_protocol::method;

#[test]
fn explicit_directory_rpc_never_falls_back_after_failure_and_preserves_the_original_selection() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let profile = root.path().join("profile");
    let default = root.path().join("default-claude");
    let selected = root.path().join("selected-product");
    for directory in [&workspace, &profile, &default] {
        std::fs::create_dir(directory).unwrap();
    }
    std::fs::write(profile.join("settings.json"), "{}").unwrap();
    let overlay = workspace.join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let config = |model: &str| {
        json!({"env":{"ANTHROPIC_BASE_URL":"https://example.invalid/v1","ANTHROPIC_MODEL":model}})
            .to_string()
    };
    std::fs::write(
        default.join("settings.json"),
        config("DefaultMustNotBeSelected"),
    )
    .unwrap();
    let start = || {
        let mut builder = TestAppServer::builder(&workspace, &overlay)
            .config_dir(&profile)
            .without_scenario()
            .discard_stderr();
        for (key, path) in [
            ("HOME", root.path()),
            ("USERPROFILE", root.path()),
            ("CLAUDE_CONFIG_DIR", default.as_path()),
            ("CODEX_HOME", root.path()),
        ] {
            builder
                .extra_env
                .push((key.into(), path.as_os_str().into()));
        }
        builder.spawn()
    };
    let initialize = |server: &mut TestAppServer| {
        rpc(
            server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"directory-source-fixture","version":"test"}}),
        )
    };
    let choice = json!({"selectionId":"11111111-1111-4111-8111-111111111111","source":"claude-code","directory":selected});
    let mut server = start();
    assert_eq!(
        initialize(&mut server)["capabilities"]["experimental"]["migrationSourceDirectoryV1"],
        true
    );
    server.send(json!({"jsonrpc":"2.0","id":2,"method":method::MIGRATION_SOURCE_DIRECTORY_SELECT,"params":choice}));
    assert_eq!(
        server.response(2)["error"]["message"],
        "migration_selected_root_unavailable"
    );
    for (id, method, params) in [
        (
            3,
            method::MIGRATION_DISCOVER,
            json!({"sources":["claude-code"]}),
        ),
        (
            4,
            method::MIGRATION_HISTORY_DISCOVER,
            json!({"source":"claude-code"}),
        ),
        (
            5,
            method::MIGRATION_PLUGIN_DISCOVER,
            json!({"sources":["claude-code"]}),
        ),
    ] {
        server.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        let response = server.response(id);
        // The existing plugin boundary keeps its own bounded error projection.
        let expected = if method == method::MIGRATION_PLUGIN_DISCOVER {
            "plugin_migration_outcome_unknown"
        } else {
            "migration_selected_root_unavailable"
        };
        assert_eq!(response["error"]["message"], expected, "{response}");
        assert!(response.get("result").is_none());
    }
    assert!(!selected.exists());
    std::fs::create_dir(&selected).unwrap();
    std::fs::write(
        selected.join("settings.json"),
        config("ExplicitlySelectedModel"),
    )
    .unwrap();
    std::fs::write(
        selected.join("CLAUDE.md"),
        "Static selected instructions.\n",
    )
    .unwrap();
    std::fs::write(
        selected.join(".credentials.json"),
        "AUTH_FILE_MUST_NOT_BE_PARSED",
    )
    .unwrap();
    let first = rpc(
        &mut server,
        6,
        method::MIGRATION_SOURCE_DIRECTORY_SELECT,
        choice.clone(),
    );
    let again = rpc(
        &mut server,
        7,
        method::MIGRATION_SOURCE_DIRECTORY_SELECT,
        choice.clone(),
    );
    assert_eq!(first["selectionId"], again["selectionId"]);
    assert!(again["remainingMs"].as_u64().unwrap() <= first["remainingMs"].as_u64().unwrap());
    let found = rpc(
        &mut server,
        8,
        method::MIGRATION_DISCOVER,
        json!({"sources":["claude-code"]}),
    );
    assert!(found["problems"].as_array().unwrap().is_empty());
    let rows = found["sources"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    let source_id = rows.iter().find(|row| row["scope"] == "user").unwrap()["sourceId"].clone();
    let scanned = rpc(
        &mut server,
        9,
        method::MIGRATION_SCAN,
        json!({"sourceId":source_id}),
    );
    let job_id = scanned["job"]["jobId"].as_str().unwrap();
    let store = kcoder_migration::store::MigrationStore::open_existing(&profile).unwrap();
    let job = store.read(job_id).unwrap();
    assert_eq!(
        job.inventory
            .items
            .iter()
            .find_map(|item| item.provider.as_ref())
            .unwrap()
            .model
            .as_deref(),
        Some("ExplicitlySelectedModel")
    );
    assert_eq!(std::fs::read(profile.join("settings.json")).unwrap(), b"{}");
    assert_eq!(
        std::fs::read(selected.join(".credentials.json")).unwrap(),
        b"AUTH_FILE_MUST_NOT_BE_PARSED"
    );
    let moved = root.path().join("previous");
    std::fs::rename(&selected, &moved).unwrap();
    std::fs::create_dir(&selected).unwrap();
    std::fs::rename(moved.join("settings.json"), selected.join("settings.json")).unwrap();
    server.send(json!({"jsonrpc":"2.0","id":10,"method":method::MIGRATION_SOURCE_DIRECTORY_SELECT,"params":choice}));
    assert_eq!(
        server.response(10)["error"]["message"],
        "migration_selected_root_changed"
    );
    let unavailable = rpc(
        &mut server,
        11,
        method::MIGRATION_DISCOVER,
        json!({"sources":["claude-code"]}),
    );
    assert!(unavailable["sources"].as_array().unwrap().is_empty());
    assert_eq!(
        unavailable["problems"][0]["code"],
        "migration_selected_root_unavailable"
    );
    let mut changed = choice;
    changed["directory"] = json!(default);
    server.send(json!({"jsonrpc":"2.0","id":12,"method":method::MIGRATION_SOURCE_DIRECTORY_SELECT,"params":changed}));
    assert_eq!(
        server.response(12)["error"]["message"],
        "migration_selected_root_selection_changed"
    );
}

#[test]
fn selected_product_directory_separately_authorizes_the_actual_trusted_workspace() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let profile = root.path().join("profile");
    let product = root.path().join("selected");
    for directory in [&workspace, &profile, &product] {
        std::fs::create_dir(directory).unwrap();
    }
    std::fs::create_dir(workspace.join(".claude")).unwrap();
    std::fs::write(profile.join("settings.json"), "{}").unwrap();
    std::fs::write(
        profile.join("trusted-folders.json"),
        json!({"trusted":[workspace],"never":[]}).to_string(),
    )
    .unwrap();
    std::fs::write(
        product.join("settings.json"),
        r#"{"model":"selected-user","env":{"ANTHROPIC_BASE_URL":"https://never-call.invalid/v1"}}"#,
    )
    .unwrap();
    std::fs::write(
        workspace.join(".claude/settings.json"),
        r#"{"model":"selected-project"}"#,
    )
    .unwrap();
    let overlay = workspace.join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let mut builder = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&profile)
        .without_scenario()
        .discard_stderr();
    for key in ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] {
        builder
            .extra_env
            .push((key.into(), root.path().as_os_str().into()));
    }
    let mut server = builder.spawn();
    rpc(
        &mut server,
        1,
        "initialize",
        json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"selected-workspace-fixture","version":"test"}}),
    );
    rpc(
        &mut server,
        2,
        method::MIGRATION_SOURCE_DIRECTORY_SELECT,
        json!({"selectionId":"11111111-1111-4111-8111-111111111111","source":"claude-code","directory":product}),
    );
    let user = rpc(
        &mut server,
        3,
        method::MIGRATION_DISCOVER,
        json!({"sources":["claude-code"],"includeProject":false}),
    );
    assert!(
        user["sources"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| !row["scope"].as_str().unwrap().starts_with("project"))
    );
    let found = rpc(
        &mut server,
        4,
        method::MIGRATION_DISCOVER,
        json!({"sources":["claude-code"],"includeProject":true}),
    );
    assert!(found["problems"].as_array().unwrap().is_empty(), "{found}");
    let layered = found["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["scope"] == "project-effective")
        .unwrap();
    let report = rpc(
        &mut server,
        5,
        method::MIGRATION_CONFIGURATION_LAYERS,
        json!({"target":{"kind":"source","sourceId":layered["sourceId"]},"pageIndex":0}),
    );
    assert_eq!(report["status"], "available");
    assert_eq!(report["layers"].as_array().unwrap().len(), 3);
    assert!(report["fields"].as_array().unwrap().iter().any(|field| {
        field["field"] == "/model"
            && field["scopes"]
                .as_array()
                .is_some_and(|scopes| scopes.iter().any(|scope| scope == "project"))
    }));
    kcoder_config::FolderTrustStore::load(&profile)
        .revoke(&workspace)
        .unwrap();
    server.send(json!({"jsonrpc":"2.0","id":6,"method":method::MIGRATION_DISCOVER,"params":{"sources":["claude-code"],"includeProject":true}}));
    assert_eq!(
        server.response(6)["error"]["message"],
        "migration_project_source_not_trusted"
    );
    server.send(json!({"jsonrpc":"2.0","id":7,"method":method::MIGRATION_SCAN,"params":{"sourceId":layered["sourceId"]}}));
    assert!(
        server.response(7).get("error").is_some(),
        "old discovered layers do not bypass fresh trust"
    );
    assert_eq!(std::fs::read(profile.join("settings.json")).unwrap(), b"{}");
}
