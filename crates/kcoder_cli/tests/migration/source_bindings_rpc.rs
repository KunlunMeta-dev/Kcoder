use super::{TestAppServer, json, rpc};

#[test]
fn source_binding_rpc_uses_native_grants_not_overlapping_categories_or_opaque_id_shapes() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let profile = root.path().join("profile");
    let source = root.path().join("claude");
    for path in [&workspace, &profile, &source] {
        std::fs::create_dir(path).unwrap();
    }
    std::fs::write(profile.join("settings.json"), "{}").unwrap();
    let overlay = workspace.join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let bytes = r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"NEVER_EXECUTE_SOURCE"}]}]}}"#;
    std::fs::write(source.join("settings.json"), bytes).unwrap();
    std::fs::write(source.join("CLAUDE.md"), "Static instructions only.\n").unwrap();
    let start = || {
        let mut builder = TestAppServer::builder(&workspace, &overlay)
            .config_dir(&profile)
            .without_scenario()
            .discard_stderr();
        for (name, path) in [
            ("HOME", root.path()),
            ("USERPROFILE", root.path()),
            ("CLAUDE_CONFIG_DIR", source.as_path()),
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
            json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"source-binding-fixture","version":"test"}}),
        )
    };
    let mut server = start();
    assert_eq!(
        initialize(&mut server)["capabilities"]["experimental"]["migrationSourceBindingsV1"],
        true
    );
    let discovered = rpc(
        &mut server,
        2,
        "migration/discover",
        json!({"sources":["claude-code"]}),
    );
    let rows = discovered["sources"].as_array().unwrap();
    let config = rows.iter().find(|row| row["scope"] == "user").unwrap()["sourceId"].clone();
    let asset = rows
        .iter()
        .find(|row| row["scope"] == "user-instructions")
        .unwrap()["sourceId"]
        .clone();
    for row in rows {
        assert!(
            row.get("family").is_none(),
            "old discovery summaries remain unchanged"
        );
    }
    let descriptors = rpc(
        &mut server,
        3,
        "migration/source/bindings",
        json!({"sourceIds":[asset,config]}),
    );
    assert_eq!(
        descriptors,
        json!({"bindings":[{"sourceId":asset,"family":"assets"},{"sourceId":config,"family":"configuration"}]})
    );
    for (id, ids) in [
        (4, json!([config, "invented"])),
        (5, json!([asset, asset])),
        (6, json!([])),
        (7, json!((0..11).map(|n| n.to_string()).collect::<Vec<_>>())),
    ] {
        server.send(json!({"jsonrpc":"2.0","id":id,"method":"migration/source/bindings","params":{"sourceIds":ids}}));
        let response = server.response(id);
        assert!(
            response.get("result").is_none(),
            "invalid or partly expired pages never return a shortened mapping"
        );
        assert!(response.get("error").is_some());
    }
    assert_eq!(
        rpc(
            &mut server,
            8,
            "migration/source/bindings",
            json!({"sourceIds":[asset,config]})
        ),
        descriptors
    );
    drop(server);
    let mut other = start();
    initialize(&mut other);
    other.send(json!({"jsonrpc":"2.0","id":9,"method":"migration/source/bindings","params":{"sourceIds":[config]}}));
    assert!(
        other.response(9).get("error").is_some(),
        "another discovery connection cannot reuse these grants"
    );
    assert_eq!(
        std::fs::read_to_string(source.join("settings.json")).unwrap(),
        bytes
    );
    assert_eq!(std::fs::read_dir(&source).unwrap().count(), 2);
}
