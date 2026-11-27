use super::{TestAppServer, Value, json, rpc};

#[test]
fn migration_configuration_layers_rpc_pages_saved_origins_without_source_or_private_values() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let profile = root.path().join("profile");
    let claude = root.path().join("claude");
    for path in [&workspace, &profile, &claude, &workspace.join(".claude")] {
        std::fs::create_dir_all(path).unwrap();
    }
    std::fs::write(profile.join("settings.json"), "{}").unwrap();
    let overlay = workspace.join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let mut settings =
        json!({"model":"base-model","env":{"ANTHROPIC_API_KEY":"SYNTHETIC_PRIVATE_LOWER_CANARY"}});
    for i in 0..13 {
        settings[format!("PRIVATE_UNKNOWN_FIELD_CANARY_{i}")] = json!(true);
    }
    std::fs::write(claude.join("settings.json"), settings.to_string()).unwrap();
    std::fs::write(workspace.join(".claude/settings.local.json"), json!({"model":"local-model","env":{"ANTHROPIC_API_KEY":"SYNTHETIC_PRIVATE_WINNER_CANARY"}}).to_string()).unwrap();
    let start = || {
        let mut builder = TestAppServer::builder(&workspace, &overlay)
            .config_dir(&profile)
            .without_scenario()
            .discard_stderr();
        for (key, value) in [
            ("HOME", root.path()),
            ("USERPROFILE", root.path()),
            ("CLAUDE_CONFIG_DIR", claude.as_path()),
            ("CODEX_HOME", root.path()),
        ] {
            builder
                .extra_env
                .push((key.into(), value.as_os_str().into()));
        }
        builder.spawn()
    };
    let initialize = |server: &mut TestAppServer| {
        rpc(
            server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"layer-report-fixture","version":"test"}}),
        )
    };
    let mut server = start();
    assert_eq!(
        initialize(&mut server)["capabilities"]["experimental"]["migrationConfigurationLayersV1"],
        true
    );
    let sources = rpc(
        &mut server,
        2,
        "migration/discover",
        json!({"sources":["claude-code"],"includeProject":true}),
    );
    assert!(!sources.to_string().contains("snapshotReport"));
    let source = sources["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|source| source["scope"] == "project-effective")
        .unwrap()["sourceId"]
        .clone();
    let target = json!({"kind":"source","sourceId":source});
    let first = rpc(
        &mut server,
        3,
        "migration/configuration/layers",
        json!({"target":target}),
    );
    assert_eq!(first["fields"].as_array().unwrap().len(), 10);
    assert_eq!(first["nextPage"], 1);
    assert_eq!(first["layers"][1]["present"], false);
    let second = rpc(
        &mut server,
        4,
        "migration/configuration/layers",
        json!({"target":target,"pageIndex":1}),
    );
    assert!(second["fields"].as_array().unwrap().len() <= 10);
    assert_eq!(second["nextPage"], Value::Null);
    let all = [
        first["fields"].as_array().unwrap().clone(),
        second["fields"].as_array().unwrap().clone(),
    ]
    .concat();
    let private = all
        .iter()
        .find(|field| field["field"] == "/env/ANTHROPIC_API_KEY")
        .unwrap();
    assert_eq!(private["scopes"], json!(["local"]));
    assert_eq!(private["private"], true);
    let scan = rpc(
        &mut server,
        5,
        "migration/batch/scan",
        json!({"sourceIds":[source]}),
    );
    let job = scan["job"]["jobId"].clone();
    let items = rpc(&mut server, 6, "migration/items", json!({"jobId":job}));
    let item = items["providers"][0]["itemId"].clone();
    assert!(item.is_string(), "{items}");
    let saved = json!({"kind":"job","jobId":job,"itemId":item});
    let original = rpc(
        &mut server,
        7,
        "migration/configuration/layers",
        json!({"target":saved}),
    );
    let before = std::fs::read(profile.join("settings.json")).unwrap();
    drop(server);
    std::fs::rename(&claude, root.path().join("withheld-source")).unwrap();
    std::fs::rename(
        workspace.join(".claude"),
        root.path().join("withheld-project"),
    )
    .unwrap();
    let mut server = start();
    initialize(&mut server);
    let recovered = rpc(
        &mut server,
        8,
        "migration/configuration/layers",
        json!({"target":saved}),
    );
    assert_eq!(recovered, original);
    let legacy_read = rpc(&mut server, 9, "migration/read", json!({"jobId":job}));
    assert!(!legacy_read.to_string().contains("snapshotReport"));
    assert!(!legacy_read.to_string().contains("configurationLayers"));
    server.send(json!({"jsonrpc":"2.0","id":10,"method":"migration/configuration/layers","params":{"target":target}}));
    assert!(server.response(10).get("error").is_some());
    server.send(json!({"jsonrpc":"2.0","id":11,"method":"migration/configuration/layers","params":{"target":saved,"path":root.path()}}));
    assert_eq!(
        server.response(11)["error"]["message"],
        "migration_invalid_parameters"
    );
    let public = [&first, &second, &recovered, &legacy_read]
        .iter()
        .map(|value| value.to_string())
        .collect::<String>();
    for private in [
        "SYNTHETIC_PRIVATE",
        "PRIVATE_UNKNOWN_FIELD_CANARY",
        root.path().to_str().unwrap(),
    ] {
        assert!(!public.contains(private), "private source data escaped");
    }
    for report in [&original, &first, &second] {
        assert!(!report.to_string().contains("local-model"));
        assert!(!report.to_string().contains("base-model"));
    }
    assert_eq!(
        std::fs::read(profile.join("settings.json")).unwrap(),
        before
    );
}
