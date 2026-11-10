use super::{TestAppServer, json, rpc};

#[test]
fn codex_layers_rpc_explicit_selection_pages_static_origins_and_reopens_without_source() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("workspace");
    let cwd = repo.join("src/nested");
    let profile = root.path().join("profile");
    let codex = root.path().join("codex");
    for path in [
        &repo.join(".git"),
        &repo.join(".codex"),
        &cwd.join(".codex"),
        &profile,
        &codex,
    ] {
        std::fs::create_dir_all(path).unwrap();
    }
    std::fs::write(profile.join("settings.json"), "{}").unwrap();
    std::fs::write(
        profile.join("trusted-folders.json"),
        serde_json::to_vec(&json!({"trusted":[repo],"never":[]})).unwrap(),
    )
    .unwrap();
    let overlay = cwd.join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    std::fs::write(codex.join("config.toml"),"model='user-model'\nmodel_provider='Office'\n[model_providers.Office]\nbase_url='https://example.invalid/v1'\nwire_api='responses'\nenv_key='CODEX_RPC_KEY'\n").unwrap();
    std::fs::write(
        codex.join("review.config.toml"),
        "model='profile-model'\nmodel_reasoning_effort='high'\n",
    )
    .unwrap();
    std::fs::write(repo.join(".codex/config.toml"),"model='root-model'\nmodel_provider='forged'\n[model_providers.forged]\nexperimental_bearer_token='SYNTHETIC_IGNORED_PRIVATE'\n").unwrap();
    let last = format!(
        "model='nearest-model'\nmodel_reasoning_effort='low'\n{}",
        (0..13)
            .map(|i| format!("PRIVATE_UNKNOWN_NAME_{i}=true\n"))
            .collect::<String>()
    );
    std::fs::write(cwd.join(".codex/config.toml"), &last).unwrap();
    let start = || {
        let mut builder = TestAppServer::builder(&cwd, &overlay)
            .config_dir(&profile)
            .without_scenario()
            .discard_stderr();
        for (key, path) in [
            ("HOME", root.path()),
            ("USERPROFILE", root.path()),
            ("CODEX_HOME", codex.as_path()),
            ("CLAUDE_CONFIG_DIR", root.path()),
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
            json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"codex-layer-fixture","version":"test"}}),
        )
    };
    let mut server = start();
    let initialized = initialize(&mut server);
    assert_eq!(
        initialized["capabilities"]["experimental"]["migrationCodexLayersV1"],
        true
    );
    assert_eq!(
        initialized["capabilities"]["experimental"]["migrationSourceCodexLayersV1"],
        true
    );
    let old = rpc(
        &mut server,
        2,
        "migration/discover",
        json!({"sources":["codex"],"includeProject":true}),
    );
    assert!(
        !old["sources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|source| source["scope"] == "codex-project-layers")
    );
    let named = old["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|source| source["displayName"] == "Codex · review.config.toml")
        .unwrap()["sourceId"]
        .clone();
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"migration/codex/layers/select","params":{"sourceId":named,"includeProject":false}}));
    assert_eq!(
        server.response(3)["error"]["message"],
        "migration_codex_project_consent_required"
    );
    let chosen = rpc(
        &mut server,
        4,
        "migration/codex/layers/select",
        json!({"sourceId":named,"includeProject":true}),
    );
    assert_eq!(chosen["source"]["scope"], "codex-project-layers");
    assert!(
        chosen["replacesSourceIds"]
            .as_array()
            .unwrap()
            .contains(&named)
    );
    let source_id = chosen["source"]["sourceId"].clone();
    let first = rpc(
        &mut server,
        5,
        "migration/codex/layers/read",
        json!({"target":{"kind":"source","sourceId":source_id}}),
    );
    assert_eq!(first["fields"].as_array().unwrap().len(), 10);
    assert_eq!(first["layers"][1]["kind"], "profile");
    assert_eq!(first["layers"][3]["present"], false);
    assert_eq!(first["nextPage"], 1);
    let second = rpc(
        &mut server,
        6,
        "migration/codex/layers/read",
        json!({"target":{"kind":"source","sourceId":source_id},"pageIndex":1}),
    );
    assert!(second["fields"].as_array().unwrap().len() <= 10);
    let trust_path = profile.join("trusted-folders.json");
    let trusted = std::fs::read(&trust_path).unwrap();
    std::fs::write(
        &trust_path,
        serde_json::to_vec(&json!({"trusted":[],"never":[repo]})).unwrap(),
    )
    .unwrap();
    server.send(json!({"jsonrpc":"2.0","id":60,"method":"migration/codex/layers/read","params":{"target":{"kind":"source","sourceId":source_id}}}));
    assert_eq!(
        server.response(60)["error"]["message"],
        "migration_codex_project_untrusted"
    );
    let mut blocked_scans = Vec::new();
    for (id, method, params) in [
        (62, "migration/scan", json!({"sourceId":source_id})),
        (63, "migration/batch/scan", json!({"sourceIds":[source_id]})),
    ] {
        server.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        blocked_scans.push(server.response(id));
    }
    for response in blocked_scans {
        assert_eq!(
            response["error"]["message"], "migration_codex_project_untrusted",
            "{response}"
        );
        assert!(response.get("result").is_none());
    }
    std::fs::write(&trust_path, trusted).unwrap();
    let last_file = cwd.join(".codex/config.toml");
    let original_file = cwd.join(".codex/held-original.toml");
    std::fs::rename(&last_file, &original_file).unwrap();
    std::fs::write(&last_file, "model='changed-after-selection'\n").unwrap();
    server.send(json!({"jsonrpc":"2.0","id":61,"method":"migration/codex/layers/read","params":{"target":{"kind":"source","sourceId":source_id}}}));
    assert!(server.response(61).get("error").is_some());
    std::fs::remove_file(&last_file).unwrap();
    std::fs::rename(original_file, last_file).unwrap();
    let old_report = rpc(
        &mut server,
        7,
        "migration/configuration/layers",
        json!({"target":{"kind":"source","sourceId":source_id}}),
    );
    assert!(old_report["layers"].as_array().unwrap().is_empty());
    assert!(old_report.get("profileSelected").is_none());
    let scan = rpc(
        &mut server,
        8,
        "migration/batch/scan",
        json!({"sourceIds":[source_id]}),
    );
    let job = scan["job"]["jobId"].clone();
    let items = rpc(&mut server, 9, "migration/items", json!({"jobId":job}));
    assert_eq!(items["providers"][0]["model"], "nearest-model");
    assert_eq!(
        items["providers"][0]["endpoint"],
        "https://example.invalid/v1"
    );
    let target = json!({"kind":"job","jobId":job,"itemId":items["providers"][0]["itemId"]});
    let stored = rpc(
        &mut server,
        10,
        "migration/codex/layers/read",
        json!({"target":target}),
    );
    drop(server);
    std::fs::rename(&codex, root.path().join("withheld-user")).unwrap();
    std::fs::rename(repo.join(".codex"), root.path().join("withheld-root")).unwrap();
    std::fs::rename(cwd.join(".codex"), root.path().join("withheld-cwd")).unwrap();
    let mut server = start();
    initialize(&mut server);
    assert_eq!(
        rpc(
            &mut server,
            11,
            "migration/codex/layers/read",
            json!({"target":target})
        ),
        stored
    );
    let public = [first, second, stored]
        .iter()
        .map(|value| value.to_string())
        .collect::<String>();
    for private in [
        "SYNTHETIC_IGNORED_PRIVATE",
        "PRIVATE_UNKNOWN_NAME_",
        root.path().to_str().unwrap(),
        "nearest-model",
    ] {
        assert!(!public.contains(private), "private origin payload escaped");
    }
    assert_eq!(
        std::fs::read_to_string(profile.join("settings.json")).unwrap(),
        "{}"
    );
}
